// Product-tool IPC dispatcher: the dsh-work parent-side handler for inbound
// `product-request` messages from the app-owned DSH Profile Bundle. The Bundle
// sends `{ type: "product-request", id, sessionId, method, payload }` over the
// fork() IPC channel when one of its project or Office tools runs. This dispatcher owns:
//   - the method whitelist (default-deny; a method not listed is rejected),
//   - the caller identity (the request NEVER carries a userId — the dispatcher
//     derives it from the bound dsh-work session via resolveUserId),
//   - the result-size cap (hard upper bound on returned items),
// The request carries only the DSH session identity. It never carries userId or
// projectId; those come from a parent-owned binding established after dsh-work
// has authorized the app Session.
//
// It returns the response envelope it wants sent back:
//   { type: "product-response", id, result: { ok: true, value } }
//   { type: "product-response", id, result: { ok: false, error: { code, message } } }
//
// This module is transport-agnostic: it takes the inbound message and returns
// the outbound message; the DshRuntimeClient owns the actual process.send.

import * as projectsService from "../../app/projects/index.js";
import * as sessionService from "../../app/chat/agent_misc.js";
import {
  createProjectOfficeArtifact,
  editProjectOfficeArtifact,
  inspectProjectOfficeArtifact,
} from "../agents/office_artifact_service.js";
import {
  createCanvas,
  createCanvasSuggestion,
  editCanvas,
  getCanvas,
} from "../agents/canvas_store.js";
import {
  hashGenerativeUiDocument,
  parseGenerativeUiDocument,
} from "../agents/generative_ui_schema.js";
import {
  loadGlobalChatMemory,
  summarizeGlobalChatMemory,
} from "../agents/global_chat_memory.js";
import {
  loadProjectChatMemory,
  summarizeProjectMemorySources,
} from "../agents/project_chat_memory.js";
import {
  buildAppInstructionsMarkdown,
  readAppInstructions,
} from "../../app/agents/app_settings.js";
import { buildProjectInstructionsMarkdown } from "../agents/workspace_context.js";

const MAX_ITEMS = 200;

/**
 * The business services the dispatcher calls. Held as a mutable registry so
 * tests can inject mocks (ES module exports are read-only at runtime). The
 * production default is the real app/projects module.
 */
export const services = {
  listProjects: projectsService.listProjects,
  listAgentSessions: sessionService.listAgentSessions,
  createProjectOfficeArtifact,
  editProjectOfficeArtifact,
  inspectProjectOfficeArtifact,
  createCanvas,
  createCanvasSuggestion,
  editCanvas,
  getCanvas,
  loadGlobalChatMemory,
  loadProjectChatMemory,
};

/**
 * Test seam: override one or more services (restored by returning the previous
 * values). Production never calls this.
 * @param {Partial<typeof services>} overrides
 * @returns {Partial<typeof services>} the previous values (pass to restore).
 */
export function overrideServices(overrides) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = services[key];
    services[key] = overrides[key];
  }
  return previous;
}

const HANDLERS = Object.freeze({
  projectList: handleProjectList,
  conversationList: handleConversationList,
  conversationMemory: handleConversationMemory,
  capabilitySnapshot: handleCapabilitySnapshot,
  skillList: handleSkillList,
  skillGet: handleRemovedPluginCapability,
  mcpToolList: handleMcpToolList,
  mcpToolCall: handleRemovedPluginCapability,
  artifactOfficeInspect: handleArtifactOfficeInspect,
  artifactOfficeCreate: handleArtifactOfficeCreate,
  artifactOfficeEdit: handleArtifactOfficeEdit,
  canvasInspect: handleCanvasInspect,
  canvasCreate: handleCanvasCreate,
  canvasEdit: handleCanvasEdit,
  canvasSuggest: handleCanvasSuggest,
  uiRender: handleUiRender,
});

