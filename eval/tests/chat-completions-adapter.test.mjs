import test from "node:test";
import assert from "node:assert/strict";
import {
  ChatCompletionsAdapter,
  chatCompletionsToResponses,
  chatCompletionsStreamToResponses,
  normalizeResponsesRequest,
  responsesRequestToChatCompletions,
} from "../../server/src/engine/agent_kernel/chat_completions_adapter.js";
import { runtimeParametersFromConfig } from "../../server/src/engine/agent_kernel/runtime_parameters.js";

const loopbackEnabled = process.env.DSH_RUN_AGENT_ADAPTER_LOOPBACK === "1";

const responsesRequest = {
  model: "project-chat-model",
  instructions: "You are a data agent.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "count rows" }] },
    { type: "function_call", call_id: "call_1", name: "query", arguments: "{\"sql\":\"select count(*)\"}" },
    { type: "function_call_output", call_id: "call_1", output: "4" },
  ],
  tools: [{ type: "function", name: "query", description: "Run SQL", parameters: { type: "object" }, strict: true }],
  tool_choice: "auto",
  parallel_tool_calls: true,
  stream: true,
  reasoning: { effort: "high" },
};

test("Responses request is translated to Chat Completions messages and tools", () => {
  const chat = responsesRequestToChatCompletions(responsesRequest);
  assert.equal(chat.model, "project-chat-model");
  assert.equal(chat.stream, true);
  assert.deepEqual(chat.messages[0], { role: "system", content: "You are a data agent." });
  assert.deepEqual(chat.messages[1], { role: "user", content: "count rows" });
  assert.equal(chat.messages[2].tool_calls[0].function.name, "query");
  assert.deepEqual(chat.messages[3], { role: "tool", tool_call_id: "call_1", content: "4" });
  assert.equal(chat.tools[0].function.name, "query");
  assert.equal(chat.tools[0].function.strict, true);
  assert.equal(chat.reasoning_effort, "high");
});

test("Codex V2 inter-agent messages remain model-visible through Chat Completions", () => {
  const chat = responsesRequestToChatCompletions({
    model: "project-chat-model",
    input: [{
      type: "agent_message",
      author: "/root",
      recipient: "/root/child",
      content: [
        { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/child" },
        { type: "encrypted_content", encrypted_content: "Inspect the Plugin lifecycle." },
      ],
    }],
    stream: false,
  });

  assert.deepEqual(chat.messages, [{
    role: "user",
    content: "Message Type: NEW_TASK\nTask name: /root/child\nInspect the Plugin lifecycle.",
  }]);
});

test("Chat Completions uses one leading system message for all high-priority instructions", () => {
  const chat = responsesRequestToChatCompletions({
    model: "project-chat-model",
    instructions: "Application instructions",
    input: [
      { type: "message", role: "system", content: [{ type: "input_text", text: "Runtime rules" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Project rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "User request" }] },
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Turn rules" }] },
    ],
    stream: false,
  });

  assert.deepEqual(chat.messages, [
    {
      role: "system",
      content: "Application instructions\n\nRuntime rules\n\nProject rules\n\nTurn rules",
    },
    { role: "user", content: "User request" },
  ]);
  assert.equal(chat.messages.filter((message) => message.role === "system").length, 1);
  assert.equal(chat.messages.some((message) => message.role === "developer"), false);
});

test("Responses requests preserve instructions and developer roles", () => {
  const request = {
    model: "project-responses-model",
    instructions: "Application instructions",
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "Project rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "User request" }] },
    ],
    stream: false,
  };
  const mapped = normalizeResponsesRequest(request);

  assert.notEqual(mapped, request);
  assert.equal(mapped.instructions, "Application instructions");
  assert.deepEqual(mapped.input.map((message) => message.role), ["developer", "user"]);
  assert.equal(mapped.input[0].content[0].text, "Project rules");
});

test("Responses image input is preserved for Chat Completions vision models", () => {
  const chat = responsesRequestToChatCompletions({
    model: "project-vision-model",
    input: [{
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "读取截图" },
        { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "high" },
      ],
    }],
    stream: false,
  });
  assert.deepEqual(chat.messages[0], {
    role: "user",
    content: [
      { type: "text", text: "读取截图" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } },
    ],
  });
});

