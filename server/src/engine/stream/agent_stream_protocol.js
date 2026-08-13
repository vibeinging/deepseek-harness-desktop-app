import { randomUUID } from "node:crypto";

/**
 * Agent Stream is Dsh's product projection of Agent app-server lifecycle.
 *
 * `agent_chat.rpcNotification()` always publishes these events under the
 * `dsh/*` namespace. Native app-server notifications are forwarded without
 * that prefix, so product-only statuses/items cannot be mistaken for Codex
 * 0.147.0 protocol objects.
 */

export const StreamEventType = Object.freeze({
  TURN_STARTED: "turn/started",
  TURN_STATUS_CHANGED: "turn/statusChanged",
  TURN_COMPLETED: "turn/completed",
  TURN_PLAN_UPDATED: "turn/plan/updated",
  ITEM_STARTED: "item/started",
  ITEM_COMPLETED: "item/completed",
  AGENT_MESSAGE_DELTA: "item/agentMessage/delta",
  REASONING_SUMMARY_DELTA: "item/reasoning/summaryTextDelta",
  REASONING_TEXT_DELTA: "item/reasoning/textDelta",
  TOOL_OUTPUT_DELTA: "item/toolCall/outputDelta",
});

export function createStreamEvent({
  type,
  threadId,
  turnId,
  itemId,
  seq,
  payload = {},
  ts = new Date().toISOString(),
} = {}) {
  if (!type) throw new Error("stream event type is required");
  const resolvedItemId = itemId || payload?.itemId || payload?.item?.id || null;
  return {
    type,
    thread_id: threadId || null,
    turn_id: turnId || null,
    item_id: resolvedItemId,
    seq: Number(seq || 0),
    ts,
    payload: payload && typeof payload === "object" ? payload : {},
  };
}

export function newMessageId(prefix = "msg") {
  return `${prefix}:${randomUUID()}`;
}

export default {
  StreamEventType,
  createStreamEvent,
  newMessageId,
};
