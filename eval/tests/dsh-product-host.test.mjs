// Tests for the dsh-app product_host_dispatcher: method whitelist, userId
// injection (never from the child payload), result-size cap, and the
// session-binding lifecycle (persistent per-Session bind, addressed removal),
// concurrent routing, and status-only capability snapshots.
//
// These tests inject a mock listProjects through overrideServices so no real
// database is touched.

import test from "node:test";
import assert from "node:assert/strict";
import {
  createSessionProductHostDispatcher,
  createProductHostDispatcher,
  nullProductHostDispatcher,
  overrideServices,
} from "../../server/src/engine/dsh_runtime/product_host_dispatcher.js";
import {
  createDshWorkProductTools,
  createDshWorkInstructionMessage,
  createDshWorkMemoryMessage,
  createCanvasProductTools,
  createOfficeProductTools,
  createPresentationProductTools,
  sendRuntimeParentMessage,
} from "../../packages/dsh-product-bridge/src/index.js";

const emptyDb = { query() {}, queryOne() {}, transaction() {} };

test("product bridge IPC treats parent shutdown as a normal lifecycle edge", () => {
  const messages = [];
  const errors = [];
  const connected = {
    connected: true,
    send(message, callback) {
      messages.push(message);
      callback(Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" }));
    },
  };
  assert.equal(sendRuntimeParentMessage(
    connected,
    { type: "client-ready" },
    (error) => errors.push(error.code),
  ), true);
  assert.deepEqual(messages, [{ type: "client-ready" }]);
  assert.deepEqual(errors, ["ERR_IPC_CHANNEL_CLOSED"]);
  assert.equal(sendRuntimeParentMessage({ connected: false }, { type: "ready" }), false);
});

function bindSession(dispatcher, overrides = {}) {
  return dispatcher.bind({
    db: emptyDb,
    dshSessionId: "dsh-s1",
    appSessionId: "app-s1",
    userId: "u1",
    projectId: "p1",
    ...overrides,
  });
}

test("session dispatcher rejects an unknown DSH session", async () => {
  const dispatcher = createSessionProductHostDispatcher();
  const reply = await dispatcher.handle({ id: "r1", sessionId: "missing", method: "projectList", payload: {} });
  assert.equal(reply.type, "product-response");
  assert.equal(reply.id, "r1");
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.error.code, "product-unavailable");
});

test("session dispatcher rejects an unknown method even when bound", async () => {
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher);
  const reply = await dispatcher.handle({ id: "r2", sessionId: "dsh-s1", method: "evilMethod", payload: {} });
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.error.code, "product-rejected");
});

test("removed project Plugin capabilities return an empty Profile-era snapshot", async () => {
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher);
  const snapshot = await dispatcher.handle({
    id: "profile-snapshot",
    sessionId: "dsh-s1",
    method: "capabilitySnapshot",
    payload: {},
  });
  const skills = await dispatcher.handle({
    id: "profile-skills",
    sessionId: "dsh-s1",
    method: "skillList",
    payload: {},
  });
  assert.deepEqual(snapshot.result.value.plugins, []);
  assert.equal(snapshot.result.value.bridge.skills, "not-bridged");
  assert.deepEqual(skills.result.value.items, []);
  await dispatcher.dispose();
});

test("session dispatcher forwards projectList with the bound userId (never from payload)", async () => {
  let capturedCtx = null;
  let capturedInput = null;
  const previous = overrideServices({
    listProjects: async (ctx, input) => {
      capturedCtx = ctx;
      capturedInput = input;
      return { data: { items: [{ id: 1, name: "Alpha" }, { id: 2, name: "Beta" }], total: 2 }, message: "ok" };
    },
  });
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher, { userId: "user-42" });
  // The child's payload must NOT carry a userId; the dispatcher derives it.
  const reply = await dispatcher.handle({ id: "r3", sessionId: "dsh-s1", method: "projectList", payload: { search: "alp" } });
  overrideServices(previous);

  assert.equal(capturedCtx.userId, "user-42", "userId comes from the binding, not the payload");
  assert.equal(capturedInput.query.search, "alp");
  assert.equal(reply.result.ok, true);
  assert.equal(reply.result.value.total, 2);
  assert.equal(reply.result.value.items[0].id, "1");
  assert.equal(reply.result.value.items[0].name, "Alpha");
  assert.equal(reply.result.value.truncated, false);
});

