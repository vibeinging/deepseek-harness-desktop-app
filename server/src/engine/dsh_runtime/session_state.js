import { EventEmitter } from "node:events";

const statesByDshSession = new Map();
const dshSessionByAppSession = new Map();
const events = new EventEmitter();
events.setMaxListeners(200);

function emptyState(binding) {
  return {
    ...binding,
    connected: false,
    lastSeq: -1,
    queueKnown: false,
    queue: [],
    projections: {},
    projectionSeq: {},
    streamError: null,
    revision: 0,
  };
}

function publish(state, frame = null) {
  state.revision += 1;
  events.emit(`session:${state.appSessionId}`, {
    state: snapshot(state),
    frame,
  });
}

function textFromContent(content) {
  if (!Array.isArray(content)) return null;
  if (content.some((block) => block?.type !== "text")) return null;
  return content.map((block) => String(block?.text || "")).join("").trim();
}

function queueItem(item) {
  const content = Array.isArray(item?.message?.content) ? structuredClone(item.message.content) : [];
  const text = textFromContent(content);
  const preview = content.map((block) => (
    block?.type === "text" ? String(block.text || "") : `[${String(block?.type || "content")}]`
  )).join(" ").replace(/\s+/g, " ").trim().slice(0, 240);
  return {
    id: String(item?.id || ""),
    placement: ["queued", "steering", "context"].includes(item?.placement) ? item.placement : "context",
    content,
    text,
    preview,
  };
}

export function bindDshSessionState(binding) {
  const dshSessionId = String(binding?.dshSessionId || "").trim();
  const appSessionId = String(binding?.appSessionId || "").trim();
  if (!(dshSessionId && appSessionId)) return null;
  const previousDshSessionId = dshSessionByAppSession.get(appSessionId);
  if (previousDshSessionId && previousDshSessionId !== dshSessionId) {
    statesByDshSession.delete(previousDshSessionId);
  }
  let state = statesByDshSession.get(dshSessionId);
  if (!state) {
    state = emptyState({
      dshSessionId,
      appSessionId,
      projectId: binding.projectId || null,
      userId: binding.userId || null,
      cwd: binding.cwd || null,
    });
    statesByDshSession.set(dshSessionId, state);
  } else {
    Object.assign(state, {
      appSessionId,
      projectId: binding.projectId || state.projectId || null,
      userId: binding.userId || state.userId || null,
      cwd: binding.cwd || state.cwd || null,
    });
  }
  dshSessionByAppSession.set(appSessionId, dshSessionId);
  return snapshot(state);
}

export function applyDshProjectionBaseline(dshSessionId, block) {
  const state = statesByDshSession.get(String(dshSessionId || ""));
  if (!state || !block || typeof block !== "object") return null;
  const seq = Number(block.asOfSeq);
  if (!Number.isFinite(seq)) return snapshot(state);
  for (const [key, value] of Object.entries(block.values || {})) {
    if (seq <= Number(state.projectionSeq[key] ?? -1)) continue;
    state.projections[key] = structuredClone(value);
    state.projectionSeq[key] = seq;
  }
  state.lastSeq = Math.max(state.lastSeq, seq);
  publish(state, { type: "session/projections-baseline", sessionId: state.dshSessionId, projections: block });
  return snapshot(state);
}

export function applyDshMuxFrame(envelope) {
  const frame = envelope?.payload;
  if (!frame || typeof frame !== "object") return null;
  const state = statesByDshSession.get(String(frame.sessionId || ""));
  if (!state) return null;
  if (frame.type === "session/subscribed") {
    state.connected = true;
    state.lastSeq = Number.isFinite(Number(frame.lastSeq)) ? Number(frame.lastSeq) : state.lastSeq;
    state.queue = [];
    state.queueKnown = false;
    state.streamError = null;
  } else if (frame.type === "session/queue") {
    state.queue = (Array.isArray(frame.items) ? frame.items : []).map(queueItem).filter((item) => item.id);
    state.queueKnown = true;
  } else if (frame.type === "session/projection") {
    const key = String(frame.key || "").trim();
    const seq = Number(frame.seq);
    if (key && Number.isFinite(seq) && seq > Number(state.projectionSeq[key] ?? -1)) {
      state.projections[key] = structuredClone(frame.value);
      state.projectionSeq[key] = seq;
      state.lastSeq = Math.max(state.lastSeq, seq);
    }
  } else if (frame.type === "session/event") {
    const seq = Number(frame.event?.seq);
    if (Number.isFinite(seq)) state.lastSeq = Math.max(state.lastSeq, seq);
  } else if (frame.type === "stream/error") {
    state.streamError = structuredClone(frame.error || { message: "DSH 事件流失败" });
  }
  publish(state, structuredClone(envelope));
  return snapshot(state);
}

export function markDshStreamError(error) {
  for (const state of statesByDshSession.values()) {
    state.connected = false;
    state.streamError = { message: error?.message || String(error || "DSH 事件流失败"), code: error?.code || null };
    publish(state, { type: "stream/error", error: state.streamError });
  }
}

export function snapshotDshSessionState(appSessionId) {
  const dshSessionId = dshSessionByAppSession.get(String(appSessionId || ""));
  const state = dshSessionId ? statesByDshSession.get(dshSessionId) : null;
  return state ? snapshot(state) : null;
}

export function listDshSessionBindings() {
  return [...statesByDshSession.values()].map((state) => ({
    appSessionId: state.appSessionId,
    dshSessionId: state.dshSessionId,
    projectId: state.projectId,
    userId: state.userId,
    cwd: state.cwd,
  }));
}

/** Resolve the current App identity for a DSH Session, including new bindings. */
export function resolveDshSessionIdentity(dshSessionId) {
  const state = statesByDshSession.get(String(dshSessionId || "").trim());
  if (!state) return null;
  return {
    appSessionId: state.appSessionId,
    dshSessionId: state.dshSessionId,
    projectId: state.projectId,
    userId: state.userId,
    cwd: state.cwd,
  };
}

export function subscribeDshSessionState(appSessionId, listener) {
  const key = `session:${String(appSessionId || "")}`;
  events.on(key, listener);
  return () => events.off(key, listener);
}

function snapshot(state) {
  return structuredClone({
    appSessionId: state.appSessionId,
    dshSessionId: state.dshSessionId,
    projectId: state.projectId,
    cwd: state.cwd,
    connected: state.connected,
    lastSeq: state.lastSeq,
    queueKnown: state.queueKnown,
    queue: state.queue,
    projections: state.projections,
    projectionSeq: state.projectionSeq,
    streamError: state.streamError,
    revision: state.revision,
  });
}
