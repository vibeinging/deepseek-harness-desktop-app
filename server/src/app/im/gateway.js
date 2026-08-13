// Unified IM Gateway — provider-neutral remote control core.
//
// This module intentionally avoids old Feishu/WeCom service dependencies.
// Platform adapters only need to normalize messages into IM events,
// then the flow continues through identity -> workspace -> session -> command -> delivery.
import { randomBytes, randomUUID } from "node:crypto";
import { ApiError } from "../../errors.js";
import { agentChat } from "../chat/agent_chat.js";
import { stopConnectorWorker } from "./worker_supervisor.js";

const PROVIDERS = new Set(["fake", "feishu", "wecom_app", "wecom_bot"]);
const SESSION_POLICIES = new Set(["per_user", "shared_chat", "fixed"]);
const IDENTITY_STATUS = new Set(["pending", "trusted", "blocked"]);
const EXECUTION_MODES = new Set(["record_only", "agent"]);
const REMOTE_APPROVAL_MODES = new Set(["ask", "auto"]);
const CONNECTOR_SETTING_KEYS = new Set(["execution_mode", "approval", "fixed_session_id"]);

const jsonText = (value, fallback = null) => {
  if (value == null) return fallback;
  if (typeof value === "string") return value.trim() ? value : fallback;
  return JSON.stringify(value);
};

const parseJson = (value, fallback = null) => {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

const parseArray = (value) => {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
};

const truthy = (value) => value === true || value === 1 || value === "1" || value === "true";

export function normalizeConnectorSettings(value, { strict = false } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  if (strict) {
    const unknown = Object.keys(source).filter((key) => !CONNECTOR_SETTING_KEYS.has(key));
    if (unknown.length) throw new ApiError(`不支持的 IM connector 设置: ${unknown.join(", ")}`, 400);
  }
  const executionMode = String(source.execution_mode || "record_only").trim();
  if (!EXECUTION_MODES.has(executionMode)) {
    throw new ApiError(`不支持的 IM execution_mode: ${executionMode}`, 400);
  }
  const approval = String(source.approval || "ask").trim();
  if (!REMOTE_APPROVAL_MODES.has(approval)) {
    throw new ApiError("远程 Agent 不能使用 full 权限，请选择 ask 或 auto", 400);
  }
  const fixedSessionId = String(source.fixed_session_id || "").trim();
  return {
    execution_mode: executionMode,
    approval,
    ...(fixedSessionId ? { fixed_session_id: fixedSessionId } : {}),
  };
}

function connectorShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    owner_user_id: row.owner_user_id,
    default_workspace_id: row.default_workspace_id || null,
    allowed_workspace_ids: parseArray(row.allowed_workspace_ids),
    session_policy: SESSION_POLICIES.has(row.session_policy) ? row.session_policy : "per_user",
    enabled: truthy(row.enabled),
    settings: normalizeConnectorSettings(parseJson(row.settings, {})),
    connection_status: row.connection_status || "disconnected",
    last_error: row.last_error || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function identityShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    connector_id: row.connector_id,
    provider: row.provider,
    external_user_id: row.external_user_id,
    external_union_id: row.external_union_id || null,
    app_user_id: row.app_user_id || null,
    display_name: row.display_name || null,
    status: row.status || "pending",
    pairing_code: row.pairing_code || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function contextShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    connector_id: row.connector_id,
    provider: row.provider,
    external_conversation_key: row.external_conversation_key,
    external_user_id: row.external_user_id,
    chat_id: row.chat_id || null,
    chat_type: row.chat_type || "dm",
    current_workspace_id: row.current_workspace_id || null,
    current_session_id: row.current_session_id || null,
    session_policy: row.session_policy || "per_user",
    last_active_at: row.last_active_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function userProjects(ctx, userId) {
  const rows = await ctx.query(
    `SELECT p.id, p.name, p.description, p.created_at, pm.is_owner
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id AND pm.deleted_at IS NULL
      WHERE pm.user_id=$1 AND p.deleted_at IS NULL
      ORDER BY p.created_at DESC`,
    [userId],
  );
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description || "",
    is_owner: !!p.is_owner,
  }));
}

