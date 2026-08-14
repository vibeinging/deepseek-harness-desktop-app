import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveDshRuntimeDistribution } from "../../server/src/engine/dsh_runtime/source_locator.js";
import { DshEventAdapter, dshTurnStatus } from "../../server/src/engine/dsh_runtime/event_adapter.js";
import {
  DshWorkspaceRuntime,
  dshPolicyCommands,
  effectiveDshPlanMode,
  resolveDshModelTarget,
} from "../../server/src/engine/dsh_runtime/workspace_runtime.js";
import { DshRuntimeClient, normalizeDshClientSurface } from "../../server/src/engine/dsh_runtime/client.js";
import { dshModelOptions, encodeDshModelRoute } from "../../server/src/engine/dsh_runtime/model_route.js";
import {
  publishDshModelSettingsChanged,
  resetDshModelSettingsEventsForTests,
  subscribeDshModelSettingsEvents,
} from "../../server/src/engine/dsh_runtime/model_settings_events.js";

const DSH_SOURCE_ROOT = process.env.DSH_SOURCE_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), "../../../test-vibeinging");
const DSH_RUNTIME_VERSION = existsSync(join(DSH_SOURCE_ROOT, "apps", "cli", "package.json"))
  ? JSON.parse(readFileSync(join(DSH_SOURCE_ROOT, "apps", "cli", "package.json"), "utf8")).version
  : null;
const DSH_NPM_VERSION = JSON.parse(readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../server/node_modules/@deepseek-ai/dsh/package.json"),
  "utf8",
)).version;
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("DSH runtime locator keeps source and npm distributions behind one seat", () => {
  assert.equal(resolveDshRuntimeDistribution({ env: {} }), null);
  const source = resolveDshRuntimeDistribution({
    env: { DSH_RUNTIME_DISTRIBUTION: "source", DSH_SOURCE_ROOT },
  });
  assert.equal(source.distribution, "source");
  assert.match(source.appBootPath, /packages\/ui\/app-boot\/lib\/index\.js$/);
  assert.match(source.entryPath, /apps\/cli\/src\/bin\.ts$/);
  assert.match(source.installAnchor, /apps\/cli\/package\.json$/);
  assert.match(source.profileBootPath, /apps\/cli\/src\/profile-boot\.ts$/);
  assert.deepEqual(source.execArgv.slice(0, 1), ["--import"]);
  const npm = resolveDshRuntimeDistribution({
    env: {
      DSH_RUNTIME_DISTRIBUTION: "npm",
      DSH_NPM_PACKAGE_ROOT: join(DSH_SOURCE_ROOT, "apps", "cli"),
    },
  });
  assert.equal(npm.launch, "cli");
  assert.equal(npm.version, DSH_RUNTIME_VERSION);
  assert.match(npm.appBootPath, /packages\/ui\/app-boot\/lib\/index\.js$/);
  assert.match(npm.entryPath, /apps\/cli\/lib\/bin\.js$/);
  assert.match(npm.installAnchor, /apps\/cli\/package\.json$/);
  assert.throws(
    () => resolveDshRuntimeDistribution({ env: { DSH_RUNTIME_DISTRIBUTION: "unknown" } }),
    { code: "DSH_RUNTIME_DISTRIBUTION_INVALID" },
  );
});

test("DSH runtime locator resolves the app-pinned npm distribution", () => {
  const npm = resolveDshRuntimeDistribution({
    env: { DSH_RUNTIME_DISTRIBUTION: "npm" },
    appRoot: resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
  });
  assert.equal(npm.distribution, "npm");
  assert.equal(npm.version, DSH_NPM_VERSION);
  assert.match(npm.entryPath, /server\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js$/);
  assert.match(npm.appBootPath, /server\/node_modules\/@deepseek-ai\/dsh-app-boot\/lib\/index\.js$/);
});

test("DSH client surface accepts only an exact loopback HTTP origin", () => {
  assert.equal(normalizeDshClientSurface("http://127.0.0.1:3080/"), "http://127.0.0.1:3080/");
  assert.throws(
    () => normalizeDshClientSurface("http://localhost:3080/"),
    { code: "DSH_CLIENT_SURFACE_INVALID" },
  );
  assert.throws(
    () => normalizeDshClientSurface("https://127.0.0.1:3080/"),
    { code: "DSH_CLIENT_SURFACE_INVALID" },
  );
});