test("session dispatcher caps the result at 200 items and marks it truncated", async () => {
  const many = Array.from({ length: 250 }, (_, i) => ({ id: i, name: `P${i}` }));
  const previous = overrideServices({
    listProjects: async () => ({ data: { items: many, total: 250 }, message: "ok" }),
  });
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher);
  const reply = await dispatcher.handle({ id: "r4", sessionId: "dsh-s1", method: "projectList", payload: {} });
  overrideServices(previous);

  assert.equal(reply.result.value.items.length, 200);
  assert.equal(reply.result.value.truncated, true);
  assert.equal(reply.result.value.total, 250);
});

test("session dispatcher maps a handler throw to product-unavailable", async () => {
  const previous = overrideServices({
    listProjects: async () => { throw new Error("db down"); },
  });
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher);
  const reply = await dispatcher.handle({ id: "r5", sessionId: "dsh-s1", method: "projectList", payload: {} });
  overrideServices(previous);

  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.error.code, "product-unavailable");
  assert.match(reply.result.error.message, /db down/);
});

test("clear() removes only the addressed DSH session binding", async () => {
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher);
  bindSession(dispatcher, { dshSessionId: "dsh-s2", appSessionId: "app-s2" });
  dispatcher.clear("dsh-s1");
  const reply = await dispatcher.handle({ id: "r6", sessionId: "dsh-s1", method: "projectList", payload: {} });
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.error.code, "product-unavailable");
  const retained = await dispatcher.handle({ id: "r6b", sessionId: "dsh-s2", method: "evilMethod", payload: {} });
  assert.equal(retained.result.error.code, "product-rejected");
});

test("createProductHostDispatcher (static binding) forwards projectList", async () => {
  const previous = overrideServices({
    listProjects: async () => ({ data: { items: [{ id: 7, name: "Gamma" }], total: 1 }, message: "ok" }),
  });
  const dispatcher = createProductHostDispatcher({ db: emptyDb, resolveUserId: () => "static-user" });
  const reply = await dispatcher.handle({ id: "r7", sessionId: "dsh-static", method: "projectList", payload: {} });
  overrideServices(previous);

  assert.equal(reply.result.ok, true);
  assert.equal(reply.result.value.items[0].id, "7");
});

test("nullProductHostDispatcher rejects every call", async () => {
  const reply = await nullProductHostDispatcher.handle({ id: "r8", sessionId: "dsh-s1", method: "projectList", payload: {} });
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.error.code, "product-unavailable");
});

test("session dispatcher forwards conversationList with projectId from binding", async () => {
  let capturedPid = null;
  const previous = overrideServices({
    listAgentSessions: async (ctx, input) => {
      capturedPid = input.params.pid;
      return { data: { sessions: [{ id: "c1", title: "Chat 1" }, { id: "c2", title: "Archived", status: "archived" }] } };
    },
  });
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher, { projectId: "proj-42" });
  const reply = await dispatcher.handle({ id: "r9", sessionId: "dsh-s1", method: "conversationList", payload: { archived: true } });
  overrideServices(previous);

  assert.equal(capturedPid, "proj-42", "projectId from binding");
  assert.equal(reply.result.ok, true);
  assert.equal(reply.result.value.items.length, 2);
  assert.equal(reply.result.value.items[0].id, "c1");
  assert.equal(reply.result.value.items[1].archived, true);
});