function validateProvider(provider) {
  const p = String(provider || "").trim();
  if (!PROVIDERS.has(p)) throw new ApiError(`不支持的 IM provider: ${p || "(empty)"}`, 400);
  return p;
}

function validateSessionPolicy(policy) {
  const p = String(policy || "per_user").trim();
  if (!SESSION_POLICIES.has(p)) throw new ApiError(`不支持的 session_policy: ${p}`, 400);
  return p;
}

async function assertWorkspaceAccess(ctx, userId, workspaceId) {
  if (!workspaceId) return null;
  const row = await ctx.queryOne(
    `SELECT p.id, p.name
       FROM projects p JOIN project_members pm ON pm.project_id=p.id AND pm.deleted_at IS NULL
      WHERE p.id=$1 AND pm.user_id=$2 AND p.deleted_at IS NULL`,
    [workspaceId, userId],
  );
  if (!row) throw new ApiError("工作区不存在或无权限", 403);
  return row;
}

async function loadConnector(ctx, id, { requireEnabled = false } = {}) {
  const row = await ctx.queryOne(
    `SELECT * FROM im_connectors WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`,
    [id, ctx.userId],
  );
  if (!row) throw new ApiError("IM connector 不存在", 404);
  const connector = connectorShape(row);
  if (requireEnabled && !connector.enabled) throw new ApiError("IM connector 已禁用", 400);
  return connector;
}

function buildEvent(body, connector) {
  const event = body.event && typeof body.event === "object" ? body.event : body;
  const provider = validateProvider(event.provider || connector.provider);
  const externalUserId = String(event.external_user_id || event.from_user || event.user_id || "").trim();
  if (!externalUserId) throw new ApiError("external_user_id 不能为空", 400);
  const chatId = String(event.external_chat_id || event.chat_id || "").trim();
  const chatType = chatId ? "group" : String(event.chat_type || "dm").trim();
  const text = String(event.text || event.message || event.content || "").trim();
  const messageId = String(event.message_id || event.msg_id || event.event_id || randomUUID()).trim();
  const eventId = String(event.event_id || messageId).trim();
  return {
    provider,
    event_id: eventId,
    message_id: messageId,
    external_user_id: externalUserId,
    external_union_id: String(event.external_union_id || event.union_id || "").trim() || null,
    chat_id: chatId || null,
    chat_type: chatType === "group" || chatType === "chat" ? "group" : "dm",
    mentioned: Boolean(event.mentioned ?? event.is_mentioned ?? false),
    text,
    raw: event,
  };
}

function conversationKey(event, sessionPolicy) {
  if (sessionPolicy === "shared_chat" && event.chat_id) return `chat:${event.chat_id}`;
  if (sessionPolicy === "fixed" && event.chat_id) return `fixed:${event.chat_id}`;
  if (event.chat_id) return `chat:${event.chat_id}:user:${event.external_user_id}`;
  return `dm:${event.external_user_id}`;
}

function contextExternalUser(event, sessionPolicy) {
  if ((sessionPolicy === "shared_chat" || sessionPolicy === "fixed") && event.chat_id) return "*";
  return event.external_user_id;
}

async function logOutbound(ctx, connector, inboundId, event, content, status = "sent", messageType = "markdown") {
  const row = await ctx.queryOne(
    `INSERT INTO im_outbound_messages
       (id,connector_id,inbound_event_id,provider,target_key,message_type,content,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
     RETURNING *`,
    [
      randomUUID(),
      connector.id,
      inboundId || null,
      connector.provider,
      event?.chat_id || event?.external_user_id || "",
      messageType,
      String(content || ""),
      status,
    ],
  );
  return row;
}

async function getTrustedIdentity(ctx, connector, event) {
  const row = await ctx.queryOne(
    `SELECT * FROM im_remote_identities
      WHERE connector_id=$1 AND external_user_id=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [connector.id, event.external_user_id],
  );
  const identity = identityShape(row);
  if (!identity) return null;
  if (identity.status === "blocked") throw new ApiError("远程用户已被阻止", 403);
  return identity.status === "trusted" ? identity : null;
}

async function ensurePendingIdentity(ctx, connector, event) {
  const existing = await ctx.queryOne(
    `SELECT * FROM im_remote_identities
      WHERE connector_id=$1 AND external_user_id=$2 AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [connector.id, event.external_user_id],
  );
  if (existing) return identityShape(existing);
  const pairingCode = randomBytes(4).toString("hex").toUpperCase();
  const row = await ctx.queryOne(
    `INSERT INTO im_remote_identities
       (id,connector_id,provider,external_user_id,external_union_id,status,pairing_code,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'pending',$6,now(),now())
     RETURNING *`,
    [randomUUID(), connector.id, connector.provider, event.external_user_id, event.external_union_id || null, pairingCode],
  );
  return identityShape(row);
}