test("every DSH unary request uses the official loopback Web ApiProxy", async () => {
  const requests = [];
  const client = new DshRuntimeClient({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({
        type: "server-response",
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            workspace: { workspaceId: "workspace-1", path: "/repo" },
            created: true,
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  client.waitForClientSurface = async () => {
    client.clientSurface = "http://127.0.0.1:3080/";
    return client.clientSurface;
  };

  const result = await client.request("workspace.create", { path: "/repo" }, { rpcId: "rpc-1" });

  assert.equal(requests[0].url, "http://127.0.0.1:3080/api/workspace.create");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    type: "client-request",
    rpcId: "rpc-1",
    method: "workspace.create",
    payload: { path: "/repo" },
  });
  assert.equal(result.workspace.workspaceId, "workspace-1");
});

test("DSH command requests use the official Typert Remote envelope", async () => {
  const requests = [];
  const client = new DshRuntimeClient({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({
        type: "server-response",
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: { commandId: "permission", result: { kind: "success" } },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  client.waitForClientSurface = async () => {
    client.clientSurface = "http://127.0.0.1:3080/";
    return client.clientSurface;
  };

  const result = await client.requestRemote("commands/execute", {
    agentId: "session-1",
    line: "/permission read-only",
  }, { rpcId: "rpc-command-1" });

  assert.equal(requests[0].url, "http://127.0.0.1:3080/api/commands/execute");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    type: "client-request",
    rpcId: "rpc-command-1",
    method: "commands/execute",
    payload: {
      args: {
        agentId: "session-1",
        line: "/permission read-only",
      },
    },
  });
  assert.deepEqual(result, { commandId: "permission", result: { kind: "success" } });
});

test("DSH interaction responses use the official /api/respond envelope", async () => {
  const requests = [];
  const client = new DshRuntimeClient({
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ accepted: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  client.waitForClientSurface = async () => {
    client.clientSurface = "http://127.0.0.1:3080/";
    return client.clientSurface;
  };

  assert.deepEqual(await client.respond("approval-1", { outcome: "rejected" }), { accepted: true });
  assert.equal(requests[0].url, "http://127.0.0.1:3080/api/respond");
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    type: "client-response",
    rpcId: "approval-1",
    result: { ok: true, value: { outcome: "rejected" } },
  });
});

class FakeWebSocket extends EventTarget {
  static sockets = [];

  constructor(url) {
    super();
    this.url = String(url);
    this.closed = false;
    FakeWebSocket.sockets.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }

  frame(message) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(new Event("close"));
  }
}

test("DSH runtime opens current mux and host WebSockets before reporting ready", async () => {
  FakeWebSocket.sockets = [];
  const apiMethods = [];
  const child = new EventEmitter();
  child.connected = true;
  child.send = (message, callback) => {
    callback?.();
    if (message?.type !== "shutdown") return;
    queueMicrotask(() => {
      child.connected = false;
      child.emit("exit", 0, null);
    });
  };
  child.disconnect = () => { child.connected = false; };
  child.kill = () => {};
  const client = new DshRuntimeClient({
    env: { DSH_RUNTIME_DISTRIBUTION: "source", DSH_SOURCE_ROOT },
    spawn: () => {
      queueMicrotask(() => {
        child.emit("message", { type: "client-ready", url: "http://127.0.0.1:3080/" });
        child.emit("message", { type: "ready", distribution: "source", version: DSH_RUNTIME_VERSION });
      });
      return child;
    },
    WebSocket: FakeWebSocket,
    fetch: async (_url, init) => {
      const request = JSON.parse(init.body);
      apiMethods.push(request.method);
      const value = request.method === "settings.describe"
        ? { namespaces: [{ ns: "ui-theme", revision: 0, value: { preference: "system" } }] }
        : { value: { preference: "dark" } };
      return new Response(JSON.stringify({
        rpcId: request.rpcId,
        result: { ok: true, value },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  await client.start();
  assert.deepEqual(apiMethods, ["settings.describe", "settings.mutate"]);
  assert.deepEqual(FakeWebSocket.sockets.map((socket) => socket.url).sort(), [
    "ws://127.0.0.1:3080/api/events.host",
    "ws://127.0.0.1:3080/api/events.mux",
  ]);
  const event = new Promise((resolveEvent) => client.once("mux", resolveEvent));
  FakeWebSocket.sockets.find((socket) => socket.url.endsWith("events.mux")).frame({
    type: "server-request",
    rpcId: "event-1",
    method: "session/event",
    payload: { type: "session/event", sessionId: "session-1", event: { type: "turn/start" } },
  });
  assert.deepEqual(await event, {
    rpcId: "event-1",
    payload: { type: "session/event", sessionId: "session-1", event: { type: "turn/start" } },
  });
  await client.close();
});

test("DSH event adapter projects text, tools, plans, and lifecycle events", async () => {
  const notifications = [];
  const adapter = new DshEventAdapter({
    sessionId: "s1",
    emit: async (method, params) => { notifications.push({ method, params }); },
  });
  const started = await adapter.handle({ type: "turn/start", seq: 1, time: 1000, data: { turn: 2 } });
  await adapter.handle({
    type: "assistant/chunk",
    seq: 2,
    time: 1001,
    data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "你" } },
  });
  await adapter.handle({
    type: "assistant/message",
    seq: 3,
    time: 1002,
    data: { turn: 2, step: 1, message: { content: [{ type: "reasoning", text: "内部推理" }, { type: "text", text: "你好" }] } },
  });
  await adapter.handle({
    type: "tool/call",
    seq: 4,
    time: 1003,
    data: { callId: "c1", name: "bash", arguments: '{"command":"pwd"}' },
  });
  await adapter.handle({
    type: "tool/result",
    seq: 5,
    time: 1004,
    data: {
      message: {
        source: { callId: "c1" },
        content: [{ type: "tool-result", content: [{ type: "text", text: "/repo" }] }],
      },
    },
  });
  await adapter.handle({ type: "todo/write", seq: 6, time: 1005, data: { todos: [{ content: "验证", status: "completed" }] } });
  const ended = await adapter.handle({ type: "turn/end", seq: 7, time: 1006, data: { reason: { kind: "completed" } } });

  assert.equal(started.kind, "turn-start");
  assert.equal(ended.kind, "turn-end");
  assert.deepEqual(notifications.map((entry) => entry.method), [
    "turn/started",
    "item/agentMessage/delta",
    "item/completed",
    "item/started",
    "item/completed",
    "turn/plan/updated",
  ]);
  assert.equal(notifications[2].params.item.text, "你好");
  assert.equal(notifications[4].params.item.contentItems[0].text, "/repo");
  assert.equal(dshTurnStatus({ kind: "aborted" }), "interrupted");
  assert.equal(dshTurnStatus({ kind: "error" }), "failed");
});

test("DSH event adapter projects successful Office writes into workspace events", async () => {
  const notifications = [];
  const adapter = new DshEventAdapter({
    sessionId: "s-office",
    emit: async (method, params) => { notifications.push({ method, params }); },
  });
  await adapter.handle({ type: "turn/start", seq: 1, data: { turn: 1 } });
  await adapter.handle({
    type: "tool/call",
    seq: 2,
    data: { callId: "office-call", name: "artifact_office_edit", arguments: '{"artifact_id":"artifact-1"}' },
  });
  await adapter.handle({
    type: "tool/result",
    seq: 3,
    data: {
      message: {
        source: { callId: "office-call" },
        content: [{
          type: "tool-result",
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              artifact: {
                id: "artifact-1",
                project_id: "project-1",
                current_version: { source_session_id: "app-session-1" },
              },
            }),
          }],
        }],
      },
    },
  });
  const event = notifications.find((entry) => entry.params?.item?.type === "workspaceEvent");
  assert.equal(event.method, "item/completed");
  assert.equal(event.params.item.data.event, "artifact_edited");
  assert.equal(event.params.item.data.project_id, "project-1");
  assert.equal(event.params.item.data.session_id, "app-session-1");
});

test("DSH event adapter projects a successful Canvas Site edit into the Site workspace", async () => {
  const notifications = [];
  const adapter = new DshEventAdapter({
    sessionId: "s-canvas",
    emit: async (method, params) => { notifications.push({ method, params }); },
  });
  await adapter.handle({ type: "turn/start", seq: 1, data: { turn: 1 } });
  await adapter.handle({
    type: "tool/call",
    seq: 2,
    data: {
      callId: "canvas-call",
      name: "canvas_edit",
      arguments: '{"canvas_id":"canvas-1","base_version_id":"v1","content":"<html></html>"}',
    },
  });
  await adapter.handle({
    type: "tool/result",
    seq: 3,
    data: {
      message: {
        source: { callId: "canvas-call" },
        content: [{
          type: "tool-result",
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              project_id: "project-1",
              canvas: {
                id: "canvas-1",
                kind: "site",
                project_id: "project-1",
                session_id: "app-session-1",
                current_version: { id: "v2" },
              },
            }),
          }],
        }],
      },
    },
  });
  const event = notifications.find((entry) => entry.params?.item?.type === "workspaceEvent");
  assert.equal(event.method, "item/completed");
  assert.equal(event.params.item.data.event, "site_updated");
  assert.equal(event.params.item.data.canvas_id, "canvas-1");
  assert.equal(event.params.item.data.session_id, "app-session-1");
});

