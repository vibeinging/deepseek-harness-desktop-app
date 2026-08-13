import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, realpath, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../../errors.js";
import { loadProjectSourceFolders } from "./project_source_folders.js";
import { effectiveProjectSourceFolders } from "./git_workspace.js";
import { resolveWorkspace } from "./workspace_paths.js";
import { locateFileReference } from "./message_annotations.js";

const ACTION_TABLE_SQL = `CREATE TABLE IF NOT EXISTS workspace_action_records (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  target_item_id TEXT,
  action_type TEXT NOT NULL,
  status TEXT NOT NULL,
  before_diff_hash TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

function decodeDiffPath(value) {
  const raw = String(value || "").trim();
  if (!raw || raw === "/dev/null") return "";
  let decoded = raw;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { decoded = JSON.parse(raw); } catch { decoded = raw.slice(1, -1); }
  }
  return decoded.replace(/^[ab]\//, "");
}

export function diffPaths(diff) {
  const found = new Set();
  for (const line of String(diff || "").split("\n")) {
    const gitHeader = line.match(/^diff --git\s+a\/(.+)\s+b\/(.+)$/);
    if (gitHeader) {
      const previousPath = decodeDiffPath(`a/${gitHeader[1]}`);
      const nextPath = decodeDiffPath(`b/${gitHeader[2]}`);
      if (previousPath) found.add(previousPath);
      if (nextPath) found.add(nextPath);
    }
    const header = line.match(/^(?:---|\+\+\+)\s+(.+)$/);
    if (!header) continue;
    const filePath = decodeDiffPath(header[1]);
    if (filePath) found.add(filePath);
  }
  return [...found];
}

function patchForChange(change) {
  const diff = String(change?.diff || "");
  if (!diff.trim()) return "";
  if (/^(?:diff --git|---\s)/m.test(diff) && /^\+\+\+\s/m.test(diff)) return diff;
  const filePath = String(change?.path || "").trim().replace(/^\/+/, "");
  if (!filePath) return "";
  const kind = String(change?.kind || "").toLowerCase();
  const previousPath = kind.includes("add") || kind.includes("create") ? "/dev/null" : `a/${filePath}`;
  const nextPath = kind.includes("delete") || kind.includes("remove") ? "/dev/null" : `b/${filePath}`;
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- ${previousPath}`,
    `+++ ${nextPath}`,
    diff,
  ].join("\n");
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function validateWorkspacePath(cwd, relativePath) {
  const normalized = String(relativePath || "").trim();
  if (!normalized || normalized.includes("\0") || path.isAbsolute(normalized)) {
    throw new ApiError("更改包含无效文件路径，不能撤销", 409);
  }
  const resolvedRoot = await realpath(cwd);
  const candidate = path.resolve(resolvedRoot, normalized);
  if (!isInside(resolvedRoot, candidate)) throw new ApiError("更改超出当前工作区，不能撤销", 409);

  let probe = candidate;
  while (probe !== resolvedRoot) {
    try {
      const stat = await lstat(probe);
      if (stat.isSymbolicLink()) throw new ApiError("更改路径经过符号链接，不能安全撤销", 409);
      const resolvedProbe = await realpath(probe);
      if (!isInside(resolvedRoot, resolvedProbe)) throw new ApiError("更改路径指向工作区外部，不能撤销", 409);
      return normalized;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error?.code !== "ENOENT") throw new ApiError("无法验证更改路径，不能撤销", 409);
      probe = path.dirname(probe);
    }
  }
  return normalized;
}

