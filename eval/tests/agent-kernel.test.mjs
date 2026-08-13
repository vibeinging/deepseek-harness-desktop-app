import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AgentKernel } from "../../server/src/engine/agent_kernel/kernel.js";

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.running = false;
    this.requests = [];
    this.handlers = new Map();
    this.notifications = [];
  }
  handle(method, handler) { this.handlers.set(method, handler); }
  async start() { this.running = true; }
  notify(method, params) { this.notifications.push({ method, params }); }
  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "initialize") return { userAgent: "agent_runtime-test" };
    if (method === "model/list") return { data: [{ id: "gpt-test" }] };
    if (method === "collaborationMode/list") return { data: [{ name: "default", mode: "default" }] };
    if (method === "skills/list") return { data: [{ cwd: params.cwds[0], skills: [], errors: [] }] };
    if (method === "app/list") return { data: [{ id: "reports", isAccessible: false }], nextCursor: null };
    if (method === "mcpServer/oauth/login") return { authorizationUrl: "https://example.com/authorize" };
    if (method === "thread/start") return { thread: { id: "thread-1" } };
    if (method === "thread/fork") return {
      thread: { id: "thread-fork-1", forkedFromId: params.threadId, turns: [] },
    };
    if (method === "thread/rollback") return { thread: { id: params.threadId, turns: [] } };
    if (method === "thread/delete") return {};
    if (method === "thread/list") return { data: [], nextCursor: null };
    if (method === "thread/read") return {
      thread: {
        id: params.threadId,
        turns: params.threadId === "thread-source"
          ? [{ id: "turn-1" }, { id: "turn-2" }, { id: "turn-3" }]
          : [],
      },
    };
    if (method === "turn/start") {
      queueMicrotask(() => this.emit("notification", {
        method: "turn/completed",
        params: { threadId: params.threadId, turn: { id: "turn-1", status: "completed" } },
      }));
      return { turn: { id: "turn-1", status: "inProgress" } };
    }
    if (method === "thread/compact/start") {
      queueMicrotask(() => {
        this.emit("notification", {
          method: "item/started",
          params: { threadId: params.threadId, turnId: "compact-turn-1", item: { id: "compact-1", type: "contextCompaction" } },
        });
        this.emit("notification", {
          method: "thread/tokenUsage/updated",
          params: {
            threadId: params.threadId,
            turnId: "compact-turn-1",
            tokenUsage: { total: { totalTokens: 1200 }, last: { totalTokens: 200 }, modelContextWindow: 2000 },
          },
        });
        this.emit("notification", {
          method: "item/completed",
          params: { threadId: params.threadId, turnId: "compact-turn-1", item: { id: "compact-1", type: "contextCompaction" } },
        });
      });
      return {};
    }
    return {};
  }
  async stop() { this.running = false; }
}

class FailingCompactionClient extends FakeClient {
  async request(method, params) {
    if (method !== "thread/compact/start") return super.request(method, params);
    this.requests.push({ method, params });
    queueMicrotask(() => this.emit("notification", {
      method: "error",
      params: { threadId: params.threadId, error: { message: "compact failed" } },
    }));
    return {};
  }
}

class HangingCompactionClient extends FakeClient {
  async request(method, params) {
    if (method !== "thread/compact/start") return super.request(method, params);
    this.requests.push({ method, params });
    return {};
  }
}

class DelayedTurnStartClient extends FakeClient {
  constructor() {
    super();
    this.resolveTurnStart = null;
  }
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.requests.push({ method, params });
    return new Promise((resolve) => { this.resolveTurnStart = resolve; });
  }
}

class ConcurrentTurnClient extends FakeClient {
  async request(method, params) {
    if (method !== "turn/start") return super.request(method, params);
    this.requests.push({ method, params });
    return { turn: { id: `turn:${params.threadId}`, status: "inProgress" } };
  }
}

class SplitReviewTurnClient extends FakeClient {
  constructor() {
    super();
    this.resolveReviewStart = null;
  }
  async request(method, params) {
    if (method !== "review/start") return super.request(method, params);
    this.requests.push({ method, params });
    return new Promise((resolve) => { this.resolveReviewStart = resolve; });
  }
}

test("AgentKernel interrupts a Turn aborted before turn/start responds", async () => {
  const client = new DelayedTurnStartClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  const controller = new AbortController();
  const running = kernel.runTurn({ threadId: "thread-race", input: "run", signal: controller.signal });
  while (!client.resolveTurnStart) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-race", turn: { id: "turn-race", status: "inProgress" } },
  });
  client.resolveTurnStart({ turn: { id: "turn-race", status: "inProgress" } });
  await assert.rejects(running, (error) => error?.name === "AbortError");
  const interrupts = client.requests.filter((request) => request.method === "turn/interrupt");
  assert.deepEqual(interrupts.map((request) => request.params), [{ threadId: "thread-race", turnId: "turn-race" }]);
})

test("AgentKernel keeps an inline Review on its canonical outer Turn id", async () => {
  const client = new SplitReviewTurnClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  const events = [];
  let finished = false;
  const running = kernel.runTurn({
    threadId: "thread-review",
    input: [],
    review: { type: "uncommittedChanges" },
    onNotification: (method, params) => events.push({ method, params }),
  }).finally(() => { finished = true; });
  while (!client.resolveReviewStart) await new Promise((resolve) => setImmediate(resolve));

  // Codex 0.147 may start the delegated reviewer before review/start is
  // observed by the client. Its id must never replace the outer Review id.
  client.emit("notification", {
    method: "item/started",
    params: {
      threadId: "thread-review",
      turnId: "turn-review-outer",
      item: { id: "entered-review", type: "enteredReviewMode", review: "current changes" },
    },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-review", turn: { id: "turn-reviewer-inner", status: "inProgress" } },
  });
  client.resolveReviewStart({
    turn: { id: "turn-review-outer", status: "inProgress" },
    reviewThreadId: "thread-review",
  });
  await new Promise((resolve) => setImmediate(resolve));

  client.emit("notification", {
    method: "item/completed",
    params: {
      threadId: "thread-review",
      turnId: "turn-review-outer",
      item: { id: "command-1", type: "commandExecution", status: "completed" },
    },
  });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-review", turn: { id: "turn-reviewer-inner", status: "completed" } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false, "delegated reviewer completion must not settle the outer Review");

  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-review", turn: { id: "turn-review-outer", status: "completed" } },
  });
  const result = await running;
  assert.equal(result.started.turn.id, "turn-review-outer");
  assert.equal(result.completed.turn.id, "turn-review-outer");
  assert.equal(kernel.activeTurns.has("thread-review"), false, "outer Review completion clears the delegated active id");
  assert.deepEqual(
    events.map(({ method, params }) => [method, params.turnId || params.turn?.id]),
    [
      ["item/started", "turn-review-outer"],
      ["turn/started", "turn-review-outer"],
      ["item/completed", "turn-review-outer"],
      ["turn/completed", "turn-review-outer"],
    ],
  );
})

test("AgentKernel interrupts an inline Review through its delegated active Turn id", async () => {
  const client = new SplitReviewTurnClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  const controller = new AbortController();
  const running = kernel.runTurn({
    threadId: "thread-review-stop",
    input: [],
    review: { type: "uncommittedChanges" },
    signal: controller.signal,
  });
  while (!client.resolveReviewStart) await new Promise((resolve) => setImmediate(resolve));
  client.resolveReviewStart({
    turn: { id: "turn-review-stop-outer", status: "inProgress" },
    reviewThreadId: "thread-review-stop",
  });
  await new Promise((resolve) => setImmediate(resolve));
  client.emit("notification", {
    method: "item/started",
    params: {
      threadId: "thread-review-stop",
      turnId: "turn-review-stop-outer",
      item: { id: "entered-review-stop", type: "enteredReviewMode", review: "current changes" },
    },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-review-stop", turn: { id: "turn-review-stop-inner", status: "inProgress" } },
  });
  controller.abort();
  await assert.rejects(running, (error) => error?.name === "AbortError");
  assert.deepEqual(
    client.requests.filter((request) => request.method === "turn/interrupt").map((request) => request.params),
    [{ threadId: "thread-review-stop", turnId: "turn-review-stop-inner" }],
  );
})