test("DSH event adapter projects validated ui_render results into structured UI", async () => {
  const notifications = [];
  const adapter = new DshEventAdapter({
    sessionId: "s-ui",
    emit: async (method, params) => { notifications.push({ method, params }); },
  });
  await adapter.handle({ type: "turn/start", seq: 1, data: { turn: 1 } });
  await adapter.handle({
    type: "tool/call",
    seq: 2,
    data: { callId: "ui-call", name: "ui_render", arguments: '{"surface_id":"status"}' },
  });
  await adapter.handle({
    type: "tool/result",
    seq: 3,
    data: {
      message: {
        source: { callId: "ui-call" },
        content: [{
          type: "tool-result",
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              document_hash: `sha256:${"a".repeat(64)}`,
              generative_ui: {
                schema_version: 1,
                surface_id: "status",
                revision: 1,
                summary: "Ready",
                root: { id: "ready", type: "text", text: "Ready" },
              },
            }),
          }],
        }],
      },
    },
  });
  const item = notifications.find((entry) => entry.params?.item?.type === "generativeUi");
  assert.equal(item.method, "item/completed");
  assert.equal(item.params.item.metadata.surface_id, "status");
  assert.equal(item.params.item.content.root.text, "Ready");
});

class FakeDshClient extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
  }

  async start() {}

  registerProductHostSession() {}

  unregisterProductHostSession() {}

  async request(method, payload) {
    this.calls.push({ method, payload });
    if (method === "workspace.create") return {
      workspace: { workspaceId: "workspace-1", path: payload.path },
      created: true,
    };
    if (method === "session.create") return { sessionId: payload.sessionId || "dsh-session-1" };
    if (method === "session.history") return {
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: -1,
        values: {
          permissions: { options: [], currentValue: "workspace-write" },
          plan: { active: false, pending: false },
        },
      },
    };
    if (method === "command.execute") return { matched: true, commandId: "command-1" };
    if (method === "session.models") return {
      current: { provider: "deepseek", model: "deepseek-chat" },
      groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-chat", name: "DeepSeek Chat", reasoning: { efforts: [{ id: "high", name: "High" }] } }] }],
      failures: [],
    };
    if (method === "session.selectModel") return { selected: payload };
    if (method === "session.prompt") {
      queueMicrotask(() => {
        this.emit("mux", {
          rpcId: "event-1",
          payload: { sessionId: "dsh-session-1", type: "session/event", event: { type: "turn/start", seq: 0, time: 1000, data: { turn: 1 } } },
        });
        this.emit("host", { payload: { sessionId: "dsh-session-1", type: "host/session-status", running: true } });
        this.emit("mux", {
          rpcId: "event-2",
          payload: {
            sessionId: "dsh-session-1",
            type: "session/event",
            event: { type: "assistant/message", seq: 1, time: 1001, data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "来自 DSH" }] } } },
          },
        });
        this.emit("mux", {
          rpcId: "event-3",
          payload: { sessionId: "dsh-session-1", type: "session/event", event: { type: "turn/end", seq: 2, time: 1002, data: { turn: 1, reason: { kind: "completed" } } } },
        });
        this.emit("host", { payload: { sessionId: "dsh-session-1", type: "host/session-status", running: false } });
      });
      return { accepted: true };
    }
    if (method === "session.cancel") return { accepted: true };
    throw new Error(`unexpected method ${method}`);
  }
}

