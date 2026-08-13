import test from "node:test";
import assert from "node:assert/strict";
import { AgentStreamAdapter } from "../../server/src/engine/agent_kernel/stream_adapter.js";

test("Agent stream adapter converts App Server message deltas to Dsh snapshots", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({ streamCallback: async (content, options) => chunks.push({ content, options }) });
  await adapter.handle("item/started", { item: { id: "m1", type: "agentMessage", text: "", phase: "final_answer" } });
  await adapter.handle("item/agentMessage/delta", { itemId: "m1", delta: "答案" });
  await adapter.handle("item/agentMessage/delta", { itemId: "m1", delta: "是 42" });
  assert.equal(chunks[1].content, "答案是 42");
  assert.equal(chunks[1].options.title, undefined);
  assert.equal(chunks[1].options.phase, "final_answer");
});

test("Agent stream adapter keeps native Codex memory citations separate", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  const memoryCitation = {
    path: "/tmp/codex-memory.md",
    lineStart: 12,
    lineEnd: 14,
    note: "项目发布约定",
    sourceThreadId: "thread-source",
  };
  await adapter.handle("item/completed", {
    item: {
      id: "m-memory",
      type: "agentMessage",
      text: "周四发布。",
      phase: "final_answer",
      memoryCitation,
    },
  });

  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].options.phase, "final_answer");
  assert.deepEqual(chunks[0].options.memory_citation, memoryCitation);
});

test("Agent stream adapter converts dynamic tool lifecycle", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({ streamCallback: async (content, options) => chunks.push({ content, options }) });
  await adapter.handle("item/started", {
    item: { id: "tool-1", type: "dynamicToolCall", tool: "query_data", arguments: { question: "收入" } },
  });
  await adapter.handle("item/completed", {
    item: {
      id: "tool-1",
      type: "dynamicToolCall",
      tool: "query_data",
      arguments: { question: "收入" },
      contentItems: [{ type: "inputText", text: "42" }],
      success: true,
      status: "completed",
    },
  });
  assert.equal(chunks[0].options.title, "running");
  assert.equal(chunks[1].options.title, "done");
  assert.equal(chunks[1].options.trace_output, "42");
});

test("Agent stream adapter persists native fileChange as a dedicated block", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({ streamCallback: async (content, options) => chunks.push({ content, options }) });
  const started = {
    id: "change-1",
    type: "fileChange",
    status: "inProgress",
    changes: [{ path: "README.md", kind: "update", diff: "-old\n+new" }],
  };
  await adapter.handle("item/started", { item: started });
  await adapter.handle("item/completed", { item: { ...started, status: "completed" } });

  assert.deepEqual(chunks.map(({ options }) => [options.content_type, options.title]), [
    ["file_change", "running"],
    ["file_change", "done"],
  ]);
  assert.deepEqual(JSON.parse(chunks[1].content).changes, started.changes);
});

test("Agent stream adapter persists automatic context compaction lifecycle", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  const item = { id: "compact-1", type: "contextCompaction" };
  await adapter.handle("item/started", { threadId: "thread-1", turnId: "turn-1", item });
  await adapter.handle("item/completed", { threadId: "thread-1", turnId: "turn-1", item });
  assert.deepEqual(chunks.map(({ content, options }) => ({
    content,
    type: options.content_type,
    title: options.title,
    trigger: options.trigger,
  })), [
    { content: "", type: "compact", title: "running", trigger: "auto" },
    { content: "上下文已自动压缩", type: "compact", title: "done", trigger: "auto" },
  ]);
});

test("Agent stream adapter persists the latest native update_plan state", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  const plan = [
    { step: "检查目录", status: "completed" },
    { step: "汇总发现", status: "inProgress" },
    { step: "给出建议", status: "pending" },
  ];
  await adapter.handle("turn/plan/updated", {
    turnId: "turn-plan-1",
    plan,
    explanation: "保留未完成状态",
  });
  const updatedPlan = [
    { step: "检查目录", status: "completed" },
    { step: "汇总发现", status: "completed" },
    { step: "给出建议", status: "inProgress" },
  ];
  await adapter.handle("turn/plan/updated", {
    turnId: "turn-plan-1",
    plan: updatedPlan,
    explanation: "替换最新状态",
  });

  assert.equal(chunks.length, 2);
  assert.deepEqual(JSON.parse(chunks[0].content), plan);
  assert.deepEqual(chunks[0].options, {
    content_id: "plan:turn-plan-1",
    content_type: "plan",
    title: "已更新计划",
    explanation: "保留未完成状态",
    source: "app-server",
  });
  assert.deepEqual(JSON.parse(chunks[1].content), updatedPlan);
  assert.equal(chunks[1].options.content_id, "plan:turn-plan-1");
  assert.equal(chunks[1].options.explanation, "替换最新状态");
});