function handleCapabilitySnapshot() {
  return {
    revision: "profile-bundles-v1",
    truncated: false,
    selectedPlugins: [],
    selectedSkills: [],
    plugins: [],
    bridge: {
      context: "available",
      skills: "not-bridged",
      mcp: "not-bridged",
      pages: "app-only",
    },
  };
}

function handleSkillList() {
  return { revision: "profile-bundles-v1", items: [] };
}

function handleMcpToolList() {
  return { revision: "profile-bundles-v1", items: [], unavailable: [] };
}

function handleRemovedPluginCapability() {
  throw productRejected("旧项目 Plugin Skill 和 MCP 桥接已移除；请使用 DSH Profile Bundle 的原生能力");
}

function productErrorCode(error) {
  if (error?.name === "AbortError") return "product-rejected";
  if (Number(error?.status) >= 400 && Number(error?.status) < 500) return "product-rejected";
  return error?.code === "product-timeout" || error?.code === "product-rejected"
    ? error.code
    : "product-unavailable";
}

/**
 * Build a dispatcher bound to a specific dsh-work session identity and db.
 * @param {object} deps
 * @param {object} deps.db - dsh-work database handle ({ query, queryOne, transaction }).
 * @param {() => string|number} deps.resolveUserId - returns the userId bound to the calling DSH session.
 * @returns {{ handle(message: object): Promise<object> }} the dispatcher.
 */
export function createProductHostDispatcher({
  db,
  resolveUserId,
  resolveProjectId,
  resolveAppSessionId,
}) {
  const inFlight = new Map();
  return {
    async handle(message) {
      const id = message?.id;
      const method = message?.method;
      const handler = HANDLERS[method];
      if (!handler) {
        return response(id, { ok: false, error: { code: "product-rejected", message: `不支持的 productHost 方法：${method}` } });
      }
      const controller = new AbortController();
      inFlight.set(id, { sessionId: String(message?.sessionId || ""), controller });
      try {
        const value = await handler({
          db,
          resolveUserId,
          resolveProjectId,
          resolveAppSessionId,
          payload: message.payload || {},
          signal: controller.signal,
        });
        return response(id, { ok: true, value });
      } catch (error) {
        const code = productErrorCode(error);
        return response(id, { ok: false, error: { code, message: error?.message || String(error) } });
      } finally {
        inFlight.delete(id);
      }
    },
    cancel(message) {
      const pending = inFlight.get(message?.id);
      if (!pending || pending.sessionId !== String(message?.sessionId || "")) return false;
      pending.controller.abort(new DOMException("product-host caller cancelled", "AbortError"));
      return true;
    },
    dispose() {
      for (const pending of inFlight.values()) {
        pending.controller.abort(new DOMException("product-host dispatcher disposed", "AbortError"));
      }
      inFlight.clear();
      return undefined;
    },
  };
}

/**
 * Null dispatcher: rejects every product-request with product-unavailable.
 * Used when no dsh-work session identity is bound (the child still loads, but
 * product-host calls fail loud instead of hanging).
 */
export const nullProductHostDispatcher = {
  async handle(message) {
    return response(message?.id, { ok: false, error: { code: "product-unavailable", message: "productHost 未接入 DeepSeek Harness Desktop App 业务服务" } });
  },
  cancel() {
    return false;
  },
  async dispose() {},
};

/**
 * Session-addressed dispatcher for the process-wide DSH child. Bindings are
 * established only from authorized dsh-work Session rows and remain available
 * across turns and child restarts. Each request selects its binding with the
 * DSH-owned sessionId; userId and projectId never come from the child payload.
 */