test("DSH turn policy leaves permission ownership in the logged session projection", () => {
  assert.equal(effectiveDshPlanMode({ active: false, pending: true }), true);
  assert.equal(effectiveDshPlanMode({ active: true, pending: true }), false);
  assert.deepEqual(dshPolicyCommands({
    values: {
      permissions: { currentValue: "workspace-write" },
      plan: { active: false, pending: false },
    },
  }, { settings: { collaborationMode: "plan" } }), [
    "/plan",
  ]);
  assert.deepEqual(dshPolicyCommands({
    values: {
      permissions: { currentValue: "workspace-write" },
      plan: { active: false, pending: true },
    },
  }, { settings: { collaborationMode: "plan" } }), []);
  assert.throws(() => dshPolicyCommands(null, {}), { code: "DSH_POLICY_PROJECTIONS_MISSING" });
});

test("DSH model resolution preserves the exact provider when model ids overlap", () => {
  const catalog = {
    current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    groups: [
      {
        id: "deepseek-official",
        models: [{ id: "shared-model", name: "DeepSeek Shared" }],
      },
      {
        id: "acme-gateway",
        models: [{ id: "shared-model", name: "Acme Shared" }],
      },
    ],
  };

  assert.deepEqual(resolveDshModelTarget(
    catalog,
    encodeDshModelRoute("acme-gateway", "shared-model"),
  ), {
    group: catalog.groups[1],
    candidate: catalog.groups[1].models[0],
    listed: true,
  });
});

