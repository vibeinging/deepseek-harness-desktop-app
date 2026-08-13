import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { AgentKernel } from "../../server/src/engine/agent_kernel/kernel.js";
import { stopChatCompletionsAdapter } from "../../server/src/engine/agent_kernel/chat_completions_adapter.js";
import { createAgentModelBinding } from "../../server/src/engine/agent_kernel/model_provider.js";
import { withNativeCollaborationConfig } from "../../server/src/engine/agent_kernel/native_collaboration.js";

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function chatChunk(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content || "");
  return content.map((part) => part?.text || part?.content || "").join("");
}

function lastUserMessage(body) {
  return [...(body.messages || [])]
    .reverse()
    .find((message) => message?.role === "user");
}

function toolName(body, suffix) {
  return (body.tools || [])
    .map((tool) => tool?.function?.name || "")
    .find((name) => name === suffix || name.endsWith(`__${suffix}`)) || "";
}

function sendToolCall(response, { id, name, arguments: args }) {
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: "native-multi-agent-test-model",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  });
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: "native-multi-agent-test-model",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  response.end("data: [DONE]\n\n");
}

function sendText(response, id, text) {
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: "native-multi-agent-test-model",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  });
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: "native-multi-agent-test-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  });
  response.end("data: [DONE]\n\n");
}