export function createSessionProductHostDispatcher() {
  const bindings = new Map();
  const inFlight = new Map();
  return {
    bind(next) {
      const dshSessionId = String(next?.dshSessionId || "").trim();
      const appSessionId = String(next?.appSessionId || "").trim();
      if (!dshSessionId || !appSessionId || !next?.db) {
        const error = new Error("注册 DSH ProductHost 绑定需要 dshSessionId、appSessionId 和数据库连接");
        error.code = "DSH_PRODUCT_HOST_BINDING_INVALID";
        throw error;
      }
      const binding = {
        db: next.db,
        dshSessionId,
        appSessionId,
        userId: String(next.userId || ""),
        projectId: String(next.projectId || "").trim() || null,
      };
      const current = bindings.get(dshSessionId);
      if (current && (current.appSessionId !== binding.appSessionId
        || current.userId !== binding.userId
        || current.projectId !== binding.projectId)) {
        const error = new Error("同一个 DSH session 不能改绑到另一项 DeepSeek Harness Desktop App 身份");
        error.code = "DSH_PRODUCT_HOST_IDENTITY_CONFLICT";
        throw error;
      }
      bindings.set(dshSessionId, binding);
      return dshSessionId;
    },
    clear(dshSessionId) {
      const key = String(dshSessionId || "").trim();
      const binding = bindings.get(key);
      if (!binding) return false;
      bindings.delete(key);
      for (const [id, pending] of inFlight) {
        if (pending.sessionId !== key) continue;
        pending.controller.abort(new DOMException("product-host Session binding removed", "AbortError"));
        inFlight.delete(id);
      }
      return true;
    },
    async handle(message) {
      const id = message?.id;
      const dshSessionId = String(message?.sessionId || "").trim();
      if (!dshSessionId) {
        return response(id, { ok: false, error: { code: "product-rejected", message: "productHost 请求缺少 DSH sessionId" } });
      }
      const binding = bindings.get(dshSessionId);
      if (!binding) {
        return response(id, { ok: false, error: { code: "product-unavailable", message: "productHost 没有这个 DSH session 的授权绑定" } });
      }
      const method = message?.method;
      const handler = HANDLERS[method];
      if (!handler) {
        return response(id, { ok: false, error: { code: "product-rejected", message: `不支持的 productHost 方法：${method}` } });
      }
      const controller = new AbortController();
      inFlight.set(id, { sessionId: dshSessionId, controller });
      try {
        const value = await handler({
          db: binding.db,
          resolveUserId: () => binding.userId,
          resolveProjectId: () => binding.projectId || null,
          resolveAppSessionId: () => binding.appSessionId,
          payload: message.payload || {},
          signal: controller.signal,
        });
        return response(id, { ok: true, value });
      } catch (error) {
        const code = productErrorCode(error);
        return response(id, { ok: false, error: { code, message: error?.message || String(error) } });
      } finally {
        inFlight.delete(id);
      }
    },
    cancel(message) {
      const pending = inFlight.get(message?.id);
      if (!pending || pending.sessionId !== String(message?.sessionId || "").trim()) return false;
      pending.controller.abort(new DOMException("product-host caller cancelled", "AbortError"));
      return true;
    },
    async dispose() {
      for (const pending of inFlight.values()) {
        pending.controller.abort(new DOMException("product-host dispatcher disposed", "AbortError"));
      }
      inFlight.clear();
      bindings.clear();
    },
  };
}

function response(id, result) {
  return { type: "product-response", id, result };
}

async function handleProjectList({ db, resolveUserId, payload }) {
  const userId = resolveUserId();
  const ctx = { query: db.query, queryOne: db.queryOne, transaction: db.transaction, userId };
  const r = await services.listProjects(ctx, { query: { search: payload.search || "" }, body: {}, params: {} });
  const all = r.data?.items || [];
  const truncated = all.length > MAX_ITEMS;
  const items = truncated ? all.slice(0, MAX_ITEMS) : all;
  return {
    items: items.map((p) => ({ id: String(p.id), name: String(p.name || ""), ...(p.description ? { description: String(p.description) } : {}) })),
    total: r.data?.total ?? all.length,
    page: 1,
    perPage: items.length,
    truncated,
  };
}

