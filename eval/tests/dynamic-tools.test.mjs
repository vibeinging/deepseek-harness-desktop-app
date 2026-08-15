import test from "node:test";
import assert from "node:assert/strict";
import { createDynamicToolBridge } from "../../server/src/engine/agent_kernel/dynamic_tools.js";
import { createProductTools } from "../../server/src/engine/agents/product_tools.js";

test("Agent dynamic tool bridge exposes and executes existing Dsh tools", async () => {
  let execution;
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "query_project_data",
      description: "查询项目数据",
      parameters: { type: "object", properties: { question: { type: "string" } }, required: ["question"] },
      exposure: "direct",
      execute: async (callId, args) => {
        execution = { callId, args };
        return { content: [{ type: "text", text: "查询结果: 42" }], details: { rows: [{ value: 42 }] } };
      },
    }],
  });
  assert.deepEqual(bridge.names, ["query_project_data"]);
  assert.equal(bridge.specs[0].type, "function");
  assert.equal(bridge.specs[0].inputSchema.required[0], "question");

  const result = await bridge.handleCall({
    callId: "call-1",
    tool: "query_project_data",
    arguments: { question: "答案是多少" },
  });
  assert.deepEqual(execution, { callId: "call-1", args: { question: "答案是多少" } });
  assert.equal(result.success, true);
  assert.equal(result.contentItems[0].text, "查询结果: 42");
  assert.deepEqual(bridge.takeHostResult("call-1")?.details, { rows: [{ value: 42 }] });
  assert.equal(bridge.takeHostResult("call-1"), undefined);
});

test("Agent dynamic tool bridge forwards Turn cancellation to Host tools", async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  let finishExecution;
  const bridge = createDynamicToolBridge({
    signal: controller.signal,
    tools: [{
      name: "host_probe",
      execute: async (_callId, _args, signal) => {
        receivedSignal = signal;
        return new Promise((resolve) => { finishExecution = resolve; });
      },
    }],
  });

  const pending = bridge.handleCall({ callId: "call-signal", tool: "host_probe", arguments: {} });
  while (!finishExecution) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(receivedSignal?.aborted, false);
  controller.abort();
  assert.equal(receivedSignal?.aborted, true);
  finishExecution("late");
  const result = await pending;

  assert.equal(result.success, false);
});

test("Agent dynamic tool bridge refuses a call after its Turn is aborted", async () => {
  const controller = new AbortController();
  let executions = 0;
  const bridge = createDynamicToolBridge({
    signal: controller.signal,
    tools: [{
      name: "host_probe",
      execute: async () => {
        executions += 1;
        return "should not run";
      },
    }],
  });
  controller.abort();

  const result = await bridge.handleCall({ callId: "call-after-abort", tool: "host_probe", arguments: {} });

  assert.equal(result.success, false);
  assert.equal(executions, 0);
  assert.match(result.contentItems[0].text, /Turn.*(?:结束|取消)/);
});

test("Agent dynamic tool bridge drops an in-flight result after explicit revocation", async () => {
  let finishExecution;
  let deliveries = 0;
  let hostActions = 0;
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "slow_host_probe",
      host_action_capable: true,
      execute: async () => new Promise((resolve) => { finishExecution = resolve; }),
    }],
    context: {
      onToolResult: async ({ result }) => {
        deliveries += 1;
        return result;
      },
      onHostAction: async () => { hostActions += 1; },
    },
  });
  const pending = bridge.handleCall({ callId: "call-in-flight", tool: "slow_host_probe", arguments: {} });
  while (!finishExecution) await new Promise((resolve) => setImmediate(resolve));

  bridge.revoke("Agent Turn 已结束");
  finishExecution({
    content: [{ type: "text", text: "late result" }],
    details: { host_actions: [{ type: "workspace_event", event: { event: "late" } }] },
  });
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(deliveries, 0);
  assert.equal(hostActions, 0);
  assert.equal(bridge.takeHostResult("call-in-flight"), undefined);
  assert.match(result.contentItems[0].text, /Turn.*结束/);
});

test("Agent dynamic tool bridge reports whether revoked Host work has drained", async () => {
  let finishExecution;
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "slow_write_probe",
      execute: async () => new Promise((resolve) => { finishExecution = resolve; }),
    }],
  });
  const pending = bridge.handleCall({
    threadId: "thread-drain",
    turnId: "turn-drain",
    callId: "call-drain",
    tool: "slow_write_probe",
    arguments: {},
  });
  while (!finishExecution) await new Promise((resolve) => setImmediate(resolve));

  bridge.revoke("Agent Turn 已取消");
  const timedOut = await bridge.drain({ timeoutMs: 5 });
  assert.deepEqual(timedOut, { settled: false, pendingCalls: 1 });

  finishExecution("late");
  await pending;
  const settled = await bridge.drain({ timeoutMs: 5 });
  assert.deepEqual(settled, { settled: true, pendingCalls: 0 });
});

