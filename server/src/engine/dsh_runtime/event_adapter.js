// Shared id-generation + helpers for projecting DSH session events onto the
// desktop's existing runtime item vocabulary. Both the live event adapter
// (DshEventAdapter, below) and the cold-history adapter
// (dsh_history_adapter.js) import these so a given DSH event produces the
// SAME item id whether it arrives live on the mux stream or is replayed from
// session.history. Without this guarantee the renderer cannot dedupe a history
// block against a live stream block.

export function textFromBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : []).map((block) => {
    if (block?.type === "text") return String(block.text || "");
    if (block?.type === "tool-result") return textFromBlocks(block.content);
    return "";
  }).join("");
}

export function reasoningFromBlocks(blocks = []) {
  return (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === "reasoning")
    .map((block) => String(block.text || ""))
    .join("");
}

/** Stable item id for an assistant message derived from its DSH turn/step. */
export function assistantItemId(sessionId, event) {
  return `dsh:${sessionId}:assistant:${event?.data?.turn ?? "turn"}:${event?.data?.step ?? "step"}`;
}

/** Stable item id for a reasoning trace derived from its DSH turn/step. */
export function reasoningItemId(sessionId, event) {
  return `dsh:${sessionId}:reasoning:${event?.data?.turn ?? "turn"}:${event?.data?.step ?? "step"}`;
}

/** Stable turn id for a DSH turn (used as the renderer's turn grouping key). */
export function turnIdFrom(threadId, event) {
  return `dsh:${threadId}:turn:${event?.data?.turn ?? event?.seq ?? "turn"}`;
}

/** Stable tool-call item id from a tool/call event (prefers DSH callId, falls back to seq). */
export function toolCallItemId(event) {
  return String(event?.data?.callId || `dsh-tool:${event?.seq ?? ""}`);
}

/** Stable tool-result item id from a tool/result event (prefers source callId, falls back to seq). */
export function toolResultItemId(event) {
  return String(event?.message?.source?.callId || `dsh-tool:${event?.seq ?? ""}`);
}

export function parseArguments(value) {
  try { return JSON.parse(value); } catch { return String(value || ""); }
}

export function toolCallItemFromEvent(event, view = null) {
  return {
    id: toolCallItemId(event),
    type: "dynamicToolCall",
    tool: String(event?.data?.name || "tool"),
    arguments: parseArguments(event?.data?.arguments),
    status: "inProgress",
    dshView: view,
    dshCallView: view?.for === "call" ? view : null,
    dshResultView: null,
  };
}

export function toolResultItemFromEvent(event, view = null, callItem = null) {
  const resultBlock = event?.data?.message?.content?.find?.((block) => block?.type === "tool-result");
  const output = textFromBlocks(resultBlock?.content || event?.data?.message?.content);
  return {
    id: toolResultItemId(event?.data),
    type: "dynamicToolCall",
    tool: callItem?.tool || String(view?.view?.title || "tool"),
    arguments: callItem?.arguments,
    status: resultBlock?.isError || event?.data?.error ? "failed" : "completed",
    success: !(resultBlock?.isError || event?.data?.error),
    contentItems: output ? [{ type: "inputText", text: output }] : [],
    dshView: view,
    dshCallView: callItem?.dshCallView || (callItem?.dshView?.for === "call" ? callItem.dshView : null),
    dshResultView: view?.for === "result" ? view : null,
  };
}

