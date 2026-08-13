import { createServer } from "node:http";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  cloneJson,
  mapRuntimeRequestParameters,
  runtimeParametersFromConfig,
} from "./runtime_parameters.js";

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 600_000;

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

export function chatCompletionsUrl(value) {
  const baseUrl = normalizeBaseUrl(value);
  if (!baseUrl) throw new Error("Chat Completions 适配器缺少 API 地址");
  if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl;
  if (/\/responses$/i.test(baseUrl)) return baseUrl.replace(/\/responses$/i, "/chat/completions");
  return `${baseUrl}/chat/completions`;
}

export function responsesUrl(value) {
  const baseUrl = normalizeBaseUrl(value);
  if (!baseUrl) throw new Error("Responses 参数适配器缺少 API 地址");
  if (/\/responses$/i.test(baseUrl)) return baseUrl;
  if (/\/chat\/completions$/i.test(baseUrl)) return baseUrl.replace(/\/chat\/completions$/i, "/responses");
  return `${baseUrl}/responses`;
}

function contentToChat(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  const parts = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (["input_text", "output_text", "text"].includes(part.type)) {
      parts.push({ type: "text", text: String(part.text || "") });
      continue;
    }
    if (part.type === "input_image" || part.type === "image_url") {
      const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) parts.push({ type: "image_url", image_url: { url, ...(part.detail ? { detail: part.detail } : {}) } });
    }
  }
  if (parts.every((part) => part.type === "text")) return parts.map((part) => part.text).join("");
  return parts;
}

function agentMessageToChat(content) {
  if (!Array.isArray(content)) return contentToChat(content);
  const text = [];
  for (const part of content) {
    if (typeof part === "string") {
      text.push(part);
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (["input_text", "output_text", "text"].includes(part.type)) {
      text.push(String(part.text || ""));
      continue;
    }
    // Codex V2 uses this field for the model-visible private payload of an
    // inter-agent message. Responses understands the native item directly;
    // Chat Completions needs the payload flattened into the user message.
    if (part.type === "encrypted_content") {
      text.push(String(part.encrypted_content || ""));
    }
  }
  return text.filter(Boolean).join("\n");
}

function instructionText(content) {
  const converted = contentToChat(content);
  if (typeof converted === "string") return converted;
  if (!Array.isArray(converted)) return converted == null ? "" : String(converted);
  return converted
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .filter(Boolean)
    .join("\n");
}

function stringifyOutput(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    const text = output.map((item) => item?.text || item?.content || "").filter(Boolean).join("\n");
    if (text) return text;
  }
  return JSON.stringify(output ?? "");
}

function namespaceToolKey(namespace, name) {
  return `${String(namespace || "")}\u0000${String(name || "")}`;
}

function chatToolName(namespace, name, usedNames = new Set()) {
  const raw = `${String(namespace || "")}__${String(name || "")}`;
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "_") || "tool";
  if (sanitized.length <= 64 && !usedNames.has(sanitized)) return sanitized;
  const suffix = createHash("sha256").update(raw).digest("hex").slice(0, 10);
  const prefix = sanitized.slice(0, Math.max(1, 64 - suffix.length - 2));
  let candidate = `${prefix}__${suffix}`;
  let collision = 0;
  while (usedNames.has(candidate)) {
    collision += 1;
    const collisionSuffix = `${suffix}${collision}`.slice(0, 12);
    candidate = `${sanitized.slice(0, Math.max(1, 64 - collisionSuffix.length - 2))}__${collisionSuffix}`;
  }
  return candidate;
}

function namespaceToolMap(tools) {
  const responseToChat = new Map();
  const chatToResponse = new Map();
  const usedNames = new Set(
    (Array.isArray(tools) ? tools : [])
      .filter((tool) => tool?.type === "function")
      .map((tool) => String(tool?.function?.name || tool?.name || ""))
      .filter(Boolean),
  );
  for (const namespace of Array.isArray(tools) ? tools : []) {
    if (!namespace || namespace.type !== "namespace" || !namespace.name) continue;
    for (const tool of Array.isArray(namespace.tools) ? namespace.tools : []) {
      if (!tool || tool.type !== "function" || !tool.name) continue;
      const flattened = chatToolName(namespace.name, tool.name, usedNames);
      usedNames.add(flattened);
      const target = { namespace: String(namespace.name), name: String(tool.name) };
      responseToChat.set(namespaceToolKey(target.namespace, target.name), flattened);
      chatToResponse.set(flattened, target);
    }
  }
  return { responseToChat, chatToResponse };
}