test("AgentKernel waits for the inline Review control id when aborted before turn/started", async () => {
  const client = new SplitReviewTurnClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  const controller = new AbortController();
  const running = kernel.runTurn({
    threadId: "thread-review-early-stop",
    input: [],
    review: { type: "uncommittedChanges" },
    signal: controller.signal,
  });
  while (!client.resolveReviewStart) await new Promise((resolve) => setImmediate(resolve));
  client.resolveReviewStart({
    turn: { id: "turn-review-early-stop-outer", status: "inProgress" },
    reviewThreadId: "thread-review-early-stop",
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(client.requests.some((request) => request.method === "turn/interrupt"), false);

  client.emit("notification", {
    method: "item/started",
    params: {
      threadId: "thread-review-early-stop",
      turnId: "turn-review-early-stop-outer",
      item: { id: "entered-review-early-stop", type: "enteredReviewMode", review: "current changes" },
    },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-review-early-stop", turn: { id: "turn-review-early-stop-inner", status: "inProgress" } },
  });
  await assert.rejects(running, (error) => error?.name === "AbortError");
  assert.deepEqual(
    client.requests.filter((request) => request.method === "turn/interrupt").map((request) => request.params),
    [{ threadId: "thread-review-early-stop", turnId: "turn-review-early-stop-inner" }],
  );
})

test("AgentKernel namespaces equal JSON-RPC request ids across runtime processes", async () => {
  const clients = [new FakeClient(), new FakeClient()];
  const seen = [];
  const kernels = clients.map((client, index) => new AgentKernel({
    binary: `/fake/agent_runtime-${index}`,
    clientFactory: () => client,
    mcpElicitationHandler: async (params) => {
      seen.push(params.localRequestId);
      return { action: "cancel", content: null, _meta: null };
    },
  }));
  await Promise.all(kernels.map((kernel) => kernel.start()));
  await Promise.all(clients.map((client, index) => client.handlers.get("mcpServer/elicitation/request")({
    threadId: `thread-${index}`,
    mode: "form",
    requestedSchema: { type: "object", properties: {} },
  }, { id: 1 })));
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.match(seen[0], /^mcp_elicitation:/);
})

test("AgentKernel delivers a global runtime notice to only one concurrent Turn", async () => {
  const client = new ConcurrentTurnClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  const firstEvents = [];
  const secondEvents = [];
  const first = kernel.runTurn({ threadId: "thread-a", input: "a", onNotification: (method) => firstEvents.push(method) });
  const second = kernel.runTurn({ threadId: "thread-b", input: "b", onNotification: (method) => secondEvents.push(method) });
  while (client.requests.filter((request) => request.method === "turn/start").length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  client.emit("notification", { method: "configWarning", params: { summary: "global warning" } });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-a", turn: { id: "turn:thread-a", status: "completed" } },
  });
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-b", turn: { id: "turn:thread-b", status: "completed" } },
  });
  await Promise.all([first, second]);
  assert.equal([...firstEvents, ...secondEvents].filter((method) => method === "configWarning").length, 1);
})

test("AgentKernel passes startup model catalog arguments to AppServerClient", async () => {
  const client = new FakeClient();
  let clientOptions = null;
  const args = ["-c", "model_catalog_json=\"/tmp/models.json\"", "app-server"];
  const kernel = new AgentKernel({
    binary: "/fake/agent_runtime",
    args,
    clientFactory: (options) => {
      clientOptions = options;
      return client;
    },
  });
  await kernel.start();
  assert.deepEqual(clientOptions?.args, args);
});

