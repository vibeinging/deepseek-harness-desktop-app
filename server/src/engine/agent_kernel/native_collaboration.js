const COLLABORATION_ITEM_TYPES = new Set(["collabAgentToolCall", "subAgentActivity"]);

const COLLABORATION_TOOL_LABELS = Object.freeze({
  spawnAgent: "创建子任务",
  sendInput: "补充子任务",
  resumeAgent: "恢复子任务",
  wait: "等待子任务",
  closeAgent: "关闭子任务",
});

function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function clipped(value, max = 16_000) {
  const text = String(value || "");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function isNativeCollaborationItem(item) {
  return COLLABORATION_ITEM_TYPES.has(String(item?.type || ""));
}

/**
 * Enable the collaboration tools that ship with the pinned Codex app-server.
 * This is a native config overlay, not a product-side scheduler.
 */
export function withNativeCollaborationConfig(config = {}, settings = {}) {
  const current = objectValue(config);
  const currentAgents = objectValue(current.agents);
  const maxConcurrent = boundedInteger(
    settings.maxConcurrentThreads
      ?? settings.max_concurrent_threads_per_session
      ?? currentAgents.max_concurrent_threads_per_session,
    4,
    1,
    8,
  );
  return {
    ...current,
    agents: {
      ...currentAgents,
      enabled: true,
      max_concurrent_threads_per_session: maxConcurrent,
      interrupt_message: currentAgents.interrupt_message !== false,
    },
  };
}

export function nativeCollaborationItemPayload(item = {}, lifecycle = "completed") {
  if (!isNativeCollaborationItem(item)) return null;
  if (item.type === "subAgentActivity") {
    const activityStatus = item.kind === "interrupted" ? "interrupted" : "running";
    return {
      version: "codex_native_collaboration.v1",
      source: "app-server",
      item_type: item.type,
      item_id: String(item.id || ""),
      lifecycle,
      title: item.kind === "started" ? "子任务已启动" : item.kind === "interrupted" ? "子任务已停止" : "子任务有新进展",
      summary: item.agentPath || String(item.agentThreadId || ""),
      tool: null,
      prompt: null,
      sender_thread_id: null,
      child_thread_ids: [String(item.agentThreadId || "")].filter(Boolean),
      agents_states: item.agentThreadId ? { [item.agentThreadId]: { status: activityStatus, message: null } } : {},
      status: activityStatus,
      agent_path: item.agentPath || null,
      activity_kind: item.kind || null,
    };
  }

  const agentsStates = objectValue(item.agentsStates);
  const childThreadIds = [...new Set([
    ...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []),
    ...Object.keys(agentsStates),
  ].map((value) => String(value || "").trim()).filter(Boolean))];
  const states = childThreadIds.map((threadId) => String(agentsStates[threadId]?.status || ""));
  const status = item.status === "failed" || states.includes("errored") || states.includes("notFound")
    ? "failed"
    : item.status === "interrupted" || states.includes("interrupted")
      ? "interrupted"
      : lifecycle === "started" || item.status === "inProgress" || states.some((value) => value === "running" || value === "pendingInit")
        ? "running"
        : "completed";
  const title = COLLABORATION_TOOL_LABELS[item.tool] || "协作子任务";
  const stateMessages = childThreadIds
    .map((threadId) => String(agentsStates[threadId]?.message || "").trim())
    .filter(Boolean);
  return {
    version: "codex_native_collaboration.v1",
    source: "app-server",
    item_type: item.type,
    item_id: String(item.id || ""),
    lifecycle,
    title,
    summary: stateMessages.join("；") || clipped(item.prompt, 240) || `${childThreadIds.length} 个子线程`,
    tool: item.tool || null,
    prompt: item.prompt == null ? null : clipped(item.prompt),
    sender_thread_id: item.senderThreadId || null,
    child_thread_ids: childThreadIds,
    agents_states: agentsStates,
    status,
    model: item.model || null,
    reasoning_effort: item.reasoningEffort || null,
  };
}

export function nativeCollaborationRunEvent(method, params = {}) {
  if (!["item/started", "item/completed"].includes(method)) return null;
  const lifecycle = method === "item/started" ? "started" : "completed";
  const payload = nativeCollaborationItemPayload(params.item, lifecycle);
  if (!payload?.item_id) return null;
  const messages = Object.values(payload.agents_states || {})
    .map((state) => String(state?.message || "").trim())
    .filter(Boolean);
  return {
    eventType: `native_collaboration_${lifecycle}`,
    turnId: params.turnId || null,
    callId: payload.item_id,
    status: payload.status,
    inputSummary: payload.prompt || payload.title,
    outputSummary: messages.join("；") || `${payload.child_thread_ids.length} 个子线程`,
    metadata: payload,
  };
}

function agentStatus(value, fallback = "running") {
  const status = String(value || "");
  if (status === "pendingInit") return "pending";
  if (status === "running") return "running";
  if (status === "completed" || status === "shutdown") return "completed";
  if (status === "errored") return "failed";
  if (status === "interrupted") return "interrupted";
  if (status === "notFound") return "not_found";
  return fallback;
}

/** Build a read-only product projection from persisted native app-server events. */
export function summarizeNativeCollaborationEvents(events = []) {
  const records = new Map();
  for (const event of events || []) {
    if (!String(event?.event_type || "").startsWith("native_collaboration_")) continue;
    const metadata = objectValue(event.metadata ?? event.metadata_json);
    const childIds = Array.isArray(metadata.child_thread_ids) ? metadata.child_thread_ids : [];
    for (const rawThreadId of childIds) {
      const threadId = String(rawThreadId || "").trim();
      if (!threadId) continue;
      const previous = records.get(threadId) || {
        thread_id: threadId,
        parent_thread_id: metadata.sender_thread_id || null,
        call_id: metadata.item_id || event.call_id || null,
        title: metadata.title || "协作子任务",
        tool: metadata.tool || null,
        prompt: metadata.prompt || null,
        model: metadata.model || null,
        reasoning_effort: metadata.reasoning_effort || null,
        status: "running",
        message: null,
        created_at: event.created_at || null,
        updated_at: event.created_at || null,
      };
      const state = objectValue(metadata.agents_states)[threadId] || {};
      const fallback = metadata.status || event.status || previous.status;
      const isCreationEvent = metadata.tool === "spawnAgent" || metadata.item_type === "subAgentActivity";
      records.set(threadId, {
        ...previous,
        parent_thread_id: metadata.sender_thread_id || previous.parent_thread_id,
        call_id: isCreationEvent ? (metadata.item_id || event.call_id || previous.call_id) : previous.call_id,
        title: isCreationEvent ? (metadata.title || previous.title) : previous.title,
        tool: isCreationEvent ? (metadata.tool || previous.tool) : previous.tool,
        prompt: isCreationEvent ? (metadata.prompt ?? previous.prompt) : previous.prompt,
        model: metadata.model || previous.model,
        reasoning_effort: metadata.reasoning_effort || previous.reasoning_effort,
        status: agentStatus(state.status, agentStatus(fallback, previous.status)),
        message: state.message || previous.message || null,
        updated_at: event.created_at || previous.updated_at,
      });
    }
  }
  return [...records.values()].sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

export default {
  isNativeCollaborationItem,
  nativeCollaborationItemPayload,
  nativeCollaborationRunEvent,
  summarizeNativeCollaborationEvents,
  withNativeCollaborationConfig,
};
