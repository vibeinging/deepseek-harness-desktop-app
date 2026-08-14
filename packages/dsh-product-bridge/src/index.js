/**
 * App-local DSH Bundle bridge for parent-owned product tools. The process wire carries only a DSH Session id;
 * dsh-work resolves the App identity and credentials in the parent process.
 */

import { randomUUID } from "node:crypto";

export const name = "product-bridge";
export const inject = ["agents", "tools", "webServer"];

const PRODUCT_MCP_TIMEOUT_MS = 60_000;
const PRODUCT_REQUEST_TIMEOUT_MS = 30_000;
const PRODUCT_WRITE_TOOL_NAMES = new Set([
  "artifact_office_create",
  "artifact_office_edit",
  "canvas_create",
  "canvas_edit",
  "canvas_suggest",
]);

const PROJECT_TOOL_SPECS = [
  {
    name: "project_list",
    method: "projectList",
    title: "List projects",
    description: "List dsh-work projects available to the current user.",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Optional project name search." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "conversation_list",
    method: "conversationList",
    title: "List project conversations",
    description: "List conversations in the project bound to the current DSH Session.",
    parameters: {
      type: "object",
      properties: {
        archived: { type: "boolean", description: "Include archived conversations." },
      },
      additionalProperties: false,
    },
  },
];

class ProductBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProductBridgeError";
    this.code = code;
  }
}

function isProductResponse(message) {
  if (!message || typeof message !== "object" || message.type !== "product-response"
    || typeof message.id !== "string" || !message.result || typeof message.result.ok !== "boolean") return false;
  if (message.result.ok) return Object.hasOwn(message.result, "value");
  return typeof message.result.error?.code === "string"
    && typeof message.result.error?.message === "string";
}

/**
 * Send one optional IPC message without turning parent shutdown into an unhandled process error.
 * @param {NodeJS.Process | { connected?: boolean, send?: Function }} channel Parent IPC channel.
 * @param {object} message Serializable process message.
 * @param {(error: Error) => void} onError Delivery failure handler.
 * @returns {boolean} Whether the channel accepted the send attempt.
 */
export function sendRuntimeParentMessage(channel, message, onError = () => {}) {
  if (channel?.connected !== true || typeof channel.send !== "function") {
    onError(Object.assign(new Error("Parent IPC channel is closed"), { code: "ERR_IPC_CHANNEL_CLOSED" }));
    return false;
  }
  try {
    channel.send(message, (error) => {
      if (error) onError(error);
    });
    return true;
  } catch (error) {
    onError(error);
    return false;
  }
}

function createProductHost(ctx) {
  const pending = new Map();

  const sendCancel = (request) => {
    sendRuntimeParentMessage(process, {
      type: "product-cancel",
      id: request.id,
      sessionId: request.sessionId,
    });
  };

  const settle = (request, error, value) => {
    clearTimeout(request.timer);
    request.signal?.removeEventListener("abort", request.onAbort);
    pending.delete(request.id);
    if (error) request.reject(error);
    else request.resolve(value);
  };

  const onMessage = (message) => {
    if (!isProductResponse(message)) return;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.result.ok) settle(request, null, message.result.value);
    else settle(request, new ProductBridgeError(message.result.error.code, message.result.error.message));
  };

  ctx.effect(() => {
    process.on("message", onMessage);
    return () => {
      process.off("message", onMessage);
      for (const request of pending.values()) {
        sendCancel(request);
        settle(request, new ProductBridgeError("product-unavailable", "dsh-work product bridge disposed"));
      }
    };
  }, "dsh-work product bridge IPC");

  return {
    request(sessionId, method, payload, signal) {
      if (!process.connected || typeof process.send !== "function") {
        return Promise.reject(new ProductBridgeError("product-unavailable", "dsh-work parent process is unavailable"));
      }
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const request = {
          id,
          sessionId,
          resolve,
          reject,
          signal,
          onAbort: null,
          timer: null,
        };
        request.onAbort = () => {
          sendCancel(request);
          settle(request, new ProductBridgeError("product-rejected", `product request ${method} aborted`));
        };
        if (signal?.aborted) {
          request.onAbort();
          return;
        }
        signal?.addEventListener("abort", request.onAbort, { once: true });
        request.timer = setTimeout(() => {
          sendCancel(request);
          settle(request, new ProductBridgeError("product-timeout", `product request ${method} timed out`));
        }, PRODUCT_REQUEST_TIMEOUT_MS);
        request.timer.unref?.();
        pending.set(id, request);
        sendRuntimeParentMessage(
          process,
          { type: "product-request", id, sessionId, method, payload },
          (error) => {
            if (!pending.has(id)) return;
            settle(request, new ProductBridgeError(
              "product-unavailable",
              `product request ${method} failed: ${error?.message || String(error)}`,
            ));
          },
        );
      });
    },
  };
}

