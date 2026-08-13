import { randomUUID } from "node:crypto";

export const DSH_MODEL_SETTINGS_EVENT_TYPES = Object.freeze({
  READY: "dsh_models.ready",
  CHANGED: "dsh_models.changed",
  HEARTBEAT: "dsh_models.heartbeat",
});

export const DSH_MODEL_SETTINGS_SERVER_INSTANCE_ID = randomUUID();

const HOST_CHANGE_TYPES = new Set([
  "host/settings-changed",
  "host/credentials-changed",
  "host/models-changed",
]);

let sequence = 0;
const subscribers = new Set();

function nextEnvelope(type, payload = {}) {
  return Object.freeze({
    type,
    payload: Object.freeze({
      event_id: randomUUID(),
      server_instance_id: DSH_MODEL_SETTINGS_SERVER_INSTANCE_ID,
      seq: ++sequence,
      reason: payload.reason || type,
      ns: payload.ns || null,
      ref: payload.ref || null,
      at: new Date().toISOString(),
    }),
  });
}

/** Create the first invalidation-stream event for one renderer subscriber. */
export function createDshModelSettingsReadyEvent() {
  return nextEnvelope(DSH_MODEL_SETTINGS_EVENT_TYPES.READY, { reason: "stream_ready" });
}

/** Create a keep-alive event without changing the authoritative snapshot. */
export function createDshModelSettingsHeartbeatEvent() {
  return nextEnvelope(DSH_MODEL_SETTINGS_EVENT_TYPES.HEARTBEAT, { reason: "heartbeat" });
}

/** Project one official DSH host change frame into the renderer invalidation bus. */
export function publishDshModelSettingsChanged(payload) {
  if (!payload || !HOST_CHANGE_TYPES.has(payload.type)) return null;
  const event = nextEnvelope(DSH_MODEL_SETTINGS_EVENT_TYPES.CHANGED, {
    reason: payload.type,
    ns: payload.type === "host/settings-changed" ? String(payload.ns || "") || null : null,
    ref: payload.type === "host/credentials-changed" ? String(payload.ref || "") || null : null,
  });
  for (const listener of subscribers) {
    try {
      listener(event);
    } catch {
      // A stale renderer stream must not break DSH host event handling.
    }
  }
  return event;
}

/** Subscribe to global DSH model configuration invalidations. */
export function subscribeDshModelSettingsEvents(listener) {
  if (typeof listener !== "function") throw new TypeError("DSH 模型设置订阅需要监听函数");
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function resetDshModelSettingsEventsForTests() {
  subscribers.clear();
  sequence = 0;
}

export default {
  DSH_MODEL_SETTINGS_EVENT_TYPES,
  createDshModelSettingsReadyEvent,
  createDshModelSettingsHeartbeatEvent,
  publishDshModelSettingsChanged,
  subscribeDshModelSettingsEvents,
};