test("AgentKernel initializes, starts a thread and completes a turn", async () => {
  const client = new FakeClient();
  const events = [];
  const userInputRequests = [];
  const mcpElicitations = [];
  const kernel = new AgentKernel({
    binary: "/fake/agent_runtime",
    skillExtraRoots: ["/tmp/dsh-skills"],
    clientFactory: () => client,
  });
  const thread = await kernel.startThread({
    tools: [{
      name: "echo",
      description: "echo",
      parameters: { type: "object" },
      execute: async () => ({ content: [{ type: "text", text: "ok" }], details: { ui_content: { renderer: "test" } } }),
    }],
    baseInstructions: "你是dsh-work",
    developerInstructions: "遵守dsh-work产品边界",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
    runtimeWorkspaceRoots: ["/tmp/dsh-run"],
    selectedCapabilityRoots: [{
      id: "ask-data@1.1.0",
      location: { type: "environment", environmentId: "local", path: "/tmp/ask-data" },
    }],
    userInputHandler: async (params) => {
      userInputRequests.push(params);
      return { answers: { choice: { answers: ["A"] } } };
    },
    mcpElicitationHandler: async (params) => {
      mcpElicitations.push(params);
      return { action: "accept", content: { account: "local" }, _meta: null };
    },
  });
  assert.equal(thread.thread.id, "thread-1");
  const threadRequest = client.requests.find((request) => request.method === "thread/start");
  assert.equal(threadRequest.params.dynamicTools[0].name, "echo");
  assert.equal(threadRequest.params.baseInstructions, "你是dsh-work");
  assert.equal(threadRequest.params.developerInstructions, "遵守dsh-work产品边界");
  assert.equal(threadRequest.params.approvalPolicy, "on-request");
  assert.equal(threadRequest.params.approvalsReviewer, "auto_review");
  assert.equal(threadRequest.params.sandbox, "workspace-write");
  assert.deepEqual(threadRequest.params.runtimeWorkspaceRoots, ["/tmp/dsh-run"]);
  assert.deepEqual(threadRequest.params.selectedCapabilityRoots, [{
    id: "ask-data@1.1.0",
    location: { type: "environment", environmentId: "local", path: "/tmp/ask-data" },
  }]);
  assert.deepEqual(
    client.requests.find((request) => request.method === "skills/extraRoots/set")?.params,
    { extraRoots: ["/tmp/dsh-skills"] },
  );
  assert.deepEqual(
    client.requests.find((request) => request.method === "initialize")?.params,
    {
      clientInfo: { name: "dsh-desktop", title: "dsh-work", version: "0.0.1" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
      },
    },
  );
  const beforeTime = Math.floor(Date.now() / 1000);
  const currentTime = await client.handlers.get("currentTime/read")({ threadId: "thread-1" });
  assert.ok(currentTime.currentTimeAt >= beforeTime);
  assert.ok(currentTime.currentTimeAt <= Math.floor(Date.now() / 1000));
  await kernel.injectThreadItems("thread-1", [{
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "历史结论" }],
  }]);
  assert.deepEqual(
    client.requests.find((request) => request.method === "thread/inject_items")?.params,
    {
      threadId: "thread-1",
      items: [{
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "历史结论" }],
      }],
    },
  );
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
  });
  const userInputResponse = await client.handlers.get("item/tool/requestUserInput")({
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "call-1",
    questions: [{ id: "choice", question: "请选择" }],
  }, { id: 77 });
  assert.deepEqual(userInputRequests, [{
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "call-1",
    questions: [{ id: "choice", question: "请选择" }],
  }]);
  assert.deepEqual(userInputResponse, { answers: { choice: { answers: ["A"] } } });
  let resolvedParams = null;
  client.on("notification", ({ method, params }) => {
    if (method === "serverRequest/resolved") resolvedParams = params;
  });
  client.emit("notification", {
    method: "serverRequest/resolved",
    params: { threadId: "thread-1", requestId: 77 },
  });
  assert.match(resolvedParams.localRequestId, /^user_input:[^:]+:thread-1:call-1$/);
  assert.equal(resolvedParams.localRequestKind, "user_input");
  assert.equal(JSON.stringify(resolvedParams).includes("localRequestId"), false);
  const elicitationResponse = await client.handlers.get("mcpServer/elicitation/request")({
    threadId: "thread-1",
    turnId: "turn-1",
    serverName: "native-test",
    mode: "form",
    message: "选择账户",
    requestedSchema: { type: "object" },
    _meta: null,
  });
  assert.equal(mcpElicitations.length, 1);
  assert.deepEqual(elicitationResponse, { action: "accept", content: { account: "local" }, _meta: null });
  const permissionResponse = await client.handlers.get("item/permissions/requestApproval")({
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "permission-1",
    permissions: { network: { enabled: true }, fileSystem: null },
  });
  assert.deepEqual(permissionResponse, { permissions: {}, scope: "turn" });
  const toolResponse = await client.handlers.get("item/tool/call")({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "dynamic-1",
    tool: "echo",
    arguments: {},
  });
  const completedTool = {
    threadId: "thread-1",
    turnId: "turn-1",
    item: {
      id: "dynamic-1",
      type: "dynamicToolCall",
      tool: "echo",
      status: "completed",
      contentItems: toolResponse.contentItems,
      success: toolResponse.success,
    },
  };
  client.emit("notification", { method: "item/completed", params: completedTool });
  assert.equal(completedTool.item.hostResult.details.ui_content.renderer, "test");
  assert.equal(Object.keys(completedTool.item).includes("hostResult"), false);
  assert.equal(JSON.stringify(completedTool).includes("hostResult"), false);

  await kernel.setSkillExtraRoots(["/tmp/skills"]);
  assert.equal((await kernel.listCollaborationModes()).data[0].name, "default");
  await kernel.listSkills({ cwds: ["/tmp/workspace"], forceReload: true });
  await kernel.listApps({ limit: 50, forceRefetch: true });
  await kernel.setSkillEnabled({ path: "/tmp/skills/demo/SKILL.md", enabled: false });
  await kernel.readConfig({ includeLayers: true });
  await kernel.writeConfigValue({ keyPath: "mcp_servers.demo", value: { command: "node" } });
  await kernel.setProjectTrustLevel('/tmp/a"b\\c\n\t\u0001\u007f');
  await kernel.reloadMcpServers();
  await kernel.listMcpServerStatus({ detail: "full" });
  assert.deepEqual(
    client.requests.filter((request) => request.method === "skills/extraRoots/set").at(-1)?.params,
    { extraRoots: ["/tmp/skills"] },
  );
  assert.deepEqual(
    client.requests.find((request) => request.method === "skills/list")?.params,
    { cwds: ["/tmp/workspace"], forceReload: true },
  );
  assert.deepEqual(
    client.requests.find((request) => request.method === "app/list")?.params,
    { limit: 50, forceRefetch: true },
  );
  assert.deepEqual(
    client.requests.find((request) => request.method === "skills/config/write")?.params,
    { path: "/tmp/skills/demo/SKILL.md", enabled: false },
  );
  assert.deepEqual(
    client.requests.find((request) => request.method === "config/value/write")?.params,
    { keyPath: "mcp_servers.demo", value: { command: "node" }, mergeStrategy: "replace" },
  );
  assert.deepEqual(
    client.requests.filter((request) => request.method === "config/value/write").at(-1)?.params,
    {
      keyPath: 'projects."/tmp/a\\"b\\\\c\\n\\t\\u0001\\u007f".trust_level',
      value: "trusted",
      mergeStrategy: "upsert",
    },
  );
  assert.equal(client.requests.some((request) => request.method === "config/mcpServer/reload"), true);
  assert.deepEqual(
    client.requests.find((request) => request.method === "mcpServerStatus/list")?.params,
    { detail: "full" },
  );

  const result = await kernel.runTurn({
    threadId: "thread-1",
    input: "你好",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    onNotification: (method) => events.push(method),
  });
  assert.equal(result.started.turn.id, "turn-1");
  assert.equal(result.completed.turn.status, "completed");
  assert.deepEqual(events, ["turn/completed"]);
  const turnRequest = client.requests.find((request) => request.method === "turn/start");
  assert.equal(turnRequest.params.approvalPolicy, "never");
  assert.equal(turnRequest.params.approvalsReviewer, "user");
  client.emit("notification", {
    method: "thread/tokenUsage/updated",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      tokenUsage: { total: { totalTokens: 1000 }, last: { totalTokens: 900 }, modelContextWindow: 2000 },
    },
  });
  const compacted = await kernel.compactThread("thread-1", { timeoutMs: 1000 });
  assert.equal(compacted.itemId, "compact-1");
  assert.equal(compacted.turnId, "compact-turn-1");
  assert.equal(compacted.before, 900);
  assert.equal(compacted.after, 200);
  assert.equal(
    client.requests.filter((request) => request.method === "thread/compact/start").length,
    1,
  );
  assert.equal(client.notifications[0].method, "initialized");
  await kernel.stop();
});

test("AgentKernel forwards native Turn fork boundaries and can delete the new Thread", async () => {
  const client = new FakeClient();
  const kernel = new AgentKernel({
    binary: "/fake/agent_runtime",
    clientFactory: () => client,
  });

  const through = await kernel.forkThread("thread-source", { lastTurnId: "turn-2" });
  assert.equal(through.thread.id, "thread-fork-1");
  assert.deepEqual(
    client.requests.find((request) => request.method === "thread/fork")?.params,
    { threadId: "thread-source", lastTurnId: "turn-2" },
  );

  client.requests.length = 0;
  await kernel.forkThread("thread-source", { beforeTurnId: "turn-2", excludeTurns: true });
  assert.deepEqual(
    client.requests.find((request) => request.method === "thread/fork")?.params,
    { threadId: "thread-source", beforeTurnId: "turn-2", excludeTurns: true },
  );
  assert.equal(client.requests.some((request) => request.method === "thread/read"), false);

  client.requests.length = 0;
  await kernel.forkThread("thread-source", { beforeTurnId: "turn-1" });
  assert.deepEqual(
    client.requests.find((request) => request.method === "thread/fork")?.params,
    { threadId: "thread-source", beforeTurnId: "turn-1" },
  );
  assert.equal(client.requests.some((request) => request.method === "thread/rollback"), false);
  await assert.rejects(
    kernel.forkThread("thread-source", { lastTurnId: "turn-1", beforeTurnId: "turn-2" }),
    /不能同时使用/,
  );

  const collaborationMode = {
    mode: "default",
    settings: {
      model: "target-model",
      reasoning_effort: null,
      developer_instructions: "目标项目指令",
    },
  };
  await kernel.updateThreadSettings("thread-fork-1", { collaborationMode });
  assert.deepEqual(
    client.requests.find((request) => request.method === "thread/settings/update")?.params,
    { threadId: "thread-fork-1", collaborationMode },
  );

  await kernel.archiveThread("thread-source");
  assert.deepEqual(
    client.requests.find((request) => request.method === "thread/archive")?.params,
    { threadId: "thread-source" },
  );

  await kernel.deleteThread("thread-fork-1");
  assert.deepEqual(
    client.requests.find((request) => request.method === "thread/delete")?.params,
    { threadId: "thread-fork-1" },
  );
  assert.equal(kernel.hasThread("thread-fork-1"), false);
  await kernel.stop();
});

