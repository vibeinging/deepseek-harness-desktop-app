// L1 use-case layer for session and message operations (including sharing), aligned line by line with routes/session_actions.js.
// Signature always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
import { randomUUID, randomBytes } from "crypto";
import { existsSync, mkdirSync, readdirSync, copyFileSync, lstatSync, rmSync } from "node:fs";
import { lstat, realpath, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ApiError } from "../../errors.js";
import { dataPath } from "../../config/paths.js";
import { IntermediateStorageService } from "../../engine/datasources/intermediate_storage_service.js";
import { activeRunSnapshot, stopActiveRun } from "../../engine/agents/active_run_registry.js";
import { removeRunnerRunDirectory } from "../../engine/runner/run_paths.js";
import { purgeSessionCanvases } from "../../engine/agents/canvas_store.js";
import {
  archiveDshSessionBeforeDelete,
  assertDshSessionCanMove,
  syncDshSessionUpdate,
} from "../../engine/dsh_runtime/session_lifecycle.js";
import { getDshRuntimeClient } from "../../engine/dsh_runtime/client.js";
import { ensureDshWorkspaceSession } from "../../engine/dsh_runtime/session_attachment.js";
import { saveDshSessionBinding } from "../../engine/dsh_runtime/session_binding.js";
import { disposeTemporaryDshRuntime } from "../../engine/dsh_runtime/temporary_runtime.js";
import { workspaceRoot } from "../../engine/agents/message_annotations.js";
import { requireProjectMember } from "../projects/access.js";