async function handleConversationList({ db, resolveUserId, resolveProjectId, payload }) {
  const userId = resolveUserId();
  const projectId = resolveProjectId();
  if (!projectId) throw new Error("conversationList 需要活动项目绑定");
  const ctx = { query: db.query, queryOne: db.queryOne, transaction: db.transaction, userId };
  const r = await services.listAgentSessions(ctx, {
    params: { pid: projectId },
    body: {},
    query: payload.archived === true ? { archived: "1" } : {},
  });
  const all = r.data?.sessions || r.data?.items || [];
  const truncated = all.length > MAX_ITEMS;
  const items = (truncated ? all.slice(0, MAX_ITEMS) : all).map((s) => ({
    id: String(s.id || s.session_id || ""),
    title: String(s.title || "（未命名对话）"),
    archived: String(s.status || "active") === "archived",
  }));
  return {
    items,
    total: all.length,
    truncated,
  };
}

async function handleConversationMemory({
  db,
  resolveUserId,
  resolveProjectId,
  resolveAppSessionId,
  payload,
}) {
  const userId = String(resolveUserId?.() || "").trim();
  const projectId = String(resolveProjectId?.() || "").trim();
  const appSessionId = String(resolveAppSessionId?.() || "").trim();
  const query = String(payload?.query || "").trim().slice(0, 8_000);
  if (!(userId && projectId && appSessionId && query)) return { text: "", presentation: null };
  const session = await db.queryOne(
    "SELECT action_type,session_config FROM sessions WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL LIMIT 1",
    [appSessionId, projectId, userId],
  ).catch(() => null);
  if (!session) throw productRejected("conversationMemory 找不到绑定的 DeepSeek Harness Desktop App Session");
  let sessionConfig = {};
  try {
    sessionConfig = typeof session.session_config === "string"
      ? JSON.parse(session.session_config)
      : (session.session_config || {});
  } catch {
    sessionConfig = {};
  }
  const temporary = session.action_type === "temporary_chat" || sessionConfig.temporary === true;
  const appInstructions = await readAppInstructions(db, userId);
  const projectRow = projectId === "__chat__"
    ? null
    : await db.queryOne(
      "SELECT instructions FROM projects WHERE id=$1 AND deleted_at IS NULL LIMIT 1",
      [projectId],
    ).catch(() => null);
  const projectInstructions = String(projectRow?.instructions || "").trim();
  const instructionText = [
    buildAppInstructionsMarkdown(appInstructions),
    buildProjectInstructionsMarkdown(projectInstructions),
    temporary
      ? "## Temporary conversation\n\n当前是临时对话。这里的内容不会进入普通对话历史，也不能作为其他对话的记忆来源。"
      : "",
  ].filter(Boolean).join("\n\n");
  const instructions = {
    text: instructionText,
    scopes: {
      application: Boolean(appInstructions),
      project: Boolean(projectInstructions),
      temporary,
    },
  };
  if (projectId === "__chat__") {
    const memory = await services.loadGlobalChatMemory({
      db,
      projectId,
      userId,
      currentSessionId: appSessionId,
      query,
      temporary,
    });
    const summary = summarizeGlobalChatMemory(memory);
    return {
      text: memory.text || "",
      instructions,
      presentation: memory.text
        ? { type: "global_memory", content: summary }
        : null,
    };
  }
  if (temporary) return { text: "", instructions, presentation: null };
  const memory = await services.loadProjectChatMemory({
    db,
    projectId,
    userId,
    currentSessionId: appSessionId,
    query,
  });
  return {
    text: memory.text || "",
    instructions,
    presentation: memory.text
      ? { type: "project_memory", content: { sources: summarizeProjectMemorySources(memory.sources) } }
      : null,
  };
}

function productRejected(message) {
  const error = new Error(message);
  error.code = "product-rejected";
  return error;
}