test("AgentKernel gives native subagent threads the parent tools and interaction handlers", async () => {
  const client = new FakeClient();
  const approvals = [];
  const elicitations = [];
  const kernel = new AgentKernel({
    binary: "/fake/agent_runtime",
    clientFactory: () => client,
  });
  await kernel.startThread({
    tools: [{
      name: "echo",
      description: "echo",
      parameters: { type: "object" },
      execute: async (_callId, args) => ({ content: [{ type: "text", text: args.value }] }),
    }],
    approvalHandler: async ({ params }) => {
      approvals.push(params.threadId);
      return { decision: "accept" };
    },
    userInputHandler: async () => ({ answers: { answer: { answers: ["ok"] } } }),
    mcpElicitationHandler: async (params) => {
      elicitations.push(params.threadId);
      return { action: "accept", content: { scope: "child" }, _meta: null };
    },
  });

  client.emit("notification", {
    method: "thread/started",
    params: { thread: { id: "child-1", parentThreadId: "thread-1" } },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "child-1", turn: { id: "child-turn-1", status: "inProgress" } },
  });

  const toolResult = await client.handlers.get("item/tool/call")({
    threadId: "child-1",
    turnId: "child-turn-1",
    callId: "child-call-1",
    tool: "echo",
    arguments: { value: "child-ok" },
  });
  assert.equal(toolResult.success, true);
  assert.equal(toolResult.contentItems[0].text, "child-ok");

  const approvalResult = await client.handlers.get("item/commandExecution/requestApproval")({
    threadId: "child-1",
    turnId: "child-turn-1",
    itemId: "command-1",
  });
  assert.deepEqual(approvalResult, { decision: "accept" });
  assert.deepEqual(approvals, ["child-1"]);

  const inputResult = await client.handlers.get("item/tool/requestUserInput")({
    threadId: "child-1",
    turnId: "child-turn-1",
    itemId: "question-1",
  });
  assert.deepEqual(inputResult, { answers: { answer: { answers: ["ok"] } } });

  const elicitationResult = await client.handlers.get("mcpServer/elicitation/request")({
    threadId: "child-1",
    turnId: "child-turn-1",
    serverName: "native-test",
    mode: "form",
    message: "选择范围",
    requestedSchema: { type: "object" },
    _meta: null,
  });
  assert.deepEqual(elicitationResult, { action: "accept", content: { scope: "child" }, _meta: null });
  assert.deepEqual(elicitations, ["child-1"]);

  client.emit("notification", {
    method: "thread/started",
    params: { thread: { id: "grandchild-1", parentThreadId: "child-1" } },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "grandchild-1", turn: { id: "grandchild-turn-1", status: "inProgress" } },
  });
  const nestedToolResult = await client.handlers.get("item/tool/call")({
    threadId: "grandchild-1",
    turnId: "grandchild-turn-1",
    callId: "grandchild-call-1",
    tool: "echo",
    arguments: { value: "grandchild-ok" },
  });
  assert.equal(nestedToolResult.success, true);
  assert.equal(nestedToolResult.contentItems[0].text, "grandchild-ok");
  assert.equal(kernel.hasThread("child-1"), true);
  assert.equal(kernel.hasThread("grandchild-1"), true);
  await kernel.stop();
});

test("AgentKernel resolves native child bindings when a tool call beats thread/started", async () => {
  class LateChildClient extends FakeClient {
    async request(method, params) {
      if (method === "thread/read" && params.threadId === "child-before-started") {
        this.requests.push({ method, params });
        return { thread: { id: "child-before-started", parentThreadId: "thread-1", turns: [] } };
      }
      return super.request(method, params);
    }
  }

  const client = new LateChildClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [{
      name: "echo",
      execute: async (_callId, args) => ({ content: [{ type: "text", text: args.value }] }),
    }],
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "child-before-started", turn: { id: "child-turn-race", status: "inProgress" } },
  });

  const result = await client.handlers.get("item/tool/call")({
    threadId: "child-before-started",
    turnId: "child-turn-race",
    callId: "child-call-race",
    tool: "echo",
    arguments: { value: "child-race-ok" },
  });

  assert.equal(result.success, true);
  assert.equal(result.contentItems[0].text, "child-race-ok");
  assert.ok(client.requests.some((request) => (
    request.method === "thread/read" && request.params.threadId === "child-before-started"
  )));
  await kernel.stop();
});

test("AgentKernel declines child interactions that finish binding after the subtree stopped", async () => {
  class DelayedChildBindingClient extends FakeClient {
    constructor() {
      super();
      this.childReadResolvers = [];
    }
    async request(method, params) {
      if (method === "thread/read" && params.threadId === "child-interaction-race") {
        this.requests.push({ method, params });
        return new Promise((resolve) => this.childReadResolvers.push(resolve));
      }
      return super.request(method, params);
    }
    resolveChildReads() {
      for (const resolve of this.childReadResolvers.splice(0)) {
        resolve({
          thread: {
            id: "child-interaction-race",
            parentThreadId: "thread-1",
            turns: [{ id: "child-interaction-turn", status: "inProgress" }],
          },
        });
      }
    }
  }

  const client = new DelayedChildBindingClient();
  const handled = { approvals: 0, inputs: 0, elicitations: 0 };
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [],
    approvalHandler: async () => {
      handled.approvals += 1;
      return { decision: "accept" };
    },
    userInputHandler: async () => {
      handled.inputs += 1;
      return { answers: { answer: { answers: ["late"] } } };
    },
    mcpElicitationHandler: async () => {
      handled.elicitations += 1;
      return { action: "accept", content: { scope: "late" }, _meta: null };
    },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "root-interaction-turn", status: "inProgress" } },
  });
  client.emit("notification", {
    method: "turn/started",
    params: {
      threadId: "child-interaction-race",
      turn: { id: "child-interaction-turn", status: "inProgress" },
    },
  });

  const approval = client.handlers.get("item/commandExecution/requestApproval")({
    threadId: "child-interaction-race",
    turnId: "child-interaction-turn",
    itemId: "late-command",
  });
  const permission = client.handlers.get("item/permissions/requestApproval")({
    threadId: "child-interaction-race",
    turnId: "child-interaction-turn",
    itemId: "late-permission",
    permissions: { network: { enabled: true }, fileSystem: null },
  });
  const input = client.handlers.get("item/tool/requestUserInput")({
    threadId: "child-interaction-race",
    turnId: "child-interaction-turn",
    itemId: "late-input",
    questions: [{ id: "answer", question: "late?" }],
  });
  const elicitation = client.handlers.get("mcpServer/elicitation/request")({
    threadId: "child-interaction-race",
    turnId: "child-interaction-turn",
    serverName: "late-server",
    mode: "form",
    requestedSchema: { type: "object" },
    _meta: null,
  });
  while (client.childReadResolvers.length < 4) await new Promise((resolve) => setImmediate(resolve));

  const stopped = await kernel.interruptThreadTree("thread-1");
  assert.equal(stopped.partial, false);
  client.resolveChildReads();

  assert.deepEqual(await approval, { decision: "decline" });
  assert.deepEqual(await permission, { permissions: {}, scope: "turn" });
  assert.deepEqual(await input, { answers: {} });
  assert.deepEqual(await elicitation, { action: "decline", content: null, _meta: null });
  assert.deepEqual(handled, { approvals: 0, inputs: 0, elicitations: 0 });
  assert.ok(kernel._subtreeStopBarriersForThread("child-interaction-race").length > 0);
  await kernel.stop();
});