test("Agent dynamic tool bridge stops queued Host actions when revoked during an action", async () => {
  let releaseFirstAction;
  const startedActions = [];
  const hookSignals = [];
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "host_action_probe",
      host_action_capable: true,
      execute: async () => ({
        content: [{ type: "text", text: "ready" }],
        details: {
          host_actions: [
            { type: "workspace_event", event: { event: "first" } },
            { type: "workspace_event", event: { event: "second" } },
          ],
        },
      }),
    }],
    context: {
      onHostAction: async (action, metadata, hookSignal) => {
        startedActions.push(action.event.event);
        hookSignals.push({ metadata: metadata.signal, argument: hookSignal });
        if (action.event.event === "first") {
          await new Promise((resolve) => { releaseFirstAction = resolve; });
        }
      },
    },
  });
  const pending = bridge.handleCall({
    threadId: "thread-action",
    turnId: "turn-action",
    callId: "call-action",
    tool: "host_action_probe",
    arguments: {},
  });
  while (!releaseFirstAction) await new Promise((resolve) => setImmediate(resolve));

  bridge.revoke("Agent Turn 已结束");
  releaseFirstAction();
  const result = await pending;

  assert.equal(result.success, false);
  assert.deepEqual(startedActions, ["first"], "revocation must stop actions that have not started");
  assert.equal(hookSignals[0].metadata, hookSignals[0].argument);
  assert.equal(hookSignals[0].argument?.aborted, true, "the running Host action receives bridge cancellation");
  assert.equal(bridge.takeHostResult("call-action", {
    threadId: "thread-action",
    turnId: "turn-action",
  }), undefined);
});

test("Agent dynamic tool cancellation reaches a product handler before its database side effect", async () => {
  let releaseCompanyLookup;
  const writes = [];
  const productTool = createProductTools({
    user_id: "user-cancel",
    db: {
      query: async (sql) => {
        writes.push(sql);
        return [];
      },
      queryOne: async () => new Promise((resolve) => { releaseCompanyLookup = resolve; }),
    },
  }).find((tool) => tool.name === "project_create");
  const bridge = createDynamicToolBridge({ tools: [productTool] });
  const pending = bridge.handleCall({
    threadId: "thread-product",
    turnId: "turn-product",
    callId: "call-product",
    tool: "project_create",
    arguments: { name: "取消测试" },
  });
  while (!releaseCompanyLookup) await new Promise((resolve) => setImmediate(resolve));

  bridge.revoke("Agent Turn 已取消");
  releaseCompanyLookup({ company_id: "company-1" });
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(writes.length, 0, "the INSERT must not begin after cancellation reaches the handler context");
  assert.match(result.contentItems[0].text, /Turn.*取消/);
});

test("Agent dynamic tool bridge rejects duplicate Host tool names before Codex registration", () => {
  assert.throws(
    () => createDynamicToolBridge({
      tools: [
        { name: "same", plugin_name: "host", execute: async () => "first" },
        { name: "same", plugin_name: "ask-data", execute: async () => "second" },
      ],
    }),
    (error) => (
      error?.code === "DYNAMIC_TOOL_NAME_CONFLICT"
      && error?.details?.first_plugin === "host"
      && error?.details?.second_plugin === "ask-data"
    ),
  );
});

test("Agent dynamic tool bridge returns a model-visible failure", async () => {
  const bridge = createDynamicToolBridge({ tools: [] });
  const result = await bridge.handleCall({ tool: "missing" });
  assert.equal(result.success, false);
  assert.match(result.contentItems[0].text, /不存在/);
});

test("Agent dynamic tool bridge preserves a product tool failure status", async () => {
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "conversation_create",
      execute: async () => ({
        isError: true,
        content: [{ type: "text", text: "没有权限" }],
      }),
    }],
  });
  const result = await bridge.handleCall({ tool: "conversation_create", arguments: {} });
  assert.equal(result.success, false);
  assert.equal(result.contentItems[0].text, "没有权限");
});

test("Agent dynamic tool bridge treats details.success=false as a failure", async () => {
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "image_generate",
      execute: async () => ({
        content: [{ type: "text", text: "未配置图像生成服务" }],
        details: { success: false, error: "IMAGE_PROVIDER_NOT_CONFIGURED" },
      }),
    }],
  });
  const result = await bridge.handleCall({ callId: "image-failed", tool: "image_generate", arguments: {} });
  assert.equal(result.success, false);
  assert.match(result.contentItems[0].text, /未配置/);
});

test("Agent dynamic tool bridge preserves native image and audio content items", async () => {
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "create_media",
      execute: async () => ({
        content: [
          { type: "text", text: "已生成" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          { type: "audio", data: "YXVkaW8=", mimeType: "audio/mpeg" },
        ],
      }),
    }],
  });
  const result = await bridge.handleCall({ callId: "media-1", tool: "create_media", arguments: {} });
  assert.deepEqual(result, {
    success: true,
    contentItems: [
      { type: "inputText", text: "已生成" },
      { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
      { type: "inputAudio", audioUrl: "data:audio/mpeg;base64,YXVkaW8=" },
    ],
  });
});