test("conversationMemory returns parent-selected global memory without accepting identity from the child", async () => {
  let captured = null;
  const previous = overrideServices({
    loadGlobalChatMemory: async (input) => {
      captured = input;
      return {
        text: "<saved_memories>结论优先</saved_memories>",
        entries: [{ id: "memory-1", content: "结论优先" }],
        sources: [{ session_id: "source-1", title: "发布计划", messages: [{ role: "user", text: "周四上线" }] }],
      };
    },
  });
  const db = {
    query() {},
    queryOne: async () => ({ action_type: "agentic_chat", session_config: "{}" }),
    transaction() {},
  };
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher, {
    db,
    projectId: "__chat__",
    appSessionId: "app-memory",
    userId: "memory-user",
  });
  try {
    const reply = await dispatcher.handle({
      id: "memory-request",
      sessionId: "dsh-s1",
      method: "conversationMemory",
      payload: { query: "海王星发布计划", userId: "forged-user" },
    });
    assert.equal(reply.result.ok, true);
    assert.equal(captured.userId, "memory-user");
    assert.equal(captured.currentSessionId, "app-memory");
    assert.equal(reply.result.value.presentation.type, "global_memory");
    assert.equal(reply.result.value.presentation.content.entries[0].content, "结论优先");
  } finally {
    overrideServices(previous);
    await dispatcher.dispose();
  }
});

test("the product bridge creates one immutable DSH recall message with presentation provenance", () => {
  const message = createDshWorkMemoryMessage({
    text: "<saved_memories>结论优先</saved_memories>",
    presentation: { type: "global_memory", content: { entries: [{ id: "m1", content: "结论优先" }], conversations: [] } },
  });
  assert.equal(message.role, "user");
  assert.deepEqual(message.source, {
    kind: "plugin",
    plugin: "dsh-work-memory",
    form: "recall",
    dshWorkMemory: { type: "global_memory", content: { entries: [{ id: "m1", content: "结论优先" }], conversations: [] } },
  });
  assert.equal(message.content[0].text.includes("saved_memories"), true);
  assert.equal(Object.isFrozen(message), true);
  assert.equal(createDshWorkMemoryMessage({ text: "", presentation: null }), null);
});

test("the product bridge logs parent-owned instructions with explicit scope provenance", () => {
  const message = createDshWorkInstructionMessage({
    instructions: {
      text: "## Application instructions\n\n先给结论。",
      scopes: { application: true, project: false, temporary: true },
    },
  });
  assert.equal(message.role, "user");
  assert.deepEqual(message.source, {
    kind: "plugin",
    plugin: "dsh-work-context",
    form: "instructions",
    dshWorkInstructions: { application: true, project: false, temporary: true },
  });
  assert.match(message.content[0].text, /Application instructions/);
  assert.equal(Object.isFrozen(message), true);
  assert.equal(createDshWorkInstructionMessage({ instructions: { text: "", scopes: {} } }), null);
});

test("session dispatcher rejects conversationList without projectId binding", async () => {
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher, { projectId: null });
  const reply = await dispatcher.handle({ id: "r10", sessionId: "dsh-s1", method: "conversationList", payload: {} });
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.error.code, "product-unavailable");
});

test("office inspect stays inside the bound project and removes UI preview SVG from the model result", async () => {
  let captured = null;
  const previous = overrideServices({
    inspectProjectOfficeArtifact: async (ctx, input) => {
      captured = { ctx, input };
      return {
        artifact: { id: input.artifactId },
        version: { id: "v2" },
        document: {
          format: "pptx",
          sections: [{ anchor: "slide:1", text: "Title", preview_svg: "<svg>large preview</svg>" }],
        },
      };
    },
  });
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher, { userId: "office-user", projectId: "office-project" });
  try {
    const reply = await dispatcher.handle({
      id: "office-inspect",
      sessionId: "dsh-s1",
      method: "artifactOfficeInspect",
      payload: { artifact_id: "artifact-1" },
    });
    assert.equal(reply.result.ok, true);
    assert.equal(captured.ctx.userId, "office-user");
    assert.equal(captured.input.projectId, "office-project");
    assert.equal(reply.result.value.document.sections[0].anchor, "slide:1");
    assert.equal(Object.hasOwn(reply.result.value.document.sections[0], "preview_svg"), false);

    const rejected = await dispatcher.handle({
      id: "office-wrong-project",
      sessionId: "dsh-s1",
      method: "artifactOfficeInspect",
      payload: { project_id: "other-project", artifact_id: "artifact-1" },
    });
    assert.equal(rejected.result.ok, false);
    assert.equal(rejected.result.error.code, "product-rejected");
  } finally {
    overrideServices(previous);
    await dispatcher.dispose();
  }
});