async function getOrCreateContext(ctx, connector, event) {
  const policy = connector.session_policy || "per_user";
  const key = conversationKey(event, policy);
  const userKey = contextExternalUser(event, policy);
  let row = await ctx.queryOne(
    `SELECT * FROM im_remote_contexts
      WHERE connector_id=$1 AND external_conversation_key=$2 AND external_user_id=$3 AND deleted_at IS NULL
      LIMIT 1`,
    [connector.id, key, userKey],
  );
  if (!row) {
    row = await ctx.queryOne(
      `INSERT INTO im_remote_contexts
         (id,connector_id,provider,external_conversation_key,external_user_id,chat_id,chat_type,session_policy,last_active_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now(),now())
       RETURNING *`,
      [randomUUID(), connector.id, connector.provider, key, userKey, event.chat_id || null, event.chat_type || "dm", policy],
    );
  } else {
    row = await ctx.queryOne(
      `UPDATE im_remote_contexts SET last_active_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
      [row.id],
    );
  }
  return contextShape(row);
}

async function updateContext(ctx, contextId, patch) {
  const fields = [];
  const params = [];
  let idx = 1;
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key}=$${idx++}`);
    params.push(value ?? null);
  }
  fields.push("last_active_at=now()");
  fields.push("updated_at=now()");
  params.push(contextId);
  const row = await ctx.queryOne(
    `UPDATE im_remote_contexts SET ${fields.join(",")} WHERE id=$${idx} RETURNING *`,
    params,
  );
  return contextShape(row);
}

export function filterAllowedProjects(projects, allowedIds) {
  if (!allowedIds.length) return [];
  const allowed = new Set(allowedIds);
  return projects.filter((p) => allowed.has(p.id));
}

async function allowedProjects(ctx, connector, appUserId) {
  const projects = await userProjects(ctx, appUserId);
  return filterAllowedProjects(projects, connector.allowed_workspace_ids || []);
}

async function resolveWorkspace(ctx, connector, context, appUserId) {
  const projects = await allowedProjects(ctx, connector, appUserId);
  const byId = new Map(projects.map((p) => [p.id, p]));
  if (context.current_workspace_id && byId.has(context.current_workspace_id)) {
    return byId.get(context.current_workspace_id);
  }
  if (connector.default_workspace_id && byId.has(connector.default_workspace_id)) {
    await updateContext(ctx, context.id, { current_workspace_id: connector.default_workspace_id, current_session_id: null });
    return byId.get(connector.default_workspace_id);
  }
  if (projects.length === 1) {
    await updateContext(ctx, context.id, { current_workspace_id: projects[0].id, current_session_id: null });
    return projects[0];
  }
  return null;
}

async function resolveWorkspaceByName(ctx, connector, appUserId, target) {
  const projects = await allowedProjects(ctx, connector, appUserId);
  const needle = String(target || "").trim().toLowerCase();
  return projects.find((p) => p.id === target || String(p.name || "").toLowerCase() === needle) ||
    projects.find((p) => String(p.name || "").toLowerCase().includes(needle)) ||
    null;
}

async function createRemoteSession(ctx, workspaceId, appUserId, event, titlePrefix = "远程会话") {
  const id = randomUUID();
  const titleParts = [titlePrefix];
  if (event.chat_id) titleParts.push(event.chat_id.slice(0, 16));
  else titleParts.push(event.external_user_id.slice(0, 16));
  const title = titleParts.join(" - ");
  await ctx.query(
    `INSERT INTO sessions
       (id,project_id,created_by,title,description,source_type,source_id,action_type,status,message_count,session_config,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,'agent',$2,'agentic_chat','active',0,$6,now(),now())`,
    [
      id,
      workspaceId,
      appUserId,
      title,
      "IM remote control session",
      JSON.stringify({
        source: "im_remote",
        provider: event.provider,
        external_user_id: event.external_user_id,
        chat_id: event.chat_id || null,
        chat_type: event.chat_type,
      }),
    ],
  );
  return id;
}

