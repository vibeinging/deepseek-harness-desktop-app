// L1 use-case layer for read-only session list/session detail/history messages/feedback status/intermediate tables.
// Copied from index.js GET handlers with line-by-line alignment.
// Signature is always async fn(ctx, input) -> { data, message }; throw ApiError on fail.
import { ApiError } from "../../errors.js";
import { IntermediateStorageService } from "../../engine/datasources/intermediate_storage_service.js";
import { listLivePendingInteractions } from "../chat/agent_misc.js";
import { dshRuntimeEnabled } from "../../engine/dsh_runtime/source_locator.js";
import { loadDshSessionBinding } from "../../engine/dsh_runtime/session_binding.js";
import { applyDshProjectionBaseline } from "../../engine/dsh_runtime/session_state.js";

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

// GET /api/projects/:pid/sessions — list sessions (exclude agentic_chat)
export async function listSessions(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, title, description, status, message_count, source_type, action_type,
            created_at, updated_at
       FROM sessions
      WHERE project_id=$1 AND created_by=$2 AND deleted_at IS NULL
        AND action_type IS DISTINCT FROM 'agentic_chat'
      ORDER BY updated_at DESC`,
    [input.params.pid, ctx.userId],
  );
  return { data: { items: rows, total: rows.length }, message: "获取会话列表成功" };
}

// GET /api/projects/:pid/sessions/:sid — session detail
export async function getSession(ctx, input) {
  const s = await ctx.queryOne(
    `SELECT id, project_id, title, description, status, message_count, source_type, action_type,
            session_config, session_summary, created_at, updated_at
       FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [input.params.sid, input.params.pid, ctx.userId],
  );
  if (!s) throw new ApiError("会话不存在", 404);
  return { data: s, message: "获取会话成功" };
}

// GET /api/projects/:pid/sessions/:sid/messages — history messages (frontend reads data.messages)
export async function listSessionMessages(ctx, input) {
  const { pid, sid } = input.params;
  const userId = String(ctx.userId || "").trim();
  const ownerParams = [sid, pid, userId];
  const ownedSession = typeof ctx.queryOne === "function"
    ? await ctx.queryOne(
      `SELECT id FROM sessions
        WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
        LIMIT 1`,
      ownerParams,
    )
    : (await ctx.query(
      `SELECT id FROM sessions
        WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
        LIMIT 1`,
      ownerParams,
    ))[0] || null;
  const rows = await ctx.query(
    `SELECT sm.id, sm.session_id, sm.role, sm.content_items, sm.message_metadata, sm.sequence_number,
            sm.parent_message_id, sm.reply_to_message_id, sm.created_at, sm.updated_at
       FROM session_messages sm
       JOIN sessions s ON s.id=sm.session_id
      WHERE sm.session_id=$1 AND s.project_id=$2 AND s.created_by=$3
        AND sm.deleted_at IS NULL AND s.deleted_at IS NULL
      ORDER BY sm.sequence_number ASC, sm.created_at ASC`,
    [sid, pid, userId],
  );
  // Frontend reads res.data.messages (not items); add timestamp per message.
  const messages = rows.map((m) => ({ ...m, timestamp: m.created_at }));
  const pendingInteractions = ownedSession
    ? listLivePendingInteractions({
      userId,
      projectId: pid,
      sessionId: sid,
    })
    : [];

  // A bound DSH session is the runtime-history authority. Fetch its complete
  // paged log and fold it through the same presenters as the live stream. The
  // local rows contribute only dsh-app product blocks that DSH does not own,
  // such as attachment and artifact cards. If DSH is unreachable, keep the
  // product projection visible but mark the response as degraded.
  let dshHistory = null;
  let dshHistoryError = null;
  try {
    dshHistory = await loadDshHistory(ctx, { sid, ownedSession });
  } catch (error) {
    dshHistoryError = error;
    console.error("[reads_session] DSH history load failed, serving the local product projection:", error?.message || error);
  }
  if (dshHistory) {
    return {
      data: {
        messages: mergeProductProjection(dshHistory.messages, messages),
        pending_interactions: pendingInteractions,
        dsh_recovery: true,
        dsh_last_seq: dshHistory.lastSeq,
        ...(dshHistory.planTodos ? { dsh_plan_todos: dshHistory.planTodos } : {}),
      },
      message: "获取消息成功",
    };
  }

  return {
    data: {
      messages,
      pending_interactions: pendingInteractions,
      ...(dshHistoryError ? {
        dsh_degraded: true,
        dsh_error: String(dshHistoryError?.message || dshHistoryError),
      } : {}),
    },
    message: "获取消息成功",
  };
}