function inputToMessages(input, instructions, toolMap = namespaceToolMap([])) {
  const messages = [];
  const instructionParts = [];
  if (String(instructions || "").trim()) instructionParts.push(String(instructions));
  const items = Array.isArray(input) ? input : [{ role: "user", content: input }];
  let pendingToolCalls = [];
  const flushToolCalls = () => {
    if (!pendingToolCalls.length) return;
    messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
    pendingToolCalls = [];
  };
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "reasoning") continue;
    if (item.type === "function_call") {
      const namespacedName = item.namespace
        ? toolMap.responseToChat.get(namespaceToolKey(item.namespace, item.name))
          || chatToolName(item.namespace, item.name)
        : null;
      pendingToolCalls.push({
        id: String(item.call_id || item.id || `call_${randomUUID()}`),
        type: "function",
        function: {
          name: String(namespacedName || item.name || ""),
          arguments: typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      });
      continue;
    }
    flushToolCalls();
    if (item.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(item.call_id || item.id || ""),
        content: stringifyOutput(item.output),
      });
      continue;
    }
    if (item.type === "agent_message") {
      const content = agentMessageToChat(item.content);
      if (content.trim()) messages.push({ role: "user", content });
      continue;
    }
    if (item.role === "system" || item.role === "developer") {
      const content = instructionText(item.content);
      if (content.trim()) instructionParts.push(content);
      continue;
    }
    if (["user", "assistant", "tool"].includes(item.role)) {
      messages.push({ role: item.role, content: contentToChat(item.content) });
    }
  }
  flushToolCalls();
  if (instructionParts.length) {
    messages.unshift({ role: "system", content: instructionParts.join("\n\n") });
  }
  return messages.length ? messages : [{ role: "user", content: "" }];
}

function toolsToChat(tools, toolMap = namespaceToolMap(tools)) {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools.flatMap((tool) => {
    if (!tool) return [];
    if (tool.type === "function") {
      if (tool.function) return [{ type: "function", function: tool.function }];
      return [{
        type: "function",
        function: {
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: tool.parameters || {},
          ...(tool.strict != null ? { strict: tool.strict } : {}),
        },
      }];
    }
    if (tool.type !== "namespace" || !tool.name) return [];
    return (Array.isArray(tool.tools) ? tool.tools : []).flatMap((child) => {
      if (!child || child.type !== "function" || !child.name) return [];
      const flattened = toolMap.responseToChat.get(namespaceToolKey(tool.name, child.name));
      if (!flattened) return [];
      return [{
        type: "function",
        function: {
          name: flattened,
          ...(child.description ? { description: child.description } : {}),
          parameters: child.parameters || {},
          ...(child.strict != null ? { strict: child.strict } : {}),
        },
      }];
    });
  });
  return converted.length ? converted : undefined;
}

function toolChoiceToChat(choice, toolMap = namespaceToolMap([])) {
  if (!choice || typeof choice === "string") return choice;
  if (choice.type === "function" && choice.name) {
    const name = choice.namespace
      ? toolMap.responseToChat.get(namespaceToolKey(choice.namespace, choice.name))
        || chatToolName(choice.namespace, choice.name)
      : choice.name;
    return { type: "function", function: { name } };
  }
  return undefined;
}

export function responsesRequestToChatCompletions(body = {}, extraBody = null, parameters = null) {
  const toolMap = namespaceToolMap(body.tools);
  const request = {
    ...jsonObject(extraBody),
    model: body.model,
    messages: inputToMessages(body.input, body.instructions, toolMap),
    stream: body.stream !== false,
  };
  const tools = toolsToChat(body.tools, toolMap);
  const toolChoice = toolChoiceToChat(body.tool_choice, toolMap);
  if (tools) request.tools = tools;
  if (toolChoice) request.tool_choice = toolChoice;
  if (body.parallel_tool_calls != null) request.parallel_tool_calls = Boolean(body.parallel_tool_calls);
  if (body.temperature != null) request.temperature = body.temperature;
  if (body.top_p != null) request.top_p = body.top_p;
  if (body.max_output_tokens != null) request.max_tokens = body.max_output_tokens;
  if (body.stop != null) request.stop = body.stop;
  return mapRuntimeRequestParameters(
    body,
    request,
    parameters || runtimeParametersFromConfig({ api_format: "chat_completions" }),
    "chat_completions",
  );
}

export function normalizeResponsesRequest(body = {}, parameters = null) {
  return mapRuntimeRequestParameters(
    body,
    cloneJson(body),
    parameters || runtimeParametersFromConfig({ api_format: "responses" }),
    "responses",
  );
}

function responseUsage(usage = {}) {
  const inputTokens = Number(usage.prompt_tokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.completion_tokens || usage.output_tokens || 0);
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens || 0) },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: Number(usage.completion_tokens_details?.reasoning_tokens || 0) },
    total_tokens: Number(usage.total_tokens || inputTokens + outputTokens),
  };
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : String(content);
  return content.map((part) => part?.text || part?.content || "").filter(Boolean).join("");
}

