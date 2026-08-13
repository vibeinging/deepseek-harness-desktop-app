import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  applyWorkspaceEdit,
  diffPaths,
  getCurrentWorkspaceDiff,
  revertWorkspaceChange,
} from "../../server/src/engine/agents/workspace_change_provider.js";

const execFileAsync = promisify(execFile);

const PATCH = [
  "diff --git a/note.txt b/note.txt",
  "--- a/note.txt",
  "+++ b/note.txt",
  "@@ -1 +1 @@",
  "-before",
  "+after",
  "",
].join("\n");

function mockContext(root) {
  const records = new Map();
  let savedMetadata = null;
  const message = {
    id: "assistant-1",
    content_items: JSON.stringify([{
      id: "change-1",
      type: "file_change",
      content: JSON.stringify({ changes: [{ path: "note.txt", kind: "update", diff: PATCH }] }),
    }]),
    message_metadata: JSON.stringify({ turn_id: "turn-1", turn_diff: PATCH }),
  };
  return {
    userId: "user-1",
    records,
    get savedMetadata() { return savedMetadata; },
    queryOne: async (sql, params) => {
      if (sql.includes("FROM sessions")) return { id: "session-1", project_id: "project-1" };
      if (sql.includes("FROM workspace_action_records")) return records.get(params[0]) || null;
      return null;
    },
    query: async (sql, params = []) => {
      if (sql.includes("FROM project_source_folders")) {
        return [{ id: "root-1", local_path: root, display_name: "workspace", access_mode: "write" }];
      }
      if (sql.includes("FROM session_messages")) return [message];
      if (sql.includes("INSERT INTO workspace_action_records")) {
        records.set(params[1], { status: "running", result_json: null });
        return [];
      }
      if (sql.includes("SET status='succeeded'")) {
        records.set(params[0], { status: "succeeded", result_json: params[1] });
        return [];
      }
      if (sql.includes("SET status='failed'")) {
        records.set(params[0], { status: "failed", error_code: params[1], error_message: params[2] });
        return [];
      }
      if (sql.includes("UPDATE session_messages")) {
        savedMetadata = JSON.parse(params[0]);
        return [];
      }
      return [];
    },
  };
}

test("diff path extraction ignores /dev/null and keeps workspace-relative paths", () => {
  assert.deepEqual(diffPaths(PATCH), ["note.txt"]);
  assert.deepEqual(diffPaths("--- /dev/null\n+++ b/new file.txt\n"), ["new file.txt"]);
});

test("workspace revert checks the persisted patch, applies it once, and restores action state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-workspace-action-"));
  try {
    await writeFile(path.join(root, "note.txt"), "after\n", "utf8");
    const ctx = mockContext(root);
    const input = {
      params: { threadId: "session-1", turnId: "turn-1" },
      body: { action: "revert_file_change", requestId: "request-1", targetItemId: "change-1" },
    };

    const first = await revertWorkspaceChange(ctx, input);
    assert.equal(first.data.status, "succeeded");
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "before\n");
    assert.equal(ctx.savedMetadata.workspace_actions["change-1"].status, "succeeded");

    const replay = await revertWorkspaceChange(ctx, input);
    assert.equal(replay.data.requestId, "request-1");
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "before\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace revert refuses a stale patch without changing the file", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-workspace-conflict-"));
  try {
    await writeFile(path.join(root, "note.txt"), "edited again\n", "utf8");
    const ctx = mockContext(root);
    await assert.rejects(
      revertWorkspaceChange(ctx, {
        params: { threadId: "session-1", turnId: "turn-1" },
        body: { action: "revert_file_change", requestId: "request-conflict", targetItemId: "change-1" },
      }),
      (error) => error?.status === 409,
    );
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "edited again\n");
    assert.equal(ctx.records.get("request-conflict")?.status, "failed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("current workspace diff is recomputed from Git and includes untracked files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-current-diff-"));
  try {
    await execFileAsync("git", ["init"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "before\n", "utf8");
    await execFileAsync("git", ["add", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "base"], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "after\n", "utf8");
    await writeFile(path.join(root, "new.txt"), "created\n", "utf8");

    const result = await getCurrentWorkspaceDiff(mockContext(root), {
      params: { threadId: "session-1" },
    });
    assert.equal(result.data.supported, true);
    assert.match(result.data.diff, /tracked\.txt/);
    assert.match(result.data.diff, /new\.txt/);
    assert.match(result.data.diffHash, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyWorkspaceEdit replaces a single line and writes it back", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-edit-"));
  try {
    await writeFile(path.join(root, "note.txt"), "line1\nbefore\nline3\n", "utf8");
    const ctx = mockContext(root);
    const input = {
      params: { threadId: "session-1", turnId: "turn-1" },
      body: { action: "apply_edit", requestId: "edit-1", path: "note.txt", lineNumber: 2, newLineText: "after" },
    };
    const result = await applyWorkspaceEdit(ctx, input);
    assert.equal(result.data.status, "succeeded");
    assert.equal(result.data.oldLineText, "before");
    assert.equal(result.data.newLineText, "after");
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "line1\nafter\nline3\n");
    // Idempotent: replaying the same requestId returns the cached result.
    const replay = await applyWorkspaceEdit(ctx, input);
    assert.equal(replay.data.status, "succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyWorkspaceEdit rejects a stale view (workspace diff hash mismatch)", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-edit-conflict-"));
  try {
    await writeFile(path.join(root, "note.txt"), "original\n", "utf8");
    const ctx = mockContext(root);
    // Wrong workspace-diff hash simulates an editor view that is out of date.
    await assert.rejects(
      applyWorkspaceEdit(ctx, {
        params: { threadId: "session-1", turnId: "turn-1" },
        body: {
          action: "apply_edit",
          requestId: "edit-conflict",
          path: "note.txt",
          lineNumber: 1,
          newLineText: "changed",
          expectedWorkspaceDiffHash: "0".repeat(64),
        },
      }),
      (error) => error?.status === 409,
    );
    // File unchanged.
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "original\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyWorkspaceEdit preserves CRLF line endings on the edited line", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-edit-crlf-"));
  try {
    await writeFile(path.join(root, "note.txt"), "line1\r\nbefore\r\nline3\r\n", "utf8");
    const ctx = mockContext(root);
    const input = {
      params: { threadId: "session-1", turnId: "turn-1" },
      body: { action: "apply_edit", requestId: "edit-crlf", path: "note.txt", lineNumber: 2, newLineText: "after" },
    };
    const result = await applyWorkspaceEdit(ctx, input);
    assert.equal(result.data.status, "succeeded");
    // CRLF is preserved across the whole file; only the edited line changed.
    assert.equal(await readFile(path.join(root, "note.txt"), "utf8"), "line1\r\nafter\r\nline3\r\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("applyWorkspaceEdit rejects path traversal outside the workspace", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsh-edit-traversal-"));
  try {
    await writeFile(path.join(root, "note.txt"), "content\n", "utf8");
    const ctx = mockContext(root);
    await assert.rejects(
      applyWorkspaceEdit(ctx, {
        params: { threadId: "session-1", turnId: "turn-1" },
        body: { action: "apply_edit", requestId: "edit-traversal", path: "../../../etc/passwd", lineNumber: 1, newLineText: "evil" },
      }),
      (error) => error?.status === 409,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