test("DSH model resolution rejects old App model ids instead of guessing", () => {
  const catalog = {
    current: { provider: "deepseek-official", model: "deepseek-v4-flash" },
    groups: [{
      id: "deepseek-official",
      models: [{ id: "deepseek-v4-flash", name: "DeepSeek-V4-Flash" }],
    }],
  };
  assert.throws(
    () => resolveDshModelTarget(catalog, "legacy-app-row"),
    { code: "DSH_MODEL_ROUTE_INVALID" },
  );
});

test("DSH host model events invalidate renderer snapshots without carrying settings values", () => {
  resetDshModelSettingsEventsForTests();
  const events = [];
  const unsubscribe = subscribeDshModelSettingsEvents((event) => events.push(event));
  assert.equal(publishDshModelSettingsChanged({ type: "host/session-status", running: true }), null);
  publishDshModelSettingsChanged({ type: "host/settings-changed", ns: "llm-deepseek" });
  publishDshModelSettingsChanged({ type: "host/credentials-changed", ref: "DEEPSEEK_API_KEY" });
  publishDshModelSettingsChanged({ type: "host/models-changed" });
  unsubscribe();

  assert.deepEqual(events.map((event) => ({
    type: event.type,
    reason: event.payload.reason,
    ns: event.payload.ns,
    ref: event.payload.ref,
  })), [
    { type: "dsh_models.changed", reason: "host/settings-changed", ns: "llm-deepseek", ref: null },
    { type: "dsh_models.changed", reason: "host/credentials-changed", ns: null, ref: "DEEPSEEK_API_KEY" },
    { type: "dsh_models.changed", reason: "host/models-changed", ns: null, ref: null },
  ]);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("DSH workspace runtime persists a binding and completes on ApiProxy idle", async () => {
  const client = new FakeDshClient();
  const notifications = [];
  let storedConfig = "{}";
  const db = {
    queryOne: async () => ({ session_config: storedConfig }),
    query: async (_sql, values) => { storedConfig = values[0]; },
  };
  const runtime = new DshWorkspaceRuntime({ client });
  const result = await runtime.execute({
    cwd: "/repo",
    streamCallback: async () => {},
    agentContext: {
      session_id: "app-session",
      db,
      directRuntimeNotifications: true,
      input_data: { turn_input: [{ type: "text", text: "你好" }] },
      onRuntimeNotification: (method, params) => notifications.push({ method, params }),
    },
  });

  assert.deepEqual(result, { success: true, status: "completed", thread_id: "dsh-session-1" });
  assert.equal(JSON.parse(storedConfig).runtime_backend, "dsh");
  assert.equal(JSON.parse(storedConfig).dsh_runtime_session_id, "dsh-session-1");
  assert.equal(client.calls.find((call) => call.method === "session.prompt").payload.content[0].text, "你好");
  assert.deepEqual(notifications.map((entry) => entry.method), ["turn/started", "item/completed", "turn/completed"]);
  assert.equal(notifications[1].params.item.text, "来自 DSH");
  assert.deepEqual(await runtime.cancel(), { accepted: true });
  assert.equal(client.calls.at(-1).method, "session.cancel");
});

test("DSH workspace runtime sends validated images through the rc.2 prompt contract", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-workspace-image-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const imagePath = join(dir, "screen.png");
  await writeFile(imagePath, ONE_PIXEL_PNG);
  const client = new FakeDshClient();
  const db = {
    queryOne: async () => ({ session_config: "{}" }),
    query: async () => {},
  };
  const runtime = new DshWorkspaceRuntime({ client });
  await runtime.execute({
    cwd: dir,
    streamCallback: async () => {},
    agentContext: {
      session_id: "app-session",
      db,
      directRuntimeNotifications: true,
      input_data: {
        turn_input: [{ type: "text", text: "读取截图" }, {
          type: "localImage",
          path: imagePath,
          mediaType: "image/png",
          name: "screen.png",
          sizeBytes: ONE_PIXEL_PNG.length,
          sha256: createHash("sha256").update(ONE_PIXEL_PNG).digest("hex"),
        }],
      },
      onRuntimeNotification: () => {},
    },
  });
  const prompt = client.calls.find((call) => call.method === "session.prompt");
  assert.deepEqual(prompt.payload.content[1], {
    type: "image",
    mediaType: "image/png",
    data: ONE_PIXEL_PNG.toString("base64"),
    name: "screen.png",
  });
});

test("DSH workspace runtime applies plan mode without rewriting the session permission preset", async () => {
  const client = new FakeDshClient();
  let storedConfig = "{}";
  const db = {
    queryOne: async () => ({ session_config: storedConfig }),
    query: async (_sql, values) => { storedConfig = values[0]; },
  };
  const runtime = new DshWorkspaceRuntime({ client });
  await runtime.execute({
    cwd: "/repo",
    streamCallback: async () => {},
    agentContext: {
      session_id: "app-session",
      db,
      settings: { collaborationMode: "plan" },
      directRuntimeNotifications: true,
      input_data: { turn_input: [{ type: "text", text: "执行" }] },
      onRuntimeNotification: () => {},
    },
  });
  const commands = client.calls.filter((call) => call.method === "command.execute");
  assert.deepEqual(commands.map((call) => call.payload.line), [
    "/plan",
  ]);
  const prompt = client.calls.find((call) => call.method === "session.prompt");
  assert.equal(prompt.payload.content[0].text, "执行");
});

test("DSH workspace runtime selects the exact provider route and reasoning effort", async () => {
  const client = new FakeDshClient();
  let storedConfig = "{}";
  const db = {
    queryOne: async () => ({ id: "app-session", project_id: "p1", created_by: "u1", session_config: storedConfig }),
    query: async (_sql, values) => { storedConfig = values[0]; },
  };
  const runtime = new DshWorkspaceRuntime({ client });
  await runtime.execute({
    cwd: "/repo",
    streamCallback: async () => {},
    agentContext: {
      session_id: "app-session",
      project_id: "p1",
      user_id: "u1",
      db,
      directRuntimeNotifications: true,
      settings: { modelId: encodeDshModelRoute("deepseek", "deepseek-chat"), reasoningEffort: "high" },
      input_data: { turn_input: [{ type: "text", text: "hello" }] },
      onRuntimeNotification: () => {},
    },
  });
  const selected = client.calls.find((call) => call.method === "session.selectModel");
  assert.deepEqual(selected.payload, {
    sessionId: "dsh-session-1",
    provider: "deepseek",
    model: "deepseek-chat",
    reasoningEffort: "high",
  });
});

test("DSH model options do not invent a modality that rc.2 omits from its catalog", () => {
  const [option] = dshModelOptions({
    groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }] }],
  });
  assert.equal(option.capabilities.supports_image_input, undefined);
});

