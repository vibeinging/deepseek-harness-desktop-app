import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentStreamAdapter } from "../../server/src/engine/agent_kernel/stream_adapter.js";
import { createDynamicToolBridge } from "../../server/src/engine/agent_kernel/dynamic_tools.js";
import { ToolRegistry } from "../../server/src/engine/agent_host/tool_registry.js";
import { createProductTools } from "../../server/src/engine/agents/product_tools.js";
import { PRODUCT_TOOL_NAMES } from "../../server/src/engine/agents/product_tool_catalog.js";
import { resolveWorkspaceToolExposure } from "../../server/src/engine/agents/workspace_tool_exposure.js";
import { createAgentStreamEmitter } from "../../server/src/engine/stream/agent_stream_emitter.js";
import {
  authorizeGenerativeUiHostResult,
  hashGenerativeUiDocument,
} from "../../server/src/engine/agents/generative_ui_schema.js";

function uiDocument({ surfaceId = "sales", revision = 1, summary = `销售界面版本 ${revision}`, root = null } = {}) {
  return {
    schema_version: 1,
    surface_id: surfaceId,
    revision,
    title: "销售概览",
    summary,
    root: root || { id: `root-${surfaceId}-${revision}`, type: "text", text: summary },
  };
}

function productContext(generativeUi) {
  return {
    generativeUi,
    db: { query: async () => [], queryOne: async () => null },
  };
}

function completedUiCall(id, hostResult, overrides = {}) {
  return {
    id,
    type: "dynamicToolCall",
    tool: "ui_render",
    arguments: hostResult?.details?.generative_ui || {},
    status: "completed",
    success: hostResult?.isError !== true && hostResult?.details?.success !== false,
    contentItems: [{ type: "inputText", text: "界面已展示" }],
    hostResult,
    ...overrides,
  };
}

test("ui_render is capability-gated, fail-closed, and changes the native Thread tool revision", async () => {
  assert.equal(PRODUCT_TOOL_NAMES.has("ui_render"), true);
  const disabledContext = productContext(false);
  const enabledContext = productContext(true);
  const disabledTools = createProductTools(disabledContext);
  const enabledTools = createProductTools(enabledContext);
  assert.equal(disabledTools.some((tool) => tool.name === "ui_render"), false);
  const uiTool = enabledTools.find((tool) => tool.name === "ui_render");
  assert.ok(uiTool);
  assert.ok(uiTool.parameters.required.includes("summary"));
  assert.equal(uiTool.side_effect, "read");

  enabledContext.generativeUi = false;
  const staleThreadCall = await uiTool.execute("ui-stale", uiDocument());
  assert.equal(staleThreadCall.isError, true);
  assert.equal(staleThreadCall.details.error_code, "UI_CAPABILITY_UNAVAILABLE");
  assert.equal(staleThreadCall.details.path, "$");

  assert.equal(
    resolveWorkspaceToolExposure({ name: "ui_render", exposure: "deferred" }, { apiFormat: "chat_completions" }),
    "direct",
  );
  assert.equal(
    resolveWorkspaceToolExposure({ name: "ui_render", exposure: "deferred" }, { apiFormat: "responses" }),
    "deferred",
  );
});

test("ui_render returns a short model-facing result and keeps the full validated Document in Host details", async () => {
  const tool = createProductTools(productContext(true)).find((candidate) => candidate.name === "ui_render");
  const input = uiDocument({ summary: "销售额增长 8%。" });

  const result = await tool.execute("ui-1", input);

  assert.equal(result.details.success, true);
  assert.deepEqual(result.details.generative_ui, input);
  assert.match(result.content[0].text, /继续用普通文本给出简短结论/);
  assert.equal(result.content[0].text.includes(JSON.stringify(input.root)), false);
  assert.equal(result.details.generative_ui_stats.node_count, 1);
  assert.equal(result.details.generative_ui_projection.mode, "emit");
  assert.equal(result.details.generative_ui_projection.item_id, "ui-1:generative-ui");
  assert.equal(result.details.generative_ui_projection.document_hash, hashGenerativeUiDocument(input));

  const invalid = await tool.execute("ui-invalid", { ...input, summary: undefined });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.details.error_code, "GENERATIVE_UI_SCHEMA_INVALID");
  assert.equal(invalid.details.path, "$.summary");
  assert.equal(Object.hasOwn(invalid.details, "generative_ui"), false);
});