test("Agent dynamic tool bridge refuses non-inline media URLs", async () => {
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "unsafe_media",
      execute: async () => ({ content: [{ type: "image", imageUrl: "file:///tmp/secret.png" }] }),
    }],
  });
  const result = await bridge.handleCall({ tool: "unsafe_media", arguments: {} });
  assert.equal(result.contentItems.length, 1);
  assert.equal(result.contentItems[0].type, "inputText");
  assert.match(result.contentItems[0].text, /file:\/\/\/tmp\/secret\.png/);
});

test("Agent dynamic tool bridge accepts JSON-string arguments", async () => {
  let received = null;
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "query_project_data",
      execute: async (_callId, args) => {
        received = args;
        return "ok";
      },
    }],
  });
  const result = await bridge.handleCall({
    callId: "call-json",
    tool: "query_project_data",
    arguments: '{"question":"总数"}',
  });
  assert.deepEqual(received, { question: "总数" });
  assert.equal(result.success, true);
});

test("Agent dynamic tool bridge delivers host actions after a successful tool call", async () => {
  const received = [];
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "conversation_open",
      host_action_capable: true,
      execute: async () => ({
        content: [{ type: "text", text: "已打开" }],
        details: {
          host_actions: [{
            type: "workspace_event",
            event: { event: "conversation_opened", project_id: "p-1", session_id: "s-1" },
          }],
        },
      }),
    }],
    context: {
      onHostAction: async (action, metadata) => received.push({ action, metadata }),
    },
  });

  const result = await bridge.handleCall({ callId: "call-open", tool: "conversation_open", arguments: {} });
  assert.equal(result.success, true);
  assert.deepEqual(received[0].action, {
    type: "workspace_event",
    event: { event: "conversation_opened", project_id: "p-1", session_id: "s-1" },
  });
  assert.equal(received[0].metadata.callId, "call-open");
  assert.equal(received[0].metadata.toolName, "conversation_open");
  assert.equal(received[0].metadata.actionIndex, 0);
  assert.equal(received[0].metadata.signal instanceof AbortSignal, true);
});

test("Agent dynamic tool bridge applies the shared output delivery hook before host actions", async () => {
  const received = [];
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "create_report",
      output_contract: { role: "deliverable", surface: "workspace", persistence: "library" },
      host_action_capable: true,
      execute: async () => ({ content: [{ type: "text", text: "已生成" }], details: { path: "/tmp/report.pdf" } }),
    }],
    context: {
      onToolResult: async ({ result }) => ({
        ...result,
        details: {
          ...result.details,
          output_delivery: { role: "deliverable", surface: "workspace", persistence: "library" },
          host_actions: [{ type: "workspace_event", event: { event: "artifact_published", artifact_id: "a-1" } }],
        },
      }),
      onHostAction: async (action) => received.push(action),
    },
  });

  const response = await bridge.handleCall({ callId: "delivery-1", tool: "create_report", arguments: {} });
  assert.equal(response.success, true);
  assert.equal(received[0].event.artifact_id, "a-1");
  assert.equal(bridge.takeHostResult("delivery-1").details.output_delivery.role, "deliverable");
});

test("Agent dynamic tool bridge ignores undeclared host actions", async () => {
  const received = [];
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "external_tool",
      execute: async () => ({
        details: {
          host_actions: [{ type: "workspace_event", event: { event: "project_opened", project_id: "p-2" } }],
        },
      }),
    }],
    context: { onHostAction: async (action) => received.push(action) },
  });
  const result = await bridge.handleCall({ callId: "call-external", tool: "external_tool", arguments: {} });
  assert.equal(result.success, true);
  assert.deepEqual(received, []);
});

test("Agent dynamic tool bridge isolates equal call ids across parent and child Threads", async () => {
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "echo_thread",
      execute: async (_callId, args) => ({ content: [{ type: "text", text: args.value }], details: { value: args.value } }),
    }],
  });
  await bridge.handleCall({ threadId: "parent", turnId: "turn-parent", callId: "call-1", tool: "echo_thread", arguments: { value: "parent" } });
  await bridge.handleCall({ threadId: "child", turnId: "turn-child", callId: "call-1", tool: "echo_thread", arguments: { value: "child" } });
  assert.equal(bridge.takeHostResult("call-1", { threadId: "parent", turnId: "turn-parent" }).details.value, "parent");
  assert.equal(bridge.takeHostResult("call-1", { threadId: "child", turnId: "turn-child" }).details.value, "child");
});

test("Agent dynamic tool bridge puts deferred tools in a namespace", () => {
  const bridge = createDynamicToolBridge({
    tools: [{
      name: "update_plan",
      description: "更新计划",
      exposure: "deferred",
      execute: async () => "ok",
    }],
  });
  assert.deepEqual(bridge.specs, [{
    type: "namespace",
    name: "dsh",
    description: "DeepSeek Harness Desktop App项目数据与工作流工具",
    tools: [{
      type: "function",
      name: "update_plan",
      description: "更新计划",
      inputSchema: { type: "object", properties: {} },
      deferLoading: true,
    }],
  }]);
});
