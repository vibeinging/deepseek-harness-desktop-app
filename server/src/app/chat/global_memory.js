import { randomUUID } from "node:crypto";

import { ApiError } from "../../errors.js";
import { readGlobalChatMemorySettings } from "../../engine/agents/global_chat_memory.js";

const CHAT_PROJECT_ID = "__chat__";
const MAX_MEMORY_ENTRIES = 200;
const MAX_MEMORY_LENGTH = 1_000;

function userIdFrom(ctx) {
  return String(ctx?.userId || "").trim();
}

function truthyDatabaseValue(value) {
  return [1, true, "1", "true"].includes(value);
}

function parseDetails(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeMemoryContent(value) {
  const content = String(value || "").replace(/\r\n/g, "\n").trim();
  if (!content) throw new ApiError("记忆内容不能为空", 400);
  if (content.length > MAX_MEMORY_LENGTH) throw new ApiError(`记忆内容不能超过 ${MAX_MEMORY_LENGTH} 个字`, 400);
  return content;
}

async function recordAudit(ctx, action, targetType, targetId = null, details = {}) {
  await ctx.query(
    `INSERT INTO chat_global_memory_audit
       (id,user_id,action,target_type,target_id,details_json,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())`,
    [randomUUID(), userIdFrom(ctx), action, targetType, targetId, JSON.stringify(details)],
  );
}

async function requireOwnedEntry(ctx, entryId) {
  const entry = await ctx.queryOne(
    `SELECT id,content,source_type,source_session_id,created_at,updated_at
       FROM chat_global_memory_entries
      WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [entryId, userIdFrom(ctx)],
  ).catch(() => null);
  if (!entry) throw new ApiError("记忆不存在或无权限", 404);
  return entry;
}

async function requireOwnedGlobalConversation(ctx, sessionId) {
  const session = await ctx.queryOne(
    `SELECT id,title FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3
        AND action_type='agentic_chat' AND deleted_at IS NULL
      LIMIT 1`,
    [sessionId, CHAT_PROJECT_ID, userIdFrom(ctx)],
  ).catch(() => null);
  if (!session) throw new ApiError("普通聊天不存在或无权限", 404);
  return session;
}

// GET /api/agent/chat-memory
export async function getGlobalChatMemory(ctx) {
  const userId = userIdFrom(ctx);
  const [settings, entries, conversations, audit] = await Promise.all([
    readGlobalChatMemorySettings(ctx, userId),
    ctx.query(
      `SELECT id,content,source_type,source_session_id,created_at,updated_at
         FROM chat_global_memory_entries
        WHERE user_id=$1 AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT $2`,
      [userId, MAX_MEMORY_ENTRIES],
    ).catch(() => []),
    ctx.query(
      `SELECT s.id,s.title,COALESCE(s.status,'active') AS status,
              COALESCE(s.message_count,0) AS message_count,s.updated_at,
              CASE WHEN e.session_id IS NULL THEN 0 ELSE 1 END AS excluded
         FROM sessions s
         LEFT JOIN chat_global_memory_exclusions e
           ON e.user_id=s.created_by AND e.session_id=s.id
        WHERE s.project_id=$1 AND s.created_by=$2
          AND s.action_type='agentic_chat' AND s.deleted_at IS NULL
        ORDER BY s.updated_at DESC LIMIT 100`,
      [CHAT_PROJECT_ID, userId],
    ).catch(() => []),
    ctx.query(
      `SELECT id,action,target_type,target_id,details_json,created_at
         FROM chat_global_memory_audit
        WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    ).catch(() => []),
  ]);

  return {
    data: {
      settings,
      entries,
      source_conversations: conversations.map((conversation) => ({
        ...conversation,
        excluded: truthyDatabaseValue(conversation.excluded),
      })),
      audit: audit.map((item) => ({ ...item, details: parseDetails(item.details_json) })),
    },
    message: "ok",
  };
}

// PUT /api/agent/chat-memory
export async function updateGlobalChatMemory(ctx, input) {
  const body = input.body || {};
  const hasSaved = typeof body.saved_memory_enabled === "boolean";
  const hasHistory = typeof body.chat_history_enabled === "boolean";
  if (!hasSaved && !hasHistory) throw new ApiError("至少提交一个记忆开关", 400);

  const current = await readGlobalChatMemorySettings(ctx, userIdFrom(ctx));
  const next = {
    saved_memory_enabled: hasSaved ? body.saved_memory_enabled : current.saved_memory_enabled,
    chat_history_enabled: hasHistory ? body.chat_history_enabled : current.chat_history_enabled,
  };
  await ctx.query(
    `INSERT INTO chat_global_memory_settings
       (user_id,saved_memory_enabled,chat_history_enabled,created_at,updated_at)
     VALUES ($1,$2,$3,now(),now())
     ON CONFLICT(user_id) DO UPDATE SET
       saved_memory_enabled=excluded.saved_memory_enabled,
       chat_history_enabled=excluded.chat_history_enabled,
       updated_at=excluded.updated_at`,
    [userIdFrom(ctx), next.saved_memory_enabled, next.chat_history_enabled],
  );
  const changed = {};
  if (hasSaved) changed.saved_memory_enabled = next.saved_memory_enabled;
  if (hasHistory) changed.chat_history_enabled = next.chat_history_enabled;
  await recordAudit(ctx, "settings.updated", "settings", userIdFrom(ctx), changed);
  return { data: next, message: "记忆设置已保存" };
}

