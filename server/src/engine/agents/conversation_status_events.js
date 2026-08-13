import { randomUUID } from "node:crypto";

export const CONVERSATION_STATUS_EVENT_TYPES = Object.freeze({
  READY: "conversation_status.ready",
  CHANGED: "conversation_status.changed",
  HEARTBEAT: "conversation_status.heartbeat",
});

export const CONVERSATION_STATUS_SERVER_INSTANCE_ID = randomUUID();

let sequence = 0;
const subscribers = new Set();

function text(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function nextEnvelope(type, {
  projectId = null,
  sessionId = null,
  runId = null,
  reason = null,
  at = new Date().toISOString(),
} = {}) {
  return Object.freeze({
    type,
    payload: Object.freeze({
      event_id: randomUUID(),
      server_instance_id: CONVERSATION_STATUS_SERVER_INSTANCE_ID,
      seq: ++sequence,
      project_id: text(projectId),
      session_id: text(sessionId),
      run_id: text(runId),
      reason: text(reason) || type,
      at,
    }),
  });
}

export function createConversationStatusReadyEvent() {
  return nextEnvelope(CONVERSATION_STATUS_EVENT_TYPES.READY, { reason: "stream_ready" });
}

export function createConversationStatusHeartbeatEvent() {
  return nextEnvelope(CONVERSATION_STATUS_EVENT_TYPES.HEARTBEAT, { reason: "heartbeat" });
}

export function publishConversationStatusChanged({
  userId = null,
  projectId = null,
  sessionId = null,
  runId = null,
  reason = "status_changed",
} = {}) {
  const audienceUserId = text(userId);
  const event = nextEnvelope(CONVERSATION_STATUS_EVENT_TYPES.CHANGED, {
    projectId,
    sessionId,
    runId,
    reason,
  });
  for (const subscriber of subscribers) {
    if (subscriber.userId && subscriber.userId !== audienceUserId) continue;
    try {
      subscriber.listener(event);
    } catch {
      // A stale stream must never make a durable run-state write fail.
    }
  }
  return event;
}

export function subscribeConversationStatusEvents(listener, { userId = null } = {}) {
  if (typeof listener !== "function") throw new TypeError("会话状态订阅需要监听函数");
  const subscriber = { listener, userId: text(userId) };
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function resetConversationStatusEventsForTests() {
  subscribers.clear();
  sequence = 0;
}

export default {
  CONVERSATION_STATUS_EVENT_TYPES,
  CONVERSATION_STATUS_SERVER_INSTANCE_ID,
  createConversationStatusReadyEvent,
  createConversationStatusHeartbeatEvent,
  publishConversationStatusChanged,
  subscribeConversationStatusEvents,
};
