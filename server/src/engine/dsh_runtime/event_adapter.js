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

/** Project a successful App product write tool result into the existing workspace-event surface. */
export function workspaceEventFromToolResult(event, callItem = null) {
  const toolName = String(callItem?.tool || "");
  const resultBlock = event?.data?.message?.content?.find?.((block) => block?.type === "tool-result");
  if (resultBlock?.isError || event?.data?.error) return null;
  const value = objectFromText(textFromBlocks(resultBlock?.content || event?.data?.message?.content));
  if (value?.success !== true) return null;
  if (["canvas_create", "canvas_edit", "canvas_suggest"].includes(toolName)) {
    const canvas = value.canvas;
    const canvasId = String(canvas?.id || "").trim();
    if (!canvasId) return null;
    const eventName = toolName === "canvas_suggest"
      ? "canvas_suggestion_created"
      : canvas.kind === "site"
        ? (toolName === "canvas_create" ? "site_opened" : "site_updated")
        : (toolName === "canvas_create" ? "canvas_opened" : "canvas_updated");
    return {
      type: "workspace_event",
      event: eventName,
      project_id: canvas.project_id || value.project_id || null,
      session_id: canvas.session_id || null,
      canvas_id: canvasId,
      canvas,
      open: true,
    };
  }
  const eventName = toolName === "artifact_office_create"
    ? "artifact_published"
    : toolName === "artifact_office_edit"
      ? "artifact_edited"
      : null;
  if (!eventName) return null;
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

/** Project a validated ui_render result into the conversation's structured-UI item. */
export function generativeUiItemFromToolResult(event, callItem = null) {
  if (String(callItem?.tool || "") !== "ui_render") return null;
  const resultBlock = event?.data?.message?.content?.find?.((block) => block?.type === "tool-result");
  if (resultBlock?.isError || event?.data?.error) return null;
  const value = objectFromText(textFromBlocks(resultBlock?.content || event?.data?.message?.content));
  const document = value?.success === true ? value.generative_ui : null;
  if (!document || typeof document !== "object" || Array.isArray(document)) return null;
  const itemId = `${toolResultItemId(event?.data)}:generative-ui`;
  return {
    id: itemId,
    type: "generativeUi",
    content: document,
    title: typeof document.title === "string" ? document.title : undefined,
    metadata: {
      item_type: "generativeUi",
      content_type: "generative_ui",
      result_role: "deliverable",
      surface_id: document.surface_id,
      revision: document.revision,
      document_hash: value.document_hash || null,
      generative_ui: {
        document,
        document_hash: value.document_hash || null,
      },
    },
  };
}

/** Project one DSH web-search result view into the desktop's source-card vocabulary. */
export function webSourcesItemFromToolResult(event, view = null) {
  const resultView = view?.for === "result" ? view.view : null;
  if (resultView?.card !== "web" || resultView?.kind !== "search" || !Array.isArray(resultView.sources)) return null;
  const sources = resultView.sources.flatMap((source, index) => {
    const url = String(source?.url || "").trim();
    if (!/^https?:\/\//i.test(url)) return [];
    return [{
      source_id: `S${index + 1}`,
      url,
      title: String(source?.title || url).trim(),
      excerpt: String(source?.snippet || "").trim(),
      published_at: String(source?.publishedAt || "").trim(),
    }];
  });
  if (!sources.length) return null;
  return {
    id: `${toolResultItemId(event?.data)}:web-sources`,
    type: "web_sources",
    content: JSON.stringify({ sources }),
    status: "completed",
  };
}

/** Normalize a DSH todo into the renderer's plan-step shape. */
export function planStepFromTodo(todo) {
  return {
    step: String(todo?.content || ""),
    status: String(todo?.status || "pending"),
  };
}

/** Project one product-memory recall from its logged DSH user/message source. */
export function dshWorkMemoryItem(sessionId, event) {
  const source = event?.data?.source;
  const memory = source?.kind === "plugin" && source?.plugin === "dsh-work-memory"
    ? source.dshWorkMemory
    : null;
  if (!memory || !["global_memory", "project_memory"].includes(memory.type)) return null;
  return {
    id: `dsh:${sessionId}:memory:${event?.seq ?? "context"}`,
    type: memory.type,
    content: JSON.stringify(memory.content || {}),
    status: "completed",
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
    if (event.type === "user/message") {
      const item = dshWorkMemoryItem(threadId, event);
      if (item) {
        await this.emit("item/completed", {
          threadId,
          turnId: this.turnId,
          item,
        });
      }
      return null;
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
      const webSources = webSourcesItemFromToolResult(event, view);
      if (webSources) {
        await this.emit("item/completed", {
          threadId,
          turnId: this.turnId,
          item: webSources,
        });
      }
      const generativeUi = generativeUiItemFromToolResult(event, callItem);
      if (generativeUi) {
        await this.emit("item/completed", {
          threadId,
          turnId: this.turnId,
          item: generativeUi,
        });
      }
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