test("office create and edit use the parent-bound user, project, and App Session", async () => {
  const calls = [];
  const previous = overrideServices({
    createProjectOfficeArtifact: async (ctx, input) => {
      calls.push({ kind: "create", ctx, input });
      return { artifact: { id: "created", current_version: { id: "v1" } } };
    },
    editProjectOfficeArtifact: async (ctx, input) => {
      calls.push({ kind: "edit", ctx, input });
      return { artifact: { id: input.artifactId, current_version: { id: "v2" } } };
    },
  });
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher, {
    userId: "office-user",
    projectId: "office-project",
    appSessionId: "app-office-session",
  });
  try {
    const created = await dispatcher.handle({
      id: "office-create",
      sessionId: "dsh-s1",
      method: "artifactOfficeCreate",
      payload: { format: "pptx", title: "Launch" },
    });
    const edited = await dispatcher.handle({
      id: "office-edit",
      sessionId: "dsh-s1",
      method: "artifactOfficeEdit",
      payload: {
        artifact_id: "created",
        base_version_id: "v1",
        operations: [{ type: "replace_text", anchor: "slide:1:title", text: "Ready" }],
      },
    });
    assert.equal(created.result.ok, true);
    assert.equal(edited.result.ok, true);
    assert.deepEqual(calls.map((call) => call.kind), ["create", "edit"]);
    assert.ok(calls.every((call) => call.ctx.userId === "office-user"));
    assert.ok(calls.every((call) => call.input.projectId === "office-project"));
    assert.ok(calls.every((call) => call.input.source.sessionId === "app-office-session"));
  } finally {
    overrideServices(previous);
    await dispatcher.dispose();
  }
});

test("the DSH product bridge registers scoped office tools with native tool results", async () => {
  const calls = [];
  const productHost = {
    async request(sessionId, method, payload, signal) {
      calls.push({ sessionId, method, payload, signal });
      return { success: true, artifact: { id: "artifact-1" } };
    },
  };
  const agent = { session: { id: "dsh-office-session" } };
  const tools = createOfficeProductTools(productHost, agent);
  assert.deepEqual(
    new Set(tools.keys()),
    new Set(["artifact_office_inspect", "artifact_office_create", "artifact_office_edit"]),
  );
  assert.deepEqual(tools.get("artifact_office_edit").definition.parameters.required, [
    "artifact_id",
    "base_version_id",
    "operations",
  ]);
  const signal = new AbortController().signal;
  const value = await tools.get("artifact_office_inspect").definition.execute(
    { artifact_id: "artifact-1" },
    { agent, signal },
  );
  assert.equal(value.success, true);
  assert.deepEqual(calls[0], {
    sessionId: "dsh-office-session",
    method: "artifactOfficeInspect",
    payload: { artifact_id: "artifact-1" },
    signal,
  });
  assert.equal(
    tools.get("artifact_office_inspect").definition.output.render({}, value)[0].text,
    JSON.stringify(value),
  );
});

