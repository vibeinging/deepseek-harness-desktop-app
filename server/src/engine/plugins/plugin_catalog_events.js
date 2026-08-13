import { randomUUID } from "node:crypto";

export const PLUGIN_CATALOG_EVENT_TYPES = Object.freeze({
  READY: "plugin_catalog.ready",
  CHANGED: "plugin_catalog.changed",
  HEARTBEAT: "plugin_catalog.heartbeat",
});

export const PLUGIN_CATALOG_SERVER_INSTANCE_ID = randomUUID();

const CHANGE_REASONS = new Set([
  "install",
  "enable",
  "disable",
  "upgrade",
  "rollback",
  "uninstall",
]);

let sequence = 0;
const subscribers = new Set();

function text(value) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function stringList(value) {
  if (value == null) return null;
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => text(item))
    .filter(Boolean))];
}

function nextEnvelope(type, {
  reason = null,
  canonicalPluginId = null,
  projectIds = null,
  at = new Date().toISOString(),
} = {}) {
  return Object.freeze({
    type,
    payload: Object.freeze({
      event_id: randomUUID(),
      server_instance_id: PLUGIN_CATALOG_SERVER_INSTANCE_ID,
      seq: ++sequence,
      reason: text(reason) || type,
      canonical_plugin_id: text(canonicalPluginId),
      project_ids: stringList(projectIds),
      at,
    }),
  });
}

export function createPluginCatalogReadyEvent() {
  return nextEnvelope(PLUGIN_CATALOG_EVENT_TYPES.READY, { reason: "stream_ready" });
}

export function createPluginCatalogHeartbeatEvent() {
  return nextEnvelope(PLUGIN_CATALOG_EVENT_TYPES.HEARTBEAT, { reason: "heartbeat" });
}

export function publishPluginCatalogChanged({
  userId = null,
  userIds = null,
  reason,
  canonicalPluginId,
  projectIds = null,
} = {}) {
  const normalizedReason = text(reason);
  const normalizedPluginId = text(canonicalPluginId);
  if (!CHANGE_REASONS.has(normalizedReason) || !normalizedPluginId) {
    throw new TypeError("Plugin 目录变化事件无效");
  }
  const audienceUserIds = new Set(stringList(
    userIds == null ? [userId] : userIds,
  ) || []);
  const event = nextEnvelope(PLUGIN_CATALOG_EVENT_TYPES.CHANGED, {
    reason: normalizedReason,
    canonicalPluginId: normalizedPluginId,
    projectIds,
  });
  for (const subscriber of subscribers) {
    if (subscriber.userId && !audienceUserIds.has(subscriber.userId)) continue;
    try {
      subscriber.listener(event);
    } catch {
      // A stale renderer stream must never make a successful lifecycle write fail.
    }
  }
  return event;
}

export function subscribePluginCatalogEvents(listener, { userId = null } = {}) {
  if (typeof listener !== "function") throw new TypeError("Plugin 目录订阅需要监听函数");
  const subscriber = { listener, userId: text(userId) };
  subscribers.add(subscriber);
  return () => subscribers.delete(subscriber);
}

export function resetPluginCatalogEventsForTests() {
  subscribers.clear();
  sequence = 0;
}

export default {
  PLUGIN_CATALOG_EVENT_TYPES,
  PLUGIN_CATALOG_SERVER_INSTANCE_ID,
  createPluginCatalogReadyEvent,
  createPluginCatalogHeartbeatEvent,
  publishPluginCatalogChanged,
  subscribePluginCatalogEvents,
};