// ─────────────────────────────────────────────
// Helper: reshape session row into frontend-facing format
// ─────────────────────────────────────────────
function sessionShape(s) {
  let config = {};
  try {
    config = typeof s.session_config === "string" ? JSON.parse(s.session_config) : (s.session_config || {});
  } catch {
    config = {};
  }
  return {
    id: s.id,
    project_id: s.project_id,
    title: s.title,
    description: s.description,
    source_type: s.source_type,
    source_id: s.source_id,
    action_type: s.action_type,
    status: s.status,
    created_by: s.created_by,
    message_count: s.message_count,
    session_config: s.session_config,
    session_summary: s.session_summary,
    temporary: s.action_type === "temporary_chat" || config.temporary === true,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

// ─────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────
function shareShape(share) {
  const snapshot =
    typeof share.snapshot === "string"
      ? (() => { try { return JSON.parse(share.snapshot); } catch { return {}; } })()
      : (share.snapshot || {});
  const messages = snapshot.messages || [];
  return {
    share_token: share.share_token,
    share_path: `/share/${share.share_token}`,
    is_active: share.is_active,
    view_count: share.view_count,
    message_ids: messages.map((m) => m.id).filter(Boolean),
    created_at: share.created_at,
    updated_at: share.updated_at,
  };
}

function generateToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function chatWorkspaceDir(sessionId) {
  return dataPath("projects", "__chat__", String(sessionId));
}

function projectWorkspaceDir(projectId) {
  return dataPath("projects", String(projectId));
}

function isInsidePath(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function removeTemporaryChatWorkspace(sessionId) {
  const requestedRoot = resolve(dataPath("projects", "__chat__"));
  const root = await realpath(requestedRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!root) return { removed: false, missing: true };
  const target = resolve(root, String(sessionId || ""));
  if (!sessionId || target === root || !isInsidePath(target, root)) {
    throw new ApiError("临时对话目录不合法", 400);
  }
  const entry = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!entry) return { removed: false, missing: true };
  if (entry.isSymbolicLink()) throw new ApiError("拒绝清理符号链接临时目录", 409);
  const canonicalTarget = await realpath(target);
  if (!isInsidePath(canonicalTarget, root)) throw new ApiError("临时对话目录越界", 409);
  await rm(canonicalTarget, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  return { removed: true, missing: false };
}

async function quietQuery(ctx, sql, params = []) {
  return ctx.query(sql, params).catch(() => []);
}

async function purgeTemporarySession(ctx, session, { force = false } = {}) {
  const sessionId = String(session?.id || "").trim();
  if (!sessionId || session?.action_type !== "temporary_chat") return { purged: false, run_count: 0 };

  const runs = await quietQuery(ctx, "SELECT id, turn_id FROM agent_runs WHERE session_id=$1", [sessionId]);
  const runIds = [...new Set(runs.map((row) => String(row.id || "").trim()).filter(Boolean))];
  const activeTurns = runs
    .map((row) => String(row.turn_id || row.id || "").trim())
    .filter((turnId) => turnId && activeRunSnapshot(turnId));
  if (activeTurns.length && !force) throw new ApiError("临时对话仍在运行，请先停止任务", 409);
  if (force) {
    for (const turnId of activeTurns) await stopActiveRun(turnId, "temporary_session_cleanup").catch(() => null);
  }
  await disposeTemporaryDshRuntime(sessionId);
  await purgeSessionCanvases(ctx, { userId: ctx.userId, sessionId });
  await quietQuery(ctx, "DELETE FROM query_executions WHERE session_id=$1", [sessionId]);

  for (const runId of runIds) {
    await removeRunnerRunDirectory(runId).catch(() => null);
    for (const table of [
      "agent_pending_inputs",
      "agent_run_events",
      "agent_tool_calls",
      "agent_artifacts",
      "agent_evidence_bundles",
    ]) {
      await quietQuery(ctx, `DELETE FROM ${table} WHERE run_id=$1`, [runId]);
    }
    await quietQuery(ctx, "DELETE FROM agent_subtask_runs WHERE run_id=$1 OR parent_run_id=$1", [runId]);
  }

  for (const table of [
    "agent_pending_inputs",
    "agent_subtask_runs",
    "agent_evidence_bundles",
    "llm_call_logs",
    "message_feedbacks",
    "session_messages",
    "workspace_action_records",
    "session_shares",
    "tasks",
    "analysis_plan_steps",
    "session_intermediate_tables",
  ]) {
    await quietQuery(ctx, `DELETE FROM ${table} WHERE session_id=$1`, [sessionId]);
  }
  await quietQuery(ctx, "DELETE FROM agent_runs WHERE session_id=$1", [sessionId]);
  await quietQuery(ctx, "DELETE FROM sessions WHERE id=$1", [sessionId]);
  if (session.project_id === "__chat__") await removeTemporaryChatWorkspace(sessionId).catch(() => null);
  return { purged: true, run_count: runIds.length };
}

function uniqueTargetPath(dir, name) {
  const target = join(dir, name);
  if (!existsSync(target)) return target;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(dir, `${name}.${stamp}`);
}

function copyWorkspaceContents(fromDir, toDir) {
  const result = { copied_files: 0, copied_dirs: 0, skipped_files: 0 };
  if (!existsSync(fromDir)) {
    return { report: { ...result, source_exists: false }, rollback: () => {} };
  }
  mkdirSync(toDir, { recursive: true });
  const createdRoots = [];

  const copyEntry = (src, destParent, cleanupRoot = null) => {
    const stat = lstatSync(src);
    const dest = uniqueTargetPath(destParent, basename(src));
    const root = cleanupRoot || dest;
    if (!cleanupRoot) createdRoots.push(root);
    if (stat.isSymbolicLink()) {
      result.skipped_files += 1;
      return;
    }
    if (stat.isDirectory()) {
      mkdirSync(dest, { recursive: true });
      result.copied_dirs += 1;
      for (const child of readdirSync(src)) copyEntry(join(src, child), dest, root);
      return;
    }
    if (stat.isFile()) {
      copyFileSync(src, dest);
      result.copied_files += 1;
    }
  };

  try {
    for (const entry of readdirSync(fromDir)) copyEntry(join(fromDir, entry), toDir);
  } catch (error) {
    for (const path of [...createdRoots].reverse()) rmSync(path, { recursive: true, force: true });
    throw error;
  }
  return {
    report: { ...result, source_exists: true },
    rollback: () => {
      for (const path of [...createdRoots].reverse()) rmSync(path, { recursive: true, force: true });
    },
  };
}

async function targetProjectForUser(ctx, projectId) {
  return ctx.queryOne(
    `SELECT p.id, p.name
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id AND pm.user_id=$2 AND pm.deleted_at IS NULL
      WHERE p.id=$1 AND p.deleted_at IS NULL
      LIMIT 1`,
    [projectId, ctx.userId],
  );
}

async function updateSessionScopedProjectIds(ctx, sessionId, projectId) {
  const tables = [
    "agent_runs",
    "agent_pending_inputs",
    "llm_call_logs",
    "message_feedbacks",
    "session_shares",
    "tasks",
  ];
  for (const table of tables) {
    await ctx.query(
      `UPDATE ${table} SET project_id=$1, updated_at=now() WHERE session_id=$2 AND (deleted_at IS NULL OR deleted_at='')`,
      [projectId, sessionId],
    ).catch(() => null);
  }
}

async function setSessionAutoApplyMemoryFlag(sessionId, enabled) {
  const mod = await import("../../engine/semantic/disambiguation_service.js");
  return mod.set_session_auto_apply_memory(sessionId, enabled);
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions/:sid/memory/auto_apply
// Session-level auto-apply memory switch:
// enabled=true makes align_value memory hits happen automatically for this session.
// It short-circuits ask_user; false restores ask_user each time.
// State is persisted via setSessionAutoApplyMemoryFlag (local SQLite); desktop local restart retains it.
// ─────────────────────────────────────────────
export async function setSessionAutoApplyMemory(ctx, input) {
  const { pid, sid } = input.params;
  const { enabled } = input.body || {};
  if (typeof enabled !== "boolean") throw new ApiError("enabled 必须为布尔值", 400);

  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  await setSessionAutoApplyMemoryFlag(sid, enabled);
  return {
    data: { session_id: sid, enabled },
    message: enabled ? "已开启本会话自动使用记忆" : "已关闭本会话自动使用记忆",
  };
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions — create session
// GET exists in index.js; this POST fills in the mutation endpoint
// ─────────────────────────────────────────────
export async function createSession(ctx, input) {
  const { pid } = input.params;
  await requireProjectMember(ctx, pid, { allowChat: true });
  const {
    title = "新建对话",
    source_type,
    source_id,
    action_type = null,
    description = null,
    skill_names = null,
    report_template_id = null,
    temporary = false,
  } = input.body || {};

  if (!source_type || !source_id) {
    throw new ApiError("source_type 和 source_id 为必填项", 400);
  }

  const id = randomUUID();
  let session_config = null;
  const configObj = {};
  const isTemporary = temporary === true;
  const resolvedActionType = isTemporary ? "temporary_chat" : action_type;
  if (skill_names && skill_names.length) configObj.skill_names = skill_names;
  if (resolvedActionType === "report" && report_template_id) configObj.report_template_id = report_template_id;
  if (isTemporary) configObj.temporary = true;
  if (Object.keys(configObj).length) session_config = JSON.stringify(configObj);

  await ctx.query(
    `INSERT INTO sessions
       (id, project_id, created_by, title, description, source_type, source_id,
        action_type, status, message_count, session_config, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',0,$9,now(),now())`,
    [id, pid, ctx.userId, title, description, source_type, source_id, resolvedActionType, session_config],
  );

  if (!isTemporary) {
    const client = getDshRuntimeClient();
    let dshSessionId = "";
    try {
      const cwd = await workspaceRoot(ctx, pid, id);
      await client.start();
      const attached = await ensureDshWorkspaceSession(client, { cwd });
      dshSessionId = attached.sessionId;
      if (String(title || "").trim()) {
        await client.request("session.rename", { sessionId: dshSessionId, title: String(title).trim() });
      }
      const binding = await saveDshSessionBinding(ctx, {
        appSessionId: id,
        dshSessionId,
        cwd,
        projectId: pid,
        userId: ctx.userId,
      });
      client.registerProductHostSession({
        db: ctx,
        userId: binding.userId,
        projectId: binding.projectId,
        appSessionId: binding.appSessionId,
        dshSessionId: binding.dshSessionId,
      });
    } catch (error) {
      if (dshSessionId) {
        await client.request("workspace.archiveSession", { sessionId: dshSessionId }).catch(() => null);
        client.unregisterProductHostSession(dshSessionId);
      }
      await ctx.query("DELETE FROM sessions WHERE id=$1", [id]).catch(() => null);
      throw new ApiError(`无法创建 DSH 会话：${error?.message || String(error)}`, 503);
    }
  }

  const s = await ctx.queryOne(
    `SELECT id, project_id, title, description, source_type, source_id, action_type,
            status, created_by, message_count, session_config, session_summary, created_at, updated_at
       FROM sessions WHERE id=$1`,
    [id],
  );

  return { data: sessionShape(s), message: "创建会话成功" };
}

// ─────────────────────────────────────────────
// PUT /api/projects/:pid/sessions/:sid — rename or update a session
// ─────────────────────────────────────────────
export async function updateSession(ctx, input) {
  const { pid, sid } = input.params;
  const { title, description, status } = input.body || {};

  if (status !== undefined && !["active", "archived"].includes(status)) {
    throw new ApiError("会话状态不合法", 400);
  }

  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  await syncDshSessionUpdate(ctx, sid, { title, status });

  const setClauses = ["updated_at=now()"];
  const params = [];
  let idx = 1;
  if (title !== undefined)       { setClauses.push(`title=$${idx}`);       params.push(title);       idx++; }
  if (description !== undefined) { setClauses.push(`description=$${idx}`); params.push(description); idx++; }
  if (status !== undefined)      { setClauses.push(`status=$${idx}`);      params.push(status);      idx++; }

  params.push(sid);
  await ctx.query(
    `UPDATE sessions SET ${setClauses.join(",")} WHERE id=$${idx}`,
    params,
  );

  const updated = await ctx.queryOne(
    `SELECT id, project_id, title, description, source_type, source_id, action_type,
            status, created_by, message_count, session_config, session_summary, created_at, updated_at
       FROM sessions WHERE id=$1`,
    [sid],
  );
  return { data: sessionShape(updated), message: "更新会话成功" };
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions/:sid/move — move a normal chat into another project.
// ─────────────────────────────────────────────
export async function moveSession(ctx, input) {
  const { pid, sid } = input.params;
  const targetProjectId = String(input.body?.target_project_id || input.body?.project_id || "").trim();
  if (!targetProjectId) throw new ApiError("target_project_id 为必填项", 400);
  if (targetProjectId === pid) {
    const existing = await ctx.queryOne(
      `SELECT id, project_id, title, description, source_type, source_id, action_type,
              status, created_by, message_count, session_config, session_summary, created_at, updated_at
         FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
      [sid, pid, ctx.userId],
    );
    if (!existing) throw new ApiError("会话不存在或无权限", 404);
    return { data: { session: sessionShape(existing), migrated: false, workspace: null }, message: "会话已在目标项目中" };
  }

  const target = await targetProjectForUser(ctx, targetProjectId);
  if (!target) throw new ApiError("目标项目不存在或无权限", 404);

  const session = await ctx.queryOne(
    `SELECT id, project_id, title, description, source_type, source_id, action_type,
            status, created_by, message_count, session_config, session_summary, created_at, updated_at
       FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!session) throw new ApiError("会话不存在或无权限", 404);
  if (session.action_type && session.action_type !== "agentic_chat") {
    throw new ApiError("仅支持迁移 Agent 对话会话", 400);
  }
  await assertDshSessionCanMove(ctx, sid);

  const activeRun = await ctx.queryOne(
    `SELECT id FROM agent_runs
      WHERE session_id=$1 AND status IN
        ('pending','queued','running','suspended','waiting_approval','waiting_user_input','recovering')
      LIMIT 1`,
    [sid],
  ).catch(() => null);
  if (activeRun) throw new ApiError("对话仍有任务在运行，请停止后再移动", 409);

  let sessionConfig = {};
  try {
    sessionConfig = typeof session.session_config === "string"
      ? JSON.parse(session.session_config)
      : (session.session_config || {});
  } catch {
    sessionConfig = {};
  }
  const sourceThreadId = String(sessionConfig.agent_runtime_thread_id || "").trim();
  delete sessionConfig.agent_runtime_thread_id;
  if (sourceThreadId) {
    sessionConfig.agent_runtime_native_move = {
      id: randomUUID(),
      source_thread_id: sourceThreadId,
      from_project_id: pid,
      target_project_id: targetProjectId,
      requested_at: new Date().toISOString(),
    };
  } else {
    delete sessionConfig.agent_runtime_native_move;
  }

  let workspace = null;
  let workspaceTransfer = null;
  if (pid === "__chat__") {
    try {
      workspaceTransfer = copyWorkspaceContents(chatWorkspaceDir(sid), projectWorkspaceDir(targetProjectId));
      workspace = workspaceTransfer.report;
    } catch (error) {
      throw new ApiError(`移动前复制对话文件失败：${error?.message || error}`, 500);
    }
  }

  try {
    await ctx.query(
      `UPDATE sessions
          SET project_id=$1, source_type='agent', source_id=$1, session_config=$3, updated_at=now()
        WHERE id=$2`,
      [targetProjectId, sid, JSON.stringify(sessionConfig)],
    );
  } catch (error) {
    workspaceTransfer?.rollback?.();
    throw error;
  }
  await updateSessionScopedProjectIds(ctx, sid, targetProjectId);
  const updated = await ctx.queryOne(
    `SELECT id, project_id, title, description, source_type, source_id, action_type,
            status, created_by, message_count, session_config, session_summary, created_at, updated_at
       FROM sessions WHERE id=$1`,
    [sid],
  );
  return {
    data: {
      session: sessionShape(updated),
      migrated: true,
      from_project_id: pid,
      target_project_id: targetProjectId,
      workspace,
      native_thread_fork_pending: Boolean(sourceThreadId),
    },
    message: "对话已移到项目",
  };
}

// ─────────────────────────────────────────────
// DELETE /api/projects/:pid/sessions/:sid — delete session (soft delete)
// ─────────────────────────────────────────────
export async function deleteSession(ctx, input) {
  const { pid, sid } = input.params;
  const s = await ctx.queryOne(
    `SELECT id, project_id, action_type FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  if (s.action_type === "temporary_chat") {
    const purged = await purgeTemporarySession(ctx, s);
    return { data: { temporary: true, ...purged }, message: "临时对话已清理" };
  }

  await archiveDshSessionBeforeDelete(ctx, sid);

  await ctx.query(
    `UPDATE sessions SET deleted_at=now(), deleted_by=$1 WHERE id=$2`,
    [ctx.userId, sid],
  );
  return { data: null, message: "会话删除成功" };
}

// POST /api/sessions/temporary/cleanup — remove temporary sessions left by an
// app crash or forced shutdown. The desktop calls this once during startup.
export async function cleanupTemporarySessions(ctx) {
  const rows = await ctx.query(
    `SELECT id, project_id, action_type FROM sessions
      WHERE created_by=$1 AND action_type='temporary_chat'`,
    [ctx.userId],
  ).catch(() => []);
  let runCount = 0;
  for (const session of rows) {
    const result = await purgeTemporarySession(ctx, session, { force: true });
    runCount += Number(result.run_count || 0);
  }
  return {
    data: { cleaned_sessions: rows.length, cleaned_runs: runCount },
    message: rows.length ? "已清理上次未退出的临时对话" : "没有待清理的临时对话",
  };
}

// ─────────────────────────────────────────────
// DELETE /api/projects/:pid/sessions/:sid/messages/:mid — delete message (soft delete)
// ─────────────────────────────────────────────
export async function deleteMessage(ctx, input) {
  const { pid, sid, mid } = input.params;

  // Verify session ownership
  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  const msg = await ctx.queryOne(
    `SELECT id FROM session_messages WHERE id=$1 AND session_id=$2 AND deleted_at IS NULL`,
    [mid, sid],
  );
  if (!msg) throw new ApiError("消息不存在", 404);

  await ctx.query(
    `UPDATE session_messages SET deleted_at=now(), deleted_by=$1 WHERE id=$2`,
    [ctx.userId, mid],
  );
  return { data: null, message: "消息删除成功" };
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions/:sid/messages/:mid/feedback — submit/update feedback
// ─────────────────────────────────────────────
export async function createMessageFeedback(ctx, input) {
  const { pid, sid, mid } = input.params;
  const { feedback_type, feedback_reason = null } = input.body || {};

  if (!["like", "dislike"].includes(feedback_type)) {
    throw new ApiError("feedback_type 必须为 like 或 dislike", 400);
  }

  // Resolve message_id and support temporary streaming IDs
  let resolvedMid = mid;
  const msgCheck = await ctx.queryOne(
    `SELECT id FROM session_messages WHERE id=$1 AND session_id=$2 AND deleted_at IS NULL`,
    [mid, sid],
  );
  if (!msgCheck) {
    if (typeof mid === "string" && mid.startsWith("streaming-")) {
      // fallback to the latest assistant message
      const fallback = await ctx.queryOne(
        `SELECT id FROM session_messages WHERE session_id=$1 AND role='assistant' AND deleted_at IS NULL
         ORDER BY sequence_number DESC LIMIT 1`,
        [sid],
      );
      if (!fallback) throw new ApiError(`消息不存在或尚未持久化: ${mid}`, 400);
      resolvedMid = fallback.id;
    } else {
      throw new ApiError(`消息不存在或尚未持久化: ${mid}`, 400);
    }
  }

  // Find existing non-deleted feedback
  const existing = await ctx.queryOne(
    `SELECT id, feedback_type FROM message_feedbacks
      WHERE message_id=$1 AND user_id=$2 AND deleted_at IS NULL`,
    [resolvedMid, ctx.userId],
  );

  if (existing) {
    if (existing.feedback_type === feedback_type) {
      // Same feedback type cancels the previous one
      await ctx.query(
        `UPDATE message_feedbacks SET deleted_at=now(), deleted_by=$1 WHERE id=$2`,
        [ctx.userId, existing.id],
      );
      return { data: { action: "cancelled", feedback_type: null, message_id: resolvedMid }, message: "操作成功" };
    }
    // Switch feedback type
    await ctx.query(
      `UPDATE message_feedbacks SET feedback_type=$1, feedback_reason=$2, updated_at=now() WHERE id=$3`,
      [feedback_type, feedback_type === "dislike" ? feedback_reason : null, existing.id],
    );
    return { data: { action: "updated", feedback_type, id: existing.id, message_id: resolvedMid }, message: "操作成功" };
  }

  // Snapshot context (best effort)
  let userQuestion = "";
  let aiResponse = "";
  try {
    const aiMsg = await ctx.queryOne(
      `SELECT content_items, sequence_number FROM session_messages WHERE id=$1 AND deleted_at IS NULL`,
      [resolvedMid],
    );
    if (aiMsg) {
      const items = Array.isArray(aiMsg.content_items) ? aiMsg.content_items : [];
      const textTypes = new Set(["text", "markdown", "result"]);
      aiResponse = items
        .filter((i) => i && textTypes.has(i.type) && typeof i.content === "string")
        .map((i) => i.content)
        .join("\n")
        .slice(0, 2000);

      const userMsg = await ctx.queryOne(
        `SELECT content_items FROM session_messages
          WHERE session_id=$1 AND role='user' AND sequence_number<$2 AND deleted_at IS NULL
         ORDER BY sequence_number DESC LIMIT 1`,
        [sid, aiMsg.sequence_number],
      );
      if (userMsg) {
        const uItems = Array.isArray(userMsg.content_items) ? userMsg.content_items : [];
        const textItem = uItems.find((i) => i && i.type === "text" && typeof i.content === "string");
        if (textItem) userQuestion = textItem.content;
      }
    }
  } catch (_) { /* Snapshot failure does not block the response */ }

  const fbId = randomUUID();
  await ctx.query(
    `INSERT INTO message_feedbacks
       (id, message_id, session_id, project_id, user_id, feedback_type, feedback_reason,
        user_question, ai_response, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),now())`,
    [
      fbId, resolvedMid, sid, pid, ctx.userId, feedback_type,
      feedback_type === "dislike" ? feedback_reason : null,
      userQuestion, aiResponse,
    ],
  );
  return { data: { action: "created", feedback_type, id: fbId, message_id: resolvedMid }, message: "操作成功" };
}

// ─────────────────────────────────────────────
// GET /api/projects/:pid/sessions/:sid/share — get sharing status
// ─────────────────────────────────────────────
export async function getSessionShare(ctx, input) {
  const { sid } = input.params;
  const share = await ctx.queryOne(
    `SELECT id, share_token, is_active, view_count, snapshot, created_at, updated_at
       FROM session_shares
      WHERE session_id=$1 AND is_active=true AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [sid],
  );
  return { data: share ? shareShape(share) : null, message: "获取分享状态成功" };
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions/:sid/share — create or refresh sharing link
// ─────────────────────────────────────────────
export async function createSessionShare(ctx, input) {
  const { pid, sid } = input.params;
  const refresh = (input.query || {}).refresh === "true" || (input.query || {}).refresh === "1";
  const { message_ids = null } = input.body || {};

  // Verify session ownership
  const session = await ctx.queryOne(
    `SELECT id, project_id, title, description, source_type, action_type, created_at
       FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!session) throw new ApiError("会话不存在或无权限", 404);

  // Find active share record
  const existing = await ctx.queryOne(
    `SELECT id, share_token, is_active, view_count, snapshot, created_at, updated_at
       FROM session_shares
      WHERE session_id=$1 AND is_active=true AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [sid],
  );

  // Build snapshot (message list)
  const buildSnapshot = async () => {
    let msgRows = await ctx.query(
      `SELECT id, session_id, role, content_items, message_metadata, sequence_number,
              parent_message_id, reply_to_message_id, created_at, updated_at
         FROM session_messages WHERE session_id=$1 AND deleted_at IS NULL
        ORDER BY sequence_number ASC, created_at ASC`,
      [sid],
    );
    const messages = msgRows.map((m) => ({ ...m, timestamp: m.created_at }));
    const filtered = message_ids && message_ids.length
      ? messages.filter((m) => message_ids.includes(m.id))
      : messages;
    return {
      session: {
        id: session.id,
        title: session.title,
        description: session.description,
        source_type: session.source_type,
        action_type: session.action_type,
        created_at: session.created_at,
      },
      messages: filtered,
    };
  };

  // Reuse existing share when no refresh and no message_ids are provided
  if (existing && !refresh && !message_ids) {
    return { data: shareShape(existing), message: "创建分享成功" };
  }

  const snapshot = await buildSnapshot();

  if (existing) {
    // Refresh snapshot while keeping the same token
    await ctx.query(
      `UPDATE session_shares SET snapshot=$1, updated_at=now() WHERE id=$2`,
      [JSON.stringify(snapshot), existing.id],
    );
    const refreshed = await ctx.queryOne(
      `SELECT id, share_token, is_active, view_count, snapshot, created_at, updated_at
         FROM session_shares WHERE id=$1`,
      [existing.id],
    );
    return { data: shareShape(refreshed), message: "创建分享成功" };
  }

  // Create new share
  const newId = randomUUID();
  const token = generateToken(32);
  await ctx.query(
    `INSERT INTO session_shares
       (id, session_id, project_id, created_by, share_token, snapshot, is_active, view_count, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,true,0,now(),now())`,
    [newId, sid, pid, ctx.userId, token, JSON.stringify(snapshot)],
  );
  const created = await ctx.queryOne(
    `SELECT id, share_token, is_active, view_count, snapshot, created_at, updated_at
       FROM session_shares WHERE id=$1`,
    [newId],
  );
  return { data: shareShape(created), message: "创建分享成功" };
}

// ─────────────────────────────────────────────
// DELETE /api/projects/:pid/sessions/:sid/share — cancel sharing
// ─────────────────────────────────────────────
export async function deleteSessionShare(ctx, input) {
  const { pid, sid } = input.params;
  // Verify ownership
  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  await ctx.query(
    `UPDATE session_shares SET is_active=false, deleted_at=now(), deleted_by=$1
      WHERE session_id=$2 AND is_active=true AND deleted_at IS NULL`,
    [ctx.userId, sid],
  );
  return { data: null, message: "已取消分享" };
}

// ─────────────────────────────────────────────
// GET /api/public/v1/shared-sessions/:token — public read-only access without login
// Access by token only; increment view_count in queueMicrotask to avoid blocking response.
// ─────────────────────────────────────────────
export async function getSharedSession(ctx, input) {
  const { token } = input.params;
  const share = await ctx.queryOne(
    `SELECT id, snapshot, view_count, created_at
       FROM session_shares
      WHERE share_token=$1 AND is_active=true AND deleted_at IS NULL`,
    [token],
  );
  if (!share) {
    throw new ApiError("分享链接不存在或已失效", 404);
  }
  // Increase view count asynchronously; failure does not affect normal response.
  queueMicrotask(() => {
    ctx.query(
      `UPDATE session_shares SET view_count=view_count+1 WHERE id=$1`,
      [share.id],
    ).catch(() => {});
  });

  const snapshot = (typeof share.snapshot === "string"
    ? JSON.parse(share.snapshot)
    : share.snapshot) || {};

  return {
    data: {
      session: snapshot.session || {},
      messages: snapshot.messages || [],
      view_count: (share.view_count || 0) + 1,
      shared_at: share.created_at,
    },
    message: "操作成功",
  };
}

// ─────────────────────────────────────────────
// POST /api/projects/:pid/sessions/:sid/stop-task — stop running task
// ─────────────────────────────────────────────
export async function stopSessionTask(ctx, input) {
  const { pid, sid } = input.params;

  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  const task = await ctx.queryOne(
    `SELECT id FROM tasks WHERE session_id=$1 AND status IN ('pending','running') AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [sid],
  );
  if (!task) throw new ApiError("没有正在运行的任务", 400);

  await ctx.query(
    `UPDATE tasks SET status='cancelled', updated_at=now() WHERE id=$1`,
    [task.id],
  );
  return { data: null, message: "任务已停止" };
}

// ─────────────────────────────────────────────
// GET /api/projects/:pid/sessions/:sid/task-status — get task status
// ─────────────────────────────────────────────
export async function getSessionTaskStatus(ctx, input) {
  const { pid, sid } = input.params;

  const s = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在或无权限", 404);

  const task = await ctx.queryOne(
    `SELECT id, status, progress, error_message, created_at, updated_at
       FROM tasks WHERE session_id=$1 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [sid],
  );
  if (!task) {
    return { data: { has_task: false, status: null }, message: "无任务" };
  }
  return {
    data: {
      has_task: true,
      task_id: task.id,
      status: task.status,
      progress: task.progress,
      error_message: task.error_message,
      created_at: task.created_at,
      updated_at: task.updated_at,
    },
    message: "获取任务状态成功",
  };
}

// ─────────────────────────────────────────────
// POST .../intermediate-generate-description
// ─────────────────────────────────────────────
export async function generateIntermediateDescription(ctx, input) {
  const { pid, sid } = input.params;
  const session = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!session) throw new ApiError("会话不存在或无权限", 404);
  const duckdbPath = IntermediateStorageService.get_duckdb_path(pid, sid);
  const available = await IntermediateStorageService.list_tables(duckdbPath);
  const requested = Array.isArray(input.body?.selected_tables) && input.body.selected_tables.length
    ? new Set(input.body.selected_tables.map(String)) : null;
  const results = [];
  for (const table of available) {
    if (requested && !requested.has(String(table.table_name))) continue;
    const columns = await IntermediateStorageService.get_table_schema(duckdbPath, table.table_name);
    const columnText = columns.slice(0, 8).map((column) => `${column.name}(${column.type})`).join("、");
    const description = `${table.table_name}：${Number(table.row_count || 0)} 行，包含 ${columnText || "暂无列信息"}`;
    const indexed = await ctx.queryOne(
      `SELECT id FROM session_intermediate_tables WHERE session_id=$1 AND table_name=$2 AND deleted_at IS NULL`,
      [sid, table.table_name],
    );
    if (indexed) {
      await ctx.query(
        `UPDATE session_intermediate_tables SET description=$1, columns=$2, updated_at=now() WHERE id=$3`,
        [description, JSON.stringify(columns), indexed.id],
      );
    } else {
      await ctx.query(
        `INSERT INTO session_intermediate_tables
           (id, session_id, table_name, duckdb_path, description, row_count, column_count, columns,
            sub_query, sql_query, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())`,
        [randomUUID(), sid, table.table_name, duckdbPath, description, table.row_count, columns.length,
          JSON.stringify(columns), table.sub_query || "", table.sql_query || ""],
      );
    }
    results.push({ table_name: table.table_name, description, columns });
  }
  return { data: { items: results, total: results.length }, message: "中间结果描述已生成" };
}

// POST .../persist-intermediate — copy selected session tables into a project structured data source.
// ─────────────────────────────────────────────
export async function persistIntermediate(ctx, input) {
  const { pid, sid } = input.params;
  const session = await ctx.queryOne(
    `SELECT id, title FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!session) throw new ApiError("会话不存在或无权限", 404);
  const sourcePath = IntermediateStorageService.get_duckdb_path(pid, sid);
  const available = await IntermediateStorageService.list_tables(sourcePath);
  if (!available.length) throw new ApiError("当前会话没有可持久化的中间结果", 400);
  const selected = Array.isArray(input.body?.selected_tables) && input.body.selected_tables.length
    ? new Set(input.body.selected_tables.map(String)) : new Set(available.map((table) => String(table.table_name)));
  const targets = available.filter((table) => selected.has(String(table.table_name)));
  if (!targets.length) throw new ApiError("没有找到选中的中间表", 400);
  const unknown = [...selected].filter((name) => !available.some((table) => String(table.table_name) === name));
  if (unknown.length) throw new ApiError(`中间表不存在: ${unknown.join("、")}`, 400);

  const dataSourceId = randomUUID();
  const connectionId = randomUUID();
  const name = String(input.body?.name || `${session.title || "会话"}中间结果`).trim();
  const targetPath = dataPath("structured", `${dataSourceId}.duckdb`);
  const imported = [];
  for (const table of targets) {
    const records = await IntermediateStorageService.read_dataframe(sourcePath, table.table_name);
    if (!records) throw new ApiError(`读取中间表失败: ${table.table_name}`, 500);
    const columns = await IntermediateStorageService.get_table_schema(sourcePath, table.table_name);
    const write = await IntermediateStorageService.write_dataframe(
      targetPath, records, table.table_name, table.description || "",
      { sub_query: table.sub_query || "", sql_query: table.sql_query || "" },
    );
    imported.push({ ...write, columns });
  }
  await ctx.query(
    `INSERT INTO database_connections
       (id, project_id, created_by, name, db_type, is_virtual, host, database, description, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'DuckDB',true,$5,$5,$6,now(),now())`,
    [connectionId, pid, ctx.userId, name, targetPath, `从会话 ${sid} 持久化的中间结果`],
  );
  await ctx.query(
    `INSERT INTO structured_data_sources
       (id, project_id, created_by, name, description, folder_path, duckdb_path,
        database_connection_id, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6,$7,true,now(),now())`,
    [dataSourceId, pid, ctx.userId, name, input.body?.description || `来自会话 ${session.title || sid}`, targetPath, connectionId],
  );
  await ctx.query(
    `INSERT INTO business_data_sources (id, project_id, source_type, source_id, created_at, updated_at)
     VALUES ($1,$2,'structured_data_source',$3,now(),now())`,
    [randomUUID(), pid, dataSourceId],
  );
  for (const table of imported) {
    const tableId = randomUUID();
    await ctx.query(
      `INSERT INTO table_metadata
         (id, database_connection_id, schema_name, table_name, table_type, row_count, is_view, created_at, updated_at)
       VALUES ($1,$2,'main',$3,'BASE TABLE',$4,0,now(),now())`,
      [tableId, connectionId, table.table_name, table.row_count],
    );
    for (const column of table.columns) {
      await ctx.query(
        `INSERT INTO column_metadata (id, table_id, column_name, data_type, created_at, updated_at)
         VALUES ($1,$2,$3,$4,now(),now())`,
        [randomUUID(), tableId, column.name, column.type || null],
      );
    }
  }
  return {
    data: { id: dataSourceId, name, database_connection_id: connectionId, duckdb_path: targetPath, tables: imported },
    message: `已持久化 ${imported.length} 张中间表`,
  };
}
