import { isAbsolute } from "node:path";

import { bindDshSessionState } from "./session_state.js";

function parseConfig(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

export async function loadDshSessionBinding(db, appSessionId) {
  const id = String(appSessionId || "").trim();
  if (!id || !db?.queryOne) return null;
  const row = await db.queryOne(
    "SELECT id,project_id,created_by,session_config FROM sessions WHERE id=$1 AND deleted_at IS NULL LIMIT 1",
    [id],
  ).catch(() => null);
  if (!row) return null;
  const config = parseConfig(row.session_config);
  const dshSessionId = String(config.dsh_runtime_session_id || "").trim();
  if (!dshSessionId) return null;
  const binding = {
    appSessionId: id,
    dshSessionId,
    projectId: String(row.project_id || "").trim() || null,
    userId: String(row.created_by || "").trim() || null,
    cwd: String(config.dsh_runtime_cwd || "").trim() || null,
  };
  bindDshSessionState(binding);
  return binding;
}

export async function saveDshSessionBinding(db, binding) {
  const appSessionId = String(binding?.appSessionId || "").trim();
  const dshSessionId = String(binding?.dshSessionId || "").trim();
  const cwd = String(binding?.cwd || "").trim();
  if (!(appSessionId && dshSessionId && cwd) || !db?.query || !db?.queryOne) {
    throw new Error("保存 DSH 会话绑定需要 appSessionId、dshSessionId、cwd 和数据库连接");
  }
  const row = await db.queryOne(
    "SELECT project_id,created_by,session_config FROM sessions WHERE id=$1 AND deleted_at IS NULL LIMIT 1",
    [appSessionId],
  );
  if (!row) throw new Error(`dsh-work 会话不存在：${appSessionId}`);
  const config = {
    ...parseConfig(row.session_config),
    runtime_backend: "dsh",
    dsh_runtime_session_id: dshSessionId,
    dsh_runtime_cwd: cwd,
  };
  delete config.agent_kernel;
  delete config.agent_runtime_thread_id;
  delete config.agent_runtime_capability_revision;
  await db.query(
    "UPDATE sessions SET session_config=$1,updated_at=now() WHERE id=$2",
    [JSON.stringify(config), appSessionId],
  );
  const resolved = {
    appSessionId,
    dshSessionId,
    cwd,
    projectId: String(binding.projectId || row.project_id || "").trim() || null,
    userId: String(binding.userId || row.created_by || "").trim() || null,
  };
  bindDshSessionState(resolved);
  return resolved;
}

export function parseDshSessionConfig(value) {
  return parseConfig(value);
}

/**
 * Recover only missing App-side cwd values from the exact DSH Session header.
 * This never guesses from an App project, changes a Session id, or rewrites an
 * existing cwd.
 */
export async function recoverMissingDshSessionCwds(db, client, rows = []) {
  const candidates = rows.filter((row) => {
    const config = parseConfig(row?.session_config);
    return String(config.dsh_runtime_session_id || "").trim()
      && !String(config.dsh_runtime_cwd || "").trim();
  });
  if (!candidates.length) return { recovered: 0, unresolved: [] };

  const listed = await client.request("session.list", {});
  const cwdBySession = new Map((Array.isArray(listed?.items) ? listed.items : [])
    .map((item) => [String(item?.sessionId || "").trim(), String(item?.cwd || "").trim()])
    .filter(([sessionId, cwd]) => sessionId && cwd && isAbsolute(cwd)));
  const unresolved = [];
  let recovered = 0;
  for (const row of candidates) {
    const config = parseConfig(row.session_config);
    const dshSessionId = String(config.dsh_runtime_session_id || "").trim();
    const cwd = cwdBySession.get(dshSessionId);
    if (!cwd) {
      unresolved.push(dshSessionId);
      continue;
    }
    await saveDshSessionBinding(db, {
      appSessionId: String(row.id || "").trim(),
      dshSessionId,
      cwd,
      projectId: String(row.project_id || "").trim() || null,
      userId: String(row.created_by || "").trim() || null,
    });
    row.session_config = {
      ...config,
      runtime_backend: "dsh",
      dsh_runtime_session_id: dshSessionId,
      dsh_runtime_cwd: cwd,
    };
    recovered += 1;
  }
  return { recovered, unresolved };
}