test("DSH workspace runtime rejects an incompatible persisted session without splitting history", async () => {
  const client = new FakeDshClient();
  const unregistered = [];
  client.unregisterProductHostSession = (sessionId) => { unregistered.push(sessionId); };
  client.request = async (method, payload) => {
    client.calls.push({ method, payload });
    if (method === "workspace.create") return {
      workspace: { workspaceId: "workspace-1", path: payload.path },
      created: false,
    };
    if (method === "session.create") {
      if (payload.sessionId) {
        const error = new Error("conflict");
        error.code = "session-conflict";
        throw error;
      }
      return { sessionId: "replacement-dsh" };
    }
    if (method === "session.history") return {
      events: [],
      hasMore: false,
      projections: {
        asOfSeq: -1,
        values: {
          permissions: { options: [], currentValue: "workspace-write" },
          plan: { active: false, pending: false },
        },
      },
    };
    if (method === "session.prompt") return { command: { text: "recovered" } };
    throw new Error(`unexpected method ${method}`);
  };
  let storedConfig = JSON.stringify({ dsh_runtime_session_id: "persisted-dsh", dsh_runtime_cwd: "/repo" });
  const db = {
    queryOne: async () => ({
      id: "app-session",
      project_id: "p1",
      created_by: "u1",
      session_config: storedConfig,
    }),
    query: async (_sql, values) => { storedConfig = values[0]; },
  };
  const runtime = new DshWorkspaceRuntime({ client });
  await assert.rejects(runtime.execute({
    cwd: "/repo",
    streamCallback: async () => {},
    agentContext: { session_id: "app-session", db, input_data: { turn_input: [{ type: "text", text: "hello" }] } },
  }), (error) => error?.code === "DSH_SESSION_CWD_MISMATCH");
  const createCalls = client.calls.filter((call) => call.method === "session.create");
  assert.equal(createCalls.length, 1);
  assert.equal(createCalls[0].payload.sessionId, "persisted-dsh");
  assert.equal(JSON.parse(storedConfig).dsh_runtime_session_id, "persisted-dsh");
  assert.deepEqual(unregistered, []);
});

