import { randomUUID } from "node:crypto";
import { createStreamEvent, newMessageId, StreamEventType } from "./agent_stream_protocol.js";
import {
  contentItemFromAgentContent,
  normalizeAgentContent,
  streamEventsFromAgentContent,
} from "./agent_content_adapter.js";

function terminalTurnStatus(status) {
  if (status === "completed") return "completed";
  if (["cancelled", "interrupted", "stopped"].includes(status)) return "interrupted";
  return "failed";
}

function deltaFromSnapshot(previous, next) {
  const before = String(previous || "");
  const after = String(next || "");
  if (after.startsWith(before)) return { delta: after.slice(before.length), mode: "append" };
  return { delta: after, mode: "replace" };
}

export class AgentStreamEmitter {
  constructor({ emit, turnId, threadId, messageId } = {}) {
    if (typeof emit !== "function") throw new Error("AgentStreamEmitter requires emit function");
    this.emit = emit;
    this.turnId = turnId || randomUUID();
    this.threadId = threadId || null;
    this.messageId = messageId || newMessageId("assistant");
    this.seq = 0;
    this.startedAtMs = null;
    this.completedAtMs = null;
    this.turnStatus = "inProgress";
    this.items = new Map();
    this.itemStartedAt = new Map();
    this.completedItems = new Set();
    this.pendingCompletions = new Map();
    this.persistedItems = new Map();
    this.completedTurnEvent = null;
  }

  event(type, payload = {}, { itemId = null } = {}) {
    const event = createStreamEvent({
      type,
      threadId: this.threadId,
      turnId: this.turnId,
      itemId,
      seq: ++this.seq,
      payload,
    });
    this.emit(event);
    return event;
  }

  itemStarted(item, startedAtMs = Date.now()) {
    if (!item?.id) return null;
    if (this.completedItems.has(item.id)) return null;
    const existing = this.items.get(item.id);
    const next = { ...(existing || {}), ...item };
    this.items.set(item.id, next);
    if (this.itemStartedAt.has(item.id)) return null;
    this.itemStartedAt.set(item.id, startedAtMs);
    return this.event(StreamEventType.ITEM_STARTED, { item: next, startedAtMs }, { itemId: item.id });
  }

  itemCompleted(item, completedAtMs = Date.now()) {
    if (!item?.id) return null;
    if (this.completedItems.has(item.id)) return null;
    const existing = this.items.get(item.id);
    const startedAtMs = this.itemStartedAt.get(item.id) || completedAtMs;
    const next = {
      ...(existing || {}),
      ...item,
      ...(item.type === "dynamicToolCall" && item.durationMs == null
        ? { durationMs: Math.max(0, completedAtMs - startedAtMs) }
        : {}),
    };
    this.itemStarted(next, startedAtMs);
    this.items.set(item.id, next);
    this.completedItems.add(item.id);
    this.updatePersistedItem(item.id, next);
    return this.event(StreamEventType.ITEM_COMPLETED, { item: next, completedAtMs }, { itemId: item.id });
  }

  queueItemCompletion(item, completedAtMs = Date.now()) {
    if (!item?.id || this.completedItems.has(item.id)) return null;
    const existing = this.items.get(item.id);
    const next = { ...(existing || {}), ...item };
    this.itemStarted(next, this.itemStartedAt.get(item.id) || completedAtMs);
    this.items.set(item.id, next);
    this.updatePersistedItem(item.id, next);
    this.pendingCompletions.set(item.id, { item: next, completedAtMs });
    return next;
  }

  flushPendingCompletions(itemId = null) {
    const ids = itemId ? [itemId] : [...this.pendingCompletions.keys()];
    for (const id of ids) {
      const pending = this.pendingCompletions.get(id);
      if (!pending) continue;
      this.pendingCompletions.delete(id);
      this.itemCompleted(pending.item, pending.completedAtMs);
    }
  }

  updatePersistedItem(itemId, protocolItem) {
    const persisted = this.persistedItems.get(itemId);
    if (!persisted) return;
    persisted.metadata = {
      ...(persisted.metadata || {}),
      item_type: protocolItem.type,
    };
  }

  completeOpenNarrative() {
    for (const [id, item] of this.items.entries()) {
      if (this.completedItems.has(id)) continue;
      if (item.type === "reasoning") {
        this.itemCompleted(item);
        continue;
      }
      if (item.type !== "agentMessage") continue;
      this.itemCompleted(item);
    }
  }