test("Agent stream adapter persists native Codex collaboration items", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  const started = {
    id: "collab-1",
    type: "collabAgentToolCall",
    tool: "spawnAgent",
    status: "inProgress",
    senderThreadId: "parent-1",
    receiverThreadIds: ["child-1"],
    prompt: "检查测试覆盖",
    model: null,
    reasoningEffort: null,
    agentsStates: { "child-1": { status: "running", message: null } },
  };
  await adapter.handle("item/started", { item: started });
  await adapter.handle("item/completed", {
    item: {
      ...started,
      status: "completed",
      agentsStates: { "child-1": { status: "completed", message: "没有发现缺口" } },
    },
  });

  assert.deepEqual(chunks.map(({ options }) => [options.content_type, options.title]), [
    ["delegated_subtask", "running"],
    ["delegated_subtask", "done"],
  ]);
  const payload = JSON.parse(chunks[1].content);
  assert.equal(payload.source, "app-server");
  assert.equal(payload.tool, "spawnAgent");
  assert.deepEqual(payload.child_thread_ids, ["child-1"]);
  assert.equal(payload.summary, "没有发现缺口");
});

test("Agent stream adapter only renders UI declared by a mounted Plugin", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
    pluginTools: [{ name: "document_prepare", plugin_name: "document-tools" }],
    uiContributions: [{
      slot: "conversation.renderer",
      plugin_name: "document-tools",
      component: "html-document",
      artifact_type: "pdf-document",
    }],
  });
  await adapter.handle("item/completed", {
    item: {
      id: "pdf-tool-1",
      type: "dynamicToolCall",
      tool: "document_prepare",
      arguments: { title: "季度报告" },
      status: "completed",
      contentItems: [{ type: "inputText", text: "已生成季度报告" }],
      success: true,
      hostResult: {
        details: {
          output_artifact: {
            type: "pdf-document",
            format: "application/pdf",
            materialization: "client-download",
          },
          ui_content: {
            renderer: "html-document",
            artifact_type: "pdf-document",
            title: "季度报告",
            content: "<html><body>42</body></html>",
          },
        },
      },
    },
  });

  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].options.content_type, "html");
  assert.equal(chunks[1].options.plugin_name, "document-tools");
  assert.equal(chunks[1].options.artifact_type, "pdf-document");
  assert.equal(chunks[1].options.result_role, "deliverable");
  assert.deepEqual(chunks[1].options.output_artifact, {
    type: "pdf-document",
    format: "application/pdf",
    materialization: "client-download",
    actions: ["download"],
  });
});

test("Agent stream adapter emits native image and audio result blocks", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  await adapter.handle("item/completed", {
    item: {
      id: "media-tool-1",
      type: "dynamicToolCall",
      tool: "create_media",
      status: "completed",
      success: true,
      contentItems: [
        { type: "inputText", text: "done" },
        { type: "inputImage", imageUrl: "data:image/png;base64,aW1hZ2U=" },
        { type: "inputAudio", audioUrl: "data:audio/mpeg;base64,YXVkaW8=" },
      ],
      hostResult: {
        details: {
          path: "/tmp/generated.png",
          output_delivery: { role: "deliverable", surface: "both", kind: "image", path: "/tmp/generated.png" },
        },
      },
    },
  });
  assert.deepEqual(chunks.map((entry) => entry.options.content_type), ["tool", "image", "audio"]);
  assert.equal(chunks[1].options.source_tool_call_id, "media-tool-1");
  assert.equal(chunks[1].options.result_role, "deliverable");
  assert.equal(chunks[1].options.saved_path, "/tmp/generated.png");
  assert.deepEqual(chunks[1].options.output_delivery.actions, ["reveal", "copy"]);
  assert.equal(chunks[2].content, "data:audio/mpeg;base64,YXVkaW8=");
});

test("Agent stream adapter emits a first-class file card for workspace deliverables", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  await adapter.handle("item/completed", {
    item: {
      id: "office-tool-1",
      type: "dynamicToolCall",
      tool: "artifact_office_create",
      status: "completed",
      success: true,
      contentItems: [{ type: "inputText", text: "已生成" }],
      hostResult: { details: {
        output_delivery: { role: "deliverable", surface: "workspace", persistence: "library", kind: "document" },
        artifact: {
          id: "artifact-1",
          name: "季度报告.docx",
          kind: "document",
          current_version: {
            id: "version-1",
            version_number: 1,
            snapshot_path: "/tmp/季度报告.docx",
            mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            size_bytes: 42,
          },
        },
      } },
    },
  });

  assert.deepEqual(chunks.map((entry) => entry.options.content_type), ["tool", "file"]);
  assert.equal(chunks[1].options.result_role, "deliverable");
  assert.equal(JSON.parse(chunks[1].content).artifact_id, "artifact-1");
  assert.deepEqual(chunks[1].options.output_delivery.actions, ["open", "reveal"]);
});

