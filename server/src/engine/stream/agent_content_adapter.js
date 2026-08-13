import { randomUUID } from "node:crypto";
import { StreamEventType } from "./agent_stream_protocol.js";
import { artifactPayloadFromPath } from "./ui_capabilities.js";

const TRACE_TEXT_MAX = Math.max(0, Number(process.env.DSH_TRACE_TEXT_MAX || 0));
const DELIVERABLE_CONTENT_TYPES = new Set([
  "json", "table", "chart", "image", "audio", "html", "pdf", "file", "action", "generative_ui",
]);

function traceText(value) {
  const text = value == null ? "" : String(value);
  return TRACE_TEXT_MAX > 0 && text.length > TRACE_TEXT_MAX ? text.slice(0, TRACE_TEXT_MAX) : text;
}

function parseJson(text) {
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeUserInputPayload(content, metadata = {}, title = "") {
  const data = parseJson(content) || (content && typeof content === "object" ? content : {});
  const requestId = String(data.request_id || metadata.request_id || metadata.user_input_id || "").trim();
  return {
    ...data,
    request_id: requestId,
    prompt: String(data.prompt || metadata.prompt || title || "需要您确认"),
    options: Array.isArray(data.options) ? data.options : [],
    allow_multiple: Boolean(data.allow_multiple),
  };
}

function toolNameFromContent(content) {
  return String(content || "").trim().split(/\s+/)[0] || "";
}

function toolCallIdFromResultId(contentId) {
  return String(contentId || "").replace(/^result:/, "");
}

function normalizeToolStatus(title) {
  if (title === "error") return "failed";
  if (title === "rejected") return "declined";
  if (title === "stopped") return "interrupted";
  if (title === "running") return "inProgress";
  return "completed";
}

function messageResultRole(title, metadata = {}, contentType = "") {
  const explicit = String(metadata?.result_role || "").trim();
  if (explicit === "deliverable" || explicit === "intermediate") return explicit;
  if (DELIVERABLE_CONTENT_TYPES.has(String(contentType || "").trim())) return "deliverable";
  return null;
}

function canonicalMetadata(metadata = {}) {
  const out = { ...(metadata || {}) };
  const rawPhase = String(out.phase || out.msg_category || "").trim();
  for (const key of ["phase", "msg_category", "resultRole", "candidate_status"]) {
    delete out[key];
  }
  if (rawPhase === "commentary" || rawPhase === "final_answer") out.phase = rawPhase;
  return out;
}

function planSteps(content) {
  const parsed = parseJson(content);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((step) => ({
    ...step,
    step: String(step?.step || step?.title || ""),
    status: ["done", "completed", "complete"].includes(String(step?.status || "").toLowerCase())
      ? "completed"
      : String(step?.status || "").toLowerCase() === "skipped"
        ? "skipped"
      : ["doing", "running", "in_progress", "inProgress"].includes(String(step?.status || ""))
        ? "inProgress"
        : "pending",
  }));
}

export function normalizeAgentContent({ content, opts = {} } = {}) {
  const contentId = opts.content_id || randomUUID();
  const contentType = opts.content_type || "text";
  const { content_id: _contentId, content_type: _contentType, title: _title, ...meta } = opts;
  return {
    contentId,
    contentType,
    content,
    title: opts.title,
    metadata: { display: true, ...canonicalMetadata(meta) },
  };
}

function displayTypeFromContent(contentType, content, metadata) {
  if (metadata?.display_type) return metadata.display_type;
  if (contentType === "json") {
    const data = parseJson(content);
    return data?.display_type || data?.chart_type || "table";
  }
  if (contentType === "markdown") return "text";
  return contentType;
}

function tracePayloadMetadata(metadata = {}) {
  const out = {};
  for (const key of [
    "task_group",
    "tool_name",
    "display_type",
    "evidence_ref",
    "validation_ref",
    "evidence_bundle_ref",
    "plugin_name",
    "plugin_renderer",
    "artifact_type",
    "source_tool_call_id",
    "memory_citation",
    "phase",
    "result_role",
    "answer_status",
    "answer_source",
    "answer_rejection_code",
    "artifact_id",
    "artifact_version_id",
    "surface_id",
    "revision",
  ]) {
    if (metadata?.[key] != null) out[key] = metadata[key];
  }
  if (Object.hasOwn(metadata || {}, "replaces_item_id")) out.replaces_item_id = metadata.replaces_item_id ?? null;
  if (metadata?.generative_ui && typeof metadata.generative_ui === "object") out.generative_ui = metadata.generative_ui;
  if (metadata?.usage && typeof metadata.usage === "object") out.usage = metadata.usage;
  if (metadata?.trace_usage && typeof metadata.trace_usage === "object") out.usage = metadata.trace_usage;
  if (metadata?.plugin_options && typeof metadata.plugin_options === "object") out.plugin_options = metadata.plugin_options;
  if (metadata?.output_artifact && typeof metadata.output_artifact === "object") out.output_artifact = metadata.output_artifact;
  if (metadata?.output_delivery && typeof metadata.output_delivery === "object") out.output_delivery = metadata.output_delivery;
  if (metadata?.model != null) out.model = metadata.model;
  if (metadata?.model_id != null) out.model_id = metadata.model_id;
  return out;
}

export function contentItemFromAgentContent({ contentId, contentType, content, title, metadata } = {}) {
  const displayType = displayTypeFromContent(contentType, content, metadata);
  const resultRole = messageResultRole(title, metadata, contentType);
  const itemType = contentType === "thinking"
    ? "reasoning"
    : contentType === "file_change"
      ? "fileChange"
    : contentType === "tool"
      ? "dynamicToolCall"
      : contentType === "tool_result"
        ? "toolResult"
        : contentType === "plan"
          ? "plan"
          : contentType === "confirm"
            ? "approval"
            : contentType === "user_input"
              ? "userInput"
              : contentType === "skill_invocation"
                ? "dshExtension"
                : contentType === "generative_ui"
                  ? "generativeUi"
                : contentType === "delegated_subtask"
                  ? "subtask"
              : contentType === "workspace_event"
                  ? "workspaceEvent"
                  : contentType === "compact"
                    ? "contextCompaction"
                  : contentType === "json" || ["table", "chart", "image", "audio", "html", "pdf", "file", "action"].includes(contentType)
                    ? "dataResult"
                    : contentType === "error"
                      ? "error"
                      : "agentMessage";
  return {
    id: contentId,
    type: contentType,
    content,
    title,
    metadata: {
      ...canonicalMetadata(metadata),
      item_type: itemType,
      ...(resultRole ? { result_role: resultRole } : {}),
    },
    display_type: displayType,
    is_streaming: false,
    is_complete: true,
  };
}

export function streamEventsFromAgentContent({ contentId, contentType, content, title, metadata } = {}) {
  const visibility = metadata?.display === false ? "hidden" : "visible";
  const resultRole = messageResultRole(title, metadata, contentType);
  const traceMetadata = tracePayloadMetadata(canonicalMetadata(metadata));

  if (contentType === "compact") {
    const completed = title !== "running";
    return [{
      type: completed ? StreamEventType.ITEM_COMPLETED : StreamEventType.ITEM_STARTED,
      itemId: contentId,
      payload: { item: {
        id: contentId,
        type: "contextCompaction",
        status: completed ? "completed" : "inProgress",
        trigger: metadata?.trigger || "auto",
        visibility,
      } },
    }];
  }

  if (contentType === "file_change") return [];

  if (contentType === "delegated_subtask") {
    const data = parseJson(content) || {};
    const status = String(data.status || metadata?.status || "running");
    return [{
      type: status === "running" ? StreamEventType.ITEM_STARTED : StreamEventType.ITEM_COMPLETED,
      itemId: contentId,
      payload: { item: {
        id: contentId,
        type: "subtask",
        runId: data.run_id || null,
        parentRunId: data.parent_run_id || null,
        callId: data.call_id || null,
        subtaskType: data.type || null,
        title: data.title || title || "子任务",
        tool: data.tool_name || null,
        status: status === "running"
          ? "inProgress"
          : status === "failed"
            ? "failed"
            : status === "interrupted"
              ? "interrupted"
              : status === "skipped"
                ? "skipped"
                : "completed",
        summary: data.summary || "",
        error: data.error || null,
        parallelGroup: data.parallel_group || null,
        visibility,
      } },
    }];
  }

  if (contentType === "skill_invocation") {
    // Codex 0.147.0 models an explicit Skill as UserInput, not ThreadItem.
    // Do not emit a fake item/started or item/completed lifecycle for it.
    return [];
  }

  if (contentType === "plan") {
    const plan = planSteps(content);
    return [{
      type: StreamEventType.TURN_PLAN_UPDATED,
      itemId: contentId,
      payload: {
        item: { id: contentId, type: "plan", text: JSON.stringify(plan), visibility },
        plan,
        explanation: metadata?.explanation || null,
      },
    }];
  }

  if (contentType === "thinking") {
    return [{
      type: StreamEventType.REASONING_SUMMARY_DELTA,
      itemId: contentId,
      startItem: { id: contentId, type: "reasoning", summary: [], content: [], visibility },
      payload: {
        text: String(content || ""),
        summaryIndex: 0,
        visibility,
        usage: metadata?.usage || metadata?.trace_usage || null,
        model: metadata?.model || metadata?.model_id || null,
        metadata: traceMetadata,
      },
    }];
  }

  if (contentType === "markdown" || contentType === "text") {
    const phase = metadata?.phase === "commentary" || metadata?.phase === "final_answer"
      ? metadata.phase
      : null;
    return [{
      type: StreamEventType.AGENT_MESSAGE_DELTA,
      itemId: contentId,
      startItem: {
        id: contentId,
        type: "agentMessage",
        text: "",
        visibility,
        ...(phase ? { phase } : {}),
      },
      payload: {
        text: String(content || ""),
        format: contentType,
        title,
        visibility,
        ...(phase ? { phase } : {}),
        usage: metadata?.usage || metadata?.trace_usage || null,
        model: metadata?.model || metadata?.model_id || null,
        metadata: traceMetadata,
      },
    }];
  }

  if (contentType === "generative_ui") {
    return [{
      type: StreamEventType.ITEM_COMPLETED,
      itemId: contentId,
      payload: { item: {
        id: contentId,
        type: "generativeUi",
        content: String(content || ""),
        title,
        metadata: {
          ...traceMetadata,
          result_role: resultRole || "deliverable",
        },
        visibility,
      } },
    }];
  }

  if (contentType === "json" || ["table", "chart", "image", "audio", "html", "pdf", "file", "action"].includes(contentType)) {
    return [{
      type: StreamEventType.ITEM_COMPLETED,
      itemId: contentId,
      payload: { item: {
        id: contentId,
        type: "dataResult",
        format: contentType,
        displayType: displayTypeFromContent(contentType, content, metadata),
        content,
        title,
        metadata: {
          ...traceMetadata,
          result_role: resultRole || "deliverable",
        },
        visibility,
      } },
    }];
  }

  if (contentType === "tool") {
    const name = metadata?.tool_name || toolNameFromContent(content);
    const argsPreview = String(content || "").slice(name.length).trim();
    const traceInput = metadata?.trace_input || metadata?.traceInput || "";
    const traceOutput = metadata?.trace_output || metadata?.traceOutput || "";
    if (title === "running") {
      return [{
        type: StreamEventType.ITEM_STARTED,
        itemId: contentId,
        payload: { item: {
          id: contentId,
          type: "dynamicToolCall",
          tool: name,
          namespace: metadata?.where || (String(name).startsWith("mcp_") ? "cloud" : "local"),
          arguments: traceInput || argsPreview,
          status: "inProgress",
          success: null,
          durationMs: null,
          result: null,
          skill: metadata?.skill_name || null,
          visibility,
        } },
      }];
    }
    const toolEvent = {
      type: StreamEventType.ITEM_COMPLETED,
      itemId: contentId,
      payload: { item: {
        id: contentId,
        type: "dynamicToolCall",
        tool: name,
        namespace: metadata?.where || (String(name).startsWith("mcp_") ? "cloud" : "local"),
        arguments: traceInput || argsPreview,
        status: normalizeToolStatus(title),
        success: title === "done",
        durationMs: metadata?.duration_ms || metadata?.durationMs || null,
        result: traceOutput || null,
        skill: metadata?.skill_name || null,
        visibility,
      } },
    };
    const artifact = artifactPayloadFromPath(metadata?.artifact, {
      source_tool_call_id: contentId,
      source_tool_name: name,
    });
    return artifact
      ? [
          toolEvent,
          {
            type: StreamEventType.ITEM_COMPLETED,
            itemId: artifact.artifact_id || `${contentId}:artifact`,
            payload: { item: {
              id: artifact.artifact_id || `${contentId}:artifact`,
              type: "artifact",
              ...artifact,
              visibility: "visible",
            } },
          },
        ]
      : [toolEvent];
  }

  if (contentType === "tool_result") {
    const name = metadata?.tool_name || title || "";
    return [{
      type: StreamEventType.TOOL_OUTPUT_DELTA,
      itemId: toolCallIdFromResultId(contentId),
      payload: {
        name,
        text: traceText(content),
      },
    }];
  }

  if (contentType === "confirm") {
    const toolCallId = metadata?.tool_call_id || String(contentId).replace(/^confirm:/, "");
    const approvalRequest = metadata?.approval_request || null;
    if (title === "approved" || title === "rejected") {
      return [{
        type: StreamEventType.ITEM_COMPLETED,
        itemId: contentId,
        payload: { item: {
          id: contentId,
          type: "approval",
          toolCallId,
          approved: title === "approved",
          summary: String(content || ""),
          status: title,
          approvalRequest,
          visibility: "visible",
        } },
      }];
    }
    return [{
      type: StreamEventType.ITEM_STARTED,
      itemId: contentId,
      payload: { item: {
        id: contentId,
        type: "approval",
        toolCallId,
        tool: title || toolNameFromContent(content),
        risk: metadata?.risk || "tool_use",
        summary: String(content || ""),
        status: "requested",
        approvalRequest,
        visibility: "visible",
      } },
    }];
  }

  if (contentType === "workspace_event") {
    const data = metadata?.workspace_event || parseJson(content) || {};
    return [{
      type: StreamEventType.ITEM_COMPLETED,
      itemId: contentId,
      payload: { item: { id: contentId, type: "workspaceEvent", data, visibility: "hidden" } },
    }];
  }

  if (contentType === "user_input") {
    const data = normalizeUserInputPayload(content, metadata, title);
    return [{
      type: StreamEventType.ITEM_STARTED,
      itemId: contentId,
      payload: { item: { id: contentId, type: "userInput", ...data, status: "requested", visibility: "visible" } },
    }];
  }

  return [{
    type: StreamEventType.ITEM_COMPLETED,
    itemId: contentId,
    payload: { item: {
      id: contentId,
      type: contentType === "error" ? "error" : "dataResult",
      format: contentType,
      content,
      title,
      metadata: {
        ...traceMetadata,
        ...(resultRole ? { result_role: resultRole } : {}),
      },
      visibility,
    } },
  }];
}

export function streamEventFromAgentContent(content = {}) {
  return streamEventsFromAgentContent(content)[0] || null;
}

export default {
  normalizeAgentContent,
  contentItemFromAgentContent,
  streamEventFromAgentContent,
  streamEventsFromAgentContent,
};