/**
 * Attempt to load history from the DSH session bound to this dsh-app session.
 * Returns null (not an error) when there is no binding, DSH is disabled, or
 * the DSH runtime is not reachable — the caller falls back to session_messages.
 * @returns {Promise<{ messages: object[], lastSeq: number, planTodos: object[]|null } | null>}
 */
async function loadDshHistory(ctx, { sid, ownedSession }) {
  if (!dshRuntimeEnabled()) return null;
  if (!ownedSession) return null;
  const binding = await loadDshSessionBinding(ctx, sid);
  if (!binding) return null;
  // Bindings created before the stable-cwd contract keep their local product
  // history until the next prompt replaces the incompatible DSH Session.
  if (!binding.cwd) return null;
  // Lazy-import the DSH client + adapter to avoid loading the IPC stack when
  // DSH is never used (non-DSH sessions, tests).
  const { getDshRuntimeClient } = await import("../../engine/dsh_runtime/client.js");
  const { ensureDshWorkspaceSession } = await import("../../engine/dsh_runtime/session_attachment.js");
  const { dshEventsToMessages } = await import("../../engine/dsh_runtime/dsh_history_adapter.js");
  const client = getDshRuntimeClient();
  await client.start();
  try {
    await ensureDshWorkspaceSession(client, { sessionId: binding.dshSessionId, cwd: binding.cwd });
  } catch (error) {
    if (error?.code !== "session-conflict") throw error;
    throw new Error("DSH 会话工作目录冲突，拒绝加载错误项目的历史", { cause: error });
  }
  const history = await loadAllDshHistoryPages(client, binding);
  if (history.projections) applyDshProjectionBaseline(binding.dshSessionId, history.projections);
  const result = dshEventsToMessages({
    entries: history.entries,
    projections: history.projections,
    sessionId: binding.dshSessionId,
    appSessionId: sid,
  });
  if (result.title) {
    await ctx.query(
      "UPDATE sessions SET title=$1,updated_at=now() WHERE id=$2 AND deleted_at IS NULL",
      [result.title, sid],
    );
  }
  return { messages: result.messages, lastSeq: result.lastSeq, planTodos: result.planTodos, title: result.title };
}