async function sessionExists(ctx, sessionId, workspaceId, appUserId) {
  if (!sessionId) return false;
  const row = await ctx.queryOne(
    `SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL`,
    [sessionId, workspaceId, appUserId],
  );
  return !!row;
}

async function resolveSession(ctx, connector, context, workspace, appUserId, event) {
  if (connector.session_policy === "fixed" && connector.settings?.fixed_session_id) {
    const ok = await sessionExists(ctx, connector.settings.fixed_session_id, workspace.id, appUserId);
    if (ok) return connector.settings.fixed_session_id;
  }
  if (context.current_session_id && await sessionExists(ctx, context.current_session_id, workspace.id, appUserId)) {
    return context.current_session_id;
  }
  const sid = await createRemoteSession(ctx, workspace.id, appUserId, event);
  await updateContext(ctx, context.id, { current_workspace_id: workspace.id, current_session_id: sid });
  return sid;
}

async function appendRemoteTurn(ctx, sessionId, userText, assistantText, metadata = {}) {
  const seqRow = await ctx.queryOne(
    `SELECT COALESCE(MAX(sequence_number),0) AS m FROM session_messages WHERE session_id=$1`,
    [sessionId],
  ).catch(() => ({ m: 0 }));
  let seq = Number(seqRow?.m || 0);
  await ctx.query(
    `INSERT INTO session_messages (id,session_id,role,content_items,message_metadata,sequence_number,created_at,updated_at)
     VALUES ($1,$2,'user',$3,$4,$5,now(),now())`,
    [
      randomUUID(),
      sessionId,
      JSON.stringify([{ id: randomUUID(), type: "text", content: userText, metadata, is_complete: true, display_type: "text" }]),
      JSON.stringify(metadata),
      ++seq,
    ],
  );
  if (assistantText) {
    await ctx.query(
      `INSERT INTO session_messages (id,session_id,role,content_items,message_metadata,sequence_number,created_at,updated_at)
       VALUES ($1,$2,'assistant',$3,$4,$5,now(),now())`,
      [
        randomUUID(),
        sessionId,
        JSON.stringify([{ id: randomUUID(), type: "markdown", content: assistantText, title: "IM Gateway", metadata, is_complete: true, display_type: "text" }]),
        JSON.stringify(metadata),
        ++seq,
      ],
    );
  }
  await ctx.query(
    `UPDATE sessions SET message_count=COALESCE(message_count,0)+$1, updated_at=now() WHERE id=$2`,
    [assistantText ? 2 : 1, sessionId],
  );
}

function eventToRemoteMetadata(connector, event, extra = {}) {
  return {
    source: "im_remote",
    provider: connector.provider,
    connector_id: connector.id,
    external_user_id: event.external_user_id,
    chat_id: event.chat_id || null,
    chat_type: event.chat_type,
    ...extra,
  };
}

function normalizedRuntimeMethod(value) {
  const method = String(value || "");
  return method.startsWith("dsh/") ? method.slice("dsh/".length) : method;
}

export function renderAgentEventsForIm(events) {
  const visible = new Map();
  let terminalAnswer = null;
  let terminalMessage = "";
  for (const ev of events || []) {
    if (!ev) continue;
    const method = normalizedRuntimeMethod(ev.method || ev.type);
    const payload = ev.params || ev.payload || {};
    const itemId = String(payload.itemId || payload.item?.id || ev.item_id || `item:${visible.size}`);
    if (method === "item/agentMessage/delta") {
      const previous = visible.get(itemId) || "";
      const delta = String(payload.delta || "");
      visible.set(itemId, payload.mode === "replace" ? delta : previous + delta);
      continue;
    }
    if (method === "item/completed" && payload?.item?.type === "agentMessage") {
      const item = payload.item;
      const itemId = String(item.id || ev.item_id || `item:${visible.size}`);
      const text = item.text ?? item.content;
      if (text != null) visible.set(itemId, String(text));
      continue;
    }
    if (method === "turn/completed") {
      terminalAnswer = payload.turn?.answer || payload.answer || null;
      terminalMessage = String(payload.message || "").trim();
    }
  }
  if (terminalAnswer?.status === "accepted" && terminalAnswer.itemId) {
    const answer = String(visible.get(String(terminalAnswer.itemId)) || "").trim();
    if (answer) return answer.slice(0, 6000);
  }
  return terminalMessage || "任务未生成可用的最终回答。";
}

