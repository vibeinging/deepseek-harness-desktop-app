// Unified IM worker supervisor.
//
// Manage connector lifecycle state only; no message routing or agent execution.
// Platform messages still use gateway/adapters entrypoints. start sets status to connecting first;
// only heartbeat or explicit status updates can move to connected, avoiding false online states.
import { ApiError } from "../../errors.js";

const HEARTBEAT_TIMEOUT_MS = Number(process.env.IM_WORKER_HEARTBEAT_TIMEOUT_MS || 45000);
const STATES = new Map();

const parseJson = (value, fallback = {}) => {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

const nowIso = () => new Date().toISOString();

function publicState(state, persisted = null) {
  const heartbeat = state?.heartbeat_at || persisted?.heartbeat_at || null;
  let status = state?.status || persisted?.status || "disconnected";
  let lastError = state?.last_error ?? persisted?.last_error ?? null;
  if (status === "connected" && heartbeat) {
    const age = Date.now() - new Date(heartbeat).getTime();
    if (Number.isFinite(age) && age > HEARTBEAT_TIMEOUT_MS) {
      status = "connecting";
      lastError = null;
    }
  }
  return {
    connector_id: state?.connector_id || persisted?.connector_id || null,
    provider: state?.provider || persisted?.provider || null,
    status,
    heartbeat_at: heartbeat,
    last_error: lastError,
    pid: state?.pid || persisted?.pid || null,
    mode: state?.mode || persisted?.mode || "supervised",
    started_at: state?.started_at || persisted?.created_at || null,
    updated_at: state?.updated_at || persisted?.updated_at || null,
  };
}

function validateStart(connector) {
  const credentials = connector.credentials || {};
  if (connector.provider === "fake") return;
  if (connector.provider === "feishu" && (!credentials.app_id || !credentials.app_secret)) {
    throw new ApiError("飞书 connector 缺少 app_id/app_secret", 400);
  }
  if (connector.provider === "wecom_bot" && (!credentials.bot_id || !credentials.bot_secret)) {
    throw new ApiError("企业微信智能机器人缺少 bot_id/bot_secret", 400);
  }
  if (connector.provider === "wecom_app" && (!credentials.corp_id || !credentials.agent_id)) {
    throw new ApiError("企业微信应用缺少 corp_id/agent_id", 400);
  }
}

async function loadConnector(ctx, connectorId) {
  const row = await ctx.queryOne(
    `SELECT * FROM im_connectors WHERE id=$1 AND owner_user_id=$2 AND deleted_at IS NULL`,
    [connectorId, ctx.userId],
  );
  if (!row) throw new ApiError("IM connector 不存在", 404);
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    enabled: row.enabled === true || row.enabled === 1 || row.enabled === "1" || row.enabled === "true",
    credentials: parseJson(row.credentials, {}),
    settings: parseJson(row.settings, {}),
    connection_status: row.connection_status || "disconnected",
    last_error: row.last_error || null,
  };
}

async function loadPersistedWorker(ctx, connectorId) {
  return ctx.queryOne(
    `SELECT * FROM im_worker_status WHERE connector_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1`,
    [connectorId],
  ).catch(() => null);
}

async function persistWorker(ctx, connector, patch) {
  const status = patch.status || "connecting";
  const heartbeat = patch.heartbeat_at || null;
  const lastError = patch.last_error || null;
  const pid = patch.pid || process.pid;
  const mode = patch.mode || "supervised";
  const row = await ctx.queryOne(
    `INSERT INTO im_worker_status
       (id,connector_id,provider,status,heartbeat_at,last_error,pid,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())
     ON CONFLICT(id) DO UPDATE SET
       status=excluded.status,
       heartbeat_at=excluded.heartbeat_at,
       last_error=excluded.last_error,
       pid=excluded.pid,
       deleted_at=NULL,
       deleted_by=NULL,
       updated_at=now()
     RETURNING *`,
    [connector.id, connector.id, connector.provider, status, heartbeat, lastError, pid],
  );
  await ctx.query(
    `UPDATE im_connectors SET connection_status=$1, last_error=$2, updated_at=now()
      WHERE id=$3 AND deleted_at IS NULL`,
    [status, lastError, connector.id],
  );
  return { ...row, mode };
}

export async function startConnectorWorker(ctx, input) {
  const connector = await loadConnector(ctx, input.params.cid);
  if (!connector.enabled) throw new ApiError("IM connector 已禁用", 400);
  validateStart(connector);

  const state = {
    connector_id: connector.id,
    provider: connector.provider,
    status: "connecting",
    heartbeat_at: null,
    last_error: null,
    pid: process.pid,
    mode: "supervised",
    started_at: nowIso(),
    updated_at: nowIso(),
  };
  STATES.set(connector.id, state);
  const persisted = await persistWorker(ctx, connector, {
    status: state.status,
    heartbeat_at: state.heartbeat_at,
    last_error: null,
    pid: state.pid,
    mode: state.mode,
  });
  return {
    data: {
      success: true,
      ...publicState(state, persisted),
    },
    message: "IM worker 启动中",
  };
}

export async function stopConnectorWorker(ctx, input) {
  const connector = await loadConnector(ctx, input.params.cid);
  STATES.delete(connector.id);
  const persisted = await persistWorker(ctx, connector, {
    status: "disconnected",
    heartbeat_at: null,
    last_error: null,
    pid: process.pid,
  });
  return {
    data: {
      success: true,
      ...publicState(null, persisted),
    },
    message: "IM worker 已停止",
  };
}

export async function getConnectorWorkerStatus(ctx, input) {
  const connector = await loadConnector(ctx, input.params.cid);
  const persisted = await loadPersistedWorker(ctx, connector.id);
  const state = STATES.get(connector.id) || null;
  const status = publicState(state, persisted || {
    connector_id: connector.id,
    provider: connector.provider,
    status: connector.connection_status,
    last_error: connector.last_error,
  });
  return { data: status, message: "获取 IM worker 状态成功" };
}

export async function heartbeatConnectorWorker(ctx, input) {
  const connector = await loadConnector(ctx, input.params.cid);
  const status = String(input.body?.status || "connected");
  const allowed = new Set(["connecting", "connected", "error", "disconnected"]);
  if (!allowed.has(status)) throw new ApiError(`不支持的 worker status: ${status}`, 400);
  const state = {
    connector_id: connector.id,
    provider: connector.provider,
    status,
    heartbeat_at: status === "connected" ? nowIso() : null,
    last_error: input.body?.last_error || input.body?.error || null,
    pid: process.pid,
    mode: "supervised",
    started_at: STATES.get(connector.id)?.started_at || nowIso(),
    updated_at: nowIso(),
  };
  STATES.set(connector.id, state);
  const persisted = await persistWorker(ctx, connector, state);
  return { data: publicState(state, persisted), message: "IM worker heartbeat 已记录" };
}

export async function setConnectorWorkerStatus(ctx, connectorId, status, lastError = null) {
  const connector = await loadConnector(ctx, connectorId);
  const state = {
    connector_id: connector.id,
    provider: connector.provider,
    status,
    heartbeat_at: status === "connected" ? nowIso() : null,
    last_error: lastError,
    pid: process.pid,
    mode: "supervised",
    started_at: STATES.get(connector.id)?.started_at || nowIso(),
    updated_at: nowIso(),
  };
  if (status === "disconnected") STATES.delete(connector.id);
  else STATES.set(connector.id, state);
  return persistWorker(ctx, connector, state);
}