export function chatCompletionsToResponses(payload = {}, request = {}) {
  const toolMap = namespaceToolMap(request.tools);
  const message = payload.choices?.[0]?.message || {};
  const output = [];
  const text = messageText(message.content);
  if (text) {
    output.push({
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [], logprobs: [] }],
    });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!call?.function?.name) continue;
    const namespaced = toolMap.chatToResponse.get(String(call.function.name));
    output.push({
      id: `fc_${randomUUID().replaceAll("-", "")}`,
      type: "function_call",
      status: "completed",
      call_id: String(call.id || `call_${randomUUID()}`),
      ...(namespaced ? { namespace: namespaced.namespace } : {}),
      name: namespaced?.name || String(call.function.name),
      arguments: typeof call.function.arguments === "string"
        ? call.function.arguments
        : JSON.stringify(call.function.arguments || {}),
    });
  }
  if (!output.length) {
    output.push({
      id: `msg_${randomUUID().replaceAll("-", "")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text: "", annotations: [], logprobs: [] }],
    });
  }
  return {
    id: `resp_${randomUUID().replaceAll("-", "")}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: request.instructions || null,
    model: payload.model || request.model || "",
    output,
    parallel_tool_calls: request.parallel_tool_calls !== false,
    previous_response_id: request.previous_response_id || null,
    tools: request.tools || [],
    tool_choice: request.tool_choice || "auto",
    usage: responseUsage(payload.usage),
  };
}

export function responsesSse(response) {
  let sequence = 0;
  const events = [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.in_progress", response: { ...response, status: "in_progress", output: [] } },
    ...response.output.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
    { type: "response.completed", response },
  ];
  return events.map((event) => {
    const data = { ...event, sequence_number: sequence++ };
    return `event: ${event.type}\ndata: ${JSON.stringify(data)}\n\n`;
  }).join("");
}

function sseEvent(type, payload, sequenceNumber) {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...payload, sequence_number: sequenceNumber })}\n\n`;
}

async function* chatSseData(body) {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder("utf8");
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try { yield JSON.parse(data); } catch { /* Ignore provider keepalive or malformed optional chunks. */ }
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const data = tail.slice(5).trim();
      if (data && data !== "[DONE]") {
        try { yield JSON.parse(data); } catch { /* Ignore a malformed final optional chunk. */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function* chatCompletionsStreamToResponses(upstreamBody, request = {}) {
  const responseId = `resp_${randomUUID().replaceAll("-", "")}`;
  const messageId = `msg_${randomUUID().replaceAll("-", "")}`;
  let sequence = 0;
  let model = request.model || "";
  let text = "";
  let messageStarted = false;
  let usage = {};
  const toolCalls = new Map();
  const progressResponse = {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "in_progress",
    output: [],
    model,
  };
  yield sseEvent("response.created", { response: progressResponse }, sequence++);
  for await (const chunk of chatSseData(upstreamBody)) {
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const delta = choice?.delta || {};
      const content = messageText(delta.content);
      if (content) {
        if (!messageStarted) {
          messageStarted = true;
          yield sseEvent("response.output_item.added", {
            output_index: 0,
            item: {
              id: messageId,
              type: "message",
              status: "in_progress",
              role: "assistant",
              content: [{ type: "output_text", text: "", annotations: [], logprobs: [] }],
            },
          }, sequence++);
        }
        text += content;
        yield sseEvent("response.output_text.delta", {
          item_id: messageId,
          output_index: 0,
          content_index: 0,
          delta: content,
        }, sequence++);
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const index = Number.isInteger(call.index) ? call.index : toolCalls.size;
        const current = toolCalls.get(index) || { id: "", name: "", arguments: "" };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.name += call.function.name;
        if (call.function?.arguments) current.arguments += call.function.arguments;
        toolCalls.set(index, current);
      }
    }
  }
  const payload = {
    model,
    choices: [{ message: {
      role: "assistant",
      content: text,
      tool_calls: [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => ({
        id: call.id || `call_${randomUUID()}`,
        type: "function",
        function: { name: call.name, arguments: call.arguments || "{}" },
      })),
    } }],
    usage,
  };
  const response = chatCompletionsToResponses(payload, request);
  if (text && response.output[0]?.type === "message") response.output[0].id = messageId;
  for (const [outputIndex, item] of response.output.entries()) {
    yield sseEvent("response.output_item.done", { output_index: outputIndex, item }, sequence++);
  }
  yield sseEvent("response.completed", { response }, sequence++);
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  return header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
}

function equalSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error("请求体过大"), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("请求体不是合法 JSON"), { statusCode: 400 });
  }
}

function writeJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

export class ChatCompletionsAdapter {
  constructor({ fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.providers = new Map();
    this.server = null;
    this.origin = null;
    this.accessToken = null;
    this.starting = null;
  }

  async start() {
    if (this.origin) return this;
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        server.unref();
        this.server = server;
        this.origin = `http://127.0.0.1:${server.address().port}`;
        this.accessToken ||= randomBytes(32).toString("hex");
        resolve(this);
      });
    }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async register(providerId, config = {}) {
    await this.start();
    const existing = this.providers.get(String(providerId));
    if (existing) {
      return {
        baseUrl: `${this.origin}/providers/${encodeURIComponent(providerId)}/v1`,
        accessToken: this.accessToken,
      };
    }
    this.providers.set(String(providerId), { config: { ...config } });
    return {
      baseUrl: `${this.origin}/providers/${encodeURIComponent(providerId)}/v1`,
      accessToken: this.accessToken,
    };
  }

  async handle(req, res) {
    try {
      if (req.method !== "POST") return writeJson(res, 405, { error: { message: "只支持 POST" } });
      const match = new URL(req.url || "/", "http://127.0.0.1").pathname.match(/^\/providers\/([^/]+)\/v1\/responses$/);
      const provider = match ? this.providers.get(decodeURIComponent(match[1])) : null;
      if (!provider) return writeJson(res, 404, { error: { message: "项目模型适配器不存在" } });
      if (!equalSecret(bearerToken(req), this.accessToken)) {
        return writeJson(res, 401, { error: { message: "项目模型适配器认证失败" } });
      }
      const request = await readJson(req);
      const extra = jsonObject(provider.config.extra_config);
      const format = String(provider.config.api_format || "chat_completions").trim().toLowerCase();
      const parameters = runtimeParametersFromConfig(provider.config);
      const isChatCompletions = format === "chat_completions";
      const upstreamBody = isChatCompletions
        ? responsesRequestToChatCompletions(request, extra.extra_body, parameters)
        : normalizeResponsesRequest(request, parameters);
      const headers = {
        "content-type": "application/json",
        ...(provider.config.api_key ? { authorization: `Bearer ${provider.config.api_key}` } : {}),
        ...jsonObject(extra.extra_headers),
      };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let upstream;
      try {
        upstream = await this.fetchImpl(
          isChatCompletions ? chatCompletionsUrl(provider.config.api_base) : responsesUrl(provider.config.api_base),
          {
            method: "POST",
            headers,
            body: JSON.stringify(upstreamBody),
            signal: controller.signal,
          },
        );
      } finally {
        clearTimeout(timer);
      }
      if (!upstream.ok) {
        const raw = await upstream.text();
        let payload;
        try { payload = JSON.parse(raw || "{}"); } catch { payload = { error: { message: raw || `HTTP ${upstream.status}` } }; }
        return writeJson(res, upstream.status, payload);
      }
      const contentType = String(upstream.headers.get("content-type") || "").toLowerCase();
      if (!isChatCompletions) {
        res.writeHead(upstream.status, {
          "content-type": contentType || "application/json; charset=utf-8",
          ...(contentType.includes("text/event-stream") ? {
            "cache-control": "no-cache",
            connection: "keep-alive",
          } : {}),
        });
        if (upstream.body) {
          for await (const chunk of upstream.body) res.write(chunk);
        }
        return res.end();
      }
      if (!contentType.includes("text/event-stream")) {
        const raw = await upstream.text();
        let payload;
        try { payload = JSON.parse(raw || "{}"); } catch { payload = { error: { message: raw || "项目模型返回了无效 JSON" } }; }
        const response = chatCompletionsToResponses(payload, request);
        if (request.stream === false) return writeJson(res, 200, response);
        res.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        return res.end(responsesSse(response));
      }
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      for await (const chunk of chatCompletionsStreamToResponses(upstream.body, request)) res.write(chunk);
      res.end();
    } catch (error) {
      const message = error?.name === "AbortError" ? "项目模型请求超时" : error?.message || String(error);
      if (!res.headersSent) writeJson(res, error?.statusCode || 502, { error: { message } });
      else res.end();
    }
  }

  async stop() {
    this.providers.clear();
    const server = this.server;
    this.server = null;
    this.origin = null;
    this.accessToken = null;
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

let sharedAdapter = null;

export function getChatCompletionsAdapter() {
  if (!sharedAdapter) sharedAdapter = new ChatCompletionsAdapter();
  return sharedAdapter;
}

export async function stopChatCompletionsAdapter() {
  const adapter = sharedAdapter;
  sharedAdapter = null;
  await adapter?.stop();
}

export function resetChatCompletionsAdapterForTests() {
  sharedAdapter = null;
}