function boundOfficeRequest({ db, resolveUserId, resolveProjectId, resolveAppSessionId, payload }) {
  const projectId = String(resolveProjectId?.() || "").trim();
  const requestedProjectId = String(payload?.project_id || projectId).trim();
  const appSessionId = String(resolveAppSessionId?.() || "").trim();
  if (!projectId || !appSessionId) throw productRejected("Office 产物工具需要活动项目和 DeepSeek Harness Desktop App Session 绑定");
  if (requestedProjectId !== projectId) throw productRejected("Office 产物工具只能操作当前 DSH Session 绑定的项目");
  return {
    projectId,
    appSessionId,
    ctx: {
      query: db.query,
      queryOne: db.queryOne,
      transaction: db.transaction,
      userId: resolveUserId(),
    },
  };
}

function officeSource(appSessionId) {
  return { sessionId: appSessionId };
}

function boundCanvasRequest({ db, resolveUserId, resolveProjectId, resolveAppSessionId }) {
  const projectId = String(resolveProjectId?.() || "").trim();
  const appSessionId = String(resolveAppSessionId?.() || "").trim();
  if (!projectId || !appSessionId) throw productRejected("Canvas 工具需要活动项目和 DeepSeek Harness Desktop App Session 绑定");
  return {
    projectId,
    appSessionId,
    userId: resolveUserId(),
    ctx: {
      query: db.query,
      queryOne: db.queryOne,
      transaction: db.transaction,
      userId: resolveUserId(),
    },
  };
}

function canvasSource() {
  return { type: "tool" };
}

function officeDocumentForModel(document) {
  if (!document || typeof document !== "object") return document;
  return {
    ...document,
    sections: Array.isArray(document.sections)
      ? document.sections.map(({ preview_svg: _previewSvg, ...section }) => section)
      : document.sections,
  };
}

async function handleArtifactOfficeInspect(deps) {
  const { projectId, ctx } = boundOfficeRequest(deps);
  const artifactId = String(deps.payload?.artifact_id || "").trim();
  if (!artifactId) throw productRejected("artifactOfficeInspect 需要 artifact_id");
  const result = await services.inspectProjectOfficeArtifact(ctx, {
    projectId,
    artifactId,
    versionId: String(deps.payload?.version_id || "").trim(),
  });
  return {
    success: true,
    ...result,
    document: officeDocumentForModel(result.document),
  };
}

async function handleArtifactOfficeCreate(deps) {
  const { projectId, appSessionId, ctx } = boundOfficeRequest(deps);
  const format = String(deps.payload?.format || "").trim();
  if (!format) throw productRejected("artifactOfficeCreate 需要 format");
  const result = await services.createProjectOfficeArtifact(ctx, {
    projectId,
    format,
    name: deps.payload?.name,
    title: deps.payload?.title,
    content: deps.payload?.content,
    specification: deps.payload?.specification,
    description: deps.payload?.description,
    source: officeSource(appSessionId),
  });
  return { success: true, ...result };
}

async function handleArtifactOfficeEdit(deps) {
  const { projectId, appSessionId, ctx } = boundOfficeRequest(deps);
  const artifactId = String(deps.payload?.artifact_id || "").trim();
  const baseVersionId = String(deps.payload?.base_version_id || "").trim();
  if (!artifactId || !baseVersionId) {
    throw productRejected("artifactOfficeEdit 需要 artifact_id 和 base_version_id");
  }
  const result = await services.editProjectOfficeArtifact(ctx, {
    projectId,
    artifactId,
    baseVersionId,
    operations: deps.payload?.operations,
    changeSummary: deps.payload?.change_summary,
    source: officeSource(appSessionId),
  });
  return { success: true, ...result };
}