test("AgentKernel recursively refreshes dynamic tools for known native subagent descendants", async () => {
  const client = new FakeClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  const tool = (value) => ({
    name: "bridge_version",
    execute: async () => ({ content: [{ type: "text", text: value }] }),
  });
  await kernel.startThread({ tools: [tool("turn-1")] });
  client.emit("notification", {
    method: "thread/started",
    params: { thread: { id: "child-refresh", parentThreadId: "thread-1" } },
  });
  client.emit("notification", {
    method: "thread/started",
    params: { thread: { id: "grandchild-refresh", parentThreadId: "child-refresh" } },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "grandchild-refresh", turn: { id: "grandchild-turn-1", status: "inProgress" } },
  });

  const before = await client.handlers.get("item/tool/call")({
    threadId: "grandchild-refresh",
    turnId: "grandchild-turn-1",
    callId: "grandchild-call-before-refresh",
    tool: "bridge_version",
    arguments: {},
  });
  assert.equal(before.contentItems[0].text, "turn-1");

  await kernel.runTurn({ threadId: "thread-1", input: "finish turn 1" });
  await kernel.resumeThread("thread-1", { tools: [tool("turn-2")] });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "child-refresh", turn: { id: "child-turn-2", status: "inProgress" } },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "grandchild-refresh", turn: { id: "grandchild-turn-2", status: "inProgress" } },
  });
  const childAfter = await client.handlers.get("item/tool/call")({
    threadId: "child-refresh",
    turnId: "child-turn-2",
    callId: "child-call-after-refresh",
    tool: "bridge_version",
    arguments: {},
  });
  const grandchildAfter = await client.handlers.get("item/tool/call")({
    threadId: "grandchild-refresh",
    turnId: "grandchild-turn-2",
    callId: "grandchild-call-after-refresh",
    tool: "bridge_version",
    arguments: {},
  });

  assert.equal(childAfter.contentItems[0].text, "turn-2");
  assert.equal(grandchildAfter.contentItems[0].text, "turn-2");
  await kernel.stop();
});

test("AgentKernel revokes dynamic tools when the owning Turn completes", async () => {
  const client = new FakeClient();
  let executions = 0;
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [{
      name: "turn_scoped_probe",
      execute: async () => {
        executions += 1;
        return { content: [{ type: "text", text: "ran" }] };
      },
    }],
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } },
  });
  const duringTurn = await client.handlers.get("item/tool/call")({
    threadId: "thread-1",
    turnId: "turn-1",
    callId: "call-during-turn",
    tool: "turn_scoped_probe",
    arguments: {},
  });
  assert.equal(duringTurn.success, true);

  await kernel.runTurn({ threadId: "thread-1", input: "finish" });
  const afterTurn = await client.handlers.get("item/tool/call")({
    threadId: "thread-1",
    turnId: "turn-late",
    callId: "call-after-turn",
    tool: "turn_scoped_probe",
    arguments: {},
  });

  assert.equal(afterTurn.success, false);
  assert.equal(executions, 1);
  assert.match(afterTurn.contentItems[0].text, /Turn.*结束/);
  await kernel.stop();
});

test("AgentKernel refuses dynamic tools after the owning Turn is aborted", async () => {
  const client = new DelayedTurnStartClient();
  const controller = new AbortController();
  let executions = 0;
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    signal: controller.signal,
    tools: [{
      name: "aborted_turn_probe",
      execute: async () => {
        executions += 1;
        return "should not run";
      },
    }],
  });
  const running = kernel.runTurn({ threadId: "thread-1", input: "wait", signal: controller.signal });
  while (!client.resolveTurnStart) await new Promise((resolve) => setImmediate(resolve));

  controller.abort();
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-aborted-tools", status: "inProgress" } },
  });
  client.resolveTurnStart({ turn: { id: "turn-aborted-tools", status: "inProgress" } });
  await assert.rejects(running, (error) => error?.name === "AbortError");

  const afterAbort = await client.handlers.get("item/tool/call")({
    threadId: "thread-1",
    turnId: "turn-aborted-tools",
    callId: "call-after-abort",
    tool: "aborted_turn_probe",
    arguments: {},
  });
  assert.equal(afterAbort.success, false);
  assert.equal(executions, 0);
  assert.match(afterAbort.contentItems[0].text, /Turn.*取消/);
  await kernel.stop();
});

test("AgentKernel rejects a stale child Turn without revoking the shared parent bridge", async () => {
  const client = new FakeClient();
  let executions = 0;
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [{
      name: "child_turn_probe",
      execute: async () => {
        executions += 1;
        return "ok";
      },
    }],
  });
  client.emit("notification", {
    method: "thread/started",
    params: { thread: { id: "child-stale", parentThreadId: "thread-1" } },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "child-stale", turn: { id: "child-turn-1", status: "inProgress" } },
  });
  const handler = client.handlers.get("item/tool/call");
  const active = await handler({
    threadId: "child-stale",
    turnId: "child-turn-1",
    callId: "child-active-call",
    tool: "child_turn_probe",
    arguments: {},
  });
  assert.equal(active.success, true);

  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "child-stale", turn: { id: "child-turn-1", status: "completed" } },
  });
  const stale = await handler({
    threadId: "child-stale",
    turnId: "child-turn-1",
    callId: "child-stale-call",
    tool: "child_turn_probe",
    arguments: {},
  });
  assert.equal(stale.success, false);
  assert.equal(executions, 1);
  assert.match(stale.contentItems[0].text, /Turn.*结束/);

  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "child-stale", turn: { id: "child-turn-2", status: "inProgress" } },
  });
  const next = await handler({
    threadId: "child-stale",
    turnId: "child-turn-2",
    callId: "child-next-call",
    tool: "child_turn_probe",
    arguments: {},
  });
  assert.equal(next.success, true, "a new child Turn keeps the inherited bridge usable");
  assert.equal(executions, 2);
  await kernel.stop();
});

test("AgentKernel makes dynamic tools fail closed as soon as stop starts", async () => {
  const client = new FakeClient();
  let executions = 0;
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [{
      name: "stop_probe",
      execute: async () => {
        executions += 1;
        return "should not run";
      },
    }],
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-stop", status: "inProgress" } },
  });
  const handler = client.handlers.get("item/tool/call");

  const stopping = kernel.stop();
  const result = await handler({
    threadId: "thread-1",
    turnId: "turn-stop",
    callId: "call-after-stop",
    tool: "stop_probe",
    arguments: {},
  });
  await stopping;

  assert.equal(result.success, false);
  assert.equal(executions, 0, "stop must revoke the bridge before its first await");
});

test("AgentKernel makes concurrent stop calls one teardown and settles a waiting runTurn", async () => {
  class HangingTurnClient extends FakeClient {
    async request(method, params) {
      if (method !== "turn/start") return super.request(method, params);
      this.requests.push({ method, params });
      return { turn: { id: "turn-hanging", status: "inProgress" } };
    }
  }
  const clients = [];
  const kernel = new AgentKernel({
    binary: "/fake/agent_runtime",
    clientFactory: () => {
      const client = new HangingTurnClient();
      clients.push(client);
      return client;
    },
  });
  await kernel.startThread({ tools: [] });
  const running = kernel.runTurn({ threadId: "thread-1", input: "hang" });
  while (!clients[0].requests.some((request) => request.method === "turn/start")) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const firstStop = kernel.stop();
  const secondStop = kernel.stop();
  assert.equal(firstStop, secondStop, "concurrent callers share the same stop Promise");
  await assert.rejects(running, (error) => error?.code === "AGENT_KERNEL_STOPPED");
  await Promise.all([firstStop, secondStop]);
  assert.equal(clients[0].listenerCount("notification"), 0);

  await kernel.startThread({ tools: [] });
  assert.equal(clients.length, 2);
  assert.equal(clients[1].running, true, "the completed old teardown cannot stop the restarted client");
  await kernel.stop();
});