// POST /api/agent/chat-memory/entries
export async function createGlobalChatMemoryEntry(ctx, input) {
  const content = normalizeMemoryContent(input.body?.content);
  const count = await ctx.queryOne(
    `SELECT count(*) AS count FROM chat_global_memory_entries
      WHERE user_id=$1 AND deleted_at IS NULL`,
    [userIdFrom(ctx)],
  );
  if (Number(count?.count || 0) >= MAX_MEMORY_ENTRIES) {
    throw new ApiError(`最多保存 ${MAX_MEMORY_ENTRIES} 条记忆，请先删除不需要的内容`, 409);
  }
  const id = randomUUID();
  await ctx.query(
    `INSERT INTO chat_global_memory_entries
       (id,user_id,content,source_type,created_at,updated_at)
     VALUES ($1,$2,$3,'manual',now(),now())`,
    [id, userIdFrom(ctx), content],
  );
  await recordAudit(ctx, "entry.created", "entry", id, { content_length: content.length });
  const entry = await requireOwnedEntry(ctx, id);
  return { data: entry, message: "记忆已添加" };
}

// PUT /api/agent/chat-memory/entries/:id
export async function updateGlobalChatMemoryEntry(ctx, input) {
  const entryId = String(input.params?.id || "").trim();
  await requireOwnedEntry(ctx, entryId);
  const content = normalizeMemoryContent(input.body?.content);
  await ctx.query(
    `UPDATE chat_global_memory_entries
        SET content=$1,updated_at=now()
      WHERE id=$2 AND user_id=$3 AND deleted_at IS NULL`,
    [content, entryId, userIdFrom(ctx)],
  );
  await recordAudit(ctx, "entry.updated", "entry", entryId, { content_length: content.length });
  return { data: await requireOwnedEntry(ctx, entryId), message: "记忆已更新" };
}

// DELETE /api/agent/chat-memory/entries/:id
export async function deleteGlobalChatMemoryEntry(ctx, input) {
  const entryId = String(input.params?.id || "").trim();
  await requireOwnedEntry(ctx, entryId);
  await ctx.query(
    `UPDATE chat_global_memory_entries
        SET deleted_at=now(),deleted_by=$1,updated_at=now()
      WHERE id=$2 AND user_id=$1 AND deleted_at IS NULL`,
    [userIdFrom(ctx), entryId],
  );
  await recordAudit(ctx, "entry.deleted", "entry", entryId);
  return { data: { id: entryId, deleted: true }, message: "记忆已删除" };
}

// POST /api/agent/chat-memory/exclusions/:sid
export async function excludeGlobalChatMemoryConversation(ctx, input) {
  const sessionId = String(input.params?.sid || "").trim();
  const session = await requireOwnedGlobalConversation(ctx, sessionId);
  await ctx.query(
    `INSERT INTO chat_global_memory_exclusions (user_id,session_id,created_at)
     VALUES ($1,$2,now()) ON CONFLICT(user_id,session_id) DO NOTHING`,
    [userIdFrom(ctx), sessionId],
  );
  await recordAudit(ctx, "conversation.excluded", "conversation", sessionId, { excluded: true });
  return { data: { session_id: sessionId, title: session.title, excluded: true }, message: "这段对话将不再用于记忆" };
}

// DELETE /api/agent/chat-memory/exclusions/:sid
export async function includeGlobalChatMemoryConversation(ctx, input) {
  const sessionId = String(input.params?.sid || "").trim();
  const session = await requireOwnedGlobalConversation(ctx, sessionId);
  await ctx.query(
    `DELETE FROM chat_global_memory_exclusions WHERE user_id=$1 AND session_id=$2`,
    [userIdFrom(ctx), sessionId],
  );
  await recordAudit(ctx, "conversation.included", "conversation", sessionId, { excluded: false });
  return { data: { session_id: sessionId, title: session.title, excluded: false }, message: "这段对话可以继续用于记忆" };
}
