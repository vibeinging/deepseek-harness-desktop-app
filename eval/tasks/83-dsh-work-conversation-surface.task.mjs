import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const requireFromServer = createRequire(new URL("../../server/package.json", import.meta.url));
const BetterSqlite3 = requireFromServer("better-sqlite3");
const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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
        JSON.stringify([{ type: "text", text: "dsh-work surface eval fixture" }]),
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
  id: "dsh-work-conversation-surface",
  desc: "无模型验证 dsh-work 单一聊天界面使用 DSH Session，且不嵌入 DSH Web 整页",
  eval: {
    feature: "dsh.work-conversation-surface",
    layer: "ui_e2e",
    risk: "P0",
    interaction: "cdp",
    model: "none",
    data: "synthetic",
    platforms: ["darwin", "win32", "linux"],
    timeoutMs: 90_000,
    repeats: 1,
    minPassRate: 1,
    requirements: [
      "dsh.authoritative-product-surface",
      "dsh.no-duplicate-web-surface",
      "dsh.permission-authoritative",
      "dsh.image-host-admission",
    ],
    tags: ["pr", "ui", "dsh", "conversation"],
    criteria: [
      {
        id: "dsh.authoritative-product-surface",
        description: "dsh-work 消息区和输入框展示绑定 DSH Session 的权威历史",
        evidence: ["ui", "api"],
      },
      {
        id: "dsh.no-duplicate-web-surface",
        description: "正式聊天没有 DSH Web iframe、原生/兼容切换或重复工作台入口",
        evidence: ["ui", "screenshots"],
      },
      {
        id: "dsh.permission-authoritative",
        description: "权限选择器读取 DSH Session 投影并通过 DSH 命令切换",
        evidence: ["ui", "api"],
      },
      {
        id: "dsh.image-host-admission",
        description: "dsh-work 把图片交给 DSH，并显示 Host 对纯文本模型的正式拒绝",
        evidence: ["ui", "api"],
      },
    ],
  },
  async run({ driver, assert, environment }) {
    await driver.login();
    const api = driver.raw.api;
    const ui = driver.ui;
    const root = mkdtempSync(join(tmpdir(), "dsh-work-surface-"));
    const stamp = Date.now().toString(36);
    const projectName = `dsh-work-surface-${stamp}`;
    let pid = "";
    let sid = "";
    try {
      const created = await api("POST", "/api/projects", {
        name: projectName,
        description: "dsh-work 单一聊天界面测试项目",
        source_folders: [{ path: root, name: "Fixture", access_mode: "write" }],
      });
      assert.status(created, 200, "创建单一聊天界面测试项目", {
        criterion: "dsh.authoritative-product-surface",
      });
      pid = created.json?.data?.id || "";
      if (!pid) return;

      const session = await api("POST", `/api/projects/${pid}/sessions`, {
        title: `work-surface-${stamp}`,
        source_type: "agent",
        source_id: pid,
        action_type: "agentic_chat",
      });
      assert.status(session, 200, "创建并绑定 DSH Session", {
        criterion: "dsh.authoritative-product-surface",
      });
      sid = session.json?.data?.id || "";
      if (!sid) return;
      seedVisibleConversation(environment.runtime.database_path, sid);

      const history = await api("GET", `/api/projects/${pid}/sessions/${sid}/messages`);
      assert.status(history, 200, "读取 DSH 权威历史", {
        criterion: "dsh.authoritative-product-surface",
      });
      assert.eq(history.json?.data?.dsh_recovery, true, "历史由绑定的 DSH Session 恢复", {
        criterion: "dsh.authoritative-product-surface",
      });

      await ui.goto("/agent");
      await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15_000 });
      await ui.waitFor('[data-agent-window-titlebar]', { timeout: 15_000 });
      await driver.raw.activateProject(created.json.data);
      const activation = await driver.raw.ev(`
        const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts');
        eventBus.emit(EVENT_TYPES.NEW_session_CREATED, {
          sessionId: ${JSON.stringify(sid)},
          workspaceId: ${JSON.stringify(pid)},
          projectId: ${JSON.stringify(pid)},
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        const listed = await window.electronAPI.apiRequest({
          method: 'GET',
          url: '/api/agent/projects/' + encodeURIComponent(${JSON.stringify(pid)}) + '/sessions',
          headers: { 'Content-Type': 'application/json' },
          body: null,
        });
        return {
          eventListeners: eventBus.events?.[EVENT_TYPES.NEW_session_CREATED]?.length || 0,
          selectedSessionId: document.querySelector('[data-agent-conv-id][aria-current="page"]')?.getAttribute('data-agent-conv-id') || '',
          listedSessionIds: (listed?.json?.data?.items || []).map((item) => item.id),
          visibleSessionIds: [...document.querySelectorAll('[data-agent-conv-id]')]
            .map((element) => element.getAttribute('data-agent-conv-id')),
        };
      `);
      assert.ok(activation.eventListeners > 0, "主窗口已注册会话切换事件", {
        criterion: "dsh.authoritative-product-surface",
      });
      assert.ok(activation.listedSessionIds.includes(sid), `权威侧栏快照包含绑定会话(${JSON.stringify(activation)})`, {
        criterion: "dsh.authoritative-product-surface",
      });
      await ui.waitFor(`[data-agent-conv-id="${sid}"]`, { timeout: 15_000 });
      await ui.click(`[data-agent-conv-id="${sid}"]`, { timeout: 10_000 });
      await ui.waitFor(`[data-agent-conv-id="${sid}"][aria-current="page"]`, { timeout: 15_000 });
      await ui.waitFor('[data-conversation-state="idle"]', { timeout: 15_000 });
      await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15_000 });
      if (!(await ui.exists('[data-workbench-empty-action="browser"]'))) {
        await ui.click('[data-edge-toggle="workspace"]', { timeout: 10_000 });
      }
      await ui.waitFor('[data-workbench-empty-action="browser"]', { timeout: 15_000 });

      const state = await driver.raw.ev(`
        const root = document.querySelector('[data-conversation-state]');
        return {
          state: root?.getAttribute('data-conversation-state') || '',
          sessionId: document.querySelector('[data-agent-conv-id][aria-current="page"]')?.getAttribute('data-agent-conv-id') || '',
          inputCount: document.querySelectorAll('[data-testid="agent-message-input"]').length,
          iframeCount: document.querySelectorAll('main iframe').length,
          nativeSwitch: [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === 'DSH 原生界面'),
          compatibilitySwitch: [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '兼容界面'),
          workbenchTools: [...document.querySelectorAll('[data-workbench-empty-action]')]
            .map((element) => element.getAttribute('data-workbench-empty-action')),
        };
      `);
      assert.eq(state.sessionId, sid, "dsh-work 选中同一个 App/DSH 绑定会话", {
        criterion: "dsh.authoritative-product-surface",
      });
      assert.eq(state.state, "idle", "dsh-work 消息区完成 DSH 历史恢复", {
        criterion: "dsh.authoritative-product-surface",
      });
      assert.eq(state.inputCount, 1, "正式聊天只有一个输入框", {
        criterion: "dsh.no-duplicate-web-surface",
      });
      assert.eq(state.iframeCount, 0, "正式聊天不嵌入 DSH Web 整页", {
        criterion: "dsh.no-duplicate-web-surface",
      });
      assert.eq(state.nativeSwitch, false, "没有 DSH 原生界面技术入口", {
        criterion: "dsh.no-duplicate-web-surface",
      });
      assert.eq(state.compatibilitySwitch, false, "没有兼容界面技术入口", {
        criterion: "dsh.no-duplicate-web-surface",
      });
      for (const tab of ["browser", "files", "artifacts", "sites"]) {
        assert.ok(state.workbenchTools.includes(tab), `现有工作台保留 ${tab} 入口`, {
          criterion: "dsh.no-duplicate-web-surface",
        });
      }

      const permissionBefore = await api("GET", `/api/agent/projects/${pid}/threads/${sid}/dsh-state`);
      assert.status(permissionBefore, 200, "读取 DSH Session 权限投影", {
        criterion: "dsh.permission-authoritative",
      });
      const selectBefore = permissionBefore.json?.data?.projections?.permissions;
      const currentPreset = selectBefore?.currentValue || "";
      const alternative = (selectBefore?.options || []).find((option) => (
        option.value !== currentPreset && option.value !== "custom"
      ));
      assert.ok(Boolean(currentPreset && alternative), "DSH Profile 提供当前权限和可切换预设", {
        criterion: "dsh.permission-authoritative",
      });
      if (currentPreset && alternative) {
        await ui.waitFor(`[data-dsh-permission-value="${currentPreset}"]`, { timeout: 15_000 });
        const opened = await driver.raw.ev(`
          const trigger = document.querySelector('[data-testid="dsh-permission-trigger"]');
          trigger?.click();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return {
            disabled: trigger?.disabled === true,
            options: [...document.querySelectorAll('[data-dsh-permission-option]')]
              .map((element) => element.getAttribute('data-dsh-permission-option')),
          };
        `);
        assert.eq(opened.disabled, false, "DSH 权限按钮在空闲会话中可操作", {
          criterion: "dsh.permission-authoritative",
        });
        assert.ok(opened.options.includes(alternative.value), `DSH 权限菜单展示投影选项(${JSON.stringify(opened)})`, {
          criterion: "dsh.permission-authoritative",
        });
        await driver.raw.ev(`
          document.querySelector(${JSON.stringify(`[data-dsh-permission-option="${alternative.value}"]`)})?.click();
          return true;
        `);
        if (alternative.value === "danger-full-access") {
          await ui.clickByTestId("dsh-confirm-full-access", { timeout: 10_000 });
        }
        await ui.waitFor(`[data-dsh-permission-value="${alternative.value}"]`, { timeout: 20_000 });
        const permissionAfter = await api("GET", `/api/agent/projects/${pid}/threads/${sid}/dsh-state`);
        assert.eq(
          permissionAfter.json?.data?.projections?.permissions?.currentValue,
          alternative.value,
          "UI 权限切换写入同一个 DSH Session 投影",
          { criterion: "dsh.permission-authoritative" },
        );
        await api("POST", `/api/agent/projects/${pid}/threads/${sid}/dsh-permission`, {
          preset: currentPreset,
        }).catch(() => {});
      }

      await driver.raw.ev(`
        const input = document.querySelector('[data-testid="agent-message-input"]');
        if (!input) throw new Error('找不到输入框');
        const raw = atob(${JSON.stringify(ONE_PIXEL_PNG_BASE64)});
        const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
        const file = new File([bytes], 'fixture.png', { type: 'image/png' });
        const transfer = new DataTransfer();
        transfer.items.add(file);
        input.dispatchEvent(new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: transfer,
        }));
        return true;
      `);
      await ui.waitFor('[data-attachment-path]', { timeout: 15_000 });
      await ui.fill('[data-testid="agent-message-input"]', "验证 DSH 图片模型门禁");
      await ui.waitFor('[data-testid="agent-send-button"]:not(:disabled)', { timeout: 10_000 });
      await ui.click('[data-testid="agent-send-button"]');
      await ui.waitUntil(`async () => document.body.innerText.includes('当前模型不支持图片，请切换到支持图片输入的模型')`, {
        timeout: 30_000,
        label: "DSH Host 图片拒绝显示为产品文案",
      });
      const imageAdmission = await driver.raw.ev(`return {
        previewCount: document.querySelectorAll('[data-attachment-preview="image"]').length,
        productCopy: document.body.innerText.includes('当前模型不支持图片，请切换到支持图片输入的模型'),
        rawReason: document.body.innerText.includes('MODEL_DOES_NOT_SUPPORT_IMAGES'),
      }`);
      assert.ok(imageAdmission.previewCount > 0, "图片在 dsh-work 消息区保留预览", {
        criterion: "dsh.image-host-admission",
      });
      assert.eq(imageAdmission.productCopy, true, "显示 DSH Host 图片门禁的可操作提示", {
        criterion: "dsh.image-host-admission",
      });
      assert.eq(imageAdmission.rawReason, false, "正式界面不暴露 DSH 图片拒绝机器码", {
        criterion: "dsh.image-host-admission",
      });
    } finally {
      if (pid && sid) await api("DELETE", `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      if (pid) await api("DELETE", `/api/projects/${pid}`).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    }
  },
};
