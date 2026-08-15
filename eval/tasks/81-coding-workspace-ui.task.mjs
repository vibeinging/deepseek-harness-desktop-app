import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requireFromServer = createRequire(new URL("../../server/package.json", import.meta.url));
const BetterSqlite3 = requireFromServer("better-sqlite3");

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-coding-workspace-ui-"));
  writeFileSync(join(root, "note.txt"), "line1\r\nbefore\r\nline3\r\n");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Dsh Eval"]);
  git(root, ["config", "user.email", "eval@dsh.local"]);
  git(root, ["add", "note.txt"]);
  git(root, ["commit", "-q", "-m", "fixture"]);
  return root;
}

function seedVisibleConversation(databasePath, sessionId) {
  const db = new BetterSqlite3(databasePath);
  try {
    db.transaction(() => {
      db.prepare(`
        INSERT INTO session_messages
          (id, session_id, role, content_items, sequence_number, created_at, updated_at)
        VALUES (?, ?, 'user', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(
        randomUUID(),
        sessionId,
        JSON.stringify([{ type: "text", text: "coding workspace eval fixture" }]),
      );
      db.prepare(`
        UPDATE sessions
           SET message_count=1, updated_at=CURRENT_TIMESTAMP
         WHERE id=?
      `).run(sessionId);
    })();
  } finally {
    db.close();
  }
}

export default {
  id: "coding-workspace-ui",
  desc: "无模型验证 Worktree、当前工作区 Diff、行编辑与安全外部打开入口",
  eval: {
    feature: "coding.workspace-ui",
    layer: "ui_e2e",
    risk: "P0",
    interaction: "cdp",
    model: "none",
    data: "synthetic",
    platforms: ["darwin", "win32", "linux"],
    timeoutMs: 180_000,
    repeats: 1,
    minPassRate: 1,
    requirements: [
      "coding.worktree-lifecycle",
      "coding.active-workspace-root",
      "coding.diff-line-edit",
      "coding.external-editor-safe-entry",
    ],
    tags: ["pr", "ui", "dsh-alignment", "coding"],
    criteria: [
      {
        id: "coding.worktree-lifecycle",
        description: "真实 Electron 设置页可创建、启用、停用和删除 Worktree",
        evidence: ["ui", "api", "filesystem"],
      },
      {
        id: "coding.active-root",
        description: "Diff 与行编辑都使用当前启用的 Worktree，主检出不被修改",
        evidence: ["api", "ui", "filesystem"],
      },
      {
        id: "coding.diff-safety",
        description: "行编辑保留 CRLF、拒绝过期 Diff，且只显示受控的外部打开入口",
        evidence: ["ui", "api", "filesystem"],
      },
    ],
  },
  async run({ driver, assert, environment }) {
    await driver.login();
    const api = driver.raw.api;
    const ui = driver.ui;
    const root = createFixture();
    const stamp = Date.now().toString(36);
    const projectName = `coding-workspace-${stamp}`;
    const branch = `feature/eval-${stamp}`;
    let pid = "";
    let sid = "";
    let worktreeId = "";
    let worktreePath = "";
    try {
      const created = await api("POST", "/api/projects", {
        name: projectName,
        description: "合成 Coding 工作区 UI Eval",
        source_folders: [{ path: root, name: "Git fixture", access_mode: "write" }],
      });
      assert.status(created, 200, "创建合成 Git 项目", { criterion: "coding.worktree-lifecycle" });
      pid = created.json?.data?.id || "";
      if (!pid) return;

      await driver.raw.ev(`
        localStorage.setItem('dsh:onboarding:completed:v1', 'true');
        return true;
      `);
      await ui.goto("/agent");
      await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15_000 });
      await ui.waitForText(projectName, { selector: "[title],button,[aria-label]", timeout: 15_000 });
      const menuSelector = `[aria-label="查看项目 ${projectName}"]`;
      await ui.click(menuSelector, { timeout: 10_000 });
      await ui.click(`[aria-label="打开${projectName}的项目设置"]`, { timeout: 10_000 });
      await ui.waitFor('[data-testid="worktree-section"]', { timeout: 15_000 });

      await ui.waitUntil(
        `() => {
          const button = document.querySelector('[data-testid="worktree-create-open"]');
          return Boolean(button && !button.disabled);
        }`,
        { timeout: 15_000, label: "Worktree 创建入口加载完成" },
      );
      const createClicked = await driver.raw.ev(`
        const button = document.querySelector('[data-testid="worktree-create-open"]');
        if (!button || button.disabled) return false;
        button.click();
        return true;
      `);
      assert.eq(createClicked, true, "触发 Worktree 创建表单", { criterion: "coding.worktree-lifecycle" });
      // Mantine portals the dialog content; the stable field hook is the
      // visible readiness signal across renderer versions.
      await ui.waitFor('[data-testid="worktree-branch-input"]', { timeout: 10_000 });
      await ui.fill('[data-testid="worktree-branch-input"]', branch);
      await ui.click('[data-testid="worktree-create-submit"]');

      const listedAfterCreate = await driver.raw.ev(`
        const pid = ${JSON.stringify(pid)};
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          const response = await window.electronAPI.apiRequest({
            method: 'GET', url: '/api/projects/' + encodeURIComponent(pid) + '/worktrees', headers: {}, body: null
          });
          const item = response?.json?.data?.items?.[0];
          if (response?.status === 200 && item) return item;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return null;
      `, { timeoutMs: 25_000 });
      assert.ok(Boolean(listedAfterCreate?.id), "设置页真实创建 Worktree", {
        criterion: "coding.worktree-lifecycle",
      });
      worktreeId = listedAfterCreate?.id || "";
      worktreePath = listedAfterCreate?.path || "";
      if (!worktreeId || !worktreePath) return;

      await ui.waitFor(`[data-testid="worktree-activate-${worktreeId}"]`, { timeout: 10_000 });
      await ui.waitUntil(
        `() => !document.querySelector(${JSON.stringify(`[data-testid="worktree-activate-${worktreeId}"]`)})?.disabled`,
        { timeout: 15_000, label: "Worktree 激活按钮可用" },
      );
      const activateClicked = await driver.raw.ev(`
        const button = document.querySelector(${JSON.stringify(`[data-testid="worktree-activate-${worktreeId}"]`)});
        if (!button || button.disabled) return false;
        button.click();
        return true;
      `);
      assert.eq(activateClicked, true, "触发 Worktree 激活", { criterion: "coding.worktree-lifecycle" });
      await ui.waitFor('[data-testid="worktree-active"]', { timeout: 15_000 });
      const active = await api("GET", `/api/projects/${pid}/worktrees`);
      assert.eq(active.json?.data?.items?.find((item) => item.id === worktreeId)?.active, true, "Worktree 已启用", {
        criterion: "coding.worktree-lifecycle",
      });

      writeFileSync(join(worktreePath, "note.txt"), "line1\r\nchanged in worktree\r\nline3\r\n");
      const session = await api("POST", `/api/projects/${pid}/sessions`, {
        title: `coding-workspace-ui-${stamp}`,
        source_type: "agent",
        source_id: pid,
        action_type: "agentic_chat",
      });
      assert.status(session, 200, "创建 Diff 诊断会话", { criterion: "coding.active-root" });
      sid = session.json?.data?.id || "";
      if (!sid) return;
      seedVisibleConversation(environment.runtime.database_path, sid);

      const diff = await api("GET", `/api/agent/threads/${sid}/workspace-diff`);
      assert.status(diff, 200, "读取当前工作区 Diff", { criterion: "coding.active-root" });
      assert.eq(diff.json?.data?.workspaceRoot, worktreePath, "Diff 使用启用的 Worktree 根目录", {
        criterion: "coding.active-root",
      });
      assert.ok(String(diff.json?.data?.diff || "").includes("changed in worktree"), "Diff 来自 Worktree", {
        criterion: "coding.active-root",
      });
      const staleHash = diff.json?.data?.diffHash || "";

      await ui.goto("/agent");
      await driver.raw.cdp('Page.reload', { ignoreCache: false });
      await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 20_000 });
      await ui.waitFor(`[data-agent-workspace-id="${pid}"]`, { timeout: 15_000 });
      const sessionVisible = await ui.exists(`[data-agent-conv-id="${sid}"]`);
      if (!sessionVisible) await ui.click(`[data-agent-workspace-id="${pid}"]`);
      await ui.waitFor(`[data-agent-conv-id="${sid}"]`, { timeout: 15_000 });
      await ui.click(`[data-agent-conv-id="${sid}"]`);
      await ui.waitFor(`[data-agent-conv-id="${sid}"][aria-current="page"]`, { timeout: 15_000 });
      await ui.waitFor('[data-testid="workspace-changes-open"]', { timeout: 15_000 });
      await ui.click('[data-testid="workspace-changes-open"]');
      await ui.waitFor('[data-testid="workspace-changes-panel"]', { timeout: 10_000 });
      assert.ok(await ui.exists('[data-testid="workspace-changes-open-editor"]'), "审核面板显示受控外部打开入口", {
        criterion: "coding.diff-safety",
      });
      const openedEditor = await driver.raw.ev(`
        const row = [...document.querySelectorAll('[data-kind="add"]')]
          .find((item) => String(item.textContent || '').includes('changed in worktree'));
        const button = row?.querySelector('[data-testid="workspace-line-edit-open"]');
        button?.click();
        return Boolean(button);
      `);
      assert.eq(openedEditor, true, "从新增行打开行编辑", { criterion: "coding.diff-safety" });
      await ui.waitFor('[data-testid="workspace-line-edit-input"]', { timeout: 10_000 });
      await ui.fill('[data-testid="workspace-line-edit-input"]', "edited through UI");
      await ui.click('[data-testid="workspace-line-edit-save"]');
      await ui.waitUntil(
        `() => !document.querySelector('[data-testid="workspace-line-edit-input"]')`,
        { timeout: 15_000, label: "行编辑保存完成" },
      );
      assert.eq(
        readFileSync(join(worktreePath, "note.txt"), "utf8"),
        "line1\r\nedited through UI\r\nline3\r\n",
        "UI 行编辑只改目标行并保留 CRLF",
        { criterion: "coding.diff-safety" },
      );
      assert.eq(
        readFileSync(join(root, "note.txt"), "utf8"),
        "line1\r\nbefore\r\nline3\r\n",
        "主检出保持不变",
        { criterion: "coding.active-root" },
      );

      const stale = await api("POST", `/api/agent/threads/${sid}/turns/current-workspace/workspace-edit`, {
        action: "apply_edit",
        requestId: `stale:${stamp}`,
        path: "note.txt",
        lineNumber: 2,
        newLineText: "stale edit must fail",
        expectedWorkspaceDiffHash: staleHash,
      });
      assert.eq(stale.status, 409, "过期 Diff 被拒绝", { criterion: "coding.diff-safety" });
      assert.ok(!readFileSync(join(worktreePath, "note.txt"), "utf8").includes("stale edit"), "冲突不写文件", {
        criterion: "coding.diff-safety",
      });

      await ui.click('[data-testid="workspace-changes-close"]');
      await ui.click(menuSelector, { timeout: 10_000 });
      await ui.click(`[aria-label="打开${projectName}的项目设置"]`, { timeout: 10_000 });
      await ui.waitFor('[data-testid="worktree-section"]', { timeout: 15_000 });
      await ui.waitUntil(
        `() => {
          const button = document.querySelector(${JSON.stringify(`[data-testid="worktree-deactivate-${worktreeId}"]`)});
          return Boolean(button && !button.disabled);
        }`,
        { timeout: 15_000, label: "Worktree 停用按钮可用" },
      );
      const deactivateClicked = await driver.raw.ev(`
        const button = document.querySelector(${JSON.stringify(`[data-testid="worktree-deactivate-${worktreeId}"]`)});
        if (!button || button.disabled) return false;
        button.click();
        return true;
      `);
      assert.eq(deactivateClicked, true, "触发 Worktree 停用", { criterion: "coding.worktree-lifecycle" });
      await ui.waitFor(`[data-testid="worktree-activate-${worktreeId}"]`, { timeout: 15_000 });
      await ui.waitUntil(
        `() => !document.querySelector(${JSON.stringify(`[data-testid="worktree-remove-${worktreeId}"]`)})?.disabled`,
        { timeout: 15_000, label: "Worktree 删除按钮可用" },
      );
      const removeClicked = await driver.raw.ev(`
        const button = document.querySelector(${JSON.stringify(`[data-testid="worktree-remove-${worktreeId}"]`)});
        if (!button || button.disabled) return false;
        button.click();
        return true;
      `);
      assert.eq(removeClicked, true, "打开 Worktree 删除确认", { criterion: "coding.worktree-lifecycle" });
      await ui.waitFor(`[data-testid="worktree-remove-confirm-${worktreeId}"]`, { timeout: 10_000 });
      const removeConfirmed = await driver.raw.ev(`
        const button = document.querySelector(${JSON.stringify(`[data-testid="worktree-remove-confirm-${worktreeId}"]`)});
        if (!button || button.disabled) return false;
        button.click();
        return true;
      `);
      assert.eq(removeConfirmed, true, "确认删除 Worktree", { criterion: "coding.worktree-lifecycle" });
      await ui.waitFor('[data-testid="worktree-empty"]', { timeout: 15_000 });
      const afterRemove = await api("GET", `/api/projects/${pid}/worktrees`);
      assert.eq(afterRemove.json?.data?.items?.length, 0, "设置页删除 Worktree", {
        criterion: "coding.worktree-lifecycle",
      });
      worktreeId = "";
    } finally {
      if (pid && worktreeId) {
        await api("POST", `/api/projects/${pid}/worktrees/deactivate`).catch(() => {});
        await api("DELETE", `/api/projects/${pid}/worktrees/${worktreeId}`).catch(() => {});
      }
      if (pid && sid) await api("DELETE", `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      if (pid) await api("DELETE", `/api/projects/${pid}`).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  },
};
