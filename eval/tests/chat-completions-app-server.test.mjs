import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AgentKernel } from "../../server/src/engine/agent_kernel/kernel.js";
import { createAgentModelBinding } from "../../server/src/engine/agent_kernel/model_provider.js";
import { stopChatCompletionsAdapter } from "../../server/src/engine/agent_kernel/chat_completions_adapter.js";
import { PROJECT_MODEL_BASE_INSTRUCTIONS } from "../../server/src/engine/agent_kernel/model_catalog.js";

const enabled = process.env.DSH_RUN_AGENT_CHAT_ADAPTER_INTEGRATION === "1";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

test("real Agent App Server uses a Chat Completions project model through the adapter", { skip: !enabled }, async (t) => {
  const upstreamRequests = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl_agent_runtime_adapter_test",
      model: "qwen3.7-plus",
      choices: [{ index: 0, delta: { role: "assistant", content: "4" }, finish_reason: null }],
    })}\n\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl_agent_runtime_adapter_test",
      model: "qwen3.7-plus",
      choices: [{ index: 0, delta: { content: "!" }, finish_reason: null }],
    })}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: "chatcmpl_agent_runtime_adapter_test",
      model: "qwen3.7-plus",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const baseUrl = await listen(upstream);
  const binding = await createAgentModelBinding({
    id: "integration-chat-model",
    model_name: "qwen3.7-plus",
    api_base: baseUrl,
    api_key: "project-api-key",
    api_format: "chat_completions",
    extra_config: {
      supports_image_input: true,
      agent_runtime: { context_window: 1_000_000 },
    },
  });
  const kernel = new AgentKernel({
    ...binding.kernelOptions,
    env: {
      ...binding.kernelOptions.env,
      CODEX_HOME: process.env.DSH_AGENT_RUNTIME_HOME,
    },
    cwd: process.cwd(),
    requestTimeoutMs: 30_000,
  });
  t.after(async () => {
    await kernel.stop();
    await stopChatCompletionsAdapter();
    await new Promise((resolve) => upstream.close(resolve));
  });
  const thread = await kernel.startThread({
    cwd: process.cwd(),
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "read-only",
    ephemeral: true,
    ...binding.threadOptions,
  });
  assert.equal(thread.approvalPolicy, "on-request");
  assert.equal(thread.approvalsReviewer, "auto_review");
  const notifications = [];
  const result = await kernel.runTurn({
    threadId: thread.thread.id,
    input: "2+2 equals what?",
    onNotification: (method, params) => notifications.push({ method, params }),
  });
  assert.equal(result.completed.turn.status, "completed");
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, "/v1/chat/completions");
  assert.equal(upstreamRequests[0].authorization, "Bearer project-api-key");
  assert.equal(upstreamRequests[0].body.stream, true);
  assert.equal(upstreamRequests[0].body.model, "qwen3.7-plus");
  assert.equal(upstreamRequests[0].body.messages[0].role, "system");
  assert.match(upstreamRequests[0].body.messages[0].content, new RegExp(PROJECT_MODEL_BASE_INSTRUCTIONS.slice(0, 48)));
  assert.doesNotMatch(
    upstreamRequests[0].body.messages[0].content,
    /You are (?:GPT|Codex)|running in the Codex CLI|based on GPT/i,
  );
  assert.ok(upstreamRequests[0].body.messages.some((message) => message.role === "user"));
  const deltaIndexes = notifications
    .map(({ method }, index) => method === "item/agentMessage/delta" ? index : -1)
    .filter((index) => index >= 0);
  const completedIndex = notifications.findIndex(({ method, params }) => method === "item/completed" && params.item?.type === "agentMessage");
  assert.equal(deltaIndexes.length, 2);
  assert.ok(deltaIndexes.every((index) => index < completedIndex));
  const final = notifications.find(({ method, params }) => method === "item/completed" && params.item?.type === "agentMessage");
  assert.equal(final?.params?.item?.text, "4!");
  assert.equal(notifications.some(({ method, params }) => (
    method === "warning" && /fallback metadata/i.test(String(params?.message || ""))
  )), false);
});