async function handleCanvasInspect(deps) {
  const { projectId, appSessionId, userId, ctx } = boundCanvasRequest(deps);
  const canvasId = String(deps.payload?.canvas_id || "").trim();
  if (!canvasId) throw productRejected("canvasInspect 需要 canvas_id");
  const canvas = await services.getCanvas(ctx, { userId, sessionId: appSessionId, canvasId });
  if (String(canvas?.project_id || "") !== projectId) throw productRejected("Canvas 不属于当前 DSH Session 绑定的项目");
  return { success: true, project_id: projectId, canvas };
}

async function handleCanvasCreate(deps) {
  const { projectId, appSessionId, userId, ctx } = boundCanvasRequest(deps);
  const result = await services.createCanvas(ctx, {
    userId,
    sessionId: appSessionId,
    title: deps.payload?.title,
    kind: deps.payload?.kind,
    language: deps.payload?.language,
    content: typeof deps.payload?.content === "string" ? deps.payload.content : "",
    changeSummary: deps.payload?.change_summary,
    source: canvasSource(),
    metadata: { created_by: "canvas_create" },
  });
  if (String(result?.canvas?.project_id || "") !== projectId) throw productRejected("创建的 Canvas 不属于当前 DSH Session 绑定的项目");
  return { success: true, project_id: projectId, ...result };
}

async function handleCanvasEdit(deps) {
  const { projectId, appSessionId, userId, ctx } = boundCanvasRequest(deps);
  const canvasId = String(deps.payload?.canvas_id || "").trim();
  const baseVersionId = String(deps.payload?.base_version_id || "").trim();
  if (!canvasId || !baseVersionId) throw productRejected("canvasEdit 需要 canvas_id 和 base_version_id");
  const result = await services.editCanvas(ctx, {
    userId,
    sessionId: appSessionId,
    canvasId,
    baseVersionId,
    ...(typeof deps.payload?.content === "string"
      ? { content: deps.payload.content }
      : { operations: deps.payload?.operations }),
    changeSummary: deps.payload?.change_summary,
    source: canvasSource(),
    metadata: { edited_by: "canvas_edit" },
  });
  if (String(result?.canvas?.project_id || "") !== projectId) throw productRejected("Canvas 不属于当前 DSH Session 绑定的项目");
  return { success: true, project_id: projectId, ...result };
}

async function handleCanvasSuggest(deps) {
  const { projectId, appSessionId, userId, ctx } = boundCanvasRequest(deps);
  const canvasId = String(deps.payload?.canvas_id || "").trim();
  const baseVersionId = String(deps.payload?.base_version_id || "").trim();
  if (!canvasId || !baseVersionId) throw productRejected("canvasSuggest 需要 canvas_id 和 base_version_id");
  const suggestion = await services.createCanvasSuggestion(ctx, {
    userId,
    sessionId: appSessionId,
    canvasId,
    baseVersionId,
    start: deps.payload?.start,
    end: deps.payload?.end,
    selectedText: deps.payload?.selected_text,
    replacementText: deps.payload?.replacement_text,
    instruction: deps.payload?.instruction,
    source: canvasSource(),
  });
  const canvas = await services.getCanvas(ctx, { userId, sessionId: appSessionId, canvasId });
  if (String(canvas?.project_id || "") !== projectId) throw productRejected("Canvas 不属于当前 DSH Session 绑定的项目");
  return { success: true, project_id: projectId, suggestion, canvas };
}

function handleUiRender({ resolveProjectId, resolveAppSessionId, payload }) {
  const projectId = String(resolveProjectId?.() || "").trim();
  const appSessionId = String(resolveAppSessionId?.() || "").trim();
  if (!projectId || !appSessionId) throw productRejected("uiRender 需要活动项目和 DeepSeek Harness Desktop App Session 绑定");
  const { document, stats } = parseGenerativeUiDocument(payload, { allowedLocalRoots: [] });
  return {
    success: true,
    project_id: projectId,
    session_id: appSessionId,
    generative_ui: document,
    generative_ui_stats: stats,
    document_hash: hashGenerativeUiDocument(document),
  };
}
