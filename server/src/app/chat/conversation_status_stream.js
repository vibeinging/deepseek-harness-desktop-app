import {
  createConversationStatusHeartbeatEvent,
  createConversationStatusReadyEvent,
  subscribeConversationStatusEvents,
} from "../../engine/agents/conversation_status_events.js";

export const CONVERSATION_STATUS_HEARTBEAT_MS = 20_000;

// GET /api/agent/session-status/events — lightweight invalidation stream.
// The sessions list remains the authoritative snapshot; this stream only tells
// renderers which project should be refreshed.
export async function watchAgentSessionStatusEvents(ctx, _input, emit) {
  if (typeof emit !== "function") throw new TypeError("会话状态流缺少 emit");
  const signal = ctx?.signal;
  if (signal?.aborted) return;

  await new Promise((resolve) => {
    let closed = false;
    let heartbeat = null;
    let unsubscribe = () => {};

    const close = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
      signal?.removeEventListener("abort", close);
      resolve();
    };
    const push = (event) => {
      if (closed) return;
      try {
        emit(event);
      } catch {
        close();
      }
    };

    unsubscribe = subscribeConversationStatusEvents(push, { userId: ctx?.userId || null });
    heartbeat = setInterval(() => push(createConversationStatusHeartbeatEvent()), CONVERSATION_STATUS_HEARTBEAT_MS);
    heartbeat.unref?.();
    signal?.addEventListener("abort", close, { once: true });
    if (signal?.aborted) {
      close();
      return;
    }
    push(createConversationStatusReadyEvent());
  });
}

export default { watchAgentSessionStatusEvents };