test("DshRuntimeClient close() sets closing flag and prevents restart scheduling", async () => {
  const client = new DshRuntimeClient({ env: { ...process.env, DSH_RUNTIME_DISTRIBUTION: "source" } });
  const fakeChild = new EventEmitter();
  fakeChild.connected = true;
  fakeChild.send = (msg, cb) => {
    if (msg?.type === "shutdown") {
      queueMicrotask(() => {
        fakeChild.connected = false;
        fakeChild.emit("exit", 0, null);
      });
    }
    cb?.();
  };
  fakeChild.kill = () => {};
  fakeChild.disconnect = () => { fakeChild.connected = false; };
  client.child = fakeChild;

  await client.close();
  assert.equal(client.closing, true, "closing flag set by close()");
  assert.equal(client.restartTimer, null, "no restart timer after deliberate close");
  assert.equal(client.restartAttempt, 0, "no restart attempts recorded");
});

test("real current DSH Web Profile serves client slots and its text prompt wire", {
  timeout: 120_000,
  skip: DSH_RUNTIME_VERSION === DSH_NPM_VERSION
    ? false
    : `source checkout ${DSH_RUNTIME_VERSION || "missing"} does not match app-pinned ${DSH_NPM_VERSION}`,
}, async () => {
  const runtimeHome = await mkdtemp(resolve(tmpdir(), "dsh-work-product-context-"));
  const client = new DshRuntimeClient({
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "",
      DSH_RUNTIME_DISTRIBUTION: "source",
      DSH_SOURCE_ROOT,
      DSH_RUNTIME_HOME: runtimeHome,
      DSH_RUNTIME_ENV_DIR: runtimeHome,
      DSH_TELEMETRY_DISABLED: "1",
    },
  });
  const sessionId = "current-dsh-real-smoke";
  try {
    await client.start();
    const sourceDistribution = resolveDshRuntimeDistribution({
      env: { DSH_RUNTIME_DISTRIBUTION: "source", DSH_SOURCE_ROOT },
    });
    const profileApi = await import(pathToFileURL(sourceDistribution.appBootPath).href);
    const profile = profileApi.loadProfile(
      "dsh-work-test",
      "web",
      join(DSH_SOURCE_ROOT, "apps", "cli", "package.json"),
      runtimeHome,
    );
    assert.equal(profile.layers.at(-1).packageName, "@deepseek-ai/dsh-work-shell");
    const profileRows = profileApi.composeEntries([
      profile.layers.flatMap((layer) => layer.patches),
      profile.patches,
    ]);
    for (const id of ["product-bridge"]) {
      assert.equal(profileRows.filter((row) => row.id === id).length, 1, `${id} must mount once through Profile`);
    }
    assert.equal(profileRows.find((row) => row.id === "web-runtime")?.name, "@deepseek-ai/dsh-web-app");
    assert.equal(profileRows.find((row) => row.id === "dsh-work-shell")?.name, "@deepseek-ai/dsh-work-shell");
    assert.equal(profileRows.some((row) => row.id === "product-client"), false);
    assert.equal(profileRows.some((row) => row.id === "turn-navigator"), false);
    const surface = await client.waitForClientSurface();
    const providers = await client.request("llm.providers", {});
    assert.ok(providers.providers.some((provider) => provider.provider === "deepseek-official"));
    const catalog = await client.request("llm.models", {});
    assert.ok(catalog.groups.some((group) => group.id === "deepseek-official"));
    const settings = await client.request("settings.describe", {});
    assert.equal(settings.writable, true);
    const deepseekSettings = settings.namespaces.find((namespace) => namespace.ns === "llm-deepseek");
    assert.ok(deepseekSettings, "the Web Profile exposes its DeepSeek settings namespace");
    const changedSettings = await client.request("settings.mutate", {
      ns: "llm-deepseek",
      ops: [{ op: "set", path: ["reasoningEffort"], value: "high" }],
      expectedRevision: deepseekSettings.revision,
    });
    assert.equal(changedSettings.value.reasoningEffort, "high");
    const credentialRef = "DSH_WORK_TEST_MODEL_KEY";
    await client.request("credentials.set", { ref: credentialRef, value: "test-secret" });
    const credentialState = await client.request("credentials.describe", { refs: [credentialRef] });
    assert.deepEqual(credentialState.credentials[credentialRef], {
      configured: true,
      source: "file",
      writable: true,
    });
    assert.equal(JSON.stringify(credentialState).includes("test-secret"), false);
    await client.request("credentials.unset", { ref: credentialRef });
    const clientHtml = await fetch(surface).then((response) => {
      assert.equal(response.ok, true);
      return response.text();
    });
    assert.doesNotMatch(clientHtml, /\/plugins\/@deepseek-ai\/dsh-product-client\/client\.js\?rev=/);
    assert.doesNotMatch(clientHtml, /\/plugins\/@deepseek-ai\/dsh-turn-navigator\/client\.js\?rev=/);
    await client.request("session.create", { sessionId, cwd: runtimeHome });
    const skillCatalog = await client.request("skill.list", { sessionId });
    assert.ok(Array.isArray(skillCatalog.skills), "the compatibility composer reads the DSH-native Skill catalog");
    assert.deepEqual(await client.request("session.prompt", {
      sessionId,
      mode: "queue",
      content: [{ type: "text", text: "describe the current workspace" }],
    }), { accepted: true });
  } finally {
    await client.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});