test("AgentKernel drops an in-flight dynamic result and Host actions when interrupt begins", async () => {
  const client = new FakeClient();
  let finishExecution;
  let executions = 0;
  let deliveries = 0;
  let hostActions = 0;
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [{
      name: "interrupt_probe",
      host_action_capable: true,
      execute: async () => {
        executions += 1;
        if (executions === 1) return new Promise((resolve) => { finishExecution = resolve; });
        return "unexpected stale execution";
      },
    }],
    toolContext: {
      onToolResult: async ({ result }) => {
        deliveries += 1;
        return result;
      },
      onHostAction: async () => { hostActions += 1; },
    },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-interrupt", status: "inProgress" } },
  });
  const handler = client.handlers.get("item/tool/call");
  const pending = handler({
    threadId: "thread-1",
    turnId: "turn-interrupt",
    callId: "call-interrupt",
    tool: "interrupt_probe",
    arguments: {},
  });
  while (!finishExecution) await new Promise((resolve) => setImmediate(resolve));

  const interrupted = await kernel.interruptThread("thread-1", { drainTimeoutMs: 5 });
  assert.equal(interrupted.settled, false);
  assert.equal(interrupted.pendingCalls, 1);
  finishExecution({
    content: [{ type: "text", text: "late result" }],
    details: { host_actions: [{ type: "workspace_event", event: { event: "late" } }] },
  });
  const result = await pending;

  assert.equal(result.success, false);
  assert.equal(deliveries, 0);
  assert.equal(hostActions, 0);
  assert.equal(kernel.toolBridges.get("thread-1")?.takeHostResult("call-interrupt", {
    threadId: "thread-1",
    turnId: "turn-interrupt",
  }), undefined);

  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-interrupt", status: "inProgress" } },
  });
  const late = await handler({
    threadId: "thread-1",
    turnId: "turn-interrupt",
    callId: "call-after-late-start",
    tool: "interrupt_probe",
    arguments: {},
  });
  assert.equal(late.success, false, "a late duplicate turn/started cannot reactivate an interrupted Turn");
  assert.equal(executions, 1);
  assert.equal(kernel.inactiveTurns.get("thread-1"), "turn-interrupt");
  client.emit("notification", {
    method: "turn/completed",
    params: { threadId: "thread-1", turn: { id: "turn-interrupt", status: "interrupted" } },
  });
  assert.equal(kernel.inactiveTurns.has("thread-1"), false, "the terminal notification retires the per-Thread tombstone");
  await kernel.stop();
});

test("AgentKernel stops observed ephemeral children even when thread/list is empty", async () => {
  const client = new FakeClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({ tools: [], ephemeral: true });
  client.emit("notification", {
    method: "thread/started",
    params: { thread: { id: "ephemeral-child-1", parentThreadId: "thread-1" } },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "ephemeral-child-1", turn: { id: "ephemeral-child-turn-1" } },
  });

  const result = await kernel.interruptThreadTree("thread-1");
  assert.equal(result.children.length, 1);
  assert.equal(result.children[0].threadId, "ephemeral-child-1");
  assert.equal(result.children[0].interrupted, true);
  await kernel.stop();
});

test("AgentKernel single-flights concurrent subtree stops for the same root", async () => {
  class StrictInterruptClient extends FakeClient {
    constructor() {
      super();
      this.rejectDuplicateInterrupt = null;
    }
    async request(method, params) {
      if (method !== "turn/interrupt") return super.request(method, params);
      this.requests.push({ method, params });
      const duplicate = this.requests.filter((request) => request.method === "turn/interrupt").length > 1;
      if (!duplicate) return {};
      return new Promise((resolve, reject) => {
        this.rejectDuplicateInterrupt = () => reject(new Error("Turn is no longer running"));
      });
    }
  }
  const client = new StrictInterruptClient();
  let executions = 0;
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [{
      name: "concurrent_tree_stop_probe",
      execute: async () => {
        executions += 1;
        return "ok";
      },
    }],
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-concurrent-stop", status: "inProgress" } },
  });

  const firstStop = kernel.interruptThreadTree("thread-1", { rootTurnId: "turn-concurrent-stop" });
  const secondStop = kernel.interruptThreadTree("thread-1", { rootTurnId: "turn-concurrent-stop" });
  const firstResult = await firstStop;
  client.rejectDuplicateInterrupt?.();
  const secondResult = await secondStop;

  assert.equal(firstStop, secondStop, "same-root callers must share one stop Promise");
  assert.equal(firstResult.partial, false);
  assert.equal(secondResult.partial, false);
  assert.equal(
    client.requests.filter((request) => request.method === "turn/interrupt").length,
    1,
    "the native Turn is interrupted once",
  );
  assert.equal(
    [...kernel.subtreeStopBarriers].filter((barrier) => barrier.root === "thread-1" && barrier.partial).length,
    0,
    "a duplicate caller cannot leave a false partial tombstone",
  );

  await kernel.startTurn({ threadId: "thread-1", input: "explicit restart" });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-after-concurrent-stop", status: "inProgress" } },
  });
  const afterRestart = await client.handlers.get("item/tool/call")({
    threadId: "thread-1",
    turnId: "turn-after-concurrent-stop",
    callId: "call-after-concurrent-stop",
    tool: "concurrent_tree_stop_probe",
    arguments: {},
  });
  assert.equal(afterRestart.success, true, "an explicit new Host Turn can reopen after the settled stop");
  assert.equal(executions, 1);
  await kernel.stop();
});

test("AgentKernel settles a failed subtree barrier and lets a successful retry replace it", async () => {
  let starts = 0;
  class FailOnceStartClient extends FakeClient {
    async start() {
      starts += 1;
      if (starts === 1) throw new Error("transient start failure");
      return super.start();
    }
  }
  const kernel = new AgentKernel({
    binary: "/fake/agent_runtime",
    clientFactory: () => new FailOnceStartClient(),
  });

  await assert.rejects(
    kernel.interruptThreadTree("thread-stop-start-failure"),
    /transient start failure/,
  );
  const failedBarrier = [...kernel.subtreeStopBarriers].find((barrier) => (
    barrier.root === "thread-stop-start-failure"
  ));
  assert.ok(failedBarrier);
  assert.equal(failedBarrier.inProgress, false);
  assert.equal(failedBarrier.partial, true);
  assert.equal(failedBarrier.stopErrors[0]?.phase, "subtree/stop");
  await assert.rejects(
    kernel.startTurn({ threadId: "thread-stop-start-failure", input: "blocked before retry" }),
    (error) => error?.code === "AGENT_SUBTREE_STOP_PARTIAL",
  );

  const retried = await kernel.interruptThreadTree("thread-stop-start-failure");
  assert.equal(retried.partial, false);
  assert.equal(kernel.subtreeStopBarriers.has(failedBarrier), false);
  await kernel.startTurn({ threadId: "thread-stop-start-failure", input: "allowed after retry" });
  await kernel.stop();
});

