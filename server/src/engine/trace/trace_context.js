import { AsyncLocalStorage } from "node:async_hooks";

const traceStorage = new AsyncLocalStorage();
let internalToolSeq = 0;

function currentTraceStore() {
  const store = traceStorage.getStore();
  if (!store) return null;
  if (store.recorder) return store;
  return { recorder: store, activeSpanStack: [] };
}

export function runWithTraceContext(recorder, fn) {
  if (!recorder || typeof fn !== "function") return fn();
  const current = currentTraceStore();
  const activeSpanStack = current?.recorder === recorder && Array.isArray(current.activeSpanStack)
    ? [...current.activeSpanStack]
    : [];
  return traceStorage.run({ recorder, activeSpanStack }, fn);
}

export function activeTraceRecorder() {
  return currentTraceStore()?.recorder || null;
}

export function activeTraceSpanId() {
  const stack = currentTraceStore()?.activeSpanStack;
  return Array.isArray(stack) && stack.length ? stack[stack.length - 1] : "";
}

function runWithActiveTraceSpan(spanId, fn) {
  if (typeof fn !== "function") return undefined;
  const store = currentTraceStore();
  if (!store || !spanId) return fn();
  const activeSpanStack = Array.isArray(store.activeSpanStack) ? [...store.activeSpanStack] : [];
  const existing = activeSpanStack.lastIndexOf(spanId);
  if (existing >= 0) activeSpanStack.splice(existing, 1);
  activeSpanStack.push(spanId);
  return traceStorage.run({ recorder: store.recorder, activeSpanStack }, fn);
}

export function recordTraceLlmCall(event = {}) {
  const recorder = activeTraceRecorder();
  if (recorder && typeof recorder.recordLlmCall === "function") {
    recorder.recordLlmCall(event);
  }
}

export function currentTraceSpan() {
  const recorder = activeTraceRecorder();
  const spanId = activeTraceSpanId();
  if (spanId && recorder && typeof recorder.traceSpanInfo === "function") {
    return recorder.traceSpanInfo(spanId);
  }
  if (recorder && typeof recorder.currentTraceSpanInfo === "function") {
    return recorder.currentTraceSpanInfo();
  }
  return null;
}

function jsonText(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolResultText(result) {
  if (result == null) return "";
  if (typeof result === "string") return result;
  const content = result.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part) return "";
        if (typeof part === "string") return part;
        if (part.type === "text") return part.text || "";
        if (part.text != null) return String(part.text);
        return jsonText(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  return jsonText(result);
}

function agentResultText(result) {
  return jsonText(result);
}

function safeToken(value) {
  return String(value || "tool").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "tool";
}

export async function traceAgentCall({
  name = "",
  input = null,
  attrs = {},
  resultToText = agentResultText,
} = {}, fn) {
  if (typeof fn !== "function") return undefined;
  const recorder = activeTraceRecorder();
  if (!recorder || typeof recorder.recordAgentStart !== "function" || typeof recorder.recordAgentEnd !== "function") {
    return fn();
  }

  const startedAt = Date.now();
  let spanId = "";
  let result;
  let error = null;
  spanId = recorder.recordAgentStart({
    name,
    input: jsonText(input),
    attrs,
    parentSpanId: activeTraceSpanId(),
  });
  try {
    result = await runWithActiveTraceSpan(spanId, fn);
    return result;
  } catch (err) {
    error = err;
    throw err;
  } finally {
    let output = "";
    if (!error) {
      try {
        output = resultToText(result);
      } catch {
        output = agentResultText(result);
      }
    }
    recorder.recordAgentEnd({
      spanId,
      name,
      input: jsonText(input),
      output,
      error,
      durationMs: Date.now() - startedAt,
      attrs,
    });
  }
}

export async function traceToolCall({
  toolCallId = "",
  name = "",
  input = null,
  attrs = {},
  resultToText = toolResultText,
  statusFromResult = null,
} = {}, fn) {
  if (typeof fn !== "function") return undefined;
  const recorder = activeTraceRecorder();
  if (!recorder || typeof recorder.recordToolStart !== "function" || typeof recorder.recordToolEnd !== "function") {
    return fn();
  }

  const startedAt = Date.now();
  const resolvedToolCallId =
    String(toolCallId || "").trim() || `dsh-tool:${safeToken(name || "tool")}:${Date.now()}:${++internalToolSeq}`;
  let result;
  let error = null;
  recorder.recordToolStart({
    toolCallId: resolvedToolCallId,
    name,
    input: jsonText(input),
    attrs,
    parentSpanId: activeTraceSpanId(),
  });
  try {
    result = await runWithActiveTraceSpan(resolvedToolCallId, fn);
    return result;
  } catch (err) {
    error = err;
    throw err;
  } finally {
    let output = "";
    if (!error) {
      try {
        output = resultToText(result);
      } catch {
        output = toolResultText(result);
      }
    }
    recorder.recordToolEnd({
      toolCallId: resolvedToolCallId,
      name,
      input: jsonText(input),
      output,
      error,
      status: !error && typeof statusFromResult === "function" ? statusFromResult(result) : 0,
      durationMs: Date.now() - startedAt,
      attrs,
    });
  }
}

export function withAgentToolLifecycle(tool, attrs = {}) {
  if (!tool || typeof tool.execute !== "function" || tool.__agenticTraceWrapped) return tool;
  const originalExecute = tool.execute.bind(tool);
  return {
    ...tool,
    __agenticTraceWrapped: true,
    async execute(toolCallId, params, signal, onUpdate) {
      return traceToolCall(
        {
          toolCallId,
          name: tool.name || tool.label || "",
          input: params || {},
          attrs: {
            trace_source: "agent_tool",
            ...(attrs && typeof attrs === "object" ? attrs : {}),
          },
        },
        () => originalExecute(toolCallId, params, signal, onUpdate),
      );
    },
  };
}

export function withAgentToolLifecycles(tools = [], attrs = {}) {
  return Array.isArray(tools) ? tools.map((tool) => withAgentToolLifecycle(tool, attrs)) : [];
}

export const withTraceTool = withAgentToolLifecycle;
export const withTraceTools = withAgentToolLifecycles;