export async function loadAllDshHistoryPages(client, binding) {
  const entries = [];
  let beforeSeq;
  let projections;
  let hasMore = true;
  while (hasMore) {
    const history = await client.request("session.history", {
      sessionId: binding.dshSessionId,
      maxMessages: 50,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    const page = Array.isArray(history?.events) ? history.events : [];
    if (beforeSeq === undefined) projections = history?.projections;
    if (page.length === 0) {
      if (history?.hasMore) throw new Error("DSH history 返回了空页但仍声明 hasMore");
      break;
    }
    entries.unshift(...page);
    hasMore = history?.hasMore === true;
    if (!hasMore) break;
    const firstSeq = page.reduce((minimum, entry) => {
      const seq = Number(entry?.event?.seq);
      return Number.isFinite(seq) ? Math.min(minimum, seq) : minimum;
    }, Number.POSITIVE_INFINITY);
    if (!Number.isFinite(firstSeq) || (beforeSeq !== undefined && firstSeq >= beforeSeq)) {
      throw new Error("DSH history 分页游标没有前进");
    }
    beforeSeq = firstSeq;
  }
  return { entries, projections };
}

const CORE_DSH_ITEM_TYPES = new Set([
  "text", "inputText", "agentMessage", "reasoning", "dynamicToolCall", "tool", "tool_result", "plan",
]);

export function mergeProductProjection(authoritativeMessages, productMessages) {
  const localByIdentity = new Map();
  for (const message of productMessages) {
    const role = String(message?.role || "");
    const metadata = parseJson(message?.message_metadata, {});
    const identity = role === "user"
      ? String(metadata.dsh_prompt_rpc_id || message?.id || "").trim()
      : String(metadata.turn_id || metadata.runtime_turn_id || "").trim();
    if (identity) localByIdentity.set(`${role}:${identity}`, message);
  }
  return authoritativeMessages.map((message) => {
    const role = String(message?.role || "");
    const metadata = parseJson(message?.message_metadata, {});
    const identity = role === "user"
      ? String(metadata.dsh_prompt_rpc_id || "").trim()
      : String(metadata.turn_id || message?.id || "").trim();
    const local = identity ? localByIdentity.get(`${role}:${identity}`) : null;
    if (!local) return message;
    const items = parseJson(local.content_items, []);
    const overlay = items.filter((item) => {
      if (!item || typeof item !== "object") return false;
      if (role === "user") return item.type === "attachment";
      return !CORE_DSH_ITEM_TYPES.has(String(item.type || ""));
    });
    if (!overlay.length) return message;
    const overlayImageDigests = new Set(overlay.flatMap((item) => {
      const sha256 = String(item?.metadata?.sha256 || "").trim();
      return item?.type === "attachment" && sha256 ? [sha256] : [];
    }));
    const authoritativeItems = (Array.isArray(message.content_items) ? message.content_items : []).filter((item) => {
      if (item?.type !== "attachment") return true;
      const attachmentId = String(item?.metadata?.dsh_attachment_id || "").trim();
      const sha256 = attachmentId.startsWith("sha256:")
        ? attachmentId.slice("sha256:".length)
        : String(item?.metadata?.sha256 || "").trim();
      return !sha256 || !overlayImageDigests.has(sha256);
    });
    return {
      ...message,
      content_items: [...overlay, ...authoritativeItems],
      message_metadata: {
        ...parseJson(local.message_metadata, {}),
        ...(message.message_metadata || {}),
        dsh_product_projection: true,
      },
    };
  });
}

// GET /api/projects/:pid/sessions/:sid/intermediate-tables — intermediate tables (empty)
export async function listIntermediateTables(ctx, input) {
  const { pid, sid } = input.params;
  const session = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sid, pid, ctx.userId],
  );
  if (!session) throw new ApiError("会话不存在", 404);
  let rows = await ctx.query(
    `SELECT id, session_id, message_id, query_execution_id, table_name, duckdb_path, description,
            row_count, column_count, columns, schema_preview, sub_query, sql_query, created_at, updated_at
       FROM session_intermediate_tables
      WHERE session_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [sid],
  );
  if (!rows.length) {
    const duckdbPath = IntermediateStorageService.get_duckdb_path(pid, sid);
    const tables = await IntermediateStorageService.list_tables(duckdbPath);
    rows = await Promise.all(tables.map(async (table) => {
      const columns = await IntermediateStorageService.get_table_schema(duckdbPath, table.table_name);
      const schemaPreview = await IntermediateStorageService.get_sample_rows(duckdbPath, table.table_name, 5);
      return { ...table, id: `${sid}:${table.table_name}`, session_id: sid, duckdb_path: duckdbPath, columns, schema_preview: schemaPreview };
    }));
  }
  const items = rows.map((row) => ({
    ...row,
    columns: parseJson(row.columns, []),
    schema_preview: parseJson(row.schema_preview, []),
  }));
  return { data: { items, total: items.length }, message: "获取中间表成功" };
}

// GET /api/projects/:pid/sessions/:sid/feedback-status — feedback status map
export async function getSessionFeedbackStatus(ctx, input) {
  const rows = await ctx.query(
    `SELECT mf.message_id, mf.feedback_type, mf.feedback_reason
       FROM message_feedbacks mf
       JOIN sessions s ON s.id=mf.session_id
      WHERE mf.session_id=$1 AND s.project_id=$2 AND s.created_by=$3
        AND mf.deleted_at IS NULL AND s.deleted_at IS NULL`,
    [input.params.sid, input.params.pid, ctx.userId],
  );
  // Frontend reads {messageId: 'like'|'dislike'|null}; values are strings.
  const map = {};
  rows.forEach((r) => { map[r.message_id] = r.feedback_type; });
  return { data: map, message: "获取反馈状态成功" };
}