const OFFICE_OPERATION_SCHEMA = {
  type: "object",
  properties: {
    type: {
      type: "string",
      description: "replace_text | replace_range | set_cell | clear_cell | set_range | annotate_region | cover_text",
    },
    anchor: { type: "string", description: "Stable anchor returned by artifact_office_inspect." },
    text: { type: "string" },
    start: {},
    end: { type: "number" },
    sheet: { type: "string" },
    address: { type: "string" },
    value: {},
    formula: { type: "string" },
    values: { type: "array", items: { type: "array", items: {} } },
    page: { type: "number" },
    rect: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["x", "y", "width", "height"],
      additionalProperties: false,
    },
    color: { type: "string" },
  },
  required: ["type"],
  additionalProperties: true,
};

const OFFICE_TOOL_SPECS = [
  {
    name: "artifact_office_inspect",
    method: "artifactOfficeInspect",
    title: "Inspect office artifact",
    description: "Read the current editable structure and stable anchors of a Markdown, DOCX, XLSX, PPTX, or PDF artifact. Always inspect before editing.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Current project id; omit to use the bound DSH Session project." },
        artifact_id: { type: "string", description: "Stable project artifact id." },
        version_id: { type: "string", description: "Version to inspect; omit for the current version." },
      },
      required: ["artifact_id"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_office_create",
    method: "artifactOfficeCreate",
    title: "Create office artifact",
    description: "Create a Markdown, DOCX, XLSX, PPTX, or PDF artifact in the current project Library and version history.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Current project id; omit to use the bound DSH Session project." },
        format: { type: "string", enum: ["markdown", "docx", "xlsx", "pptx", "pdf"] },
        name: { type: "string" },
        title: { type: "string" },
        content: { type: "string" },
        description: { type: "string" },
        specification: { type: "object", additionalProperties: true },
      },
      required: ["format"],
      additionalProperties: false,
    },
  },
  {
    name: "artifact_office_edit",
    method: "artifactOfficeEdit",
    title: "Edit office artifact",
    description: "Edit an office artifact at stable anchors returned by artifact_office_inspect. Saving creates an immutable new version and rejects a stale base version.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Current project id; omit to use the bound DSH Session project." },
        artifact_id: { type: "string", description: "Stable project artifact id." },
        base_version_id: { type: "string", description: "Current version id returned by artifact_office_inspect." },
        operations: { type: "array", items: OFFICE_OPERATION_SCHEMA },
        change_summary: { type: "string" },
      },
      required: ["artifact_id", "base_version_id", "operations"],
      additionalProperties: false,
    },
  },
];

const CANVAS_OPERATION_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["replace_range", "replace_all"] },
    start: { type: "number", description: "UTF-16 start offset for replace_range." },
    end: { type: "number", description: "UTF-16 end offset for replace_range." },
    text: { type: "string", description: "Replacement text." },
  },
  required: ["type", "text"],
  additionalProperties: false,
};