function objectFromText(value) {
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Project a successful App Office write tool result into the existing workspace-event surface. */
export function workspaceEventFromToolResult(event, callItem = null) {
  const toolName = String(callItem?.tool || "");
  const eventName = toolName === "artifact_office_create"
    ? "artifact_published"
    : toolName === "artifact_office_edit"
      ? "artifact_edited"
      : null;
  if (!eventName) return null;
  const resultBlock = event?.data?.message?.content?.find?.((block) => block?.type === "tool-result");
  if (resultBlock?.isError || event?.data?.error) return null;
  const value = objectFromText(textFromBlocks(resultBlock?.content || event?.data?.message?.content));
  const artifact = value?.success === true ? value.artifact : null;
  const artifactId = String(artifact?.id || "").trim();
  if (!artifactId) return null;
  return {
    type: "workspace_event",
    event: eventName,
    project_id: artifact.project_id || callItem?.arguments?.project_id || null,
    session_id: artifact.current_version?.source_session_id || null,
    artifact_id: artifactId,
    artifact,
    open: true,
  };
}

/** Normalize a DSH todo into the renderer's plan-step shape. */
export function planStepFromTodo(todo) {
  return {
    step: String(todo?.content || ""),
    status: String(todo?.status || "pending"),
  };
}

/** Project DSH session events onto the desktop's existing runtime item vocabulary. */
export class DshEventAdapter {
  constructor({ sessionId, emit }) {
    this.sessionId = sessionId;
    this.emit = emit;
    this.turnId = null;
    this.toolCalls = new Map();
  }

  async handle(event, view = null) {
    if (!event || typeof event !== "object") return null;
    const threadId = this.sessionId;
    if (event.type === "turn/start") {
      this.turnId = turnIdFrom(threadId, event);
      await this.emit("turn/started", {
        threadId,
        turnId: this.turnId,
        turn: { id: this.turnId, status: "inProgress", startedAt: Number(event.time || Date.now()) / 1000 },
      });
      return { kind: "turn-start", turnId: this.turnId };
    }
    if (event.type === "assistant/chunk") {
      const chunk = event.data?.chunk || {};
      if (chunk.type === "text-delta") {
        await this.emit("item/agentMessage/delta", {
          threadId,
          turnId: this.turnId,
          itemId: assistantItemId(threadId, event),
          delta: String(chunk.text || ""),
        });
      } else if (chunk.type === "reasoning-delta") {
        await this.emit("item/reasoning/textDelta", {
          threadId,
          turnId: this.turnId,
          itemId: reasoningItemId(threadId, event),
          delta: String(chunk.text || ""),
        });
      }
      return null;
    }
    if (event.type === "assistant/message") {
      const text = textFromBlocks(event.data?.message?.content);
      if (text) {
        await this.emit("item/completed", {
          threadId,
          turnId: this.turnId,
          item: {
            id: assistantItemId(threadId, event),
            type: "agentMessage",
            text,
            status: "completed",
          },
        });
      }
      return null;
    }
    if (event.type === "tool/call") {
      const item = toolCallItemFromEvent(event, view);
      this.toolCalls.set(item.id, item);
      await this.emit("item/started", {
        threadId,
        turnId: this.turnId,
        item,
      });
      return null;
    }
    if (event.type === "tool/result") {
      const itemId = toolResultItemId(event.data);
      const callItem = this.toolCalls.get(itemId);
      const item = toolResultItemFromEvent(event, view, callItem);
      this.toolCalls.delete(itemId);
      await this.emit("item/completed", {
        threadId,
        turnId: this.turnId,
        item,
      });
      const workspaceEvent = workspaceEventFromToolResult(event, callItem);
      if (workspaceEvent) {
        await this.emit("item/completed", {
          threadId,
          turnId: this.turnId,
          item: { id: `${itemId}:workspace-event`, type: "workspaceEvent", data: workspaceEvent, visibility: "hidden" },
        });
      }
      return null;
    }
    if (event.type === "todo/write") {
      await this.emit("turn/plan/updated", {
        threadId,
        turnId: this.turnId,
        plan: (event.data?.todos || []).map(planStepFromTodo),
      });
      return null;
    }
    if (event.type === "turn/end") {
      const result = { kind: "turn-end", turnId: this.turnId, reason: event.data?.reason || { kind: "completed" } };
      this.toolCalls.clear();
      return result;
    }
    return null;
  }
}

export function dshTurnStatus(reason = {}) {
  const kind = String(reason?.kind || "").toLowerCase();
  if (["aborted", "cancelled", "canceled", "interrupted"].includes(kind)) return "interrupted";
  if (["completed", "stop", "success"].includes(kind)) return "completed";
  return "failed";
}