async function runRemoteAgentTurn(ctx, connector, workspace, sessionId, identity, event) {
  const mode = connector.settings?.execution_mode || "record_only";
  const metadata = eventToRemoteMetadata(connector, event, { execution_mode: mode });
  if (mode === "record_only") {
    const assistantText = "已收到远程消息,并已写入 app 会话。";
    await appendRemoteTurn(ctx, sessionId, event.text, assistantText, metadata);
    return {
      status: "completed",
      execution_mode: "record_only",
      outbound: assistantText,
      events: [],
    };
  }

  const events = [];
  const emit = (ev) => {
    events.push(ev);
  };
  await agentChat(
    ctx,
    {
      params: { pid: workspace.id, sid: sessionId },
      body: {
        message: event.text,
        approval: connector.settings?.approval || "ask",
        source: "im_remote",
        connector_id: connector.id,
        remote_identity_id: identity.id,
      },
    },
    emit,
  );
  const done = [...events].reverse().find((ev) => (ev?.method || ev?.type) === "turn/completed");
  return {
    status: done?.params?.turn?.status || done?.payload?.turn?.status || done?.payload?.status || "completed",
    execution_mode: "agent",
    outbound: renderAgentEventsForIm(events),
    events,
  };
}

async function insertInbound(ctx, connector, event, contextKey) {
  const duplicate = await ctx.queryOne(
    `SELECT * FROM im_inbound_events
      WHERE connector_id=$1 AND event_id=$2 AND deleted_at IS NULL
      LIMIT 1`,
    [connector.id, event.event_id],
  );
  if (duplicate) return { duplicate: true, row: duplicate };
  const row = await ctx.queryOne(
    `INSERT INTO im_inbound_events
       (id,connector_id,provider,event_id,message_id,external_conversation_key,external_user_id,chat_id,chat_type,text,raw_event,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'received',now(),now())
     RETURNING *`,
    [
      randomUUID(),
      connector.id,
      connector.provider,
      event.event_id,
      event.message_id || null,
      contextKey || null,
      event.external_user_id,
      event.chat_id || null,
      event.chat_type || "dm",
      event.text || "",
      JSON.stringify(event.raw || event),
    ],
  );
  return { duplicate: false, row };
}

async function finishInbound(ctx, inboundId, patch) {
  const fields = [];
  const params = [];
  let idx = 1;
  for (const [key, value] of Object.entries(patch)) {
    fields.push(`${key}=$${idx++}`);
    params.push(value ?? null);
  }
  fields.push("updated_at=now()");
  params.push(inboundId);
  await ctx.query(`UPDATE im_inbound_events SET ${fields.join(",")} WHERE id=$${idx}`, params);
}

function commandOf(text) {
  const s = String(text || "").trim();
  if (!s.startsWith("/")) return null;
  const [cmd, ...rest] = s.split(/\s+/);
  return { name: cmd.slice(1).toLowerCase(), arg: rest.join(" ").trim() };
}

