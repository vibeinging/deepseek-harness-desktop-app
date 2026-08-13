import { nativeCollaborationItemPayload } from "./native_collaboration.js";
import { artifactActionsFor, normalizeArtifactActions } from "../agents/artifact_actions.js";
import {
  hashGenerativeUiDocument,
  isAuthorizedGenerativeUiHostResult,
  parseGenerativeUiDocument,
} from "../agents/generative_ui_schema.js";

function itemId(params = {}) {
  return params.itemId || params.item?.id || null;
}

function messagePhase(...values) {
  for (const value of values) {
    const phase = String(value || "").trim();
    if (phase === "commentary" || phase === "final_answer") return phase;
  }
  return null;
}

function toolOutput(item = {}) {
  if (Array.isArray(item.contentItems)) {
    return item.contentItems.map((content) => {
      if (content?.type === "inputText") return String(content.text || "");
      if (content?.type === "inputImage") return String(content.imageUrl || content.image_url || "");
      if (content?.type === "inputAudio") return String(content.audioUrl || content.audio_url || "");
      try { return JSON.stringify(content); } catch { return String(content || ""); }
    }).filter(Boolean).join("\n");
  }
  const value = item.result ?? item.output ?? item.aggregatedOutput ?? item.results ?? item.content ?? null;
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function toolArguments(item = {}) {
  const value = item.arguments ?? item.command ?? item.input ?? null;
  if (typeof value === "string") return value;
  if (value == null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}

function lifecycleTitle(item = {}) {
  const status = String(item.status || "").toLowerCase();
  if (status === "failed" || status === "error" || status === "errored" || item.success === false) return "error";
  if (status === "declined" || status === "rejected") return "rejected";
  if (["interrupted", "cancelled", "canceled", "stopped"].includes(status)) return "stopped";
  if (["inprogress", "in_progress", "running", "pendinginit"].includes(status)) return "running";
  return "done";
}

function collaborationTitle(status) {
  if (status === "failed") return "error";
  if (status === "interrupted") return "stopped";
  if (status === "running") return "running";
  return "done";
}

function imageGenerationContent(item = {}) {
  const value = String(item.result || "");
  if (!value) return "";
  return value.startsWith("data:") || value.startsWith("http://") || value.startsWith("https://")
    ? value
    : `data:image/png;base64,${value}`;
}

const TRUSTED_PLUGIN_RENDERERS = Object.freeze({
  "html-document": "html",
});

function objectValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function toolResultDetails(item = {}) {
  const hostResult = objectValue(item.hostResult);
  if (hostResult) return objectValue(hostResult.details) || hostResult;
  const contentResult = (Array.isArray(item.contentItems) ? item.contentItems : [])
    .filter((content) => content?.type === "inputText")
    .map((content) => objectValue(content.text))
    .find(Boolean);
  if (contentResult) return objectValue(contentResult.details) || contentResult;
  const result = objectValue(item.result ?? item.output ?? item.aggregatedOutput ?? item.content);
  if (!result) return null;
  return objectValue(result.details) || result;
}

function deliveryWithActions(delivery, fallback = {}) {
  const value = objectValue(delivery);
  const input = {
    kind: value?.kind || fallback.kind,
    path: value?.path || fallback.path,
    materialization: value?.materialization || fallback.materialization,
  };
  if (!value) return { ...fallback, ...input, actions: artifactActionsFor(input) };
  return {
    ...fallback,
    ...value,
    actions: normalizeArtifactActions(value.actions, input),
  };
}

export class AgentStreamAdapter {
  constructor({
    streamCallback,
    pluginTools = [],
    uiContributions = [],
    generativeUiEnabled = false,
    allowedLocalRoots = [],
  } = {}) {
    if (typeof streamCallback !== "function") throw new TypeError("AgentStreamAdapter 需要 streamCallback");
    this.streamCallback = streamCallback;
    this.text = new Map();
    this.items = new Map();
    this.pluginByTool = new Map((pluginTools || []).map((tool) => [tool.name, tool.plugin_name]).filter((item) => item[0] && item[1]));
    this.uiContributions = Array.isArray(uiContributions) ? uiContributions : [];
    this.generativeUiEnabled = generativeUiEnabled;
    this.allowedLocalRoots = allowedLocalRoots;
  }

  async emitGenerativeUi(item) {
    const declaredNames = [item?.tool, item?.name].map((value) => String(value || "").trim()).filter(Boolean);
    if (!declaredNames.length || declaredNames.some((name) => name !== "ui_render")) return;
    let enabled = false;
    try {
      enabled = (typeof this.generativeUiEnabled === "function"
        ? this.generativeUiEnabled()
        : this.generativeUiEnabled) === true;
    } catch {
      enabled = false;
    }
    if (!enabled) return;
    const hostResult = objectValue(item?.hostResult);
    if (!isAuthorizedGenerativeUiHostResult(hostResult)) return;
    const details = objectValue(hostResult.details);
    if (details?.success !== true) return;
    const projection = objectValue(details.generative_ui_projection);
    if (projection?.mode === "noop") return;
    if (projection?.mode !== "emit") return;
    const input = objectValue(details.generative_ui);
    if (!input) return;
    let document;
    try {
      const workspaceRoots = typeof this.allowedLocalRoots === "function"
        ? this.allowedLocalRoots()
        : this.allowedLocalRoots;
      ({ document } = parseGenerativeUiDocument(input, {
        allowedLocalRoots: Array.isArray(workspaceRoots) ? workspaceRoots : [],
      }));
    } catch {
      return;
    }
    const contentId = String(projection.item_id || "");
    if (!contentId || contentId !== `${item.id}:generative-ui`) return;
    const documentHash = hashGenerativeUiDocument(document);
    if (projection.document_hash !== documentHash) return;
    const replacesItemId = projection.replaces_item_id == null
      ? null
      : String(projection.replaces_item_id);
    if (replacesItemId === contentId) return;
    await this.streamCallback(document.summary, {
      content_id: contentId,
      content_type: "generative_ui",
      title: document.title || "生成式界面",
      source_tool_call_id: item.id,
      result_role: "deliverable",
      surface_id: document.surface_id,
      revision: document.revision,
      replaces_item_id: replacesItemId,
      generative_ui: {
        document,
        document_hash: documentHash,
      },
    });
  }

  async emitPluginUi(item) {
    const toolName = item.tool || item.name || "";
    const pluginName = this.pluginByTool.get(toolName);
    if (!pluginName) return;
    const details = toolResultDetails(item);
    const ui = objectValue(details?.ui_content);
    const outputArtifact = objectValue(details?.output_artifact);
    const renderer = String(ui?.renderer || "");
    const artifactType = String(ui?.artifact_type || "");
    const contentType = TRUSTED_PLUGIN_RENDERERS[renderer];
    if (!(contentType && artifactType && typeof ui?.content === "string")) return;
    const allowed = this.uiContributions.some((contribution) => (
      contribution?.slot === "conversation.renderer"
      && contribution?.plugin_name === pluginName
      && contribution?.component === renderer
      && contribution?.artifact_type === artifactType
    ));
    if (!allowed) return;
    await this.streamCallback(ui.content, {
      content_id: `${item.id}:plugin-ui`,
      content_type: contentType,
      title: String(ui.title || artifactType),
      plugin_name: pluginName,
      plugin_renderer: renderer,
      artifact_type: artifactType,
      plugin_options: objectValue(ui.options) || {},
      output_artifact: outputArtifact ? {
        ...outputArtifact,
        actions: normalizeArtifactActions(outputArtifact.actions, {
          kind: artifactType,
          path: outputArtifact.path,
          materialization: outputArtifact.materialization,
        }),
      } : undefined,
      source_tool_call_id: item.id,
      result_role: "deliverable",
      display: true,
    });
  }

  async emitDeliveredArtifact(item) {
    const details = toolResultDetails(item);
    const artifact = objectValue(details?.artifact);
    const delivery = deliveryWithActions(details?.output_delivery, {
      kind: artifact?.kind || "file",
      path: artifact?.current_version?.snapshot_path,
    });
    if (!(delivery?.role === "deliverable" && delivery?.surface === "workspace" && artifact?.id)) return;
    const version = objectValue(artifact.current_version) || {};
    await this.streamCallback(JSON.stringify({
      name: artifact.name || "产物",
      path: version.snapshot_path || delivery.path || "",
      kind: artifact.kind || delivery.kind || "file",
      mime_type: version.mime_type || "",
      size_bytes: Number(version.size_bytes || 0),
      artifact_id: artifact.id,
      artifact_version_id: version.id || null,
      artifact_version_number: version.version_number || null,
    }), {
      content_id: `${item.id}:deliverable`,
      content_type: "file",
      display_type: "file",
      title: artifact.name || "生成的产物",
      source_tool_call_id: item.id,
      result_role: "deliverable",
      artifact_id: artifact.id,
      artifact_version_id: version.id || null,
      output_delivery: delivery,
    });
  }

  async handlePluginUi(method, params = {}) {
    if (method !== "item/completed" || params.item?.type !== "dynamicToolCall") return;
    const failed = params.item.success === false
      || ["failed", "declined", "cancelled"].includes(String(params.item.status || "").toLowerCase());
    if (!failed) await this.emitPluginUi(params.item);
  }

  async handle(method, params = {}) {
    const id = itemId(params);
    if (method === "turn/plan/updated") {
      const turnId = String(params.turnId || params.turn?.id || "current");
      await this.streamCallback(JSON.stringify(Array.isArray(params.plan) ? params.plan : []), {
        content_id: `plan:${turnId}`,
        content_type: "plan",
        title: "已更新计划",
        explanation: params.explanation || null,
        source: "app-server",
      });
      return;
    }
    if (method === "item/started" && params.item) {
      this.items.set(params.item.id, params.item);
      const collaboration = nativeCollaborationItemPayload(params.item, "started");
      if (collaboration) {
        await this.streamCallback(JSON.stringify(collaboration), {
          content_id: params.item.id,
          content_type: "delegated_subtask",
          title: collaborationTitle(collaboration.status),
          subtask_title: collaboration.title,
          child_thread_ids: collaboration.child_thread_ids,
          parent_thread_id: collaboration.sender_thread_id,
          agents_states: collaboration.agents_states,
          source: "app-server",
        });
        return;
      }
      if (params.item.type === "contextCompaction") {
        await this.streamCallback("", {
          content_id: params.item.id,
          content_type: "compact",
          title: "running",
          trigger: "auto",
        });
        return;
      }
      if (params.item.type === "fileChange") {
        await this.streamCallback(JSON.stringify({
          changes: Array.isArray(params.item.changes) ? params.item.changes : [],
          status: params.item.status || "inProgress",
        }), {
          content_id: params.item.id,
          content_type: "file_change",
          title: "running",
        });
        return;
      }
      if (params.item.type === "imageGeneration") {
        await this.streamCallback("正在生成图片…", {
          content_id: params.item.id,
          content_type: "status",
          title: "running",
          native_item_type: params.item.type,
          replace_snapshot: true,
        });
        return;
      }
      if (params.item.type === "sleep") {
        await this.streamCallback(`等待 ${Math.max(0, Number(params.item.durationMs || 0))} 毫秒…`, {
          content_id: params.item.id,
          content_type: "status",
          title: "running",
          native_item_type: params.item.type,
          duration_ms: Number(params.item.durationMs || 0),
          replace_snapshot: true,
        });
        return;
      }
      if (["dynamicToolCall", "mcpToolCall", "commandExecution", "webSearch"].includes(params.item.type)) {
        const toolName = params.item.type === "webSearch"
          ? "web_search"
          : params.item.type === "commandExecution"
            ? "command"
            : params.item.tool || params.item.name || params.item.type;
        await this.streamCallback(`${params.item.tool || params.item.name || params.item.type} ${toolArguments(params.item)}`.trim(), {
          content_id: params.item.id,
          content_type: "tool",
          title: "running",
          tool_name: toolName,
          trace_input: params.item.query ?? toolArguments(params.item),
          where: params.item.type === "mcpToolCall" ? "mcp" : "agent_runtime",
        });
      }
      return;
    }
    if (method === "item/agentMessage/delta" && id) {
      const current = `${this.text.get(id) || ""}${params.delta || ""}`;
      this.text.set(id, current);
      const phase = messagePhase(
        params.phase,
        params.item?.phase,
        params.metadata?.phase,
        this.items.get(id)?.phase,
        this.items.get(id)?.metadata?.phase,
      );
      await this.streamCallback(current, {
        content_id: id,
        content_type: "markdown",
        ...(phase ? { phase } : {}),
      });
      return;
    }
    if ((method === "item/reasoning/summaryTextDelta" || method === "item/reasoning/textDelta") && id) {
      const current = `${this.text.get(id) || ""}${params.delta || ""}`;
      this.text.set(id, current);
      await this.streamCallback(current, {
        content_id: id,
        content_type: "thinking",
        title: "思考过程",
      });
      return;
    }
    if (method === "item/completed" && params.item) {
      const item = params.item;
      this.items.set(item.id, item);
      const collaboration = nativeCollaborationItemPayload(item, "completed");
      if (collaboration) {
        await this.streamCallback(JSON.stringify(collaboration), {
          content_id: item.id,
          content_type: "delegated_subtask",
          title: collaborationTitle(collaboration.status),
          subtask_title: collaboration.title,
          child_thread_ids: collaboration.child_thread_ids,
          parent_thread_id: collaboration.sender_thread_id,
          agents_states: collaboration.agents_states,
          source: "app-server",
        });
        return;
      }
      if (item.type === "contextCompaction") {
        await this.streamCallback("上下文已自动压缩", {
          content_id: item.id,
          content_type: "compact",
          title: "done",
          trigger: "auto",
        });
        return;
      }
      if (item.type === "agentMessage") {
        const text = item.text || this.text.get(item.id) || "";
        const memoryCitation = item.memoryCitation || item.memory_citation || null;
        const phase = messagePhase(item.phase, item.metadata?.phase, this.items.get(item.id)?.phase);
        this.text.set(item.id, text);
        await this.streamCallback(text, {
          content_id: item.id,
          content_type: "markdown",
          ...(phase ? { phase } : {}),
          ...(memoryCitation ? { memory_citation: memoryCitation } : {}),
        });
        return;
      }
      if (item.type === "reasoning") {
        const text = Array.isArray(item.summary) ? item.summary.join("\n") : this.text.get(item.id) || "";
        if (text) await this.streamCallback(text, { content_id: item.id, content_type: "thinking", title: "思考过程" });
        return;
      }
      if (item.type === "plan") {
        await this.streamCallback(String(item.text || ""), {
          content_id: item.id,
          content_type: "markdown",
          title: "计划方案",
          item_type: "planDocument",
        });
        return;
      }
      if (item.type === "fileChange") {
        await this.streamCallback(JSON.stringify({
          changes: Array.isArray(item.changes) ? item.changes : [],
          status: item.status || "completed",
        }), {
          content_id: item.id,
          content_type: "file_change",
          title: lifecycleTitle(item),
        });
        return;
      }
      if (item.type === "imageView") {
        const path = String(item.path || "");
        await this.streamCallback(String(item.path || ""), {
          content_id: item.id,
          content_type: "image",
          display_type: "image",
          title: "查看图片",
          native_item_type: item.type,
          result_role: "deliverable",
          output_delivery: deliveryWithActions(null, {
            role: "deliverable",
            surface: "inline",
            persistence: "none",
            kind: "image",
            path,
          }),
          saved_path: path || undefined,
          replace_snapshot: true,
        });
        return;
      }
      if (item.type === "imageGeneration") {
        const title = lifecycleTitle(item);
        const image = title === "done" ? imageGenerationContent(item) : "";
        const savedPath = item.savedPath || null;
        await this.streamCallback(
          image || (title === "error" ? "图片生成失败" : title === "rejected" ? "图片生成已拒绝" : title === "stopped" ? "图片生成已停止" : "正在生成图片…"),
          {
            content_id: item.id,
            content_type: image ? "image" : title === "error" ? "error" : "status",
            display_type: image ? "image" : undefined,
            title: image ? "生成的图片" : title,
            native_item_type: item.type,
            revised_prompt: item.revisedPrompt || null,
            saved_path: savedPath,
            output_delivery: image ? deliveryWithActions(null, {
              role: "deliverable",
              surface: "inline",
              persistence: "none",
              kind: "image",
              path: savedPath,
            }) : undefined,
            result_role: image ? "deliverable" : undefined,
            replace_snapshot: true,
          },
        );
        return;
      }
      if (item.type === "sleep") {
        const title = lifecycleTitle(item);
        await this.streamCallback(title === "done" ? "等待结束" : title === "stopped" ? "等待已停止" : "等待失败", {
          content_id: item.id,
          content_type: title === "error" ? "error" : "status",
          title,
          native_item_type: item.type,
          duration_ms: Number(item.durationMs || 0),
          replace_snapshot: true,
        });
        return;
      }
      if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
        const entered = item.type === "enteredReviewMode";
        await this.streamCallback(String(item.review || (entered ? "已进入代码审查模式" : "已退出代码审查模式")), {
          content_id: item.id,
          content_type: "status",
          title: entered ? "开始审查" : "结束审查",
          native_item_type: item.type,
          replace_snapshot: true,
        });
        return;
      }
      if (["dynamicToolCall", "mcpToolCall", "commandExecution", "webSearch"].includes(item.type)) {
        const title = lifecycleTitle(item);
        const failed = title !== "done";
        const toolName = item.type === "webSearch"
          ? "web_search"
          : item.type === "commandExecution"
            ? "command"
            : item.tool || item.name || item.type;
        await this.streamCallback(`${item.tool || item.name || item.type} ${toolArguments(item)}`.trim(), {
          content_id: item.id,
          content_type: "tool",
          title,
          tool_name: toolName,
          trace_input: item.query ?? toolArguments(item),
          trace_output: toolOutput(item),
          where: item.type === "mcpToolCall" ? "mcp" : "agent_runtime",
        });
        const deliveredDetails = toolResultDetails(item);
        const outputDeliveryValue = objectValue(deliveredDetails?.output_delivery);
        const deliveredArtifact = objectValue(deliveredDetails?.artifact);
        const deliveredPath = deliveredArtifact?.current_version?.snapshot_path
          || deliveredDetails?.path
          || outputDeliveryValue?.path
          || null;
        const outputDelivery = outputDeliveryValue
          ? deliveryWithActions(outputDeliveryValue, { path: deliveredPath })
          : null;
        for (const [contentIndex, content] of (Array.isArray(item.contentItems) ? item.contentItems : []).entries()) {
          if (content?.type === "inputImage" && (content.imageUrl || content.image_url)) {
            const imagePath = content.savedPath || content.saved_path || content.path
              || (outputDelivery?.kind === "image" ? deliveredPath : null);
            const imageDelivery = deliveryWithActions(outputDelivery ? {
              ...outputDelivery,
              kind: "image",
              path: imagePath,
              ...(outputDelivery.kind === "image" ? {} : { actions: undefined }),
            } : null, { kind: "image", path: imagePath });
            await this.streamCallback(String(content.imageUrl || content.image_url), {
              content_id: `${item.id}:content:${contentIndex}`,
              content_type: "image",
              display_type: "image",
              title: `${item.tool || item.name || "工具"} 生成的图片`,
              source_tool_call_id: item.id,
              result_role: "deliverable",
              output_delivery: imageDelivery,
              artifact_id: deliveredArtifact?.id || undefined,
              artifact_version_id: deliveredArtifact?.current_version?.id || undefined,
              saved_path: imagePath || undefined,
            });
          }
          if (content?.type === "inputAudio" && (content.audioUrl || content.audio_url)) {
            const audioPath = content.savedPath || content.saved_path || content.path
              || (outputDelivery?.kind === "audio" ? deliveredPath : null);
            const audioDelivery = deliveryWithActions(outputDelivery ? {
              ...outputDelivery,
              kind: "audio",
              path: audioPath,
              ...(outputDelivery.kind === "audio" ? {} : { actions: undefined }),
            } : null, { kind: "audio", path: audioPath });
            await this.streamCallback(String(content.audioUrl || content.audio_url), {
              content_id: `${item.id}:content:${contentIndex}`,
              content_type: "audio",
              display_type: "audio",
              title: `${item.tool || item.name || "工具"} 生成的音频`,
              source_tool_call_id: item.id,
              result_role: "deliverable",
              output_delivery: audioDelivery,
              artifact_id: deliveredArtifact?.id || undefined,
              artifact_version_id: deliveredArtifact?.current_version?.id || undefined,
              saved_path: audioPath || undefined,
            });
          }
        }
        if (!failed && item.type === "dynamicToolCall") {
          await this.emitGenerativeUi(item);
          await this.emitDeliveredArtifact(item);
          await this.emitPluginUi(item);
        }
      }
      return;
    }
    if (method === "error") {
      await this.streamCallback(`⚠️ ${params.error?.message || params.message || "Agent 执行失败"}`, {
        content_id: `agent_runtime-error:${params.turnId || Date.now()}`,
        content_type: "markdown",
        title: "提示",
      });
    }
  }
}

export default AgentStreamAdapter;