const CANVAS_TOOL_SPECS = [
  {
    name: "canvas_inspect",
    method: "canvasInspect",
    title: "Inspect canvas",
    description: "Read a Canvas or local Site in the current conversation, including its content and immutable version id. Always inspect before editing or suggesting.",
    parameters: {
      type: "object",
      properties: {
        canvas_id: { type: "string", description: "Canvas id in the current conversation." },
      },
      required: ["canvas_id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_create",
    method: "canvasCreate",
    title: "Create canvas",
    description: "Create a versioned document, code Canvas, or local single-file HTML Site in the current conversation.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "Optional title; derived from content when omitted." },
        kind: { type: "string", enum: ["document", "code", "site"], description: "Canvas kind; defaults to document." },
        language: { type: "string", description: "Code language; Sites always use html." },
        content: { type: "string", description: "Initial full content; a Site must be complete single-file HTML." },
        change_summary: { type: "string", description: "Creation summary." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "canvas_edit",
    method: "canvasEdit",
    title: "Edit canvas",
    description: "Save a new immutable Canvas or Site version. Inspect first and provide the current base version; use either full content or non-overlapping operations.",
    parameters: {
      type: "object",
      properties: {
        canvas_id: { type: "string", description: "Canvas id in the current conversation." },
        base_version_id: { type: "string", description: "Current version id returned by canvas_inspect." },
        content: { type: "string", description: "Replacement full content; mutually exclusive with operations." },
        operations: { type: "array", items: CANVAS_OPERATION_SCHEMA, description: "Precise edits against the same immutable base version." },
        change_summary: { type: "string", description: "Change summary." },
      },
      required: ["canvas_id", "base_version_id"],
      additionalProperties: false,
    },
  },
  {
    name: "canvas_suggest",
    method: "canvasSuggest",
    title: "Suggest canvas edit",
    description: "Create a reviewable inline suggestion against an exact selection in the current Canvas version without changing its content.",
    parameters: {
      type: "object",
      properties: {
        canvas_id: { type: "string", description: "Canvas id in the current conversation." },
        base_version_id: { type: "string", description: "Current version id returned by canvas_inspect." },
        start: { type: "number", description: "UTF-16 selection start offset." },
        end: { type: "number", description: "UTF-16 selection end offset." },
        selected_text: { type: "string", description: "Exact selected text; the parent verifies it byte-for-byte." },
        replacement_text: { type: "string", description: "Suggested replacement text." },
        instruction: { type: "string", description: "Reason or requested rewrite." },
      },
      required: ["canvas_id", "base_version_id", "start", "end", "selected_text", "replacement_text"],
      additionalProperties: false,
    },
  },
];

const PRESENTATION_TOOL_SPECS = [{
  name: "ui_render",
  method: "uiRender",
  title: "Render structured UI",
  description: "Render one safe, schema-validated interactive surface in the conversation. Buttons and forms submit a visible next user message and do not execute hidden actions.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["schema_version", "surface_id", "revision", "summary", "root"],
    properties: {
      schema_version: { type: "number", enum: [1] },
      surface_id: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },
      revision: { type: "integer", minimum: 1, maximum: 1_000_000 },
      title: { type: "string", minLength: 1, maxLength: 120 },
      summary: { type: "string", minLength: 1, maxLength: 1_000 },
      root: {
        type: "object",
        required: ["id", "type"],
        description: "Complete component tree using stack, grid, section, text, markdown, metric, alert, state, divider, table, chart, image, button, form, text_input, select, or checkbox nodes.",
      },
    },
  },
}];

function productTool(productHost, agent, spec) {
  return {
    label: spec.title,
    definition: {
      name: spec.name,
      description: spec.description,
      parameters: structuredClone(spec.parameters),
      output: {
        schema: { type: "object", additionalProperties: true },
        render(_args, value) {
          return [{ type: "text", text: JSON.stringify(value) }];
        },
      },
      async execute(args, exec) {
        return productHost.request(
          exec.agent?.session.id || agent.session.id,
          spec.method,
          args,
          exec.signal,
        );
      },
      timeoutMs: PRODUCT_MCP_TIMEOUT_MS,
      presentCall(args) {
        return { card: "generic", title: spec.title, kind: "execute", rawInput: args };
      },
      presentResult() {
        return { card: "generic", title: spec.title };
      },
    },
  };
}

/** Build read-only App context tools without relying on removed DSH product-host packages. */
export function createProjectProductTools(productHost, agent) {
  return new Map(PROJECT_TOOL_SPECS.map((spec) => [spec.name, productTool(productHost, agent, spec)]));
}

/** Build the App-owned office tools registered in one DSH Agent scope. */
export function createOfficeProductTools(productHost, agent) {
  return new Map(OFFICE_TOOL_SPECS.map((spec) => [spec.name, productTool(productHost, agent, spec)]));
}

/** Build the App-owned Canvas and local Site tools registered in one DSH Agent scope. */
export function createCanvasProductTools(productHost, agent) {
  return new Map(CANVAS_TOOL_SPECS.map((spec) => [spec.name, productTool(productHost, agent, spec)]));
}

/** Build safe product-presentation tools registered in one DSH Agent scope. */
export function createPresentationProductTools(productHost, agent) {
  return new Map(PRESENTATION_TOOL_SPECS.map((spec) => [spec.name, productTool(productHost, agent, spec)]));
}

/** Build every dsh-work tool contributed to one DSH Agent scope. */
export function createDshWorkProductTools(productHost, agent) {
  return new Map([
    ...createProjectProductTools(productHost, agent),
    ...createOfficeProductTools(productHost, agent),
    ...createCanvasProductTools(productHost, agent),
    ...createPresentationProductTools(productHost, agent),
  ]);
}

function registerTools(runtimeTools, tools) {
  const disposers = new Map();
  try {
    for (const [toolName, tool] of tools) {
      disposers.set(toolName, runtimeTools.register(tool.definition));
    }
    return disposers;
  } catch (error) {
    for (const dispose of disposers.values()) dispose();
    throw error;
  }
}

function messageText(message) {
  return (Array.isArray(message?.content) ? message.content : [])
    .filter((block) => block?.type === "text")
    .map((block) => String(block.text || ""))
    .join("\n")
    .trim();
}

/** Build one logged DSH recall message from the parent-owned memory snapshot. */
export function createDshWorkMemoryMessage(snapshot) {
  const text = String(snapshot?.text || "").trim();
  const presentation = snapshot?.presentation;
  if (!text || !presentation || !["global_memory", "project_memory"].includes(presentation.type)) return null;
  const source = Object.freeze({
    kind: "plugin",
    plugin: "dsh-work-memory",
    form: "recall",
    dshWorkMemory: structuredClone(presentation),
  });
  const content = Object.freeze([Object.freeze({ type: "text", text })]);
  return Object.freeze({ id: randomUUID(), role: "user", content, source });
}

/** Build one logged DSH context message from parent-owned application and project instructions. */
export function createDshWorkInstructionMessage(snapshot) {
  const text = String(snapshot?.instructions?.text || "").trim();
  const scopes = snapshot?.instructions?.scopes;
  if (!text || !scopes || typeof scopes !== "object") return null;
  const source = Object.freeze({
    kind: "plugin",
    plugin: "dsh-work-context",
    form: "instructions",
    dshWorkInstructions: Object.freeze({
      application: scopes.application === true,
      project: scopes.project === true,
      temporary: scopes.temporary === true,
    }),
  });
  const content = Object.freeze([Object.freeze({ type: "text", text })]);
  return Object.freeze({ id: randomUUID(), role: "user", content, source });
}

function registerConversationMemory(productHost, agent) {
  return agent.ctx.on("agent/pre-step", async (payload, next) => {
    const decision = await next();
    if (decision?.kind !== "enter") return decision;
    const query = decision.messages
      .filter((message) => message?.source?.kind === "user")
      .map(messageText)
      .filter(Boolean)
      .join("\n")
      .trim();
    if (!query) return decision;
    try {
      const snapshot = await productHost.request(
        agent.session.id,
        "conversationMemory",
        { query },
        payload.signal,
      );
      const instructions = createDshWorkInstructionMessage(snapshot);
      const memory = createDshWorkMemoryMessage(snapshot);
      const additions = [instructions, memory].filter(Boolean);
      return additions.length ? { kind: "enter", messages: [...decision.messages, ...additions] } : decision;
    } catch (error) {
      agent.ctx.logger.warn(`dsh-work memory unavailable: ${error?.message || String(error)}`);
      return decision;
    }
  });
}

function modelTarget(config) {
  const provider = String(config?.provider || "").trim();
  const model = String(config?.model || "").trim();
  if (!provider || !model) return null;
  return Object.freeze({
    provider,
    model,
    ...(Number.isSafeInteger(config?.maxTokens) && config.maxTokens > 0 ? { maxTokens: config.maxTokens } : {}),
    ...(config?.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
  });
}

function trackAgentModelTarget(agent, state) {
  return agent.ctx.on("agent/request", async (_payload, next) => {
    const resolved = await next();
    state.modelTarget = modelTarget(resolved);
    return resolved;
  }, { prepend: true });
}

function pinInheritedModelTarget(agent, selected) {
  const target = { current: selected, assembled: null };
  const disposeAssembly = agent.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const assembled = await next();
    target.assembled = target.current;
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: target.current.provider,
        model: target.current.model,
      },
    };
  }, { prepend: true });
  const disposeRequest = agent.ctx.on("agent/request", async (_payload, next) => {
    const resolved = await next();
    const selectedTarget = target.assembled || target.current;
    const { reasoningEffort: _reasoningEffort, ...withoutReasoningEffort } = resolved;
    return {
      ...withoutReasoningEffort,
      provider: selectedTarget.provider,
      model: selectedTarget.model,
      ...(selectedTarget.maxTokens ? { maxTokens: selectedTarget.maxTokens } : {}),
      ...(selectedTarget.reasoningEffort ? { reasoningEffort: selectedTarget.reasoningEffort } : {}),
    };
  }, { prepend: true });
  return () => {
    disposeRequest();
    disposeAssembly();
  };
}