async function handleCommand(ctx, connector, context, event, identity, inboundId, command) {
  const appUserId = identity.app_user_id || ctx.userId;
  if (command.name === "help") {
    return { status: "command", content: "可用命令: /workspaces, /workspace <名称或ID>, /new, /session, /status, /unbind, /help" };
  }
  if (command.name === "whoami") {
    return { status: "command", content: `已绑定用户: ${identity.display_name || identity.external_user_id}\nprovider: ${connector.provider}` };
  }
  if (command.name === "workspaces") {
    const projects = await allowedProjects(ctx, connector, appUserId);
    const lines = projects.map((p, i) => `${i + 1}. ${p.name} (${p.id})`);
    return { status: "command", content: lines.length ? `可用工作区:\n${lines.join("\n")}` : "没有可用工作区。" };
  }
  if (command.name === "workspace") {
    if (!command.arg) return { status: "workspace_required", content: "请指定工作区名称或 ID,例如 /workspace smoke-eval" };
    const target = await resolveWorkspaceByName(ctx, connector, appUserId, command.arg);
    if (!target) return { status: "workspace_not_found", content: `没有找到可访问的工作区: ${command.arg}` };
    const updated = await updateContext(ctx, context.id, { current_workspace_id: target.id, current_session_id: null });
    void updated;
    await finishInbound(ctx, inboundId, { status: "workspace_switched", command: "workspace", result_workspace_id: target.id });
    return { status: "workspace_switched", workspace: target, content: `已切换到工作区: ${target.name}` };
  }
  if (command.name === "new") {
    const workspace = await resolveWorkspace(ctx, connector, context, appUserId);
    if (!workspace) return { status: "workspace_required", content: "请先使用 /workspace 选择工作区。" };
    const sid = await createRemoteSession(ctx, workspace.id, appUserId, event, "远程新会话");
    await updateContext(ctx, context.id, { current_workspace_id: workspace.id, current_session_id: sid });
    await finishInbound(ctx, inboundId, { status: "session_created", command: "new", result_workspace_id: workspace.id, result_session_id: sid });
    return { status: "session_created", workspace, session_id: sid, content: `已创建新会话: ${sid}` };
  }
  if (command.name === "session") {
    return { status: "command", content: `当前 session: ${context.current_session_id || "(未创建)"}` };
  }
  if (command.name === "status") {
    return {
      status: "command",
      content: [
        `connector: ${connector.name}`,
        `workspace: ${context.current_workspace_id || "(未选择)"}`,
        `session: ${context.current_session_id || "(未创建)"}`,
        `policy: ${context.session_policy}`,
      ].join("\n"),
    };
  }
  if (command.name === "unbind") {
    await updateContext(ctx, context.id, { current_workspace_id: null, current_session_id: null });
    return { status: "unbound", content: "已清除当前远程上下文的工作区和会话绑定。" };
  }
  return { status: "unknown_command", content: `未知命令: /${command.name}。发送 /help 查看可用命令。` };
}