test("Agent stream adapter persists every Codex 0.147 native visual lifecycle", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });

  await adapter.handle("item/started", {
    item: { id: "search-1", type: "webSearch", status: "inProgress", query: "OpenAI" },
  });
  await adapter.handle("item/completed", {
    item: { id: "search-1", type: "webSearch", status: "completed", query: "OpenAI", results: [{ title: "OpenAI" }] },
  });
  await adapter.handle("item/completed", {
    item: { id: "view-1", type: "imageView", path: "/tmp/view.png" },
  });
  await adapter.handle("item/started", {
    item: { id: "image-1", type: "imageGeneration", status: "inProgress" },
  });
  await adapter.handle("item/completed", {
    item: { id: "image-1", type: "imageGeneration", status: "completed", result: "aW1hZ2U=" },
  });
  await adapter.handle("item/started", {
    item: { id: "sleep-1", type: "sleep", status: "inProgress", durationMs: 25 },
  });
  await adapter.handle("item/completed", {
    item: { id: "sleep-1", type: "sleep", status: "completed", durationMs: 25 },
  });
  await adapter.handle("item/completed", {
    item: { id: "review-in", type: "enteredReviewMode", review: "检查当前修改" },
  });
  await adapter.handle("item/completed", {
    item: { id: "review-out", type: "exitedReviewMode", review: "审查结束" },
  });

  assert.deepEqual(chunks.map(({ options }) => [options.content_type, options.title]), [
    ["tool", "running"],
    ["tool", "done"],
    ["image", "查看图片"],
    ["status", "running"],
    ["image", "生成的图片"],
    ["status", "running"],
    ["status", "done"],
    ["status", "开始审查"],
    ["status", "结束审查"],
  ]);
  assert.equal(chunks[1].options.trace_output, JSON.stringify([{ title: "OpenAI" }]));
  assert.equal(chunks[4].content, "data:image/png;base64,aW1hZ2U=");
  assert.equal(chunks[3].options.replace_snapshot, true);
  assert.equal(chunks[4].options.replace_snapshot, true);
});

test("Agent stream adapter keeps declined and interrupted terminal states distinct", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  await adapter.handle("item/completed", {
    item: { id: "command-declined", type: "commandExecution", command: "pwd", status: "declined" },
  });
  await adapter.handle("item/completed", {
    item: { id: "change-stopped", type: "fileChange", status: "interrupted", changes: [] },
  });
  await adapter.handle("item/completed", {
    item: {
      id: "collab-stopped",
      type: "collabAgentToolCall",
      tool: "spawnAgent",
      status: "interrupted",
      receiverThreadIds: ["child-1"],
      agentsStates: { "child-1": { status: "interrupted", message: "已停止" } },
    },
  });

  assert.deepEqual(chunks.map(({ options }) => options.title), ["rejected", "stopped", "stopped"]);
  assert.equal(JSON.parse(chunks[2].content).status, "interrupted");
});

test("Agent stream adapter ignores undeclared Plugin UI", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
    pluginTools: [{ name: "document_prepare", plugin_name: "document-tools" }],
    uiContributions: [],
  });
  await adapter.handle("item/completed", {
    item: {
      id: "pdf-tool-2",
      type: "dynamicToolCall",
      tool: "document_prepare",
      status: "completed",
      contentItems: [{ type: "inputText", text: "已生成报告" }],
      success: true,
      hostResult: { details: { ui_content: {
        renderer: "html-document",
        artifact_type: "pdf-document",
        content: "<html></html>",
      } } },
    },
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].options.content_type, "tool");
});

test("Agent stream adapter can project only Plugin UI on the direct runtime path", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => chunks.push({ content, options }),
    pluginTools: [{ name: "document_prepare", plugin_name: "document-tools" }],
    uiContributions: [{
      slot: "conversation.renderer",
      plugin_name: "document-tools",
      component: "html-document",
      artifact_type: "pdf-document",
    }],
  });
  await adapter.handlePluginUi("item/completed", {
    item: {
      id: "pdf-tool-direct",
      type: "dynamicToolCall",
      tool: "document_prepare",
      status: "completed",
      contentItems: [{ type: "inputText", text: "已生成报告" }],
      success: true,
      hostResult: { details: { ui_content: {
        renderer: "html-document",
        artifact_type: "pdf-document",
        title: "直通报告",
        content: "<html><body>direct</body></html>",
      } } },
    },
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].options.content_type, "html");
});