test("AgentKernel interrupts a native subagent tree before the parent turn", async () => {
  class CollaborationClient extends FakeClient {
    async request(method, params) {
      if (method === "thread/list") {
        this.requests.push({ method, params });
        return {
          data: [
            { id: "child-1", parentThreadId: "thread-1" },
            { id: "grandchild-1", parentThreadId: "child-1" },
          ],
          nextCursor: null,
        };
      }
      return super.request(method, params);
    }
  }
  const client = new CollaborationClient();
  let executions = 0;
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [{
      name: "tree_stop_probe",
      execute: async () => {
        executions += 1;
        return "should not run";
      },
    }],
  });
  client.emit("notification", {
    method: "thread/started",
    params: { thread: { id: "child-1", parentThreadId: "thread-1" } },
  });
  client.emit("notification", {
    method: "thread/started",
    params: { thread: { id: "grandchild-1", parentThreadId: "child-1" } },
  });
  for (const [threadId, turnId] of [
    ["thread-1", "turn-1"],
    ["child-1", "child-turn-1"],
    ["grandchild-1", "grandchild-turn-1"],
  ]) {
    client.emit("notification", { method: "turn/started", params: { threadId, turn: { id: turnId } } });
  }

  const stopping = kernel.interruptThreadTree("thread-1", { rootTurnId: "turn-1" });
  const handler = client.handlers.get("item/tool/call");
  const [childCall, grandchildCall, result] = await Promise.all([
    handler({
      threadId: "child-1",
      turnId: "child-turn-1",
      callId: "child-call-after-tree-stop",
      tool: "tree_stop_probe",
      arguments: {},
    }),
    handler({
      threadId: "grandchild-1",
      turnId: "grandchild-turn-1",
      callId: "grandchild-call-after-tree-stop",
      tool: "tree_stop_probe",
      arguments: {},
    }),
    stopping,
  ]);
  assert.equal(childCall.success, false);
  assert.equal(grandchildCall.success, false);
  assert.equal(executions, 0, "tree stop deactivates all known descendants before its first await");
  assert.equal(result.root.interrupted, true);
  assert.equal(result.children.filter((item) => item.interrupted).length, 2);
  const interrupts = client.requests.filter((request) => request.method === "turn/interrupt");
  assert.deepEqual(new Set(interrupts.slice(0, 2).map((request) => request.params.threadId)), new Set(["child-1", "grandchild-1"]));
  assert.equal(interrupts.at(-1).params.threadId, "thread-1");
  await kernel.stop();
});

test("AgentKernel keeps a subtree stop barrier against a new Turn during enumeration", async () => {
  class DelayedTreeListClient extends FakeClient {
    constructor() {
      super();
      this.resolveThreadList = null;
    }
    async request(method, params) {
      if (method !== "thread/list") return super.request(method, params);
      this.requests.push({ method, params });
      return new Promise((resolve) => { this.resolveThreadList = resolve; });
    }
  }
  const client = new DelayedTreeListClient();
  let executions = 0;
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [{
      name: "tree_barrier_probe",
      execute: async () => {
        executions += 1;
        return "should not run";
      },
    }],
  });
  client.emit("notification", {
    method: "thread/started",
    params: { thread: { id: "child-barrier", parentThreadId: "thread-1" } },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "child-barrier", turn: { id: "child-turn-before-stop" } },
  });

  const stopping = kernel.interruptThreadTree("thread-1", { rootTurnId: "turn-1" });
  while (!client.resolveThreadList) await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    kernel.startTurn({ threadId: "thread-1", input: "must not start" }),
    (error) => error?.code === "AGENT_SUBTREE_STOPPING",
  );
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "child-barrier", turn: { id: "child-turn-during-stop" } },
  });
  const duringStop = await client.handlers.get("item/tool/call")({
    threadId: "child-barrier",
    turnId: "child-turn-during-stop",
    callId: "call-during-tree-stop",
    tool: "tree_barrier_probe",
    arguments: {},
  });
  client.resolveThreadList({
    data: [{ id: "child-barrier", parentThreadId: "thread-1" }],
    nextCursor: null,
  });
  const result = await stopping;

  assert.equal(duringStop.success, false);
  assert.equal(executions, 0, "a new native Turn cannot reopen Host tools while its subtree is stopping");
  assert.equal(
    client.requests.some((request) => (
      request.method === "turn/interrupt"
      && request.params.threadId === "child-barrier"
      && request.params.turnId === "child-turn-during-stop"
    )),
    true,
    "the barrier must also interrupt the Turn that appeared during stop",
  );
  assert.equal(result.partial, false);
  assert.equal(result.settled, true);
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "child-barrier", turn: { id: "child-turn-after-stop-return" } },
  });
  const afterReturn = await client.handlers.get("item/tool/call")({
    threadId: "child-barrier",
    turnId: "child-turn-after-stop-return",
    callId: "call-after-tree-stop-return",
    tool: "tree_barrier_probe",
    arguments: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(afterReturn.success, false, "a retained stop tombstone blocks delayed runtime starts");
  assert.equal(client.requests.some((request) => (
    request.method === "turn/interrupt"
    && request.params.turnId === "child-turn-after-stop-return"
  )), true);
  await kernel.stop();
});

test("AgentKernel enumerates every subagent page before reporting a tree stopped", async () => {
  class PaginatedTreeClient extends FakeClient {
    async request(method, params) {
      if (method === "thread/list") {
        this.requests.push({ method, params });
        return params.cursor === "page-2"
          ? { data: [{ id: "child-page-2", parentThreadId: "thread-1" }], nextCursor: null }
          : { data: [{ id: "child-page-1", parentThreadId: "thread-1" }], nextCursor: "page-2" };
      }
      if (method === "thread/read" && params.threadId.startsWith("child-page-")) {
        this.requests.push({ method, params });
        return { thread: { id: params.threadId, turns: [{ id: `${params.threadId}-turn`, status: "inProgress" }] } };
      }
      return super.request(method, params);
    }
  }
  const client = new PaginatedTreeClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({ tools: [] });

  const result = await kernel.interruptThreadTree("thread-1", { rootTurnId: "turn-1" });
  const listRequests = client.requests.filter((request) => request.method === "thread/list");
  const interruptedThreads = new Set(
    client.requests
      .filter((request) => request.method === "turn/interrupt")
      .map((request) => request.params.threadId),
  );

  assert.deepEqual(listRequests.map((request) => request.params.cursor || null), [null, "page-2"]);
  assert.equal(interruptedThreads.has("child-page-1"), true);
  assert.equal(interruptedThreads.has("child-page-2"), true);
  assert.equal(result.enumeration.complete, true);
  assert.equal(result.partial, false);
  await kernel.stop();
});

test("AgentKernel keeps known descendants blocked and reports partial when tree enumeration fails", async () => {
  class FailingTreeListClient extends FakeClient {
    constructor() {
      super();
      this.failList = true;
    }
    async request(method, params) {
      if (method === "thread/list" && this.failList) {
        this.requests.push({ method, params });
        throw new Error("thread list unavailable");
      }
      return super.request(method, params);
    }
  }
  const client = new FailingTreeListClient();
  let executions = 0;
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [{
      name: "partial_stop_probe",
      execute: async () => {
        executions += 1;
        return "should not run";
      },
    }],
  });
  client.emit("notification", {
    method: "thread/started",
    params: { thread: { id: "known-child-partial", parentThreadId: "thread-1" } },
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "known-child-partial", turn: { id: "known-turn-before-stop" } },
  });

  const result = await kernel.interruptThreadTree("thread-1", { rootTurnId: "turn-1" });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "known-child-partial", turn: { id: "known-turn-after-partial-stop" } },
  });
  const afterPartial = await client.handlers.get("item/tool/call")({
    threadId: "known-child-partial",
    turnId: "known-turn-after-partial-stop",
    callId: "call-after-partial-stop",
    tool: "partial_stop_probe",
    arguments: {},
  });

  assert.equal(result.partial, true);
  assert.equal(result.enumeration.complete, false);
  assert.match(result.enumeration.error, /thread list unavailable/);
  assert.equal(result.barrierRetained, true);
  assert.equal(afterPartial.success, false, "an uncertain stop must remain fail-closed");
  assert.equal(executions, 0);

  await assert.rejects(
    kernel.startTurn({ threadId: "thread-1", input: "unsafe restart" }),
    (error) => error?.code === "AGENT_SUBTREE_STOP_PARTIAL",
  );
  client.failList = false;
  const recovered = await kernel.interruptThreadTree("thread-1", { rootTurnId: "turn-1" });
  assert.equal(recovered.partial, false);
  await kernel.startTurn({ threadId: "thread-1", input: "explicit new turn" });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "known-child-partial", turn: { id: "known-turn-after-explicit-restart" } },
  });
  const afterExplicitRestart = await client.handlers.get("item/tool/call")({
    threadId: "known-child-partial",
    turnId: "known-turn-after-explicit-restart",
    callId: "call-after-explicit-restart",
    tool: "partial_stop_probe",
    arguments: {},
  });
  assert.equal(afterExplicitRestart.success, true, "an explicit Host Turn can release a retained partial-stop barrier");
  assert.equal(executions, 1);
  await kernel.stop();
});