test("the pinned app-server accepts the native multi-agent thread contract", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "darwin") {
    t.skip("bundled native app-server smoke currently runs on macOS");
    return;
  }

  const binary = [
    resolve("server/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"),
    resolve("server/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex"),
  ].find(existsSync);
  if (!binary) {
    t.skip("bundled app-server binary is unavailable");
    return;
  }

  const runtimeHome = await mkdtemp(join(tmpdir(), "dsh-native-multi-agent-"));
  const kernel = new AgentKernel({
    binary,
    cwd: process.cwd(),
    env: { ...process.env, CODEX_HOME: runtimeHome },
    requestTimeoutMs: 15_000,
  });

  try {
    const modes = await kernel.listCollaborationModes();
    assert.ok(Array.isArray(modes.data));

    const started = await kernel.startThread({
      ephemeral: false,
      tools: [],
      config: withNativeCollaborationConfig({}, { maxConcurrentThreads: 2 }),
    });
    const rootThreadId = started.thread.id;
    assert.ok(rootThreadId);

    const read = await kernel.readThread(rootThreadId, { includeTurns: false });
    assert.equal(read.thread.id, rootThreadId);

    const children = await kernel.listSubagentThreads(rootThreadId, { recursive: true });
    assert.deepEqual(children.data, []);
  } finally {
    await kernel.stop();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test("the pinned app-server really spawns, runs and waits for a native child thread", { timeout: 30_000 }, async (t) => {
  if (process.platform !== "darwin") {
    t.skip("bundled native app-server smoke currently runs on macOS");
    return;
  }

  const binary = [
    resolve("server/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex"),
    resolve("server/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex"),
  ].find(existsSync);
  if (!binary) {
    t.skip("bundled app-server binary is unavailable");
    return;
  }

  const parentPrompt = "Create one native child task, wait for it, then finish.";
  const childPrompt = "Run child_echo with child-native-input and report completion.";
  const applicationContext = "application-context-visible-to-forked-native-child";
  const requests = [];
  const childToolExecutions = [];
  const handlerErrors = [];
  let spawnedAgentTarget = "";
  let spawnedAgentId = "";

  const upstream = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      requests.push(body);
      response.writeHead(200, { "content-type": "text/event-stream" });

      const lastUser = messageText(lastUserMessage(body)?.content);
      const serializedMessages = JSON.stringify(body.messages || []);
      if (lastUser.includes(childPrompt)) {
        if (!serializedMessages.includes("call_child_echo")) {
          const childEcho = toolName(body, "child_echo");
          assert.ok(childEcho, `child thread did not inherit child_echo: ${JSON.stringify(body.tools || [])}`);
          sendToolCall(response, {
            id: "call_child_echo",
            name: childEcho,
            arguments: { value: "child-native-input" },
          });
          return;
        }
        sendText(response, "child_done", "child-native-done");
        return;
      }

      assert.ok(serializedMessages.includes(parentPrompt), `unexpected model request: ${serializedMessages}`);
      if (!serializedMessages.includes("call_spawn_child")) {
        const spawnAgent = toolName(body, "spawn_agent");
        assert.ok(spawnAgent, `parent request did not expose spawn_agent: ${JSON.stringify(body.tools || [])}`);
        sendToolCall(response, {
          id: "call_spawn_child",
          name: spawnAgent,
          arguments: { task_name: "child_native", message: childPrompt, fork_turns: "all" },
        });
        return;
      }

      if (!serializedMessages.includes("call_wait_child")) {
        const spawnOutput = (body.messages || []).find((message) => (
          message?.role === "tool" && message?.tool_call_id === "call_spawn_child"
        ));
        const spawnContent = String(spawnOutput?.content || "");
        assert.doesNotMatch(spawnContent, /collab spawn failed/i, spawnContent);
        try {
          const parsed = JSON.parse(spawnContent);
          spawnedAgentTarget = parsed?.agent_id || parsed?.task_name || "";
        } catch {
          spawnedAgentTarget = spawnContent.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/i)?.[0] || "";
        }
        assert.ok(spawnedAgentTarget, `spawn_agent did not return a task target: ${JSON.stringify(spawnOutput)}`);
        const waitAgent = toolName(body, "wait_agent");
        assert.ok(waitAgent, `parent request did not expose wait_agent: ${JSON.stringify(body.tools || [])}`);
        sendToolCall(response, {
          id: "call_wait_child",
          name: waitAgent,
          arguments: { timeout_ms: 10_000 },
        });
        return;
      }

      const waitOutput = (body.messages || []).find((message) => (
        message?.role === "tool" && message?.tool_call_id === "call_wait_child"
      ));
      const waitResult = JSON.parse(String(waitOutput?.content || "{}"));
      assert.equal(waitResult.timed_out, false, JSON.stringify(waitResult));
      sendText(response, "parent_done", "parent-native-done");
    } catch (error) {
      handlerErrors.push(error);
      if (!response.headersSent) response.writeHead(500, { "content-type": "text/plain" });
      response.end(error?.stack || error?.message || String(error));
    }
  });

  const runtimeHome = await mkdtemp(join(tmpdir(), "dsh-native-multi-agent-turn-"));
  const baseUrl = await listen(upstream);
  const binding = await createAgentModelBinding({
    id: "native-multi-agent-integration-model",
    model_name: "native-multi-agent-test-model",
    api_base: baseUrl,
    api_key: "native-multi-agent-test-key",
    api_format: "chat_completions",
  });
  const kernel = new AgentKernel({
    ...binding.kernelOptions,
    binary,
    cwd: process.cwd(),
    env: { ...binding.kernelOptions.env, CODEX_HOME: runtimeHome },
    requestTimeoutMs: 20_000,
  });

  try {
    const started = await kernel.startThread({
      cwd: process.cwd(),
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "read-only",
      ephemeral: false,
      tools: [{
        name: "child_echo",
        description: "Echo a value from a native child thread.",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        },
        execute: async (_callId, args) => {
          childToolExecutions.push(args);
          return { content: [{ type: "text", text: `echo:${args.value}` }] };
        },
      }],
      config: withNativeCollaborationConfig(binding.threadOptions.config, { maxConcurrentThreads: 4 }),
      model: binding.threadOptions.model,
      modelProvider: binding.threadOptions.modelProvider,
    });
    const notifications = [];
    const result = await kernel.runTurn({
      threadId: started.thread.id,
      input: parentPrompt,
      additionalContext: {
        app_instructions: { value: applicationContext, kind: "application" },
      },
      onNotification: (method, params) => notifications.push({ method, params }),
    });

    assert.equal(result.completed.turn.status, "completed");
    assert.deepEqual(handlerErrors, []);
    assert.deepEqual(childToolExecutions, [{ value: "child-native-input" }]);
    assert.ok(spawnedAgentTarget);
    assert.ok(requests.some((body) => (
      messageText(lastUserMessage(body)?.content).includes(childPrompt)
      && JSON.stringify(body.messages || []).includes(applicationContext)
    )), "forked child request did not preserve the current application context");

    const spawnActivity = notifications.find(({ method, params }) => (
      method === "item/completed"
      && params.item?.type === "subAgentActivity"
      && params.item?.id === "call_spawn_child"
      && params.item?.kind === "started"
    ))?.params?.item;
    spawnedAgentId = spawnActivity?.agentThreadId || "";
    assert.ok(spawnedAgentId);
    assert.equal(spawnActivity?.agentPath, "/root/child_native");
    const waitCompleted = notifications.find(({ method, params }) => (
      method === "item/completed"
      && params.item?.type === "collabAgentToolCall"
      && params.item?.tool === "wait"
    ))?.params?.item;
    assert.ok(waitCompleted);

    const children = await kernel.listSubagentThreads(started.thread.id, { recursive: true });
    assert.ok(children.data.some((thread) => thread.id === spawnedAgentId));
    const child = await kernel.readThread(spawnedAgentId, { includeTurns: true });
    assert.match(JSON.stringify(child.thread), /child-native-done/);
    assert.equal(
      notifications.find(({ method, params }) => (
        method === "item/completed" && params.item?.type === "agentMessage" && params.item?.text === "parent-native-done"
      ))?.params?.item?.text,
      "parent-native-done",
    );
  } finally {
    await kernel.stop();
    await stopChatCompletionsAdapter();
    upstream.closeAllConnections?.();
    await new Promise((resolvePromise) => upstream.close(resolvePromise));
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