function runGit(cwd, args, stdin = "") {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: Number(code ?? 1), stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function patchFromItems(items, targetItemId, turnDiff) {
  const fileItems = (Array.isArray(items) ? items : []).filter((item) => item?.type === "file_change");
  const target = targetItemId ? fileItems.find((item) => String(item.id) === targetItemId) : null;
  const selected = target || (fileItems.length === 1 ? fileItems[0] : null);
  const payload = parseJson(selected?.content, {});
  const changes = Array.isArray(payload?.changes) ? payload.changes : [];
  const itemPatch = changes
    .map(patchForChange)
    .filter((diff) => diff.trim())
    .join("\n");
  const rawPatch = itemPatch || String(payload?.patch || "") || String(turnDiff || "");
  return {
    patch: rawPatch.trim() ? (rawPatch.endsWith("\n") ? rawPatch : `${rawPatch}\n`) : "",
    targetItemId: selected?.id || targetItemId || null,
  };
}

async function ensureActionTable(ctx) {
  await ctx.query(ACTION_TABLE_SQL);
}

async function ownedSession(ctx, sessionId) {
  const session = await ctx.queryOne(
    `SELECT id, project_id FROM sessions
      WHERE id=$1 AND created_by=$2 AND deleted_at IS NULL LIMIT 1`,
    [sessionId, ctx.userId || ""],
  ).catch(() => null);
  if (!session) throw new ApiError("无权操作这个会话", 403);
  return session;
}

async function turnMessage(ctx, sessionId, turnId) {
  const rows = await ctx.query(
    `SELECT id, content_items, message_metadata FROM session_messages
      WHERE session_id=$1 AND role='assistant' AND deleted_at IS NULL
      ORDER BY sequence_number DESC, created_at DESC`,
    [sessionId],
  );
  for (const row of rows) {
    const metadata = parseJson(row.message_metadata, {});
    if (String(metadata?.turn_id || "") === String(turnId || "")) {
      return { ...row, metadata, items: parseJson(row.content_items, []) };
    }
  }
  throw new ApiError("找不到这轮任务的文件更改", 404);
}

async function resolveWorkspaceRoot(ctx, projectId, sessionId) {
  const sourceFolders = await loadProjectSourceFolders(ctx, projectId);
  const effectiveFolders = await effectiveProjectSourceFolders(
    ctx,
    projectId,
    sourceFolders.filter((folder) => folder.available),
  );
  return resolveWorkspace(projectId, sessionId, {
    sourceFolders: effectiveFolders,
  }).cwd;
}

async function currentGitDiff(cwd) {
  const repo = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (repo.code !== 0 || repo.stdout.trim() !== "true") return { supported: false, diff: "" };
  let tracked = await runGit(cwd, ["diff", "--binary", "HEAD", "--", "."]);
  if (tracked.code !== 0) tracked = await runGit(cwd, ["diff", "--binary", "--", "."]);
  let diff = tracked.code === 0 ? tracked.stdout : "";
  const status = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (status.code === 0) {
    const untracked = status.stdout.split("\0")
      .filter((entry) => entry.startsWith("?? "))
      .map((entry) => entry.slice(3))
      .filter(Boolean)
      .slice(0, 200);
    for (const relativePath of untracked) {
      try { await validateWorkspacePath(cwd, relativePath); } catch { continue; }
      const fileStat = await lstat(path.resolve(cwd, relativePath)).catch(() => null);
      if (!fileStat?.isFile() || fileStat.size > 5 * 1024 * 1024) continue;
      const created = await runGit(cwd, ["diff", "--no-index", "--binary", "--", "/dev/null", relativePath]);
      if ((created.code === 0 || created.code === 1) && created.stdout) diff += `${diff.endsWith("\n") || !diff ? "" : "\n"}${created.stdout}`;
    }
  }
  return { supported: true, diff };
}

export async function getCurrentWorkspaceDiff(ctx, input) {
  const { threadId: sessionId } = input.params || {};
  const session = await ownedSession(ctx, sessionId);
  const cwd = await resolveWorkspaceRoot(ctx, session.project_id, sessionId);
  const current = await currentGitDiff(cwd);
  return {
    data: {
      supported: current.supported,
      diff: current.diff,
      diffHash: sha256(current.diff),
      workspaceRoot: cwd,
      updatedAt: new Date().toISOString(),
    },
    message: current.supported ? "已读取当前工作区更改" : "当前工作区没有 Git 差异视图",
  };
}

export async function resolveFileReference(ctx, input) {
  const { threadId: sessionId } = input.params || {};
  const session = await ownedSession(ctx, sessionId);
  const cwd = await resolveWorkspaceRoot(ctx, session.project_id, sessionId);
  const target = input.body && typeof input.body === "object" ? input.body : {};
  const resolved = await locateFileReference(cwd, target);
  if (!resolved) throw new ApiError("引用的文件已经不存在或无法唯一定位", 404);
  return {
    data: resolved,
    message: "文件引用已定位",
  };
}

async function existingAction(ctx, requestId) {
  if (!requestId) return null;
  return ctx.queryOne(
    `SELECT status, result_json, error_code, error_message FROM workspace_action_records
      WHERE request_id=$1 LIMIT 1`,
    [requestId],
  ).catch(() => null);
}

function replayAction(record) {
  if (!record) return null;
  if (record.status === "succeeded") return { data: parseJson(record.result_json, {}), message: "更改已经撤销" };
  if (record.status === "failed") throw new ApiError(record.error_message || "撤销失败", 409);
  throw new ApiError("撤销正在处理中", 409);
}

async function recordFailure(ctx, requestId, code, message) {
  await ctx.query(
    `UPDATE workspace_action_records
        SET status='failed', error_code=$2, error_message=$3, updated_at=now()
      WHERE request_id=$1`,
    [requestId, code, message],
  ).catch(() => null);
}

async function persistMessageAction(ctx, message, action) {
  const latest = await ctx.queryOne(
    "SELECT message_metadata FROM session_messages WHERE id=$1 AND deleted_at IS NULL LIMIT 1",
    [message.id],
  ).catch(() => null);
  const latestMetadata = parseJson(latest?.message_metadata, message.metadata || {});
  const metadata = {
    ...latestMetadata,
    workspace_actions: {
      ...(latestMetadata?.workspace_actions || {}),
      [action.targetItemId || action.turnId]: action,
    },
  };
  await ctx.query(
    "UPDATE session_messages SET message_metadata=$1, updated_at=now() WHERE id=$2",
    [JSON.stringify(metadata), message.id],
  );
}

export async function revertWorkspaceChange(ctx, input) {
  const { threadId: sessionId, turnId } = input.params || {};
  const body = input.body || {};
  const requestId = String(body.requestId || "").trim();
  const targetItemId = String(body.targetItemId || "").trim() || null;
  if (!requestId) throw new ApiError("缺少撤销请求编号", 400);
  if (body.action !== "revert_file_change") throw new ApiError("不支持这个工作区操作", 400);

  await ensureActionTable(ctx);
  const replay = await existingAction(ctx, requestId);
  if (replay) return replayAction(replay);

  const session = await ownedSession(ctx, sessionId);
  const message = await turnMessage(ctx, sessionId, turnId);
  const { patch, targetItemId: resolvedTargetItemId } = patchFromItems(
    message.items,
    targetItemId,
    message.metadata?.turn_diff,
  );
  if (!patch) throw new ApiError("这轮任务没有可撤销的文件补丁", 409);
  const diffHash = sha256(patch);
  const expectedHash = String(body.expectedTurnDiffHash || "").trim();
  if (expectedHash && expectedHash !== diffHash) throw new ApiError("更改内容已经更新，请重新打开审核面板", 409);

  try {
    await ctx.query(
      `INSERT INTO workspace_action_records
        (id,request_id,session_id,project_id,turn_id,target_item_id,action_type,status,before_diff_hash,actor_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'revert_file_change','running',$7,$8,now(),now())`,
      [randomUUID(), requestId, sessionId, session.project_id, turnId, resolvedTargetItemId, diffHash, ctx.userId || ""],
    );
  } catch (error) {
    const raced = await existingAction(ctx, requestId);
    if (raced) return replayAction(raced);
    throw error;
  }

  try {
    const cwd = await resolveWorkspaceRoot(ctx, session.project_id, sessionId);
    const paths = diffPaths(patch);
    if (!paths.length) throw new ApiError("文件补丁格式不完整，不能安全撤销", 409);
    await Promise.all(paths.map((filePath) => validateWorkspacePath(cwd, filePath)));

    const check = await runGit(cwd, ["apply", "--reverse", "--check", "--binary", "--recount", "--whitespace=nowarn", "-"], patch);
    if (check.code !== 0) {
      console.warn("[workspace action] reverse check rejected", String(check.stderr || "").trim().slice(0, 500));
      throw new ApiError("当前文件与这次更改已经不一致，请先审核最新内容", 409);
    }
    const applied = await runGit(cwd, ["apply", "--reverse", "--binary", "--recount", "--whitespace=nowarn", "-"], patch);
    if (applied.code !== 0) throw new ApiError("撤销没有完成，文件未被修改", 409);

    const workspaceDiff = await currentGitDiff(cwd);
    const result = {
      requestId,
      action: "revert_file_change",
      status: "succeeded",
      sessionId,
      turnId,
      targetItemId: resolvedTargetItemId,
      revertedPaths: paths,
      currentDiff: workspaceDiff.supported ? workspaceDiff.diff : null,
      workspaceRoot: cwd,
      completedAt: new Date().toISOString(),
    };
    await ctx.query(
      `UPDATE workspace_action_records SET status='succeeded', result_json=$2, updated_at=now()
        WHERE request_id=$1`,
      [requestId, JSON.stringify(result)],
    );
    await persistMessageAction(ctx, message, result);
    return { data: result, message: "已撤销这次文件更改" };
  } catch (error) {
    const messageText = error?.message || "撤销失败";
    await recordFailure(ctx, requestId, error instanceof ApiError ? "WORKSPACE_CONFLICT" : "WORKSPACE_ACTION_FAILED", messageText);
    if (error instanceof ApiError) throw error;
    throw new ApiError("撤销失败，文件未被修改", 409);
  }
}

const MAX_EDITABLE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_EDITABLE_LINE_BYTES = 100 * 1024;

/**
 * Apply a line-level edit edited from the diff review panel.
 *
 * Reads the target file, replaces a single line identified by `lineNumber`
 * (1-based, new-file numbering) with `newLineText`, and writes it back.
 * Conflict detection uses `expectedWorkspaceDiffHash` (SHA-256 of the current
 * workspace diff the editor rendered) so concurrent edits are rejected,
 * mirroring the revert path. The hash is over the workspace diff text, not
 * the raw file content — that is what the renderer can observe.
 *
 * Does NOT go through codex — this is a dsh-side direct file write, like
 * the revert path uses direct `git apply`.
 */
export async function applyWorkspaceEdit(ctx, input) {
  const { threadId: sessionId } = input.params || {};
  const body = input.body || {};
  const requestId = String(body.requestId || "").trim();
  const filePath = String(body.path || "").trim();
  const lineNumber = Math.floor(Number(body.lineNumber) || 0);
  const newLineText = String(body.newLineText ?? "");
  const expectedHash = String(body.expectedWorkspaceDiffHash || body.expectedContentHash || "").trim();
  if (!requestId) throw new ApiError("缺少编辑请求编号", 400);
  if (body.action !== "apply_edit") throw new ApiError("不支持这个工作区操作", 400);
  if (!filePath) throw new ApiError("缺少文件路径", 400);
  if (lineNumber < 1) throw new ApiError("行号不合法", 400);
  if (newLineText.length > MAX_EDITABLE_LINE_BYTES) {
    throw new ApiError(`单行内容不能超过 ${MAX_EDITABLE_LINE_BYTES} 字符`, 400);
  }

  await ensureActionTable(ctx);
  const replay = await existingAction(ctx, requestId);
  if (replay) return replayAction(replay);

  const session = await ownedSession(ctx, sessionId);

  try {
    await ctx.query(
      `INSERT INTO workspace_action_records
        (id,request_id,session_id,project_id,turn_id,target_item_id,action_type,status,before_diff_hash,actor_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'apply_edit','running',$7,$8,now(),now())`,
      [randomUUID(), requestId, sessionId, session.project_id, "", filePath, expectedHash, ctx.userId || ""],
    );
  } catch (error) {
    const raced = await existingAction(ctx, requestId);
    if (raced) return replayAction(raced);
    throw error;
  }

  try {
    const cwd = await resolveWorkspaceRoot(ctx, session.project_id, sessionId);
    await validateWorkspacePath(cwd, filePath);
    const absolutePath = path.resolve(await realpath(cwd), filePath);

    // Conflict check: compare the workspace diff the editor rendered (what the
    // renderer can observe) against the current workspace diff. A stale view is
    // rejected before any write happens.
    const beforeDiff = await currentGitDiff(cwd);
    if (expectedHash) {
      const beforeDiffHash = sha256(beforeDiff.diff);
      if (expectedHash !== beforeDiffHash) {
        throw new ApiError("更改已经更新，请重新打开审核面板", 409);
      }
    }

    let content;
    try {
      content = await readFile(absolutePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") throw new ApiError("文件不存在，可能已经被删除", 409);
      throw new ApiError("无法读取这个文件", 409);
    }
    if (Buffer.byteLength(content, "utf8") > MAX_EDITABLE_FILE_BYTES) {
      throw new ApiError("文件过大，暂不支持行级编辑（上限 2 MB）", 409);
    }

    // Preserve CRLF line endings: detect from the first line, strip only on
    // the edited line, and re-add before writing. Editing a CRLF file must not
    // silently mix line endings across the whole file.
    const crlf = content.includes("\r\n");
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    // lineNumber is 1-based; trailing-newline files end with "" which split produces
    // as a final element — editing it is a no-op at worst.
    if (lineNumber > lines.length) {
      throw new ApiError("行号超出文件范围，文件可能已经被修改", 409);
    }
    const oldLineText = lines[lineNumber - 1];
    if (oldLineText === newLineText) {
      throw new ApiError("这一行内容没有变化", 409);
    }
    lines[lineNumber - 1] = newLineText;
    let updatedContent = lines.join("\n");
    if (crlf) updatedContent = updatedContent.replace(/\n/g, "\r\n");

    await writeFile(absolutePath, updatedContent, "utf8");

    const workspaceDiff = await currentGitDiff(cwd);
    const result = {
      requestId,
      action: "apply_edit",
      status: "succeeded",
      sessionId,
      path: filePath,
      lineNumber,
      oldLineText,
      newLineText,
      currentDiff: workspaceDiff.supported ? workspaceDiff.diff : null,
      workspaceDiffHash: sha256(workspaceDiff.diff),
      workspaceRoot: cwd,
      completedAt: new Date().toISOString(),
    };
    await ctx.query(
      `UPDATE workspace_action_records SET status='succeeded', result_json=$2, updated_at=now()
        WHERE request_id=$1`,
      [requestId, JSON.stringify(result)],
    );
    return { data: result, message: "已应用行级编辑" };
  } catch (error) {
    const messageText = error?.message || "编辑失败";
    await recordFailure(
      ctx,
      requestId,
      error instanceof ApiError ? "WORKSPACE_CONFLICT" : "WORKSPACE_ACTION_FAILED",
      messageText,
    );
    if (error instanceof ApiError) throw error;
    throw new ApiError("编辑失败，文件未被修改", 409);
  }
}

export default { getCurrentWorkspaceDiff, revertWorkspaceChange, resolveFileReference, applyWorkspaceEdit };