test("Canvas tools use the parent-bound App Session and project", async () => {
  const calls = [];
  const canvas = {
    id: "canvas-1",
    session_id: "app-canvas-session",
    project_id: "canvas-project",
    kind: "document",
    current_version: { id: "canvas-v2" },
  };
  const previous = overrideServices({
    getCanvas: async (ctx, input) => {
      calls.push({ kind: "inspect", ctx, input });
      return canvas;
    },
    createCanvas: async (ctx, input) => {
      calls.push({ kind: "create", ctx, input });
      return { canvas: { ...canvas, current_version: { id: "canvas-v1" } }, created: true };
    },
    editCanvas: async (ctx, input) => {
      calls.push({ kind: "edit", ctx, input });
      return { canvas, version: canvas.current_version };
    },
    createCanvasSuggestion: async (ctx, input) => {
      calls.push({ kind: "suggest", ctx, input });
      return { id: "suggestion-1", canvas_id: input.canvasId, status: "pending" };
    },
  });
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher, {
    userId: "canvas-user",
    projectId: "canvas-project",
    appSessionId: "app-canvas-session",
  });
  try {
    const inspected = await dispatcher.handle({
      id: "canvas-inspect",
      sessionId: "dsh-s1",
      method: "canvasInspect",
      payload: { canvas_id: "canvas-1" },
    });
    const created = await dispatcher.handle({
      id: "canvas-create",
      sessionId: "dsh-s1",
      method: "canvasCreate",
      payload: { kind: "document", content: "First" },
    });
    const edited = await dispatcher.handle({
      id: "canvas-edit",
      sessionId: "dsh-s1",
      method: "canvasEdit",
      payload: { canvas_id: "canvas-1", base_version_id: "canvas-v1", content: "Second" },
    });
    const suggested = await dispatcher.handle({
      id: "canvas-suggest",
      sessionId: "dsh-s1",
      method: "canvasSuggest",
      payload: {
        canvas_id: "canvas-1",
        base_version_id: "canvas-v2",
        start: 0,
        end: 6,
        selected_text: "Second",
        replacement_text: "Ready",
      },
    });
    assert.ok([inspected, created, edited, suggested].every((reply) => reply.result.ok === true));
    assert.deepEqual(calls.map((call) => call.kind), ["inspect", "create", "edit", "suggest", "inspect"]);
    assert.ok(calls.every((call) => call.ctx.userId === "canvas-user"));
    assert.ok(calls.every((call) => call.input.sessionId === "app-canvas-session"));
    assert.equal(calls[1].input.metadata.created_by, "canvas_create");
    assert.equal(calls[2].input.metadata.edited_by, "canvas_edit");
    assert.equal(suggested.result.value.suggestion.id, "suggestion-1");
  } finally {
    overrideServices(previous);
    await dispatcher.dispose();
  }
});

test("the DSH product bridge registers Canvas and local Site tools", async () => {
  const calls = [];
  const productHost = {
    async request(sessionId, method, payload, signal) {
      calls.push({ sessionId, method, payload, signal });
      return { success: true, canvas: { id: "canvas-1" } };
    },
  };
  const agent = { session: { id: "dsh-canvas-session" } };
  const tools = createCanvasProductTools(productHost, agent);
  assert.deepEqual(new Set(tools.keys()), new Set([
    "canvas_inspect",
    "canvas_create",
    "canvas_edit",
    "canvas_suggest",
  ]));
  assert.deepEqual(tools.get("canvas_suggest").definition.parameters.required, [
    "canvas_id",
    "base_version_id",
    "start",
    "end",
    "selected_text",
    "replacement_text",
  ]);
  const signal = new AbortController().signal;
  await tools.get("canvas_inspect").definition.execute(
    { canvas_id: "canvas-1" },
    { agent, signal },
  );
  assert.deepEqual(calls[0], {
    sessionId: "dsh-canvas-session",
    method: "canvasInspect",
    payload: { canvas_id: "canvas-1" },
    signal,
  });
});

