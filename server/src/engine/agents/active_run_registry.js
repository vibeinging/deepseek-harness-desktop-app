const activeRuns = new Map();
const activeSessions = new Map();

export function claimActiveSession(sessionId) {
  const id = String(sessionId || "").trim();
  if (!id || activeSessions.has(id)) return null;
  const token = Symbol(id);
  activeSessions.set(id, token);
  return () => {
    if (activeSessions.get(id) === token) activeSessions.delete(id);
  };
}

export function registerActiveRun(runId, entry = {}) {
  const id = String(runId || "").trim();
  if (!id) return () => {};
  const token = Symbol(id);
  activeRuns.set(id, { ...entry, token, registered_at: new Date().toISOString() });
  return () => {
    if (activeRuns.get(id)?.token === token) activeRuns.delete(id);
  };
}

async function waitForSettlement(entry, waitForSettlementMs) {
  const timeoutMs = Math.max(0, Number(waitForSettlementMs || 0));
  if (!(timeoutMs > 0) || typeof entry?.waitForSettlement !== "function") {
    return { settled: false, settlement: null };
  }
  let timeout = null;
  try {
    const settlement = await Promise.race([
      Promise.resolve().then(() => entry.waitForSettlement()),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(null), timeoutMs);
        timeout.unref?.();
      }),
    ]);
    return { settled: Boolean(settlement), settlement: settlement || null };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function stopActiveRun(runId, reason = "user_stop", { waitForSettlementMs = 0 } = {}) {
  const id = String(runId || "").trim();
  const entry = activeRuns.get(id);
  if (!entry) return { found: false, stopped: false };
  let keepUntilRuntimeSettles = false;
  try {
    await entry.cancel?.(reason);
    const waited = await waitForSettlement(entry, waitForSettlementMs);
    keepUntilRuntimeSettles = waitForSettlementMs > 0 && waited.settled !== true;
    if (keepUntilRuntimeSettles && typeof entry.waitForSettlement === "function") {
      void Promise.resolve()
        .then(() => entry.waitForSettlement())
        .catch(() => null)
        .finally(() => {
          if (activeRuns.get(id)?.token === entry.token) activeRuns.delete(id);
        });
    }
    return waitForSettlementMs > 0
      ? { found: true, stopped: true, ...waited }
      : { found: true, stopped: true };
  } finally {
    if (!keepUntilRuntimeSettles && activeRuns.get(id)?.token === entry.token) activeRuns.delete(id);
  }
}

export async function steerActiveRun(runId, input) {
  const id = String(runId || "").trim();
  const entry = activeRuns.get(id);
  if (!entry) return { found: false, accepted: false };
  if (typeof entry.steer !== "function") return { found: true, accepted: false };
  const result = await entry.steer(input);
  return { found: true, accepted: true, result };
}

export function activeRunSnapshot(runId) {
  const entry = activeRuns.get(String(runId || "").trim());
  if (!entry) return null;
  return {
    run_id: String(runId),
    session_id: entry.sessionId || null,
    project_id: entry.projectId || null,
    agent_run_id: entry.runId || null,
    supports_image_input: entry.supportsImageInput === true,
    registered_at: entry.registered_at,
  };
}

export function clearActiveRunsForTests() {
  activeRuns.clear();
  activeSessions.clear();
}

export default { claimActiveSession, registerActiveRun, stopActiveRun, steerActiveRun, activeRunSnapshot };