export async function listConnectors(ctx) {
  const rows = await ctx.query(
    `SELECT * FROM im_connectors WHERE owner_user_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [ctx.userId],
  );
  return { data: { items: rows.map(connectorShape), total: rows.length }, message: "获取 IM Connector 成功" };
}

export async function createConnector(ctx, input) {
  const b = input.body || {};
  const provider = validateProvider(b.provider);
  const sessionPolicy = validateSessionPolicy(b.session_policy);
  const name = String(b.name || `${provider} remote`).trim();
  const allowed = Array.isArray(b.allowed_workspace_ids) ? b.allowed_workspace_ids.filter(Boolean) : [];
  const settings = normalizeConnectorSettings(b.settings, { strict: true });
  if (b.default_workspace_id) await assertWorkspaceAccess(ctx, ctx.userId, b.default_workspace_id);
  for (const workspaceId of allowed) await assertWorkspaceAccess(ctx, ctx.userId, workspaceId);
  if (b.default_workspace_id && !allowed.includes(b.default_workspace_id)) {
    throw new ApiError("default_workspace_id 必须包含在 allowed_workspace_ids 中", 400);
  }
  const row = await ctx.queryOne(
    `INSERT INTO im_connectors
       (id,provider,name,owner_user_id,default_workspace_id,allowed_workspace_ids,session_policy,enabled,credentials,settings,connection_status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'disconnected',now(),now())
     RETURNING *`,
    [
      randomUUID(),
      provider,
      name,
      ctx.userId,
      b.default_workspace_id || null,
      jsonText(allowed, "[]"),
      sessionPolicy,
      b.enabled === false ? 0 : 1,
      jsonText(b.credentials || {}, "{}"),
      jsonText(settings, "{}"),
    ],
  );
  return { data: connectorShape(row), message: "创建 IM Connector 成功" };
}

export async function updateConnector(ctx, input) {
  const connector = await loadConnector(ctx, input.params.cid);
  const b = input.body || {};
  const nextAllowed = b.allowed_workspace_ids !== undefined
    ? (Array.isArray(b.allowed_workspace_ids) ? b.allowed_workspace_ids.filter(Boolean) : [])
    : connector.allowed_workspace_ids;
  const nextDefault = b.default_workspace_id !== undefined
    ? (b.default_workspace_id || null)
    : connector.default_workspace_id;
  if (nextDefault && !nextAllowed.includes(nextDefault)) {
    throw new ApiError("default_workspace_id 必须包含在 allowed_workspace_ids 中", 400);
  }
  const sets = [];
  const params = [];
  let idx = 1;
  const add = (col, value) => { sets.push(`${col}=$${idx++}`); params.push(value); };
  if (b.name !== undefined) add("name", String(b.name || "").trim() || connector.name);
  if (b.default_workspace_id !== undefined) {
    if (b.default_workspace_id) await assertWorkspaceAccess(ctx, ctx.userId, b.default_workspace_id);
    add("default_workspace_id", b.default_workspace_id || null);
  }
  if (b.allowed_workspace_ids !== undefined) {
    for (const workspaceId of nextAllowed) await assertWorkspaceAccess(ctx, ctx.userId, workspaceId);
    add("allowed_workspace_ids", JSON.stringify(nextAllowed));
  }
  if (b.session_policy !== undefined) add("session_policy", validateSessionPolicy(b.session_policy));
  if (b.enabled !== undefined) add("enabled", b.enabled === false ? 0 : 1);
  if (b.credentials !== undefined) add("credentials", jsonText(b.credentials || {}, "{}"));
  if (b.settings !== undefined) add("settings", jsonText(normalizeConnectorSettings(b.settings, { strict: true }), "{}"));
  if (!sets.length) return { data: connector, message: "无变更" };
  sets.push("updated_at=now()");
  params.push(connector.id);
  const row = await ctx.queryOne(`UPDATE im_connectors SET ${sets.join(",")} WHERE id=$${idx} RETURNING *`, params);
  return { data: connectorShape(row), message: "更新 IM Connector 成功" };
}

export async function deleteConnector(ctx, input) {
  const connector = await loadConnector(ctx, input.params.cid);
  await stopConnectorWorker(ctx, { params: { cid: connector.id } }).catch(() => null);
  await ctx.query(
    `UPDATE im_connectors SET deleted_at=now(), deleted_by=$1, updated_at=now() WHERE id=$2`,
    [ctx.userId, connector.id],
  );
  return { data: { deleted: true, id: connector.id }, message: "删除 IM Connector 成功" };
}

export async function upsertIdentity(ctx, input) {
  const connector = await loadConnector(ctx, input.params.cid);
  const b = input.body || {};
  const externalUserId = String(b.external_user_id || "").trim();
  if (!externalUserId) throw new ApiError("external_user_id 不能为空", 400);
  const status = String(b.status || "trusted").trim();
  if (!IDENTITY_STATUS.has(status)) throw new ApiError(`不支持的 identity status: ${status}`, 400);
  const existing = await ctx.queryOne(
    `SELECT * FROM im_remote_identities WHERE connector_id=$1 AND external_user_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [connector.id, externalUserId],
  );
  // Desktop app currently uses a built-in single-user model.
  // Even if management UI is added later, switching bound user must happen via
  // authorized server-side operations; do not trust app_user_id from webhook/eval payloads.
  const appUserId = ctx.userId;
  if (existing) {
    const row = await ctx.queryOne(
      `UPDATE im_remote_identities
          SET status=$1, app_user_id=$2, display_name=$3, external_union_id=$4, pairing_code=NULL, updated_at=now()
        WHERE id=$5 RETURNING *`,
      [status, appUserId, b.display_name || existing.display_name || null, b.external_union_id || existing.external_union_id || null, existing.id],
    );
    return { data: identityShape(row), message: "更新远程身份成功" };
  }
  const row = await ctx.queryOne(
    `INSERT INTO im_remote_identities
       (id,connector_id,provider,external_user_id,external_union_id,app_user_id,display_name,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),now())
     RETURNING *`,
    [randomUUID(), connector.id, connector.provider, externalUserId, b.external_union_id || null, appUserId, b.display_name || null, status],
  );
  return { data: identityShape(row), message: "创建远程身份成功" };
}