test("Model parameter mapping rewrites Chat Completions keys and API values", () => {
  const parameters = runtimeParametersFromConfig({
    api_format: "chat_completions",
    extra_config: {
      agent_runtime: {
        parameters: {
          reasoning_effort: {
            request_key: "thinking.level",
            options: [{ value: "medium", label: "中", api_value: "balanced" }],
            default: "medium",
          },
          verbosity: {
            request_key: "answer.detail",
            options: [{ value: "low", api_value: "2" }],
            default: "low",
          },
        },
      },
    },
  });
  const chat = responsesRequestToChatCompletions({
    ...responsesRequest,
    reasoning: { effort: "medium" },
    text: { verbosity: "low" },
  }, null, parameters);
  assert.equal(chat.reasoning_effort, undefined);
  assert.equal(chat.thinking.level, "balanced");
  assert.equal(chat.answer.detail, 2);
  const unsupported = responsesRequestToChatCompletions({
    ...responsesRequest,
    reasoning: { effort: "high" },
    text: { verbosity: "high" },
  }, null, parameters);
  assert.equal(unsupported.thinking, undefined);
  assert.equal(unsupported.answer, undefined);
});

test("Chat Completions tool calls are translated to Agent ResponseItems", () => {
  const response = chatCompletionsToResponses({
    model: "project-chat-model",
    choices: [{ message: { content: null, tool_calls: [{ id: "call_2", type: "function", function: { name: "query", arguments: "{\"sql\":\"select 1\"}" } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  }, responsesRequest);
  assert.equal(response.output[0].type, "function_call");
  assert.equal(response.output[0].call_id, "call_2");
  assert.equal(response.output[0].name, "query");
  assert.equal(response.usage.input_tokens, 10);
  assert.equal(response.usage.output_tokens, 5);
});

test("Responses namespace tools round-trip through Chat Completions", () => {
  const namespaceRequest = {
    model: "project-chat-model",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "echo" }] },
      {
        type: "function_call",
        call_id: "call_previous",
        namespace: "mcp__native-echo",
        name: "echo",
        arguments: "{\"text\":\"previous\"}",
      },
      { type: "function_call_output", call_id: "call_previous", output: "echo:previous" },
    ],
    tools: [{
      type: "namespace",
      name: "mcp__native-echo",
      description: "Native echo tools",
      tools: [{
        type: "function",
        name: "echo",
        description: "Echo text",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        strict: false,
      }],
    }],
    tool_choice: { type: "function", namespace: "mcp__native-echo", name: "echo" },
  };

  const chat = responsesRequestToChatCompletions(namespaceRequest);
  const flattenedName = chat.tools[0].function.name;
  assert.equal(flattenedName, "mcp__native-echo__echo");
  assert.equal(chat.messages[1].tool_calls[0].function.name, flattenedName);
  assert.equal(chat.tool_choice.function.name, flattenedName);

  const response = chatCompletionsToResponses({
    model: "project-chat-model",
    choices: [{
      message: {
        content: null,
        tool_calls: [{
          id: "call_native",
          type: "function",
          function: { name: flattenedName, arguments: "{\"text\":\"native\"}" },
        }],
      },
    }],
  }, namespaceRequest);
  assert.equal(response.output[0].namespace, "mcp__native-echo");
  assert.equal(response.output[0].name, "echo");
});

test("Long namespace tool names use stable Chat Completions-safe names", () => {
  const namespace = `mcp__${"server".repeat(12)}`;
  const request = {
    model: "project-chat-model",
    input: [],
    tools: [{
      type: "namespace",
      name: namespace,
      description: "Long namespace",
      tools: [{ type: "function", name: "echo", description: "Echo", parameters: {} }],
    }],
  };
  const first = responsesRequestToChatCompletions(request).tools[0].function.name;
  const second = responsesRequestToChatCompletions(request).tools[0].function.name;
  assert.ok(first.length <= 64);
  assert.match(first, /^[a-zA-Z0-9_-]+$/);
  assert.equal(first, second);
  const response = chatCompletionsToResponses({
    choices: [{ message: { tool_calls: [{ id: "call_long", function: { name: first, arguments: "{}" } }] } }],
  }, request);
  assert.equal(response.output[0].namespace, namespace);
  assert.equal(response.output[0].name, "echo");
});

test("Chat Completions SSE is translated into incremental Responses events", async () => {
  const chatSse = [
    'data: {"model":"project-chat-model","choices":[{"index":0,"delta":{"role":"assistant","content":"There are "}}]}',
    'data: {"model":"project-chat-model","choices":[{"index":0,"delta":{"content":"4 rows."},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}',
    'data: [DONE]',
    '',
  ].join('\n\n');
  const output = [];
  for await (const event of chatCompletionsStreamToResponses(new Response(chatSse).body, responsesRequest)) output.push(event);
  const sse = output.join("");
  const eventTypes = [...sse.matchAll(/^event: ([^\n]+)$/gm)].map((match) => match[1]);
  const itemAddedIndex = eventTypes.indexOf("response.output_item.added");
  const firstDeltaIndex = eventTypes.indexOf("response.output_text.delta");
  const itemDoneIndex = eventTypes.indexOf("response.output_item.done");
  assert.ok(itemAddedIndex >= 0, "message item must be active before text deltas arrive");
  assert.ok(itemAddedIndex < firstDeltaIndex, "message item must be added before the first text delta");
  assert.ok(firstDeltaIndex < itemDoneIndex, "incremental text must arrive before the completed item");
  assert.match(sse, /response\.output_text\.delta/);
  assert.match(sse, /There are /);
  assert.match(sse, /4 rows\./);
  assert.match(sse, /response\.output_item\.done/);
  assert.match(sse, /"input_tokens":12/);
  assert.match(sse, /response\.completed/);
});

test("Loopback adapter forwards credentials upstream and returns Responses SSE", { skip: !loopbackEnabled }, async (t) => {
  let captured = null;
  const adapter = new ChatCompletionsAdapter({
    fetchImpl: async (url, options) => {
      captured = { url, options, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        id: "chatcmpl_1",
        model: "project-chat-model",
        choices: [{ message: { role: "assistant", content: "There are 4 rows." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  t.after(() => adapter.stop());
  const registration = await adapter.register("provider_test", {
    api_base: "https://models.example.com/v1",
    api_key: "upstream-secret",
  });
  const result = await fetch(`${registration.baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${registration.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify(responsesRequest),
  });
  assert.equal(result.status, 200);
  assert.equal(captured.url, "https://models.example.com/v1/chat/completions");
  assert.equal(captured.options.headers.authorization, "Bearer upstream-secret");
  assert.equal(captured.body.stream, true);
  const sse = await result.text();
  assert.match(sse, /event: response\.output_item\.done/);
  assert.match(sse, /There are 4 rows\./);
  assert.match(sse, /event: response\.completed/);
});

test("Loopback adapter rewrites custom Responses parameters before forwarding", { skip: !loopbackEnabled }, async (t) => {
  let captured = null;
  const adapter = new ChatCompletionsAdapter({
    fetchImpl: async (url, options) => {
      captured = { url, body: JSON.parse(options.body) };
      return new Response(JSON.stringify({
        id: "resp_custom_1",
        object: "response",
        status: "completed",
        output: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  t.after(() => adapter.stop());
  const registration = await adapter.register("provider_custom_responses", {
    api_base: "https://models.example.com/v1",
    api_key: "upstream-secret",
    api_format: "responses",
    extra_config: {
      agent_runtime: {
        parameters: {
          reasoning_effort: {
            request_key: "thinking.level",
            options: [{ value: "medium", api_value: "balanced" }],
            default: "medium",
          },
        },
      },
    },
  });
  const result = await fetch(`${registration.baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${registration.accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ ...responsesRequest, stream: false, reasoning: { effort: "medium" } }),
  });
  assert.equal(result.status, 200);
  assert.equal(captured.url, "https://models.example.com/v1/responses");
  assert.equal(captured.body.reasoning, undefined);
  assert.equal(captured.body.thinking.level, "balanced");
  assert.equal((await result.json()).id, "resp_custom_1");
});