test("AgentKernel reports an unsettled tree stop while cancelled Host work is still running", async () => {
  const client = new FakeClient();
  let finishExecution;
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    tools: [{
      name: "tree_drain_probe",
      execute: async () => new Promise((resolve) => { finishExecution = resolve; }),
    }],
  });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-tree-drain" } },
  });
  const pending = client.handlers.get("item/tool/call")({
    threadId: "thread-1",
    turnId: "turn-tree-drain",
    callId: "call-tree-drain",
    tool: "tree_drain_probe",
    arguments: {},
  });
  while (!finishExecution) await new Promise((resolve) => setImmediate(resolve));

  const result = await kernel.interruptThreadTree("thread-1", {
    rootTurnId: "turn-tree-drain",
    drainTimeoutMs: 5,
  });

  assert.equal(result.partial, true);
  assert.equal(result.settled, false);
  assert.equal(result.pendingCalls, 1);
  assert.equal(result.barrierRetained, true);
  assert.equal(result.root.settled, false);
  assert.equal(result.root.pendingCalls, 1);
  await assert.rejects(
    kernel.startTurn({ threadId: "thread-1", input: "must wait for old write" }),
    (error) => error?.code === "AGENT_SUBTREE_STOP_PARTIAL" && error?.details?.pendingCalls === 1,
  );
  finishExecution("late");
  await pending;
  await kernel.startTurn({ threadId: "thread-1", input: "safe after drain" });
  await kernel.stop();
});

test("AgentKernel keeps a failed interrupt visible as an unsettled pending Turn", async () => {
  class FailingInterruptClient extends FakeClient {
    async request(method, params) {
      if (method === "turn/interrupt") {
        this.requests.push({ method, params });
        throw new Error("interrupt unavailable");
      }
      return super.request(method, params);
    }
  }
  const client = new FailingInterruptClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({ tools: [] });
  client.emit("notification", {
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-failed-interrupt" } },
  });

  const result = await kernel.interruptThreadTree("thread-1", { rootTurnId: "turn-failed-interrupt" });

  assert.equal(result.partial, true);
  assert.equal(result.settled, false);
  assert.equal(result.pendingTurns, 1);
  assert.equal(result.root.settled, false);
  assert.match(result.root.error, /interrupt unavailable/);
  await kernel.stop();
});

test("AgentKernel tracks MCP OAuth completion for the exact Thread and Server", async () => {
  const client = new FakeClient();
  const kernel = new AgentKernel({
    binary: "/fake/agent_runtime",
    clientFactory: () => client,
  });
  await kernel.startThread({ tools: [] });

  const login = await kernel.startMcpOauthLogin({ name: "account", threadId: "thread-1" });
  assert.equal(login.authorizationUrl, "https://example.com/authorize");
  assert.match(login.oauthAttemptId, /^[0-9a-f-]{36}$/);
  const completion = kernel.waitForMcpOauthCompletion({
    attemptId: login.oauthAttemptId,
    name: "account",
    threadId: "thread-1",
    timeoutMs: 1_000,
  });
  client.emit("notification", {
    method: "mcpServer/oauthLogin/completed",
    params: { name: "other", threadId: "thread-1", success: true },
  });
  client.emit("notification", {
    method: "mcpServer/oauthLogin/completed",
    params: { name: "account", threadId: "thread-1", success: true },
  });
  assert.deepEqual(await completion, {
    completed: true,
    success: true,
    name: "account",
    threadId: "thread-1",
    error: null,
  });
  await assert.rejects(
    () => kernel.waitForMcpOauthCompletion({
      attemptId: login.oauthAttemptId,
      name: "other",
      threadId: "thread-1",
    }),
    (error) => error?.code === "PLUGIN_MCP_OAUTH_ATTEMPT_NOT_FOUND",
  );

  const pendingLogin = await kernel.startMcpOauthLogin({ name: "pending", threadId: "thread-1" });
  assert.deepEqual(await kernel.waitForMcpOauthCompletion({
    attemptId: pendingLogin.oauthAttemptId,
    name: "pending",
    threadId: "thread-1",
    timeoutMs: 100,
  }), {
    completed: false,
    success: false,
    name: "pending",
    threadId: "thread-1",
    error: null,
  });
  await kernel.stop();
});

test("AgentKernel shares one startup across concurrent calls", async () => {
  let clientCount = 0;
  const client = new FakeClient();
  const kernel = new AgentKernel({
    binary: "/fake/agent_runtime",
    env: { ...process.env, CODEX_HOME: "/tmp/agent-kernel-concurrent-start" },
    clientFactory: () => {
      clientCount += 1;
      return client;
    },
  });

  await Promise.all([
    kernel.readConfig({ includeLayers: true }),
    kernel.listMcpServerStatus({ detail: "full" }),
    kernel.listSkills({ cwds: ["/tmp/workspace"], forceReload: true }),
  ]);

  assert.equal(clientCount, 1);
  assert.equal(client.requests.filter((request) => request.method === "initialize").length, 1);
  await kernel.stop();
});

test("AgentKernel sends the 0.147 sandbox mode instead of the legacy thread permissions field", async () => {
  const client = new FakeClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await kernel.startThread({
    permissions: "dsh-project",
    sandbox: "workspace-write",
    config: {
      default_permissions: "dsh-project",
      permissions: {
        "dsh-project": {
          filesystem: {
            ":minimal": "read",
            ":workspace_roots": { ".": "write" },
          },
        },
      },
    },
  });
  const request = client.requests.find((entry) => entry.method === "thread/start");
  assert.equal(request.params.sandbox, "workspace-write");
  assert.equal("permissions" in request.params, false);
  await kernel.stop();
});

test("AgentKernel serializes different process startups that share one runtime home", async () => {
  let activeInitializations = 0;
  let maxActiveInitializations = 0;
  class SlowInitializeClient extends FakeClient {
    async request(method, params) {
      if (method !== "initialize") return super.request(method, params);
      this.requests.push({ method, params });
      activeInitializations += 1;
      maxActiveInitializations = Math.max(maxActiveInitializations, activeInitializations);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
      activeInitializations -= 1;
      return { userAgent: "agent_runtime-test" };
    }
  }
  const options = {
    binary: "/fake/agent_runtime",
    env: { ...process.env, CODEX_HOME: "/tmp/agent-kernel-shared-home" },
  };
  const first = new AgentKernel({ ...options, clientFactory: () => new SlowInitializeClient() });
  const second = new AgentKernel({ ...options, clientFactory: () => new SlowInitializeClient() });

  await Promise.all([first.start(), second.start()]);
  assert.equal(maxActiveInitializations, 1);
  await Promise.all([first.stop(), second.stop()]);
});

test("AgentKernel reports compaction failure instead of a false success", async () => {
  const client = new FailingCompactionClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await assert.rejects(
    kernel.compactThread("thread-1", { timeoutMs: 1000 }),
    /compact failed/,
  );
  await kernel.stop();
});

test("AgentKernel times out when compaction never completes", async () => {
  const client = new HangingCompactionClient();
  const kernel = new AgentKernel({ binary: "/fake/agent_runtime", clientFactory: () => client });
  await assert.rejects(
    kernel.compactThread("thread-1", { timeoutMs: 10 }),
    (error) => error?.code === "AGENT_RUNTIME_COMPACTION_TIMEOUT",
  );
  await kernel.stop();
});