export async function listContexts(ctx, input) {
  const connector = await loadConnector(ctx, input.params.cid);
  const rows = await ctx.query(
    `SELECT * FROM im_remote_contexts WHERE connector_id=$1 AND deleted_at IS NULL ORDER BY last_active_at DESC`,
    [connector.id],
  );
  return { data: { items: rows.map(contextShape), total: rows.length }, message: "获取远程上下文成功" };
}

export async function handleConnectorEvent(ctx, input) {
  const connectorId = input.params?.cid || input.body?.connector_id || input.body?.connectorId;
  if (!connectorId) throw new ApiError("connector_id 不能为空", 400);
  const connector = await loadConnector(ctx, connectorId, { requireEnabled: true });
  const event = buildEvent(input.body, connector);
  const policy = connector.session_policy || "per_user";
  const key = conversationKey(event, policy);
  const inbound = await insertInbound(ctx, connector, event, key);
  if (inbound.duplicate) {
    return {
      data: {
        deduplicated: true,
        event_id: event.event_id,
        status: inbound.row.status,
        workspace_id: inbound.row.result_workspace_id || null,
        session_id: inbound.row.result_session_id || null,
      },
      message: "IM event 已处理",
    };
  }

  const identity = await getTrustedIdentity(ctx, connector, event);
  if (!identity) {
    const pending = await ensurePendingIdentity(ctx, connector, event);
    const content = `需要绑定远程用户。pairing code: ${pending.pairing_code}`;
    await logOutbound(ctx, connector, inbound.row.id, event, content);
    await finishInbound(ctx, inbound.row.id, { status: "pairing_required" });
    return { data: { status: "pairing_required", identity: pending, outbound: content }, message: "需要绑定远程用户" };
  }

  let context = await getOrCreateContext(ctx, connector, event);
  const cmd = commandOf(event.text);
  if (cmd) {
    const result = await handleCommand(ctx, connector, context, event, identity, inbound.row.id, cmd);
    await finishInbound(ctx, inbound.row.id, {
      status: result.status || "command",
      command: cmd.name,
      result_workspace_id: result.workspace?.id || null,
      result_session_id: result.session_id || null,
    });
    await logOutbound(ctx, connector, inbound.row.id, event, result.content);
    context = await getOrCreateContext(ctx, connector, event);
    return { data: { ...result, context }, message: "IM 命令已处理" };
  }

  const workspace = await resolveWorkspace(ctx, connector, context, identity.app_user_id || ctx.userId);
  if (!workspace) {
    const projects = await allowedProjects(ctx, connector, identity.app_user_id || ctx.userId);
    const content = projects.length
      ? `请选择工作区:\n${projects.map((p, i) => `${i + 1}. ${p.name}`).join("\n")}\n\n发送 /workspace <名称> 切换。`
      : "没有可用工作区。";
    await logOutbound(ctx, connector, inbound.row.id, event, content);
    await finishInbound(ctx, inbound.row.id, { status: "workspace_required" });
    return { data: { status: "workspace_required", projects, context }, message: "需要选择工作区" };
  }

  const sessionId = await resolveSession(ctx, connector, context, workspace, identity.app_user_id || ctx.userId, event);
  let runResult;
  try {
    runResult = await runRemoteAgentTurn(ctx, connector, workspace, sessionId, identity, event);
  } catch (e) {
    const assistantText = `远程消息已收到,但 agent 执行失败:${e?.message || e}`;
    await appendRemoteTurn(ctx, sessionId, event.text, assistantText, eventToRemoteMetadata(connector, event, {
      execution_mode: "agent",
      error: e?.message || String(e),
    }));
    runResult = {
      status: "failed",
      execution_mode: "agent",
      outbound: assistantText,
      events: [],
    };
  }
  await logOutbound(ctx, connector, inbound.row.id, event, runResult.outbound);
  await finishInbound(ctx, inbound.row.id, {
    status: "routed",
    result_workspace_id: workspace.id,
    result_session_id: sessionId,
  });
  context = await getOrCreateContext(ctx, connector, event);
  return {
    data: {
      status: "routed",
      workspace,
      session_id: sessionId,
      context,
      execution_mode: runResult.execution_mode,
      agent_status: runResult.status,
      outbound: runResult.outbound,
    },
    message: "IM event 已路由",
  };
}

export async function handleFakeEvent(ctx, input) {
  return handleConnectorEvent(ctx, input);
}