test("ui_render and stream projection apply the same workspace-root check to local images", async () => {
  const root = await mkdtemp(join(tmpdir(), "generative-ui-tool-"));
  try {
    const imagePath = join(root, "chart.png");
    await writeFile(imagePath, "png");
    const context = { ...productContext(true), generativeUiWorkspaceRoots: [root] };
    const tool = createProductTools(context).find((candidate) => candidate.name === "ui_render");
    const result = await tool.execute("local-image", uiDocument({
      root: { id: "root-image", type: "image", src: imagePath, alt: "本地图" },
    }));
    assert.equal(result.details.success, true);
    assert.match(result.details.generative_ui.root.src, /^dsh-file:\/\/local\//);

    const rejectedChunks = [];
    const rootlessAdapter = new AgentStreamAdapter({
      generativeUiEnabled: true,
      streamCallback: async (content, options) => rejectedChunks.push({ content, options }),
    });
    await rootlessAdapter.handle("item/completed", {
      item: completedUiCall("local-image", result),
    });
    assert.equal(rejectedChunks.some((entry) => entry.options.content_type === "generative_ui"), false);

    const acceptedChunks = [];
    const rootedAdapter = new AgentStreamAdapter({
      generativeUiEnabled: true,
      allowedLocalRoots: [root],
      streamCallback: async (content, options) => acceptedChunks.push({ content, options }),
    });
    await rootedAdapter.handle("item/completed", {
      item: completedUiCall("local-image", result),
    });
    assert.equal(acceptedChunks.some((entry) => entry.options.content_type === "generative_ui"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AgentStreamAdapter emits immutable Generative UI revisions with summary fallback and a document hash", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    generativeUiEnabled: true,
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  const tool = createProductTools(productContext(true)).find((candidate) => candidate.name === "ui_render");
  const first = uiDocument({ revision: 1, summary: "第一版摘要" });
  const second = uiDocument({ revision: 2, summary: "第二版摘要" });
  const stale = uiDocument({ revision: 1, summary: "过期摘要" });
  const firstResult = await tool.execute("call-1", first);
  const secondResult = await tool.execute("call-2", second);
  const staleResult = await tool.execute("call-3", stale);

  assert.equal(staleResult.isError, true);
  assert.equal(staleResult.details.error_code, "UI_REVISION_STALE");
  await adapter.handle("item/completed", { item: completedUiCall("call-1", firstResult) });
  await adapter.handle("item/completed", { item: completedUiCall("call-2", secondResult) });
  await adapter.handle("item/completed", { item: completedUiCall("call-3", staleResult, { status: "failed" }) });

  const uiChunks = chunks.filter((entry) => entry.options.content_type === "generative_ui");
  assert.equal(uiChunks.length, 2);
  assert.equal(uiChunks[0].content, "第一版摘要");
  assert.equal(uiChunks[0].options.content_id, "call-1:generative-ui");
  assert.equal(uiChunks[0].options.replaces_item_id, null);
  assert.equal(uiChunks[1].options.content_id, "call-2:generative-ui");
  assert.equal(uiChunks[1].options.replaces_item_id, "call-1:generative-ui");
  assert.deepEqual(uiChunks[1].options.generative_ui.document, second);
  assert.equal(uiChunks[1].options.generative_ui.document_hash, hashGenerativeUiDocument(second));
  assert.equal(chunks.filter((entry) => entry.options.content_type === "tool").length, 3);
});

test("ui_render makes identical revisions idempotent and reports conflicts before projection", async () => {
  const context = productContext(true);
  const tool = createProductTools(context).find((candidate) => candidate.name === "ui_render");
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    generativeUiEnabled: true,
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  const first = uiDocument({ summary: "稳定摘要" });
  const firstResult = await tool.execute("idempotent-1", first);
  const duplicateResult = await tool.execute("idempotent-2", structuredClone(first));
  const conflictResult = await tool.execute("idempotent-3", {
    ...first,
    summary: "同版本的不同内容",
  });

  assert.equal(firstResult.details.generative_ui_projection.mode, "emit");
  assert.equal(duplicateResult.isError, undefined);
  assert.equal(duplicateResult.details.success, true);
  assert.equal(duplicateResult.details.generative_ui_projection.mode, "noop");
  assert.equal(duplicateResult.details.generative_ui_projection.item_id, "idempotent-1:generative-ui");
  assert.equal(conflictResult.isError, true);
  assert.equal(conflictResult.details.error_code, "UI_REVISION_CONFLICT");

  await adapter.handle("item/completed", { item: completedUiCall("idempotent-1", firstResult) });
  await adapter.handle("item/completed", { item: completedUiCall("idempotent-2", duplicateResult) });
  await adapter.handle("item/completed", {
    item: completedUiCall("idempotent-3", conflictResult, { status: "failed" }),
  });
  assert.equal(chunks.filter((entry) => entry.options.content_type === "generative_ui").length, 1);
});

test("ui_render reports the per-Turn resource limit instead of silently dropping projection", async () => {
  const tool = createProductTools(productContext(true)).find((candidate) => candidate.name === "ui_render");
  for (let index = 0; index < 8; index += 1) {
    const result = await tool.execute(`limited-${index}`, uiDocument({
      surfaceId: `surface-${index}`,
      summary: `界面 ${index}`,
    }));
    assert.equal(result.details.success, true);
    assert.equal(result.details.generative_ui_projection.mode, "emit");
  }
  const limited = await tool.execute("limited-8", uiDocument({
    surfaceId: "surface-8",
    summary: "第九个界面",
  }));
  assert.equal(limited.isError, true);
  assert.equal(limited.details.error_code, "GENERATIVE_UI_RESOURCE_LIMIT");
  assert.equal(limited.details.path, "$");
});

test("AgentStreamAdapter only projects an enabled, authorized ui_render Host result", async () => {
  const chunks = [];
  const adapter = new AgentStreamAdapter({
    generativeUiEnabled: true,
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  const tool = createProductTools(productContext(true)).find((candidate) => candidate.name === "ui_render");
  const trustedDocument = uiDocument({ surfaceId: "trusted", summary: "可信界面" });
  const bridge = createDynamicToolBridge({ tools: [tool] });
  const bridgeResponse = await bridge.handleCall({
    callId: "trusted",
    tool: "ui_render",
    arguments: trustedDocument,
  });
  assert.equal(bridgeResponse.success, true);
  const trustedResult = bridge.takeHostResult("trusted");
  assert.ok(trustedResult);

  const untrustedArguments = uiDocument({ surfaceId: "arguments-only", summary: "不能从参数恢复" });
  await adapter.handle("item/completed", {
    item: completedUiCall("arguments-only", undefined, { arguments: untrustedArguments }),
  });
  const forgedResult = {
    details: {
      success: true,
      generative_ui: trustedDocument,
      generative_ui_projection: trustedResult.details.generative_ui_projection,
    },
  };
  await adapter.handle("item/completed", {
    item: completedUiCall("trusted", forgedResult),
  });
  const rejectedResult = authorizeGenerativeUiHostResult({
    details: {
      success: false,
      generative_ui: trustedDocument,
      generative_ui_projection: trustedResult.details.generative_ui_projection,
    },
  });
  await adapter.handle("item/completed", {
    item: completedUiCall("trusted", rejectedResult, { success: true }),
  });
  await adapter.handle("item/completed", {
    item: completedUiCall("trusted", trustedResult, { tool: "plugin_render" }),
  });
  await adapter.handle("item/completed", {
    item: completedUiCall("trusted", trustedResult, { name: "plugin_render" }),
  });
  const disabledAdapter = new AgentStreamAdapter({
    generativeUiEnabled: false,
    streamCallback: async (content, options) => chunks.push({ content, options }),
  });
  await disabledAdapter.handle("item/completed", { item: completedUiCall("trusted", trustedResult) });
  assert.equal(chunks.some((entry) => entry.options.content_type === "generative_ui"), false);

  await adapter.handle("item/completed", { item: completedUiCall("trusted", trustedResult) });
  assert.equal(chunks.filter((entry) => entry.options.content_type === "generative_ui").length, 1);
});

test("Generative UI persistence keeps only the summary in content and the full Document in metadata", () => {
  const events = [];
  const stream = createAgentStreamEmitter({
    emit: (event) => events.push(event),
    turnId: "turn-ui",
    threadId: "thread-ui",
    messageId: "assistant-ui",
  });
  const document = uiDocument({ revision: 2, summary: "旧客户端只显示这段摘要" });
  const documentHash = hashGenerativeUiDocument(document);

  stream.content(document.summary, {
    content_id: "ui-item-2",
    content_type: "generative_ui",
    title: document.title,
    result_role: "deliverable",
    surface_id: document.surface_id,
    revision: document.revision,
    replaces_item_id: "ui-item-1",
    generative_ui: { document, document_hash: documentHash },
  });

  const completed = events.find((event) => event.type === "item/completed");
  assert.equal(completed.payload.item.type, "generativeUi");
  assert.equal(completed.payload.item.content, document.summary);
  assert.deepEqual(completed.payload.item.metadata.generative_ui.document, document);
  assert.equal(completed.payload.item.metadata.generative_ui.document_hash, documentHash);
  assert.equal(completed.payload.item.metadata.replaces_item_id, "ui-item-1");
  const persisted = stream.persistedItems.get("ui-item-2");
  assert.equal(persisted.type, "generative_ui");
  assert.equal(persisted.content, document.summary);
  assert.deepEqual(persisted.metadata.generative_ui.document, document);
  assert.equal(persisted.metadata.item_type, "generativeUi");
});