/** Mount dsh-work product tools on DSH's public agent and tool seams. */
export function apply(ctx) {
  const productHost = createProductHost(ctx);
  const agentScopes = new Map();
  let stopping = false;

  const stopRuntime = () => {
    if (stopping) return;
    stopping = true;
    void ctx.root.fiber.dispose().finally(() => process.exit(0));
  };

  const onLifecycleMessage = (message) => {
    if (message?.type === "shutdown") stopRuntime();
  };

  ctx.effect(() => {
    process.on("message", onLifecycleMessage);
    process.on("disconnect", stopRuntime);
    return () => {
      process.off("message", onLifecycleMessage);
      process.off("disconnect", stopRuntime);
    };
  }, "dsh-work runtime lifecycle");

  ctx.on("agent/created", ({ agent }) => {
    const tools = agent.ctx.get("tools");
    if (!tools) throw new Error(`product bridge scoped tools are not ready for agent ${agent.id}`);
    const parentId = String(agent.session?.header?.parentSession || "").trim();
    const parent = parentId ? ctx.agents.get(parentId) : null;
    const inheritedTarget = parent ? agentScopes.get(parent)?.modelTarget : null;
    const state = {
      tools,
      productToolDisposers: new Map(),
      memoryDisposer: () => {},
      modelTargetDisposer: () => {},
      modelTrackingDisposer: () => {},
      modelTarget: inheritedTarget || null,
    };
    agentScopes.set(agent, state);
    if (agent.session?.header?.origin === "subagent" && inheritedTarget) {
      state.modelTargetDisposer = pinInheritedModelTarget(agent, inheritedTarget);
    }
    state.modelTrackingDisposer = trackAgentModelTarget(agent, state);
    state.productToolDisposers = registerTools(tools, createDshWorkProductTools(productHost, agent));
    state.memoryDisposer = registerConversationMemory(productHost, agent);
  });

  ctx.on("tools/pre-execute", (exec, next) => {
    if (PRODUCT_WRITE_TOOL_NAMES.has(exec.name)) {
      return Promise.resolve({
        kind: "ask",
        reason: `${exec.name} changes parent-owned dsh-work product data`,
      });
    }
    return next();
  });

  ctx.on("agent/disposed", ({ agent }) => {
    const state = agentScopes.get(agent);
    agentScopes.delete(agent);
    state?.memoryDisposer?.();
    state?.modelTrackingDisposer?.();
    state?.modelTargetDisposer?.();
    for (const dispose of state?.productToolDisposers?.values() || []) dispose();
  });

  ctx.effect(() => () => {
    for (const state of agentScopes.values()) {
      state.memoryDisposer?.();
      state.modelTrackingDisposer?.();
      state.modelTargetDisposer?.();
      for (const dispose of state.productToolDisposers.values()) dispose();
    }
    agentScopes.clear();
  }, "dsh-work product bridge agent scopes");

  if (!ctx.webServer?.port) throw new Error("dsh-work product bridge requires a listening Web server");
  const publishReady = () => {
    if (!ctx.get("webServer")?.port) return;
    sendRuntimeParentMessage(process, {
      type: "client-ready",
      url: `http://127.0.0.1:${ctx.webServer.port}/`,
    });
    sendRuntimeParentMessage(process, {
      type: "ready",
      distribution: process.env.DSH_RUNTIME_DISTRIBUTION || "npm",
      version: process.env.DSH_RUNTIME_VERSION || null,
    });
  };
  const settled = ctx.get("loader")?.await();
  if (!settled) publishReady();
  else void settled.then(publishReady, () => {});
}