test("real app-pinned DSH npm package boots through its public CLI entry", {
  timeout: 120_000,
  skip: existsSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../server/node_modules/@deepseek-ai/dsh/lib/bin.js"))
    ? false
    : "missing app-pinned DSH CLI",
}, async () => {
  const runtimeHome = await mkdtemp(resolve(tmpdir(), "dsh-app-npm-cli-"));
  const client = new DshRuntimeClient({
    env: {
      ...process.env,
      DEEPSEEK_API_KEY: "",
      DSH_RUNTIME_DISTRIBUTION: "npm",
      DSH_RUNTIME_HOME: runtimeHome,
      DSH_RUNTIME_ENV_DIR: runtimeHome,
      DSH_TELEMETRY_DISABLED: "1",
    },
  });
  const sessionId = "app-pinned-image-admission-smoke";
  try {
    const ready = new Promise((resolveReady) => client.once("ready", resolveReady));
    await client.start();
    assert.equal((await ready).version, DSH_NPM_VERSION);
    const manifest = JSON.parse(readFileSync(join(runtimeHome, "profiles", "web", "package.json"), "utf8"));
    assert.equal(manifest.dsh.profile.bundles.at(-1), "@deepseek-ai/dsh-work-shell");
    assert.equal(manifest.dsh.profile.bundles.includes("@deepseek-ai/dsh-product-bridge"), true);
    assert.equal(manifest.dsh.profile.bundles.includes("@deepseek-ai/dsh-theme-pack"), true);
    assert.equal(manifest.dsh.profile.bundles.includes("@deepseek-ai/dsh-product-client"), false);
    assert.equal(manifest.dsh.profile.bundles.includes("@deepseek-ai/dsh-turn-navigator"), false);
    const described = await client.request("host.describe", {});
    assert.equal(typeof described.version, "string");
    const settings = await client.request("settings.describe", {});
    const themeSettings = settings.namespaces.find((namespace) => namespace.ns === "ui-theme");
    assert.equal(themeSettings.value.preference, "dark");
    assert.equal(themeSettings.user.preference, "dark");
    const surface = await client.waitForClientSurface();
    const html = await fetch(surface).then((response) => response.text());
    assert.match(html, /\/plugins\/@deepseek-ai\/dsh-work-shell\/client\.js\?rev=/);
    assert.match(html, /const preference = "dark"/);
    assert.doesNotMatch(html, /\/plugins\/@deepseek-ai\/dsh-product-client\/client\.js\?rev=/);
    assert.doesNotMatch(html, /\/plugins\/@deepseek-ai\/dsh-turn-navigator\/client\.js\?rev=/);
    await client.request("session.create", { sessionId, cwd: runtimeHome });
    await assert.rejects(
      client.request("session.prompt", {
        sessionId,
        mode: "queue",
        content: [{
          type: "image",
          mediaType: "image/png",
          data: ONE_PIXEL_PNG.toString("base64"),
          name: "screen.png",
        }],
      }),
      (error) => error?.code === "attachment-error"
        && error?.details?.reason === "MODEL_DOES_NOT_SUPPORT_IMAGES",
    );
    const history = await client.request("session.history", { sessionId });
    assert.equal(history.events.some((event) => event.type === "user/message"), false);
  } finally {
    await client.close();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
