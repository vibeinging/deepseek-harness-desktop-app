import { APP_DISPLAY_NAME } from "../../config/app_name.js";

function cloneSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  return JSON.parse(JSON.stringify(schema));
}

function toolResultText(result) {
  if (typeof result === "string") return result;
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
  if (text) return text;
  if (result == null) return "工具执行完成。";
  try { return JSON.stringify(result); } catch { return String(result); }
}

function mediaDataUrl(item, kind) {
  const direct = item?.[`${kind}Url`] || item?.[`${kind}_url`] || item?.url;
  if (typeof direct === "string" && direct.startsWith(`data:${kind}/`)) return direct;
  if (typeof item?.data !== "string" || !item.data) return "";
  if (item.data.startsWith(`data:${kind}/`)) return item.data;
  if (item.data.startsWith("data:")) return "";
  const fallback = kind === "image" ? "image/png" : "audio/mpeg";
  const mimeType = String(item.mimeType || item.mime_type || fallback);
  return `data:${mimeType};base64,${item.data}`;
}

function toolResultContentItems(result) {
  const content = Array.isArray(result?.content) ? result.content : [];
  const items = [];
  for (const entry of content) {
    if (entry?.type === "text" && typeof entry.text === "string") {
      items.push({ type: "inputText", text: entry.text });
      continue;
    }
    if (entry?.type === "image") {
      const imageUrl = mediaDataUrl(entry, "image");
      if (imageUrl) items.push({ type: "inputImage", imageUrl });
      continue;
    }
    if (entry?.type === "audio") {
      const audioUrl = mediaDataUrl(entry, "audio");
      if (audioUrl) items.push({ type: "inputAudio", audioUrl });
    }
  }
  return items.length ? items : [{ type: "inputText", text: toolResultText(result) }];
}

function normalizeTools(toolsOrRegistry, context) {
  if (typeof toolsOrRegistry?.listVisible === "function") return toolsOrRegistry.listVisible(context);
  if (typeof toolsOrRegistry?.list === "function") return toolsOrRegistry.list(context);
  return Array.isArray(toolsOrRegistry) ? toolsOrRegistry : [];
}