  emitSnapshotDelta(mapped) {
    const itemId = mapped.itemId;
    const payload = mapped.payload || {};
    const startItem = mapped.startItem || { id: itemId };

    if (this.completedItems.has(itemId)) return;
    this.flushPendingCompletions();

    if (startItem.type === "reasoning") {
      for (const [id, item] of this.items.entries()) {
        if (id !== itemId && item.type === "reasoning" && !this.completedItems.has(id)) this.itemCompleted(item);
      }
    }

    // Provider callbacks carry full text snapshots. Do not re-apply the empty
    // start snapshot on later callbacks, otherwise the prior text is lost and
    // every frame is incorrectly emitted as the full message again.
    if (!this.itemStartedAt.has(itemId)) this.itemStarted(startItem);
    const current = this.items.get(itemId) || startItem;
    const nextText = String(payload.text || "");
    const nextVisibility = payload.visibility || startItem.visibility || current.visibility || "visible";
    const previousText = current.type === "reasoning"
      ? String(current.summary?.[Number(payload.summaryIndex || 0)] || "")
      : String(current.text || "");
    const { delta, mode } = deltaFromSnapshot(previousText, nextText);
    const visibilityChanged = nextVisibility !== current.visibility;
    const metadataChanged = payload.metadata != null
      && JSON.stringify(payload.metadata) !== JSON.stringify(current.metadata || null);

    const next = current.type === "reasoning"
      ? { ...current, summary: [nextText], visibility: nextVisibility, model: payload.model || current.model, usage: payload.usage || current.usage }
      : {
          ...current,
          text: nextText,
          visibility: nextVisibility,
          phase: payload.phase || current.phase,
          format: payload.format || current.format,
          title: payload.title || current.title,
          model: payload.model || current.model,
          usage: payload.usage || current.usage,
          metadata: payload.metadata || current.metadata,
        };
    this.items.set(itemId, next);
    this.updatePersistedItem(itemId, next);

    if (delta || mode === "replace" || visibilityChanged || metadataChanged) {
      this.event(mapped.type, {
        delta,
        mode,
        visibility: next.visibility,
        ...(payload.summaryIndex != null ? { summaryIndex: payload.summaryIndex } : {}),
        ...(payload.format ? { format: payload.format } : {}),
        ...(payload.title ? { title: payload.title } : {}),
        ...(payload.phase ? { phase: payload.phase } : {}),
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.usage ? { usage: payload.usage } : {}),
        ...(payload.metadata ? { metadata: payload.metadata } : {}),
      }, { itemId });
    }

  }

  emitMapped(mapped) {
    if (!mapped) return;
    if (mapped.type === StreamEventType.AGENT_MESSAGE_DELTA || mapped.type === StreamEventType.REASONING_SUMMARY_DELTA) {
      this.emitSnapshotDelta(mapped);
      return;
    }

    if (mapped.type === StreamEventType.TURN_PLAN_UPDATED) {
      this.flushPendingCompletions();
      const item = mapped.payload?.item;
      if (item) this.itemCompleted(item);
      this.event(StreamEventType.TURN_PLAN_UPDATED, {
        plan: mapped.payload?.plan || [],
        explanation: mapped.payload?.explanation || null,
      }, { itemId: mapped.itemId });
      return;
    }

    if (mapped.type === StreamEventType.ITEM_STARTED) {
      const item = mapped.payload?.item;
      if (item?.type === "dynamicToolCall") {
        this.flushPendingCompletions();
        this.completeOpenNarrative();
      }
      this.itemStarted(item);
      return;
    }

    if (mapped.type === StreamEventType.ITEM_COMPLETED) {
      const item = mapped.payload?.item;
      if (item?.type === "dynamicToolCall") {
        this.completeOpenNarrative();
        this.queueItemCompletion(item);
        return;
      }
      this.flushPendingCompletions();
      this.itemCompleted(item);
      return;
    }

    if (mapped.type === StreamEventType.TOOL_OUTPUT_DELTA) {
      const itemId = mapped.itemId;
      if (this.completedItems.has(itemId)) return;
      const current = this.items.get(itemId) || {
        id: itemId,
        type: "dynamicToolCall",
        tool: mapped.payload?.name || "tool",
        arguments: null,
        status: "completed",
        success: true,
        result: "",
      };
      const previous = String(current.result || "");
      const nextText = String(mapped.payload?.text || "");
      const { delta, mode } = deltaFromSnapshot(previous, nextText);
      const next = { ...current, result: nextText };
      this.items.set(itemId, next);
      this.updatePersistedItem(itemId, next);
      this.event(StreamEventType.TOOL_OUTPUT_DELTA, { delta, mode, name: mapped.payload?.name || next.tool }, { itemId });
    }
  }

  runStarted({ mode = "chat", skill = null, content = "正在处理…" } = {}) {
    this.startedAtMs = Date.now();
    this.turnStatus = "inProgress";
    return this.event(StreamEventType.TURN_STARTED, {
      turn: {
        id: this.turnId,
        status: "inProgress",
        startedAt: Math.floor(this.startedAtMs / 1000),
        completedAt: null,
        durationMs: null,
        items: [],
      },
      mode,
      skill,
      label: content,
      messageId: this.messageId,
    });
  }

  runCompleted({
    status = "completed",
    message = "处理完成",
    usage = null,
    error = null,
    answerStatus = null,
    answerItemId = null,
    answerSource = null,
    answerRejectionCode = null,
    emitTerminal = true,
  } = {}) {
    if (this.completedTurnEvent) return this.completedTurnEvent;
    const normalizedStatus = terminalTurnStatus(status);
    this.flushPendingCompletions();
    this.completeOpenNarrative();
    this.completedAtMs = Date.now();
    this.turnStatus = normalizedStatus;
    const answer = answerStatus
      ? {
          status: String(answerStatus),
          itemId: answerItemId || null,
          source: answerSource || null,
          rejectionCode: answerRejectionCode || null,
        }
      : null;
    const terminalPayload = {
      turn: {
        id: this.turnId,
        status: normalizedStatus,
        startedAt: this.startedAtMs ? Math.floor(this.startedAtMs / 1000) : null,
        completedAt: Math.floor(this.completedAtMs / 1000),
        durationMs: this.startedAtMs ? Math.max(0, this.completedAtMs - this.startedAtMs) : null,
        items: [],
        error: normalizedStatus === "failed" ? { message: String(error?.message || error || message || "处理失败") } : null,
        ...(answer ? { answer } : {}),
      },
      message,
      usage,
    };
    this.completedTurnEvent = emitTerminal
      ? this.event(StreamEventType.TURN_COMPLETED, terminalPayload)
      : createStreamEvent({
          type: StreamEventType.TURN_COMPLETED,
          threadId: this.threadId,
          turnId: this.turnId,
          seq: ++this.seq,
          payload: terminalPayload,
        });
    return this.completedTurnEvent;
  }

  runSuspended({ reason = "user_input", request_id = null, resumable = true, ...extra } = {}) {
    this.flushPendingCompletions();
    this.completeOpenNarrative();
    this.turnStatus = "suspended";
    return this.event(StreamEventType.TURN_STATUS_CHANGED, {
      status: "suspended",
      reason,
      request_id,
      resumable,
      ...extra,
    });
  }

  runResumed({ request_id = null, mode = "handle", ...extra } = {}) {
    this.turnStatus = "inProgress";
    return this.event(StreamEventType.TURN_STATUS_CHANGED, {
      status: "inProgress",
      request_id,
      mode,
      ...extra,
    });
  }

  runExpired({ request_id = null, reason = "resume_expired", ...extra } = {}) {
    this.turnStatus = "expired";
    return this.event(StreamEventType.TURN_STATUS_CHANGED, {
      status: "expired",
      request_id,
      reason,
      ...extra,
    });
  }

  content(content, opts = {}) {
    const normalized = normalizeAgentContent({ content, opts });
    const previousPersisted = this.persistedItems.get(normalized.contentId);
    const replaceableSnapshot = normalized.contentType === "plan"
      || normalized.metadata?.replace_snapshot === true
      || previousPersisted?.metadata?.replace_snapshot === true;
    if (this.completedItems.has(normalized.contentId) && !replaceableSnapshot) {
      return {
        contentId: normalized.contentId,
        item: this.persistedItems.get(normalized.contentId) || null,
      };
    }
    const nextPersisted = contentItemFromAgentContent({
      contentId: normalized.contentId,
      contentType: normalized.contentType,
      content,
      title: normalized.title,
      metadata: normalized.metadata,
    });
    const persisted = this.persistedItems.get(normalized.contentId);
    if (persisted) Object.assign(persisted, nextPersisted);
    else this.persistedItems.set(normalized.contentId, nextPersisted);

    const mappedEvents = streamEventsFromAgentContent(normalized);
    for (const mapped of mappedEvents) this.emitMapped(mapped);
    return {
      contentId: normalized.contentId,
      item: this.persistedItems.get(normalized.contentId),
    };
  }

  userInputRequested(payload = {}) {
    const requestId = String(payload.request_id || payload.user_input_id || "").trim();
    if (!requestId) return null;
    const id = `user_input:${requestId}`;
    return this.itemStarted({ id, type: "userInput", ...payload, request_id: requestId, status: "requested", visibility: "visible" });
  }

  userInputResolved({ request_id, value, status = "answered", ...extra } = {}) {
    const requestId = String(request_id || "").trim();
    if (!requestId) return null;
    const id = `user_input:${requestId}`;
    return this.itemCompleted({ id, type: "userInput", request_id: requestId, value, status, ...extra, visibility: "visible" });
  }

  turnMetadata() {
    return {
      thread_id: this.threadId,
      turn_id: this.turnId,
      message_id: this.messageId,
      turn_status: this.turnStatus,
      started_at: this.startedAtMs ? new Date(this.startedAtMs).toISOString() : null,
      completed_at: this.completedAtMs ? new Date(this.completedAtMs).toISOString() : null,
      duration_ms: this.startedAtMs && this.completedAtMs ? Math.max(0, this.completedAtMs - this.startedAtMs) : null,
    };
  }
}

export function createAgentStreamEmitter(options = {}) {
  return new AgentStreamEmitter(options);
}

export default {
  AgentStreamEmitter,
  createAgentStreamEmitter,
};
