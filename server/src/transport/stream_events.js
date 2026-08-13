import { randomUUID } from 'node:crypto';
import { createStreamEvent, StreamEventType } from '../engine/stream/agent_stream_protocol.js';

/**
 * Observe a route's Agent stream and keep transport-level failures inside the
 * same turn. This is shared by HTTP eval transport and Electron IPC.
 */
export function createTransportStream(rawEmit, { threadId = null } = {}) {
  if (typeof rawEmit !== 'function') throw new Error('createTransportStream requires emit function');
  const state = {
    turnId: null,
    threadId,
    seq: 0,
    startedAt: null,
    completed: false,
  };

  const emit = (event) => {
    const type = event?.type || event?.method || "";
    const payload = event?.payload || event?.params || {};
    const meta = payload?._meta && typeof payload._meta === "object" ? payload._meta : {};
    if (type) {
      state.turnId = event.turn_id || payload.turnId || payload.turn?.id || state.turnId;
      state.threadId = event.thread_id || payload.threadId || state.threadId;
      state.seq = Math.max(state.seq, Number(event.seq || meta.seq || 0));
      if (type === StreamEventType.TURN_STARTED || type === `dsh/${StreamEventType.TURN_STARTED}`) {
        state.startedAt = payload?.turn?.startedAt || state.startedAt;
      }
      if (type === StreamEventType.TURN_COMPLETED || type === `dsh/${StreamEventType.TURN_COMPLETED}`) {
        state.completed = true;
      }
    }
    rawEmit(event);
    return event;
  };

  const fail = (message) => {
    if (state.completed) return [];
    const emitted = [];
    const push = (event) => {
      emitted.push(event);
      return emit(event);
    };
    const turnId = state.turnId || randomUUID();
    const resolvedThreadId = state.threadId || null;
    const now = Date.now();
    const errorMessage = String(message || '服务错误');

    if (!state.turnId) {
      push(createStreamEvent({
        type: StreamEventType.TURN_STARTED,
        threadId: resolvedThreadId,
        turnId,
        seq: state.seq + 1,
        payload: {
          turn: {
            id: turnId,
            status: 'inProgress',
            startedAt: Math.floor(now / 1000),
            completedAt: null,
            durationMs: null,
            items: [],
          },
          mode: 'transport',
        },
      }));
      state.startedAt = Math.floor(now / 1000);
    }

    const errorItem = {
      id: 'transport:error',
      type: 'error',
      content: errorMessage,
      title: '错误',
      visibility: 'visible',
    };
    push(createStreamEvent({
      type: StreamEventType.ITEM_STARTED,
      threadId: resolvedThreadId,
      turnId,
      itemId: errorItem.id,
      seq: state.seq + 1,
      payload: { item: errorItem, startedAtMs: now },
    }));
    push(createStreamEvent({
      type: StreamEventType.ITEM_COMPLETED,
      threadId: resolvedThreadId,
      turnId,
      itemId: errorItem.id,
      seq: state.seq + 1,
      payload: { item: errorItem, completedAtMs: now },
    }));
    push(createStreamEvent({
      type: StreamEventType.TURN_COMPLETED,
      threadId: resolvedThreadId,
      turnId,
      seq: state.seq + 1,
      payload: {
        turn: {
          id: turnId,
          status: 'failed',
          startedAt: state.startedAt,
          completedAt: Math.floor(now / 1000),
          durationMs: state.startedAt ? Math.max(0, now - state.startedAt * 1000) : 0,
          items: [],
          error: { message: errorMessage },
        },
      },
    }));
    return emitted;
  };

  return { emit, fail, state };
}

export default { createTransportStream };
