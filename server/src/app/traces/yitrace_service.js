import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

import { StreamEventType } from "../../engine/stream/agent_stream_protocol.js";
import { activeTraceSpanId } from "../../engine/trace/trace_context.js";
import { dataPath } from "../../config/paths.js";

const DEFAULT_TENANT_ID = 1;
const TRACE_ROOT_SPAN_ID = "dsh-run";
const LLM_SPAN_PREFIX = "dsh-llm";
const AGENT_SPAN_PREFIX = "dsh-agent";
const TRACE_TEXT_MAX = Math.max(0, Number(process.env.DSH_TRACE_TEXT_MAX || 0));
const MAX_SPAN_DETAILS = 40;

let modulePromise = null;
let dbPromise = null;
let loadErrorLogged = false;
let openErrorLogged = false;

function traceEnabled() {
  return process.env.DSH_TRACE !== "0";
}

function dataDir() {
  return process.env.DSH_YITRACE_DIR || dataPath("yitrace");
}

function lockPath(dir = dataDir()) {
  return join(dir, ".yitrace.lock");
}

function staleLockPath(dir = dataDir()) {
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  return join(dir, `.yitrace.lock.stale-${stamp}-${process.pid}`);
}

function isLockError(error) {
  const message = String(error?.message || error || "");
  return message.includes(".yitrace.lock") || message.includes("already open or locked");
}

function isFileOpen(path) {
  try {
    execFileSync("lsof", [path], { stdio: ["ignore", "pipe", "ignore"], timeout: 1000 });
    return true;
  } catch {
    return false;
  }
}

function recoverStaleLock(error, dir = dataDir()) {
  if (process.env.DSH_YITRACE_STALE_LOCK_RECOVERY === "0") return false;
  if (!isLockError(error)) return false;
  const currentLock = lockPath(dir);
  if (!existsSync(currentLock)) return false;
  if (isFileOpen(currentLock)) {
    console.warn("[yitrace] trace DB lock 当前仍被进程持有,不自动恢复:", currentLock);
    return false;
  }
  const stale = staleLockPath(dir);
  try {
    renameSync(currentLock, stale);
    console.warn("[yitrace] 检测到遗留 trace DB lock,已改名并重试:", stale);
    return true;
  } catch (renameError) {
    console.warn("[yitrace] trace DB lock 恢复失败:", renameError?.message || renameError);
    return false;
  }
}

function clip(value, max = TRACE_TEXT_MAX) {
  const text = value == null ? "" : String(value);
  const limit = Math.max(0, Number(max || 0));
  return limit > 0 && text.length > limit ? `${text.slice(0, limit).trimEnd()}...` : text;
}

function jsonText(value, max = TRACE_TEXT_MAX) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return clip(value, max);
  try {
    return clip(JSON.stringify(value), max);
  } catch {
    return clip(String(value), max);
  }
}

function parseMaybeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function textFromContentItems(value) {
  const items = parseMaybeJson(value, []);
  if (!Array.isArray(items)) return "";
  return items
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      if (item.type === "text" || item.display_type === "text") return String(item.content || "");
      return "";
    })
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function traceText(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return clip(value);
  try {
    return clip(JSON.stringify(value));
  } catch {
    return clip(String(value));
  }
}

function toolInputFromPayload(payload = {}) {
  return traceText(payload.input || payload.trace_input || payload.traceInput || payload.args || payload.args_preview);
}

function toolOutputFromPayload(payload = {}) {
  return traceText(payload.output || payload.trace_output || payload.traceOutput || payload.result || payload.result_preview);
}

function contentItemText(item) {
  if (!item || typeof item !== "object") return "";
  const title = String(item.title || "").trim();
  const content = item.content;
  let body = "";
  if (typeof content === "string") {
    body = content;
  } else if (content && typeof content === "object") {
    try {
      body = JSON.stringify(content);
    } catch {
      body = String(content);
    }
  }
  const text = [title, body].filter(Boolean).join("\n");
  return clip(text);
}

function isTraceTextItem(item) {
  if (!item || typeof item !== "object") return false;
  if (!["thinking", "markdown", "text", "json"].includes(String(item.type || ""))) return false;
  const meta = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
  return meta.display !== false;
}

function llmSnapshotName(item) {
  if (item?.type === "thinking") return "LLM 思考";
  const meta = item?.metadata && typeof item.metadata === "object" ? item.metadata : {};
  if (meta.answer_status === "accepted") return "LLM 返回";
  return "LLM 输出";
}

function safeSpanToken(value) {
  return String(value || "span").replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "span";
}

function traceSnapshotsFromMessages(rows = []) {
  const snapshots = new Map();
  const llmByQuestionNo = new Map();
  let questionNo = 0;
  let questionText = "";
  for (const row of rows) {
    const items = parseMaybeJson(row.content_items, []);
    if (!Array.isArray(items)) continue;
    if (row.role === "user") {
      questionNo += 1;
      questionText = textFromContentItems(row.content_items);
      continue;
    }
    if (row.role !== "assistant" || questionNo <= 0) continue;
    const toolStack = [];
    const currentToolId = () => toolStack[toolStack.length - 1] || "";
    const activateTool = (toolId) => {
      if (!toolId) return;
      const index = toolStack.lastIndexOf(toolId);
      if (index >= 0) toolStack.splice(index, 1);
      toolStack.push(toolId);
    };
    const finishCurrentTool = () => {
      if (toolStack.length) toolStack.pop();
    };
    let order = 0;
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const meta = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
      if (item.type === "tool") {
        order += 1;
        const toolId = String(item.id || "").trim();
        const parentToolId = String(meta.parent_tool_call_id || "").trim();
        if (toolId) {
          const prev = snapshots.get(toolId) || {};
          snapshots.set(toolId, {
            ...prev,
            order: prev.order ?? order,
            parentToolId: prev.parentToolId || parentToolId || "",
            input: prev.input || contentItemText(item),
          });
          toolStack.length = 0;
          activateTool(toolId);
        }
        continue;
      }
      if (item.type === "plan" || item.type === "skill_invocation" || item.type === "tool") continue;
      if (isTraceTextItem(item)) {
        order += 1;
        const text = contentItemText(item);
          if (text) {
            const list = llmByQuestionNo.get(questionNo) || [];
          const parentToolId = String(meta.parent_tool_call_id || "").trim();
          list.push({
            id: `${LLM_SPAN_PREFIX}:history:${questionNo}:${order}:${item.id || list.length}`,
            name: llmSnapshotName(item),
            parentToolId,
            input: questionText,
            output: text,
            order,
            attrs: {
              channel: item.type,
              title: item.title || "",
              answer_status: meta.answer_status || "",
              parent_tool_call_id: parentToolId,
            },
          });
          llmByQuestionNo.set(questionNo, list);
        }
      }
      const activeToolId = currentToolId();
      if (!activeToolId) continue;
      if (meta.answer_status === "accepted") {
        toolStack.length = 0;
        continue;
      }
      const canBackfillToolOutput = item.type === "table"
        || item.type === "tool_result"
        || meta.result_role === "intermediate";
      if (!canBackfillToolOutput) continue;
      const text = contentItemText(item);
      if (!text) continue;
      const prev = snapshots.get(activeToolId) || {};
      snapshots.set(activeToolId, {
        ...prev,
        output: prev.output ? `${prev.output}\n\n${text}` : text,
      });
      if (item.type === "table" || meta.result_role === "intermediate") finishCurrentTool();
    }
  }
  return { toolSnapshots: snapshots, llmByQuestionNo };
}

function messagesFromLogEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.flatMap((event) => {
    if (!event || typeof event !== "object") return [];
    if (Array.isArray(event.messages)) return event.messages;
    if (Array.isArray(event.logs)) return event.logs;
    if (event.message != null) return [event.message];
    return [];
  });
}

function uniqueClippedLogs(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = clip(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function runTimeMs(run) {
  const candidates = [run?.created_at, run?.updated_at, run?.finished_at]
    .map((value) => new Date(value || "").getTime())
    .filter((value) => Number.isFinite(value));
  return candidates.length ? Math.max(...candidates) : 0;
}

function traceQuestionText(trace) {
  const spans = Array.isArray(trace?.spans) ? trace.spans : [];
  const root = spans.find((span) => Number(span?.depth || 0) === 0) || spans[0];
  return compactText(root?.input);
}

function fallbackQuestionFromTrace(trace) {
  const questionText = traceQuestionText(trace);
  if (!questionText) return null;
  return {
    questionNo: 0,
    questionMessageId: null,
    questionText,
    sequenceNumber: null,
    createdAt: null,
  };
}

function questionForRun(run, questions = [], trace = null) {
  const traceText = traceQuestionText(trace);
  if (traceText && questions.length) {
    const matched = questions.find((question) => {
      const candidate = compactText(question.questionText);
      return candidate === traceText || candidate.includes(traceText) || traceText.includes(candidate);
    });
    if (matched) return matched;
  }
  if (!questions.length) return fallbackQuestionFromTrace(trace);
  const marker = runTimeMs(run);
  if (!marker) return questions[questions.length - 1];
  const before = questions.filter((question) => question.timeMs && question.timeMs <= marker);
  return before[before.length - 1] || questions[questions.length - 1];
}

function nowNs() {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

function msToNs(ms) {
  return (BigInt(Math.max(0, Math.floor(Number(ms) || 0))) * 1_000_000n).toString();
}

function durationNsSince(startMs) {
  return (BigInt(Math.max(0, Date.now() - startMs)) * 1_000_000n).toString();
}

function safeStatus(status) {
  return status === "completed" || status === "ok" || status === "suspended" || status === 0 ? 0 : 1;
}

function numberFrom(...values) {
  for (const value of values) {
    const n = Number(value || 0);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

function timestampMs(value) {
  const numeric = Number(value || 0);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = new Date(value || "").getTime();
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function runStartMs(run) {
  return timestampMs(run?.created_at || run?.createdAt);
}

function runWallDurationMs(run) {
  const startMs = runStartMs(run);
  const endMs = timestampMs(
    run?.finished_at || run?.finishedAt || run?.updated_at || run?.updatedAt,
  );
  return startMs > 0 && endMs >= startMs ? endMs - startMs : 0;
}

function encodedSpanStartMs(span) {
  const attrs = span?.attrs && typeof span.attrs === "object" ? span.attrs : {};
  const recorded = numberFrom(attrs.trace_started_at_ms, attrs.trace_start_ms);
  if (recorded) return recorded;

  const externalSpanId = String(span?.externalSpanId || span?.external_span_id || "");
  const durationMs = numberFrom(span?.durMs, span?.duration_ms);
  const llmCallMatch = externalSpanId.match(/:call:(\d{13}):\d+$/);
  if (llmCallMatch) return Math.max(0, Number(llmCallMatch[1]) - durationMs);

  const timedSpanMatch = externalSpanId.match(/^dsh-(?:agent|tool):.*:(\d{13}):\d+$/);
  return timedSpanMatch ? Number(timedSpanMatch[1]) : 0;
}

function clampTimelineStart(startMs, durationMs, rangeStartMs, rangeDurationMs) {
  const minStart = Math.max(0, Number(rangeStartMs || 0));
  const maxStart = Math.max(
    minStart,
    minStart + Math.max(0, Number(rangeDurationMs || 0) - Math.max(0, Number(durationMs || 0))),
  );
  return Math.round(Math.min(maxStart, Math.max(minStart, Number(startMs || 0))));
}

function normalizeTraceTiming(spans, summary = {}, run = null) {
  const root = spans.find((span) => Number(span.depth || 0) === 0) || null;
  const summaryDurationMs = numberFrom(summary.durMs, summary.duration_ms);
  const rootDurationMs = numberFrom(root?.durMs, root?.duration_ms);
  const wallDurationMs = runWallDurationMs(run) || rootDurationMs || summaryDurationMs;
  const startedAtMs = runStartMs(run);
  const rawStartBySpan = new Map(spans.map((span) => [span, Number(span.startMs || 0)]));
  const positioned = new Set();

  if (root) {
    root.startMs = 0;
    root.durMs = wallDurationMs;
    positioned.add(root);
  }

  for (const span of spans) {
    if (span === root) continue;
    const absoluteStartMs = encodedSpanStartMs(span);
    if (!absoluteStartMs || !startedAtMs) continue;
    span.startMs = clampTimelineStart(
      absoluteStartMs - startedAtMs,
      span.durMs,
      0,
      wallDurationMs,
    );
    positioned.add(span);
  }

  let orderedCursorMs = 0;
  const orderedSpans = spans
    .filter((span) => Number(span.depth || 0) > 0 && Number(span.order || 0) > 0)
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  for (const span of orderedSpans) {
    if (!positioned.has(span)) {
      span.startMs = clampTimelineStart(orderedCursorMs, span.durMs, 0, wallDurationMs);
      positioned.add(span);
    }
    orderedCursorMs = Math.max(
      orderedCursorMs,
      Number(span.startMs || 0) + Math.max(1, Number(span.durMs || 0)),
    );
  }

  const legacyScale = summaryDurationMs > wallDurationMs && summaryDurationMs > 0
    ? wallDurationMs / summaryDurationMs
    : 1;
  for (const span of spans) {
    if (positioned.has(span)) continue;
    span.startMs = clampTimelineStart(
      Number(rawStartBySpan.get(span) || 0) * legacyScale,
      span.durMs,
      0,
      wallDurationMs,
    );
  }

  const spanById = new Map();
  for (const span of spans) {
    for (const key of [span.id, span.externalSpanId]) {
      if (key != null && key !== "") spanById.set(String(key), span);
    }
  }
  for (const span of [...spans].sort((a, b) => Number(a.depth || 0) - Number(b.depth || 0))) {
    if (span === root) continue;
    const parent = spanById.get(String(span.externalParentSpanId || span.parentId || ""));
    if (!parent) continue;
    span.startMs = clampTimelineStart(
      span.startMs,
      span.durMs,
      parent.startMs,
      parent.durMs,
    );
  }

  return wallDurationMs;
}

function traceUsageFrom(usage = null) {
  if (!usage || typeof usage !== "object") {
    return {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningOutputTokens: 0,
      costUsd: 0,
    };
  }
  const cacheRead = numberFrom(
    usage.cached_tokens,
    usage.cachedInputTokens,
    usage.cached_input_tokens,
    usage.cache_read_input_tokens,
    usage.cacheRead,
    usage.cache_read,
    usage.prompt_tokens_details?.cached_tokens,
  );
  const cacheWrite = numberFrom(
    usage.cache_write_tokens,
    usage.cacheWriteInputTokens,
    usage.cache_write_input_tokens,
    usage.cache_creation_input_tokens,
    usage.cacheWrite,
    usage.cache_write,
  );
  const baseInput = numberFrom(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.inputTokens,
    usage.promptTokens,
    usage.input,
  );
  const inputTokens = numberFrom(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.inputTokens,
    usage.promptTokens,
    baseInput + cacheRead + cacheWrite,
  );
  const outputTokens = numberFrom(
    usage.completion_tokens,
    usage.output_tokens,
    usage.outputTokens,
    usage.completionTokens,
    usage.output,
  );
  const totalTokens = numberFrom(usage.total_tokens, usage.totalTokens, inputTokens + outputTokens);
  const reasoningOutputTokens = numberFrom(
    usage.reasoning_output_tokens,
    usage.reasoningOutputTokens,
    usage.output_tokens_details?.reasoning_tokens,
  );
  const costUsd = numberFrom(usage.cost_usd, usage.costUsd, usage.cost?.total);
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningOutputTokens,
    costUsd,
  };
}

function hasTraceUsage(usage) {
  return Boolean(
    usage
      && (usage.inputTokens || usage.outputTokens || usage.totalTokens || usage.cachedTokens || usage.cacheWriteTokens || usage.reasoningOutputTokens || usage.costUsd)
  );
}

function addTraceUsage(left = {}, right = {}) {
  return {
    inputTokens: numberFrom(left.inputTokens) + numberFrom(right.inputTokens),
    outputTokens: numberFrom(left.outputTokens) + numberFrom(right.outputTokens),
    totalTokens: numberFrom(left.totalTokens) + numberFrom(right.totalTokens),
    cachedTokens: numberFrom(left.cachedTokens) + numberFrom(right.cachedTokens),
    cacheWriteTokens: numberFrom(left.cacheWriteTokens) + numberFrom(right.cacheWriteTokens),
    reasoningOutputTokens: numberFrom(left.reasoningOutputTokens) + numberFrom(right.reasoningOutputTokens),
    costUsd: 0,
  };
}

function usageSignature(value = {}) {
  const usage = traceUsageFrom(value);
  return [
    usage.inputTokens,
    usage.cachedTokens,
    usage.cacheWriteTokens,
    usage.outputTokens,
    usage.reasoningOutputTokens,
    usage.totalTokens,
  ].map((item) => String(numberFrom(item))).join(":");
}

export function createRuntimeTokenUsageAccumulator() {
  const seenTotals = new Set();
  let total = traceUsageFrom();
  return {
    observe(tokenUsage = null) {
      if (!tokenUsage || typeof tokenUsage !== "object") return total;
      const cumulative = tokenUsage.total && typeof tokenUsage.total === "object" ? tokenUsage.total : {};
      const signature = usageSignature(cumulative);
      if (seenTotals.has(signature)) return total;
      seenTotals.add(signature);
      const latest = tokenUsage.last && typeof tokenUsage.last === "object" ? tokenUsage.last : null;
      if (!latest) return total;
      total = addTraceUsage(total, traceUsageFrom(latest));
      return total;
    },
    snapshot() {
      return { ...total };
    },
  };
}

const RUNTIME_TOOL_ITEM_TYPES = new Set(["dynamicToolCall", "mcpToolCall", "commandExecution", "fileChange"]);

export function runtimeTraceToolPayload(item = {}) {
  if (!RUNTIME_TOOL_ITEM_TYPES.has(item?.type)) return null;
  const name = item.type === "commandExecution"
    ? "command_execution"
    : item.type === "fileChange"
      ? "file_change"
      : item.type === "mcpToolCall"
        ? item.tool || item.name || "mcp_tool"
        : item.tool || "tool";
  return {
    tool_call_id: item.id,
    id: item.id,
    name,
    input: item.arguments ?? item.command ?? item.changes ?? item.input,
    result_preview: item.result ?? item.output ?? item.aggregatedOutput ?? item.content,
    skill: item.skill,
    attrs: {
      runtime_item_type: item.type,
      tool_source: item.type === "mcpToolCall" ? "mcp" : item.type === "dynamicToolCall" ? "dynamic" : "agent_runtime",
    },
  };
}

async function loadYiTraceModule() {
  if (!traceEnabled()) return null;
  if (!modulePromise) {
    modulePromise = import("@yitrace/db").catch((error) => {
      if (!loadErrorLogged) {
        console.warn("[yitrace] @yitrace/db 不可用,trace 已禁用:", error?.message || error);
        loadErrorLogged = true;
      }
      return null;
    });
  }
  return modulePromise;
}

export async function getYiTraceDb() {
  const mod = await loadYiTraceModule();
  if (!mod?.YiTraceDB) return null;
  if (!dbPromise) {
    const dir = dataDir();
    dbPromise = (async () => {
      try {
        return await mod.YiTraceDB.open({ dataDir: dir, tenantId: DEFAULT_TENANT_ID });
      } catch (error) {
        if (recoverStaleLock(error, dir)) {
          try {
            return await mod.YiTraceDB.open({ dataDir: dir, tenantId: DEFAULT_TENANT_ID });
          } catch (retryError) {
            error = retryError;
          }
        }
        if (!openErrorLogged) {
          console.warn("[yitrace] 打开本地 trace DB 失败,trace 已禁用:", error?.message || error);
          openErrorLogged = true;
        }
        dbPromise = null;
        return null;
      }
    })();
  }
  return dbPromise;
}

export async function closeYiTraceDb() {
  const pending = dbPromise;
  dbPromise = null;
  if (!pending) return;
  try {
    const db = await pending;
    await db?.close?.();
  } catch (error) {
    console.warn("[yitrace] 关闭本地 trace DB 失败:", error?.message || error);
  }
}

function noopRecorder(rawEmit) {
  return {
    emit: rawEmit,
    observe: () => {},
    finish: async () => {},
  };
}

export async function createTraceRecorder({
  emit,
  projectId,
  sessionId,
  runId,
  userId = "",
  mode = "agent",
  skill = null,
  question = "",
  callSite = "agent_chat",
} = {}) {
  if (typeof emit !== "function" || !projectId || !sessionId || !runId) return noopRecorder(emit);
  const mod = await loadYiTraceModule();
  if (!mod?.createSpanEventBuilder) return noopRecorder(emit);

  const startedAt = Date.now();
  const rootAttrs = {
    project_id: String(projectId),
    skill: skill || "",
    mode: mode || "agent",
    call_site: callSite,
    external_run_id: String(runId),
    user_id: userId ? String(userId) : "",
  };
  const builder = mod.createSpanEventBuilder({
    traceId: String(runId),
    sessionId: String(sessionId),
    tenantId: DEFAULT_TENANT_ID,
    attrs: rootAttrs,
  });
  const startedSpans = new Set([TRACE_ROOT_SPAN_ID]);
  const endedSpans = new Set();
  const spanStartedAt = new Map([[TRACE_ROOT_SPAN_ID, startedAt]]);
  const spanKinds = new Map([[TRACE_ROOT_SPAN_ID, "agent"]]);
  const spanNames = new Map([[TRACE_ROOT_SPAN_ID, "DSH"]]);
  const toolOutputs = new Map();
  const agentOutputs = new Map();
  const llmOutputs = new Map();
  const llmParents = new Map();
  const llmAttrs = new Map();
  const llmUsages = new Map();
  const activeLlmSpans = new Set();
  const runtimeTokenUsage = createRuntimeTokenUsageAccumulator();
  let internalLlmSeq = 0;
  let internalAgentSeq = 0;
  let finished = false;
  let lastAnswer = "";

  const logEvent = (spanId, message, attrs = undefined) => {
    builder.log({
      spanId,
      message,
      attrs,
      ts: nowNs(),
    });
  };

  builder.startSpan({
    spanId: TRACE_ROOT_SPAN_ID,
    name: "Agent Run",
    agentName: "DSH",
    inputText: clip(question),
    attrs: { trace_started_at_ms: startedAt },
    ts: nowNs(),
  });

  const currentTraceParentSpanId = () => {
    const spanId = activeTraceSpanId();
    return spanId && startedSpans.has(spanId) ? spanId : TRACE_ROOT_SPAN_ID;
  };

  const traceSpanInfo = (spanId = "") => {
    const id = spanId && startedSpans.has(spanId) ? spanId : currentTraceParentSpanId();
    return {
      spanId: id,
      kind: spanKinds.get(id) || "span",
      name: spanNames.get(id) || "",
    };
  };

  const currentTraceSpanInfo = () => traceSpanInfo();

  const resolveParentSpanId = (spanId, preferredParentSpanId = "") => {
    const parentSpanId = preferredParentSpanId || currentTraceParentSpanId();
    if (parentSpanId && parentSpanId !== spanId && startedSpans.has(parentSpanId)) return parentSpanId;
    return TRACE_ROOT_SPAN_ID;
  };

  const ensureToolSpan = (payload = {}, parentSpanId = "") => {
    const spanId = String(payload.tool_call_id || payload.id || "").trim();
    if (!spanId || startedSpans.has(spanId)) return spanId;
    const resolvedParentSpanId = resolveParentSpanId(spanId, parentSpanId);
    startedSpans.add(spanId);
    spanKinds.set(spanId, "tool");
    spanNames.set(spanId, payload.name || "tool");
    const spanStartMs = Date.now();
    spanStartedAt.set(spanId, spanStartMs);
    builder.startSpan({
      spanId,
      parentSpanId: resolvedParentSpanId,
      name: payload.name || "tool",
      toolName: payload.name || "",
      inputText: toolInputFromPayload(payload),
      attrs: {
        ...(payload.attrs && typeof payload.attrs === "object" ? payload.attrs : {}),
        ...(payload.skill ? { skill: String(payload.skill) } : {}),
        parent_tool_call_id: resolvedParentSpanId === TRACE_ROOT_SPAN_ID ? "" : resolvedParentSpanId,
        trace_started_at_ms: spanStartMs,
      },
      ts: nowNs(),
    });
    return spanId;
  };

  const ensureAgentSpan = (payload = {}, parentSpanId = "") => {
    const name = payload.name || payload.agentName || "agent";
    const spanId = String(payload.spanId || payload.agent_span_id || payload.id || `${AGENT_SPAN_PREFIX}:${safeSpanToken(name)}:${Date.now()}:${++internalAgentSeq}`).trim();
    if (!spanId || startedSpans.has(spanId)) return spanId;
    const resolvedParentSpanId = resolveParentSpanId(spanId, parentSpanId);
    startedSpans.add(spanId);
    spanKinds.set(spanId, "agent");
    spanNames.set(spanId, name);
    const spanStartMs = Date.now();
    spanStartedAt.set(spanId, spanStartMs);
    builder.startSpan({
      spanId,
      parentSpanId: resolvedParentSpanId,
      name,
      agentName: name,
      inputText: traceText(payload.input || payload.trace_input || payload.traceInput),
      attrs: {
        ...(payload.attrs && typeof payload.attrs === "object" ? payload.attrs : {}),
        parent_span_id: resolvedParentSpanId === TRACE_ROOT_SPAN_ID ? "" : resolvedParentSpanId,
        trace_started_at_ms: spanStartMs,
      },
      ts: nowNs(),
    });
    return spanId;
  };

  const ensureLlmSpan = (payload = {}, visibility = "") => {
    const blockId = String(payload.block_id || payload.id || "message").trim() || "message";
    const meta = payload.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
    const canonicalAnswer = payload.answer_status === "accepted" || meta.answer_status === "accepted";
    const parentSpanId = canonicalAnswer ? TRACE_ROOT_SPAN_ID : currentTraceParentSpanId();
    const spanId = `${LLM_SPAN_PREFIX}:${safeSpanToken(parentSpanId)}:${safeSpanToken(blockId)}`;
    const usage = traceUsageFrom(payload.usage || meta.usage || meta.trace_usage);
    if (hasTraceUsage(usage)) llmUsages.set(spanId, usage);
    if (!startedSpans.has(spanId)) {
      const spanStartMs = Date.now();
      const attrs = {
        channel: payload.channel || "",
        format: payload.format || "",
        visibility: visibility || "",
        answer_status: canonicalAnswer ? "accepted" : "",
        task_group: meta.task_group || "",
        parent_tool_call_id: parentSpanId === TRACE_ROOT_SPAN_ID ? "" : parentSpanId,
        trace_started_at_ms: spanStartMs,
      };
      startedSpans.add(spanId);
      spanKinds.set(spanId, "llm");
      spanNames.set(spanId, payload.channel === "thinking" ? "LLM 思考" : canonicalAnswer ? "LLM 返回" : "LLM 输出");
      spanStartedAt.set(spanId, spanStartMs);
      activeLlmSpans.add(spanId);
      llmParents.set(spanId, parentSpanId);
      llmAttrs.set(spanId, attrs);
      builder.startSpan({
        spanId,
        parentSpanId,
        name: payload.channel === "thinking" ? "LLM 思考" : canonicalAnswer ? "LLM 返回" : "LLM 输出",
        model: payload.model || meta.model || meta.model_id || null,
        inputText: clip(question),
        attrs,
        ts: nowNs(),
      });
    }
    activeLlmSpans.add(spanId);
    return spanId;
  };

  const endLlmSpan = (spanId, status = 0) => {
    if (!spanId || endedSpans.has(spanId)) return;
    const usage = llmUsages.get(spanId) || traceUsageFrom();
    const attrs = {
      ...(llmAttrs.get(spanId) || {}),
      ...(hasTraceUsage(usage) ? {
        trace_input_tokens: usage.inputTokens || null,
        trace_output_tokens: usage.outputTokens || null,
        trace_total_tokens: usage.totalTokens || null,
        trace_cached_tokens: usage.cachedTokens || null,
        trace_cache_write_tokens: usage.cacheWriteTokens || null,
        trace_cost_usd: usage.costUsd || null,
      } : {}),
    };
    builder.endSpan({
      spanId,
      status,
      outputText: llmOutputs.get(spanId) || "",
      inputTokens: usage.inputTokens || null,
      outputTokens: usage.outputTokens || null,
      durationNs: durationNsSince(spanStartedAt.get(spanId) || Date.now()),
      ts: nowNs(),
      attrs,
    });
    endedSpans.add(spanId);
    activeLlmSpans.delete(spanId);
  };

  const endActiveLlmSpans = () => {
    for (const spanId of [...activeLlmSpans]) endLlmSpan(spanId);
  };

  const recordLlmCall = ({
    callSite = "",
    model = "",
    modelId = "",
    input = "",
    output = "",
    status = 0,
    error = null,
    durationMs = 0,
    usage = null,
    attrs = {},
  } = {}) => {
    if (finished) return;
    const parentSpanId = currentTraceParentSpanId();
    const startMs = Date.now() - Math.max(0, Number(durationMs || 0));
    const spanId = `${LLM_SPAN_PREFIX}:${safeSpanToken(parentSpanId)}:call:${Date.now()}:${++internalLlmSeq}`;
    const normalizedStatus = error || status === "error" || status === 1 ? 1 : 0;
    const usageMetrics = traceUsageFrom(usage);
    const { inputTokens, outputTokens, totalTokens, cachedTokens, cacheWriteTokens, costUsd } = usageMetrics;
    startedSpans.add(spanId);
    endedSpans.add(spanId);
    spanKinds.set(spanId, "llm");
    spanStartedAt.set(spanId, startMs);
    const llmAttrs = {
      llm_call_site: callSite || "",
      model_id: modelId || "",
      parent_tool_call_id: parentSpanId === TRACE_ROOT_SPAN_ID ? "" : parentSpanId,
      ...(attrs && typeof attrs === "object" ? attrs : {}),
      trace_started_at_ms: startMs,
    };
    builder.startSpan({
      spanId,
      parentSpanId,
      name: callSite ? `LLM ${callSite}` : "LLM Call",
      model: model || modelId || "primary",
      inputText: traceText(input),
      attrs: llmAttrs,
      ts: msToNs(startMs),
    });
    builder.endSpan({
      spanId,
      status: normalizedStatus,
      outputText: error ? traceText(error?.message || error) : traceText(output),
      inputTokens: inputTokens || null,
      outputTokens: outputTokens || null,
      durationNs: msToNs(durationMs),
      ts: nowNs(),
      attrs: {
        ...llmAttrs,
        trace_input_tokens: inputTokens || null,
        trace_output_tokens: outputTokens || null,
        trace_total_tokens: totalTokens || null,
        trace_cached_tokens: cachedTokens || null,
        trace_cache_write_tokens: cacheWriteTokens || null,
        trace_cost_usd: costUsd || null,
      },
    });
  };

  const recordToolStart = ({
    toolCallId = "",
    name = "",
    input = "",
    attrs = {},
    parentSpanId = "",
  } = {}) => {
    if (finished) return "";
    const spanId = ensureToolSpan({
      tool_call_id: toolCallId,
      id: toolCallId,
      name,
      input,
      trace_input: input,
      attrs,
    }, parentSpanId);
    return spanId;
  };

  const recordToolEnd = ({
    toolCallId = "",
    name = "",
    input = "",
    output = "",
    status = 0,
    error = null,
    durationMs = 0,
    attrs = {},
  } = {}) => {
    if (finished) return;
    const spanId = ensureToolSpan({
      tool_call_id: toolCallId,
      id: toolCallId,
      name,
      input,
      trace_input: input,
      attrs,
    });
    if (!spanId) return;
    const normalizedStatus = error || status === "error" || status === 1 ? 1 : 0;
    const outputText = error ? traceText(error?.message || error) : traceText(output);
    if (!endedSpans.has(spanId)) {
      builder.endSpan({
        spanId,
        status: normalizedStatus,
        outputText,
        durationNs: durationMs ? msToNs(durationMs) : durationNsSince(spanStartedAt.get(spanId) || Date.now()),
        ts: nowNs(),
        attrs: attrs && typeof attrs === "object" ? attrs : {},
      });
      endedSpans.add(spanId);
    } else if (outputText) {
      logEvent(spanId, outputText, { trace_tool_output: true });
    }
  };

  const recordAgentStart = ({
    name = "",
    input = "",
    attrs = {},
    parentSpanId = "",
  } = {}) => {
    if (finished) return "";
    const spanId = ensureAgentSpan({
      name,
      input,
      trace_input: input,
      attrs,
    }, parentSpanId);
    return spanId;
  };

  const recordAgentEnd = ({
    spanId = "",
    name = "",
    input = "",
    output = "",
    status = 0,
    error = null,
    durationMs = 0,
    attrs = {},
  } = {}) => {
    if (finished) return;
    const id = String(spanId || "").trim() || ensureAgentSpan({
      name,
      input,
      trace_input: input,
      attrs,
    });
    if (!id) return;
    endActiveLlmSpans();
    const normalizedStatus = error || status === "error" || status === 1 ? 1 : 0;
    const outputText = error ? traceText(error?.message || error) : traceText(output);
    if (outputText) agentOutputs.set(id, outputText);
    if (!endedSpans.has(id)) {
      builder.endSpan({
        spanId: id,
        status: normalizedStatus,
        outputText,
        durationNs: durationMs ? msToNs(durationMs) : durationNsSince(spanStartedAt.get(id) || Date.now()),
        ts: nowNs(),
        attrs: attrs && typeof attrs === "object" ? attrs : {},
      });
      endedSpans.add(id);
    } else if (outputText) {
      logEvent(id, outputText, { trace_agent_output: true });
    }
  };

  const recordEvent = (event) => {
    const type = event?.type;
    const payload = event?.payload || {};
    if (!type) return;

    if (type === "thread/tokenUsage/updated") {
      runtimeTokenUsage.observe(payload.tokenUsage);
      return;
    }

    if (type === StreamEventType.TURN_PLAN_UPDATED) {
      const plan = payload.plan || [];
      logEvent(TRACE_ROOT_SPAN_ID, `plan ${Array.isArray(plan) ? plan.length : 0} steps`);
      return;
    }

    if (type === StreamEventType.ITEM_STARTED || type === StreamEventType.ITEM_COMPLETED) {
      const item = payload.item || {};
      if (item.type === "contextCompaction") {
        logEvent(
          TRACE_ROOT_SPAN_ID,
          type === StreamEventType.ITEM_STARTED ? "context compaction started" : "context compaction completed",
          { context_compaction: true, status: type === StreamEventType.ITEM_STARTED ? "running" : "completed" },
        );
        return;
      }
      if (item.type === "skill") {
        logEvent(
          TRACE_ROOT_SPAN_ID,
          `skill ${item.name || ""} ${item.status || ""}`.trim(),
          item.name ? { skill: String(item.name) } : undefined,
        );
        return;
      }
      if (item.type === "approval" || item.type === "userInput") {
        logEvent(TRACE_ROOT_SPAN_ID, jsonText(item.prompt || item.summary || item.tool || item.type));
        return;
      }
      const toolPayload = runtimeTraceToolPayload(item);
      if (toolPayload) {
        endActiveLlmSpans();
        const spanId = ensureToolSpan(toolPayload, currentTraceParentSpanId());
        if (type === StreamEventType.ITEM_COMPLETED && spanId && !endedSpans.has(spanId)) {
          const output = traceText(
            item.result ?? item.output ?? item.aggregatedOutput ?? item.content ?? toolOutputs.get(spanId) ?? "",
          );
          builder.endSpan({
            spanId,
            status: ["failed", "declined", "cancelled"].includes(String(item.status || "").toLowerCase()) || item.success === false ? 1 : 0,
            outputText: output,
            durationNs: item.durationMs ? msToNs(item.durationMs) : durationNsSince(spanStartedAt.get(spanId) || Date.now()),
            ts: nowNs(),
          });
          endedSpans.add(spanId);
        }
        return;
      }
      if (type === StreamEventType.ITEM_COMPLETED && item.type === "agentMessage") {
        const canonicalAnswer = item.answer_status === "accepted" || item.metadata?.answer_status === "accepted";
        const normalized = {
          block_id: item.id,
          channel: "answer",
          format: "markdown",
          content: item.text,
          answer_status: canonicalAnswer ? "accepted" : null,
          model: item.model,
          usage: item.usage,
        };
        const spanId = ensureLlmSpan(normalized, canonicalAnswer ? "primary" : "secondary");
        llmOutputs.set(spanId, traceText(item.text));
        if (canonicalAnswer) lastAnswer = traceText(item.text);
        endLlmSpan(spanId);
        return;
      }
      if (type === StreamEventType.ITEM_COMPLETED && item.type === "reasoning") {
        const normalized = {
          block_id: item.id,
          channel: "thinking",
          format: "text",
          content: (item.summary || item.content || []).join("\n"),
          model: item.model,
          usage: item.usage,
        };
        const spanId = ensureLlmSpan(normalized, "secondary");
        llmOutputs.set(spanId, traceText(normalized.content));
        endLlmSpan(spanId);
        return;
      }
      if (type === StreamEventType.ITEM_COMPLETED && item.type === "dataResult" && item.metadata?.answer_status === "accepted") {
        lastAnswer = traceText(item.content);
        return;
      }
      if (type === StreamEventType.ITEM_COMPLETED && item.type === "error") {
        logEvent(TRACE_ROOT_SPAN_ID, traceText(item.content || item.text || item.title || "error"));
      }
      return;
    }

    if (type === StreamEventType.TOOL_OUTPUT_DELTA) {
      const toolId = event.item_id || payload.itemId || "tool";
      const spanId = ensureToolSpan({ tool_call_id: toolId, id: toolId, name: payload.name || "tool" });
      if (!spanId) return;
      const previous = toolOutputs.get(spanId) || "";
      const output = payload.mode === "replace" ? traceText(payload.delta) : previous + traceText(payload.delta);
      toolOutputs.set(spanId, output);
      logEvent(spanId, traceText(payload.delta));
      return;
    }

    if (
      type === StreamEventType.AGENT_MESSAGE_DELTA
      || type === StreamEventType.REASONING_SUMMARY_DELTA
      || type === StreamEventType.REASONING_TEXT_DELTA
    ) {
      const thinking = type !== StreamEventType.AGENT_MESSAGE_DELTA;
      const blockId = event.item_id || payload.itemId || "message";
      const canonicalAnswer = payload.answer_status === "accepted" || payload.metadata?.answer_status === "accepted";
      const normalized = {
        block_id: blockId,
        channel: thinking ? "thinking" : "answer",
        format: thinking ? "text" : payload.format || "markdown",
        answer_status: canonicalAnswer ? "accepted" : null,
        model: payload.model,
        usage: payload.usage,
        metadata: payload.metadata,
      };
      const spanId = ensureLlmSpan(normalized, thinking || !canonicalAnswer ? "secondary" : "primary");
      const previous = llmOutputs.get(spanId) || "";
      const content = payload.mode === "replace" ? traceText(payload.delta) : previous + traceText(payload.delta);
      llmOutputs.set(spanId, content);
      if (thinking && payload.delta) logEvent(spanId, traceText(payload.delta), { channel: "thinking" });
      if (!thinking && canonicalAnswer) lastAnswer = content;
      return;
    }
  };

  const tracedEmit = (event) => {
    emit(event);
    try {
      recordEvent(event);
    } catch (error) {
      console.warn("[yitrace] trace event 记录失败:", error?.message || error);
    }
  };

  const finish = async ({ status = "completed", error = null } = {}) => {
    if (finished) return;
    finished = true;
    endActiveLlmSpans();
    for (const spanId of startedSpans) {
      if (spanId === TRACE_ROOT_SPAN_ID || endedSpans.has(spanId)) continue;
      builder.endSpan({
        spanId,
        status: 0,
        outputText: toolOutputs.get(spanId) || agentOutputs.get(spanId) || llmOutputs.get(spanId) || "",
        durationNs: durationNsSince(spanStartedAt.get(spanId) || Date.now()),
        ts: nowNs(),
      });
      endedSpans.add(spanId);
    }
    const turnUsage = runtimeTokenUsage.snapshot();
    builder.endSpan({
      spanId: TRACE_ROOT_SPAN_ID,
      status: safeStatus(status),
      durationNs: durationNsSince(startedAt),
      outputText: error ? clip(error?.message || error) : lastAnswer,
      inputTokens: turnUsage.inputTokens || null,
      outputTokens: turnUsage.outputTokens || null,
      attrs: {
        trace_total_tokens: turnUsage.totalTokens || null,
        trace_cached_tokens: turnUsage.cachedTokens || null,
        trace_cache_write_tokens: turnUsage.cacheWriteTokens || null,
        trace_reasoning_output_tokens: turnUsage.reasoningOutputTokens || null,
      },
      ts: nowNs(),
    });
    const db = await getYiTraceDb();
    if (!db) return;
    try {
      await builder.ingest(db);
      await db.flush();
    } catch (ingestError) {
      console.warn("[yitrace] trace 写入失败:", ingestError?.message || ingestError);
    }
  };

  return {
    emit: tracedEmit,
    observe: (event) => {
      try {
        recordEvent(event);
      } catch (error) {
        console.warn("[yitrace] trace event 记录失败:", error?.message || error);
      }
    },
    finish,
    recordLlmCall,
    recordToolStart,
    recordToolEnd,
    recordAgentStart,
    recordAgentEnd,
    traceSpanInfo,
    currentTraceSpanInfo,
  };
}

function normalizeSpan(span, detail = null, snapshot = null) {
  const logs = uniqueClippedLogs([
    ...(Array.isArray(span?.logs) ? span.logs : []),
    ...(Array.isArray(detail?.logs) ? detail.logs : []),
    ...messagesFromLogEvents(span?.logEvents),
    ...messagesFromLogEvents(detail?.logEvents),
  ]);
  const input = detail?.input || detail?.inputText || detail?.input_text || span?.input || span?.inputText || span?.input_text || snapshot?.input || "";
  const rawOutput = detail?.output || detail?.outputText || detail?.output_text || span?.output || span?.outputText || span?.output_text || "";
  const output = snapshot?.output && (!rawOutput || rawOutput === input) ? snapshot.output : rawOutput === input ? "" : rawOutput;
  const attrs = {
    ...(span?.attrs && typeof span.attrs === "object" ? span.attrs : {}),
    ...(detail?.attrs && typeof detail.attrs === "object" ? detail.attrs : {}),
  };
  const kind = span?.kind || "span";
  const externalSpanId = span?.externalSpanId || span?.external_span_id || null;
  let name = span?.name || span?.externalSpanId || span?.id || "span";
  if (kind === "llm") {
    if (attrs.llm_call_site) name = `LLM ${attrs.llm_call_site}`;
    else if (attrs.channel === "thinking") name = "LLM 思考";
    else if (attrs.answer_status === "accepted") name = "LLM 返回";
    else if (attrs.channel || attrs.format || String(externalSpanId || "").startsWith(LLM_SPAN_PREFIX)) name = "LLM 输出";
  }
  const externalParentSpanId =
    span?.externalParentSpanId ||
    span?.external_parent_span_id ||
    attrs.parent_tool_call_id ||
    attrs.parent_span_id ||
    attrs.trace_parent_span_id ||
    null;
  return {
    id: String(span?.id || ""),
    parentId: span?.parentId == null ? null : String(span.parentId),
    externalTraceId: span?.externalTraceId || span?.external_trace_id || null,
    externalSpanId,
    externalParentSpanId,
    externalSessionId: span?.externalSessionId || span?.external_session_id || null,
    kind,
    name,
    status: span?.status || "ok",
    depth: Number(span?.depth || 0),
    startMs: Number(span?.startMs || span?.start_ms || 0),
    durMs: numberFrom(span?.durMs, span?.duration_ms, detail?.durMs, detail?.duration_ms),
    cost: numberFrom(
      span?.cost,
      span?.cost_usd,
      span?.costUsd,
      detail?.cost,
      detail?.cost_usd,
      detail?.costUsd,
      attrs.cost_usd,
      attrs.trace_cost_usd,
    ),
    inTok: numberFrom(
      span?.inTok,
      span?.input_tokens,
      span?.inputTokens,
      detail?.inTok,
      detail?.input_tokens,
      detail?.inputTokens,
      attrs.trace_input_tokens,
      attrs.input_tokens,
    ),
    outTok: numberFrom(
      span?.outTok,
      span?.output_tokens,
      span?.outputTokens,
      detail?.outTok,
      detail?.output_tokens,
      detail?.outputTokens,
      attrs.trace_output_tokens,
      attrs.output_tokens,
    ),
    model: span?.model || detail?.model || null,
    attrs,
    order: snapshot?.order || null,
    input,
    output,
    logs,
  };
}

export async function normalizeTrace(
  db,
  runId,
  trace,
  runStatus = null,
  toolSnapshots = new Map(),
  llmSnapshots = [],
  run = null,
) {
  if (!trace) return null;
  const summary = trace.summary || {};
  const spans = Array.isArray(trace.spans) ? trace.spans : [];
  const detailPairs = await Promise.all(
    spans.slice(0, MAX_SPAN_DETAILS).map(async (span) => {
      const spanId = span?.externalSpanId || span?.external_span_id || span?.id;
      if (!spanId) return [span, null];
      const detail = await db.span(runId, spanId).catch(() => null);
      return [span, detail];
    }),
  );
  const detailById = new Map(detailPairs.map(([span, detail]) => [span, detail]));
  const normalizedSpans = spans.map((span) => {
    const externalSpanId = span?.externalSpanId || span?.external_span_id || span?.id;
    return normalizeSpan(span, detailById.get(span), toolSnapshots.get(String(externalSpanId || "")));
  });
  const rootSpan = normalizedSpans.find((span) => Number(span.depth || 0) === 0) || null;
  const spanByExternalId = new Map();
  for (const span of normalizedSpans) {
    const externalSpanId = String(span.externalSpanId || span.id || "");
    if (externalSpanId) spanByExternalId.set(externalSpanId, span);
  }
  for (let pass = 0; pass < 3; pass += 1) {
    for (const span of normalizedSpans) {
      const externalSpanId = String(span.externalSpanId || span.id || "");
      const parentToolId = String(toolSnapshots.get(externalSpanId)?.parentToolId || "");
      if (!parentToolId) continue;
      const parent = spanByExternalId.get(parentToolId);
      if (!parent) continue;
      span.parentId = parent.id || parent.externalSpanId || null;
      span.externalParentSpanId = parent.externalSpanId || parent.id || parentToolId;
      span.depth = Number(parent.depth || 0) + 1;
      span.attrs = { ...(span.attrs || {}), parent_tool_call_id: parentToolId };
    }
  }
  const hasRecordedLlmSpans = normalizedSpans.some(
    (span) => span.kind === "llm" && !String(span.externalSpanId || "").startsWith(`${LLM_SPAN_PREFIX}:history:`),
  );
  const existingExternalIds = new Set(normalizedSpans.map((span) => String(span.externalSpanId || span.id || "")));
  if (!hasRecordedLlmSpans) {
    for (const snapshot of llmSnapshots) {
      if (!snapshot?.id || existingExternalIds.has(String(snapshot.id))) continue;
      const parentToolId = String(snapshot.parentToolId || "");
      const parentSpan = (parentToolId && spanByExternalId.get(parentToolId)) || rootSpan;
      normalizedSpans.push({
        id: String(snapshot.id),
        parentId: parentSpan?.id || null,
        externalTraceId: runId,
        externalSpanId: String(snapshot.id),
        externalParentSpanId: parentSpan?.externalSpanId || TRACE_ROOT_SPAN_ID,
        externalSessionId: null,
        kind: "llm",
        name: snapshot.name || "LLM 输出",
        status: "ok",
        depth: parentSpan ? Number(parentSpan.depth || 0) + 1 : 1,
        startMs: 0,
        durMs: 1,
        cost: 0,
        inTok: 0,
        outTok: 0,
        model: "primary",
        attrs: { ...(snapshot.attrs || {}), parent_tool_call_id: parentToolId },
        order: snapshot.order || null,
        input: snapshot.input || "",
        output: snapshot.output || "",
        logs: [],
      });
      existingExternalIds.add(String(snapshot.id));
    }
  }
  const wallDurationMs = normalizeTraceTiming(normalizedSpans, summary, run);
  normalizedSpans.sort((a, b) => {
    const ar = Number(a.depth || 0) === 0 ? 0 : 1;
    const br = Number(b.depth || 0) === 0 ? 0 : 1;
    const ao = Number(a.order || 0);
    const bo = Number(b.order || 0);
    if (ar !== br) return ar - br;
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    if (ao > 0 && bo > 0 && ao !== bo) return ao - bo;
    if (ao > 0 && bo <= 0) return -1;
    if (ao <= 0 && bo > 0) return 1;
    return a.depth - b.depth || a.name.localeCompare(b.name);
  });

  return {
    traceId: String(summary.traceId || summary.trace_id || ""),
    externalTraceId: summary.externalTraceId || summary.external_trace_id || runId,
    name: summary.name || "Trace",
    status: runStatus || summary.status || "ok",
    durMs: wallDurationMs,
    cost: Number(summary.cost || 0),
    spanCount: normalizedSpans.length || Number(summary.spanCount || summary.span_count || 0),
    spans: normalizedSpans,
  };
}

export async function listSessionTraces(ctx, input) {
  const { pid, sid } = input.params || {};
  const limit = Math.max(1, Math.min(50, Number(input.query?.limit || 20)));
  const runs = await ctx.query(
    `SELECT id, session_id, project_id, user_id, status, skill_name, mode, created_at, updated_at, finished_at
       FROM agent_runs
      WHERE session_id=$1
        AND deleted_at IS NULL
        AND (project_id=$2 OR project_id IS NULL OR $2 IS NULL)
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT $3`,
    [sid, pid, limit],
  ).catch(() => []);
  const messageRows = await ctx.query(
    `SELECT id, role, content_items, sequence_number, created_at
       FROM session_messages
      WHERE session_id=$1
        AND deleted_at IS NULL
      ORDER BY sequence_number ASC, created_at ASC`,
    [sid],
  ).catch(() => []);
  const questionRows = messageRows.filter((row) => row.role === "user");
  const { toolSnapshots, llmByQuestionNo } = traceSnapshotsFromMessages(messageRows);
  const questions = questionRows
    .map((row, index) => ({
      questionNo: index + 1,
      questionMessageId: row.id,
      questionText: textFromContentItems(row.content_items),
      sequenceNumber: Number(row.sequence_number || 0),
      createdAt: row.created_at,
      timeMs: new Date(row.created_at || "").getTime(),
    }))
    .filter((row) => row.questionText);

  const db = await getYiTraceDb();
  if (!db) {
    return {
      data: {
        enabled: false,
        dataDir: dataDir(),
        items: runs.map((run) => ({ ...run, runId: run.id, question: questionForRun(run, questions), trace: null })),
      },
    };
  }

  const sessionPage = await db.sessions({
    attrs: { project_id: String(pid || "") },
    limit: 200,
  }).catch(() => null);
  const ySession = (sessionPage?.items || []).find((item) => String(item.externalSessionId || item.sessionId || "") === String(sid));

  const items = [];
  for (const run of runs) {
    const trace = await db.trace(run.id).catch(() => null);
    const baseTrace = await normalizeTrace(db, run.id, trace, run.status, toolSnapshots, [], run);
    const question = questionForRun(run, questions, baseTrace) || questionForRun(run, questions, trace);
    const normalizedTrace = await normalizeTrace(
      db,
      run.id,
      trace,
      run.status,
      toolSnapshots,
      llmByQuestionNo.get(question?.questionNo || 0) || [],
      run,
    );
    items.push({
      runId: run.id,
      sessionId: run.session_id,
      projectId: run.project_id,
      userId: run.user_id,
      status: run.status,
      skill: run.skill_name,
      mode: run.mode,
      createdAt: run.created_at,
      updatedAt: run.updated_at,
      finishedAt: run.finished_at,
      question,
      trace: normalizedTrace,
    });
  }

  return {
    data: {
      enabled: true,
      dataDir: dataDir(),
      session: ySession || null,
      items,
    },
  };
}