function normalizeArguments(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function namespaceName(tool) {
  const value = String(tool.namespace || "dsh").trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(value) ? value : "dsh";
}

function hostResultKey({ threadId = "", turnId = "", callId = "" } = {}) {
  return `${String(threadId)}\u0000${String(turnId)}\u0000${String(callId)}`;
}

function functionSpec(tool, { deferred = false } = {}) {
  return {
    type: "function",
    name: tool.name,
    description: String(tool.description || ""),
    inputSchema: cloneSchema(tool.input_schema ?? tool.inputSchema ?? tool.parameters),
    ...(deferred ? { deferLoading: true } : {}),
  };
}

export function createDynamicToolBridge({
  tools = [],
  context = {},
  signal = null,
  isCallActive = null,
} = {}) {
  const entries = normalizeTools(tools, context);
  const byName = new Map();
  for (const tool of entries) {
    const name = String(tool?.name || "").trim();
    if (!name) {
      const error = new Error("动态工具缺少名称");
      error.code = "DYNAMIC_TOOL_NAME_REQUIRED";
      throw error;
    }
    if (byName.has(name)) {
      const first = byName.get(name);
      const error = new Error(`动态工具名称冲突: ${name}`);
      error.code = "DYNAMIC_TOOL_NAME_CONFLICT";
      error.details = {
        name,
        first_plugin: first?.plugin_name || null,
        second_plugin: tool?.plugin_name || null,
      };
      throw error;
    }
    byName.set(name, tool);
  }
  const hostResults = new Map();
  const activeCalls = new Set();
  // A bridge belongs to one product Turn even when native child Threads inherit
  // it. Guard both sides of async hooks so late completions cannot publish into
  // a finished Turn after the underlying tool ignored cancellation.
  let revoked = false;
  let revokeReason = "Agent Turn 已结束";
  const isActive = (params) => {
    if (typeof isCallActive !== "function") return true;
    try { return isCallActive(params) === true; } catch { return false; }
  };
  const isUnavailable = (params, callSignal = null) => (
    revoked
    || signal?.aborted === true
    || callSignal?.aborted === true
    || !isActive(params)
  );
  const forgetHostResult = (params = {}) => {
    if (params.callId) hostResults.delete(hostResultKey(params));
  };
  const unavailableResult = (params = {}, callSignal = null) => {
    forgetHostResult(params);
    const callReason = callSignal?.reason;
    const text = revoked
      ? revokeReason
      : signal?.aborted === true
        ? "Agent Turn 已取消，不能再调用工具。"
        : callSignal?.aborted === true && callReason
          ? String(callReason?.message || callReason)
          : "Agent Turn 已结束，不能再调用工具。";
    return {
      success: false,
      contentItems: [{ type: "inputText", text }],
    };
  };
  const abortCalls = (predicate, reason) => {
    for (const call of activeCalls) {
      if (predicate(call) && !call.controller.signal.aborted) call.controller.abort(reason);
    }
  };
  const callMatches = (call, { threadIds = null, turnIds = null } = {}) => {
    const threads = threadIds == null
      ? null
      : new Set(Array.from(threadIds, (value) => String(value || "")).filter(Boolean));
    const turns = turnIds == null
      ? null
      : new Set(Array.from(turnIds, (value) => String(value || "")).filter(Boolean));
    return (!threads || threads.has(call.threadId)) && (!turns || turns.has(call.turnId));
  };
  signal?.addEventListener?.("abort", () => {
    hostResults.clear();
    abortCalls(() => true, signal.reason || "Agent Turn 已取消");
  }, { once: true });
  const direct = entries.filter((tool) => tool.exposure !== "deferred");
  const deferredByNamespace = new Map();
  for (const tool of entries.filter((entry) => entry.exposure === "deferred")) {
    const namespace = namespaceName(tool);
    const grouped = deferredByNamespace.get(namespace) || [];
    grouped.push(tool);
    deferredByNamespace.set(namespace, grouped);
  }
  return {
    specs: [
      ...direct.map((tool) => functionSpec(tool)),
      ...[...deferredByNamespace.entries()].map(([name, namespaceTools]) => ({
        type: "namespace",
        name,
        description: name === "dsh" ? `${APP_DISPLAY_NAME}项目数据与工作流工具` : `${name} 工具`,
        tools: namespaceTools.map((tool) => functionSpec(tool, { deferred: true })),
      })),
    ],
    names: [...byName.keys()],
    revoke(reason = "Agent Turn 已结束") {
      if (revoked) return;
      revoked = true;
      revokeReason = String(reason?.message || reason || "Agent Turn 已结束");
      hostResults.clear();
      abortCalls(() => true, revokeReason);
    },
    revokeTurn(threadId, turnId, reason = "Agent Turn 已结束") {
      const thread = String(threadId || "");
      const turn = String(turnId || "");
      if (!(thread && turn)) return;
      const message = String(reason?.message || reason || "Agent Turn 已结束");
      abortCalls((call) => call.threadId === thread && call.turnId === turn, message);
      const prefix = `${thread}\u0000${turn}\u0000`;
      for (const key of hostResults.keys()) {
        if (key.startsWith(prefix)) hostResults.delete(key);
      }
    },
    async drain({ timeoutMs = 1_000, threadIds = null, turnIds = null } = {}) {
      const scope = { threadIds, turnIds };
      const pending = [...activeCalls].filter((call) => callMatches(call, scope));
      if (!pending.length) return { settled: true, pendingCalls: 0 };
      const waitMs = Math.max(0, Math.min(30_000, Number(timeoutMs) || 0));
      let timer = null;
      const completed = Promise.allSettled(pending.map((call) => call.settled)).then(() => true);
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      });
      try {
        await Promise.race([completed, timedOut]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      const pendingCalls = [...activeCalls].filter((call) => callMatches(call, scope)).length;
      return { settled: pendingCalls === 0, pendingCalls };
    },
    pendingCallCount({ threadIds = null, turnIds = null } = {}) {
      return [...activeCalls].filter((call) => callMatches(call, { threadIds, turnIds })).length;
    },
    takeHostResult(callId, { threadId = "", turnId = "" } = {}) {
      const id = String(callId || "");
      if (!id) return undefined;
      let key = hostResultKey({ threadId, turnId, callId: id });
      if (!hostResults.has(key) && !threadId && !turnId) {
        const matches = [...hostResults.keys()].filter((candidate) => candidate.endsWith(`\u0000${id}`));
        if (matches.length === 1) [key] = matches;
      }
      if (!hostResults.has(key)) return undefined;
      const result = hostResults.get(key);
      hostResults.delete(key);
      return result;
    },
    async handleCall(params = {}) {
      if (isUnavailable(params)) return unavailableResult(params);
      const tool = byName.get(params.tool);
      if (!tool || typeof tool.execute !== "function") {
        return {
          success: false,
          contentItems: [{ type: "inputText", text: `${APP_DISPLAY_NAME}工具不存在或不可执行: ${params.tool}` }],
        };
      }
      const call = {
        threadId: String(params.threadId || ""),
        turnId: String(params.turnId || ""),
        controller: new AbortController(),
        settled: null,
        settle: null,
      };
      call.settled = new Promise((resolve) => { call.settle = resolve; });
      if (signal?.aborted === true) call.controller.abort(signal.reason || "Agent Turn 已取消");
      activeCalls.add(call);
      try {
        let result = await tool.execute(params.callId, normalizeArguments(params.arguments), call.controller.signal);
        if (isUnavailable(params, call.controller.signal)) return unavailableResult(params, call.controller.signal);
        if (typeof context?.onToolResult === "function") {
          result = await context.onToolResult({
            tool,
            result,
            callId: params.callId || null,
            signal: call.controller.signal,
          }, call.controller.signal);
        }
        if (isUnavailable(params, call.controller.signal)) return unavailableResult(params, call.controller.signal);
        const hostActions = Array.isArray(result?.details?.host_actions)
          ? result.details.host_actions.filter((action) => action && typeof action === "object")
          : [];
        if (tool.host_action_capable === true && hostActions.length && typeof context?.onHostAction === "function") {
          for (const [actionIndex, action] of hostActions.entries()) {
            if (isUnavailable(params, call.controller.signal)) return unavailableResult(params, call.controller.signal);
            try {
              await context.onHostAction(action, {
                callId: params.callId || null,
                toolName: tool.name,
                actionIndex,
                signal: call.controller.signal,
              }, call.controller.signal);
            } catch {
              // Host actions are best-effort, matching the previous allSettled
              // behavior. Cancellation is checked separately and fails closed.
            }
            if (isUnavailable(params, call.controller.signal)) return unavailableResult(params, call.controller.signal);
          }
        }
        if (isUnavailable(params, call.controller.signal)) return unavailableResult(params, call.controller.signal);
        if (params.callId) hostResults.set(hostResultKey(params), result);
        return {
          success: !(result?.isError === true || result?.success === false || result?.details?.success === false),
          contentItems: toolResultContentItems(result),
        };
      } catch (error) {
        if (isUnavailable(params, call.controller.signal)) return unavailableResult(params, call.controller.signal);
        if (params.callId) {
          hostResults.set(hostResultKey(params), {
            isError: true,
            content: [{ type: "text", text: `工具执行失败: ${error?.message || String(error)}` }],
          });
        }
        return {
          success: false,
          contentItems: [{ type: "inputText", text: `工具执行失败: ${error?.message || String(error)}` }],
        };
      } finally {
        activeCalls.delete(call);
        call.settle?.();
      }
    },
  };
}

export default createDynamicToolBridge;
