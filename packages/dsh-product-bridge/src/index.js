/**
 * App-local DSH Bundle bridge for parent-owned product tools. The process wire carries only a DSH Session id;
 * dsh-work resolves the App identity and credentials in the parent process.
 */

import { randomUUID } from "node:crypto";

export const name = "product-bridge";
export const inject = ["agents", "tools", "webServer"];

const PRODUCT_MCP_TIMEOUT_MS = 60_000;
const PRODUCT_REQUEST_TIMEOUT_MS = 30_000;
const OFFICE_WRITE_TOOL_NAMES = new Set(["artifact_office_create", "artifact_office_edit"]);

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

function createProductHost(ctx) {
  const pending = new Map();

  const sendCancel = (request) => {
    if (!process.connected) return;
    try {
      process.send?.({ type: "product-cancel", id: request.id, sessionId: request.sessionId });
    } catch {
      // The local request is already settling, so disconnect wins.
    }
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
        try {
          process.send({ type: "product-request", id, sessionId, method, payload });
        } catch (error) {
          settle(request, new ProductBridgeError(
            "product-unavailable",
            `product request ${method} failed: ${error?.message || String(error)}`,
          ));
        }
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

/** Build every dsh-work tool contributed to one DSH Agent scope. */
export function createDshWorkProductTools(productHost, agent) {
  return new Map([
    ...createProjectProductTools(productHost, agent),
    ...createOfficeProductTools(productHost, agent),
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
    const state = { tools, productToolDisposers: new Map() };
    agentScopes.set(agent, state);
    state.productToolDisposers = registerTools(tools, createDshWorkProductTools(productHost, agent));
  });

  ctx.on("tools/pre-execute", (exec, next) => {
    if (OFFICE_WRITE_TOOL_NAMES.has(exec.name)) {
      return Promise.resolve({
        kind: "ask",
        reason: `${exec.name} writes a new immutable version to the current dsh-work project Library`,
      });
    }
    return next();
  });

  ctx.on("agent/disposed", ({ agent }) => {
    const state = agentScopes.get(agent);
    agentScopes.delete(agent);
    for (const dispose of state?.productToolDisposers?.values() || []) dispose();
  });

  ctx.effect(() => () => {
    for (const state of agentScopes.values()) {
      for (const dispose of state.productToolDisposers.values()) dispose();
    }
    agentScopes.clear();
  }, "dsh-work product bridge agent scopes");

  if (!ctx.webServer?.port) throw new Error("dsh-work product bridge requires a listening Web server");
  const publishReady = () => {
    if (!ctx.get("webServer")?.port) return;
    process.send?.({ type: "client-ready", url: `http://127.0.0.1:${ctx.webServer.port}/` });
    process.send?.({
      type: "ready",
      distribution: process.env.DSH_RUNTIME_DISTRIBUTION || "npm",
      version: process.env.DSH_RUNTIME_VERSION || null,
    });
  };
  const settled = ctx.get("loader")?.await();
  if (!settled) publishReady();
  else void settled.then(publishReady, () => {});
}