test("ui_render is validated by the bound parent and registered in the DSH Agent scope", async () => {
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher, {
    userId: "ui-user",
    projectId: "ui-project",
    appSessionId: "app-ui-session",
  });
  const document = {
    schema_version: 1,
    surface_id: "release-status",
    revision: 1,
    title: "Release status",
    summary: "Two checks passed",
    root: {
      id: "status",
      type: "metric",
      label: "Checks",
      value: "2/2",
    },
  };
  try {
    const rendered = await dispatcher.handle({
      id: "ui-render",
      sessionId: "dsh-s1",
      method: "uiRender",
      payload: document,
    });
    assert.equal(rendered.result.ok, true);
    assert.equal(rendered.result.value.project_id, "ui-project");
    assert.equal(rendered.result.value.session_id, "app-ui-session");
    assert.equal(rendered.result.value.generative_ui.surface_id, "release-status");
    assert.match(rendered.result.value.document_hash, /^sha256:[a-f0-9]{64}$/);

    const rejected = await dispatcher.handle({
      id: "ui-render-invalid",
      sessionId: "dsh-s1",
      method: "uiRender",
      payload: { ...document, root: { id: "bad", type: "script" } },
    });
    assert.equal(rejected.result.ok, false);
    assert.match(rejected.result.error.message, /must be one of|unsupported|unknown node type/i);
  } finally {
    await dispatcher.dispose();
  }

  const calls = [];
  const productHost = {
    async request(sessionId, method, payload) {
      calls.push({ sessionId, method, payload });
      return { success: true, generative_ui: payload };
    },
  };
  const agent = { session: { id: "dsh-ui-session" } };
  const tools = createPresentationProductTools(productHost, agent);
  assert.deepEqual([...tools.keys()], ["ui_render"]);
  assert.deepEqual(tools.get("ui_render").definition.parameters.required, [
    "schema_version",
    "surface_id",
    "revision",
    "summary",
    "root",
  ]);
  await tools.get("ui_render").definition.execute(document, { agent });
  assert.deepEqual(calls[0], { sessionId: "dsh-ui-session", method: "uiRender", payload: document });
});

test("the DSH product bridge owns project tools removed from the current SDK", async () => {
  const calls = [];
  const productHost = {
    async request(sessionId, method, payload) {
      calls.push({ sessionId, method, payload });
      return { items: [] };
    },
  };
  const agent = { session: { id: "dsh-project-session" } };
  const tools = createDshWorkProductTools(productHost, agent);
  assert.deepEqual(new Set(tools.keys()), new Set([
    "project_list",
    "conversation_list",
    "artifact_office_inspect",
    "artifact_office_create",
    "artifact_office_edit",
    "canvas_inspect",
    "canvas_create",
    "canvas_edit",
    "canvas_suggest",
    "ui_render",
  ]));
  await tools.get("project_list").definition.execute({ search: "alpha" }, { agent });
  await tools.get("conversation_list").definition.execute({ archived: true }, { agent });
  assert.deepEqual(calls, [{
    sessionId: "dsh-project-session",
    method: "projectList",
    payload: { search: "alpha" },
  }, {
    sessionId: "dsh-project-session",
    method: "conversationList",
    payload: { archived: true },
  }]);
});

test("session dispatcher routes concurrent DSH sessions to separate identities", async () => {
  const previous = overrideServices({
    listProjects: async (ctx) => ({ data: { items: [{ id: ctx.userId, name: ctx.userId }], total: 1 } }),
  });
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher, { dshSessionId: "dsh-s1", appSessionId: "app-s1", userId: "u1" });
  bindSession(dispatcher, { dshSessionId: "dsh-s2", appSessionId: "app-s2", userId: "u2" });
  const [one, two] = await Promise.all([
    dispatcher.handle({ id: "r11", sessionId: "dsh-s1", method: "projectList", payload: {} }),
    dispatcher.handle({ id: "r12", sessionId: "dsh-s2", method: "projectList", payload: {} }),
  ]);
  overrideServices(previous);
  assert.equal(one.result.value.items[0].id, "u1");
  assert.equal(two.result.value.items[0].id, "u2");
});

test("session dispatcher rejects identity changes for an existing DSH session", () => {
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher);
  assert.throws(
    () => bindSession(dispatcher, { appSessionId: "other-app", userId: "other-user" }),
    (error) => error?.code === "DSH_PRODUCT_HOST_IDENTITY_CONFLICT",
  );
});

test("session dispatcher rejects requests without a DSH sessionId", async () => {
  const dispatcher = createSessionProductHostDispatcher();
  bindSession(dispatcher);
  const reply = await dispatcher.handle({ id: "r13", method: "projectList", payload: {} });
  assert.equal(reply.result.ok, false);
  assert.equal(reply.result.error.code, "product-rejected");
});
