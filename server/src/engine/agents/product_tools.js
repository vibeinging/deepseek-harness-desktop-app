import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Type } from "../agent_host/json_schema.js";
import { PRODUCT_TOOL_CATALOG } from "./product_tool_catalog.js";
import { listProjects, createProject, getProject } from "../../app/projects/index.js";
import { listAgentSessions } from "../../app/chat/agent_misc.js";
import { createSession, updateSession } from "../../app/session/index.js";
import {
  createAppSkill,
  deleteAppSkill,
  listAppSkills,
  listSkills,
  setAppSkillEnabled,
  updateAppSkill,
} from "./skill_registry.js";
import { publishProjectArtifact } from "./project_artifact_store.js";
import {
  createProjectOfficeArtifact,
  editProjectOfficeArtifact,
  inspectProjectOfficeArtifact,
} from "./office_artifact_service.js";
import {
  createCanvas,
  createCanvasSuggestion,
  editCanvas,
  getCanvas,
} from "./canvas_store.js";
import {
  GENERATIVE_UI_TOOL_INPUT_SCHEMA,
  authorizeGenerativeUiHostResult,
  hashGenerativeUiDocument,
  parseGenerativeUiDocument,
} from "./generative_ui_schema.js";

const DB_EXTS = new Set([".db", ".sqlite", ".sqlite3", ".duckdb"]);
const STRUCTURED_EXTS = new Set([".csv", ".tsv", ".xlsx", ".xls", ".json", ".jsonl", ".ndjson", ".parquet", ".pq"]);
const UNSTRUCTURED_EXTS = new Set([".md", ".markdown", ".txt", ".pdf", ".docx", ".doc", ".html", ".htm"]);
const MAX_SCAN_FILES = 500;
const HOST_ACTION_TOOL_NAMES = new Set([
  "project_create",
  "project_open",
  "conversation_create",
  "conversation_open",
  "conversation_rename",
  "conversation_archive",
  "canvas_create",
  "canvas_edit",
  "canvas_suggest",
  "artifact_publish",
  "artifact_office_create",
  "artifact_office_edit",
]);
const GENERATIVE_UI_TURN_STATE = Symbol("generative-ui-turn-state");
const MAX_GENERATIVE_UI_CALLS_PER_TURN = 8;
const MAX_GENERATIVE_UI_SURFACES_PER_TURN = 8;

function toolResult(data) {
  const text = JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text }], details: data };
}

function withHostAction(data, action) {
  const { host_actions: previousActions, ...visibleData } = data || {};
  const result = toolResult(visibleData);
  return {
    ...result,
    details: {
      ...result.details,
      host_actions: [...(Array.isArray(previousActions) ? previousActions : []), action],
    },
  };
}

function errorResult(message, extra = {}) {
  return {
    ...toolResult({ success: false, error: String(message || "工具执行失败"), ...extra }),
    isError: true,
  };
}

function uiCapabilityUnavailableResult() {
  return errorResult("当前客户端未启用宿主原生生成式界面", {
    error_code: "UI_CAPABILITY_UNAVAILABLE",
    path: "$",
  });
}

function generativeUiTurnState(agentContext) {
  if (!agentContext[GENERATIVE_UI_TURN_STATE]) {
    Object.defineProperty(agentContext, GENERATIVE_UI_TURN_STATE, {
      configurable: false,
      enumerable: false,
      writable: false,
      value: { callCount: 0, surfaces: new Map() },
    });
  }
  return agentContext[GENERATIVE_UI_TURN_STATE];
}

function uiRenderTool(agentContext, params = {}, toolCallId = null) {
  if (agentContext?.generativeUi !== true) return uiCapabilityUnavailableResult();
  try {
    const allowedLocalRoots = Array.isArray(agentContext?.generativeUiWorkspaceRoots)
      ? agentContext.generativeUiWorkspaceRoots
      : [
          ...(Array.isArray(agentContext?.workspace_roots) ? agentContext.workspace_roots : []),
          agentContext?.workspace_write_root,
        ].filter(Boolean);
    const { document, stats } = parseGenerativeUiDocument(params, { allowedLocalRoots });
    const callId = String(toolCallId || "").trim();
    if (!callId) {
      return errorResult("生成式界面缺少工具调用 ID", {
        error_code: "GENERATIVE_UI_CALL_ID_REQUIRED",
        path: "$",
      });
    }
    const documentHash = hashGenerativeUiDocument(document);
    const state = generativeUiTurnState(agentContext);
    if (state.callCount >= MAX_GENERATIVE_UI_CALLS_PER_TURN) {
      return errorResult(`每个 Turn 最多调用 ${MAX_GENERATIVE_UI_CALLS_PER_TURN} 次 ui_render`, {
        error_code: "GENERATIVE_UI_RESOURCE_LIMIT",
        path: "$",
      });
    }
    const previous = state.surfaces.get(document.surface_id) || null;
    if (!previous && state.surfaces.size >= MAX_GENERATIVE_UI_SURFACES_PER_TURN) {
      return errorResult(`每个 Turn 最多创建 ${MAX_GENERATIVE_UI_SURFACES_PER_TURN} 个生成式界面`, {
        error_code: "GENERATIVE_UI_RESOURCE_LIMIT",
        path: "$.surface_id",
      });
    }
    state.callCount += 1;
    if (previous && document.revision < previous.revision) {
      return errorResult("revision 低于当前 Surface 版本", {
        error_code: "UI_REVISION_STALE",
        path: "$.revision",
        current_revision: previous.revision,
      });
    }
    if (previous && document.revision === previous.revision && documentHash !== previous.hash) {
      return errorResult("相同 revision 不能对应不同的界面内容", {
        error_code: "UI_REVISION_CONFLICT",
        path: "$.revision",
        current_revision: previous.revision,
      });
    }
    if (previous && document.revision === previous.revision) {
      return authorizeGenerativeUiHostResult({
        content: [{
          type: "text",
          text: "相同界面版本已经展示，无需重复渲染。请继续用普通文本给出简短结论。",
        }],
        details: {
          success: true,
          generative_ui: document,
          generative_ui_stats: stats,
          generative_ui_projection: {
            mode: "noop",
            item_id: previous.itemId,
            document_hash: documentHash,
          },
        },
      });
    }
    const itemId = `${callId}:generative-ui`;
    const projection = {
      mode: "emit",
      item_id: itemId,
      replaces_item_id: previous?.itemId || null,
      document_hash: documentHash,
    };
    state.surfaces.set(document.surface_id, {
      revision: document.revision,
      hash: documentHash,
      itemId,
    });
    return authorizeGenerativeUiHostResult({
      content: [{
        type: "text",
        text: "界面已展示。请继续用普通文本给出简短结论；按钮或表单只会发送下一轮用户消息，尚未执行任何操作。",
      }],
      details: {
        success: true,
        generative_ui: document,
        generative_ui_stats: stats,
        generative_ui_projection: projection,
      },
    });
  } catch (error) {
    return errorResult(error?.message || "生成式界面不符合 v1 规格", {
      error_code: error?.code || "GENERATIVE_UI_SCHEMA_INVALID",
      path: error?.path || "$",
    });
  }
}

function makeCtx(agentContext) {
  const db = agentContext?.db || {};
  return {
    query: db.query,
    queryOne: db.queryOne,
    transaction: db.transaction,
    userId: agentContext?.user_id || "",
    signal: agentContext?.signal,
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted !== true) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  const error = new Error("Agent Turn 已取消");
  error.name = "AbortError";
  throw error;
}

function invocationContext(agentContext, signal) {
  if (!signal || !agentContext || typeof agentContext !== "object") return agentContext;
  const db = agentContext.db && typeof agentContext.db === "object" ? agentContext.db : null;
  const scopedDb = db ? Object.create(db) : null;
  if (scopedDb) {
    for (const method of ["query", "queryOne", "transaction"]) {
      const operation = db[method];
      if (typeof operation !== "function") continue;
      Object.defineProperty(scopedDb, method, {
        configurable: true,
        enumerable: true,
        value: method === "transaction" ? (...args) => {
          throwIfAborted(signal);
          const result = Reflect.apply(operation, db, args);
          throwIfAborted(signal);
          return result;
        } : async (...args) => {
          throwIfAborted(signal);
          const result = await Reflect.apply(operation, db, args);
          throwIfAborted(signal);
          return result;
        },
      });
    }
  }
  return new Proxy(agentContext, {
    get(target, property, receiver) {
      if (property === "signal") return signal;
      if (property === "db" && scopedDb) return scopedDb;
      return Reflect.get(target, property, receiver);
    },
  });
}

function projectId(agentContext, params = {}) {
  const explicit = String(params?.project_id || "").trim();
  if (explicit) return explicit;
  const current = String(agentContext?.project_id || "");
  if (current && current !== "__chat__") return current;
  return "";
}

function normalizePaths(value) {
  if (Array.isArray(value)) return value.map((x) => String(x || "").trim()).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function isInsidePath(rootPath, candidatePath) {
  const rel = relative(resolve(rootPath), resolve(candidatePath));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function walkPath(p, recursive, out) {
  if (out.length >= MAX_SCAN_FILES) return;
  if (!existsSync(p)) {
    out.push({ path: p, exists: false, kind: "missing", ext: extname(p).toLowerCase() });
    return;
  }
  const st = statSync(p);
  if (st.isDirectory()) {
    if (!recursive) {
      out.push({ path: p, exists: true, kind: "directory", ext: "" });
      return;
    }
    for (const name of readdirSync(p)) {
      if (out.length >= MAX_SCAN_FILES) break;
      if (name.startsWith(".")) continue;
      walkPath(join(p, name), recursive, out);
    }
    return;
  }
  if (st.isFile()) {
    out.push({ path: p, exists: true, kind: "file", ext: extname(p).toLowerCase(), size: st.size, name: basename(p) });
  }
}

function classifyFiles(paths, recursive = false) {
  const files = [];
  for (const p of paths) walkPath(p, recursive, files);
  const groups = {
    database_files: [],
    structured_files: [],
    unstructured_docs: [],
    unsupported: [],
    missing: [],
    directories: [],
  };
  for (const f of files) {
    if (!f.exists) groups.missing.push(f);
    else if (f.kind === "directory") groups.directories.push(f);
    else if (DB_EXTS.has(f.ext)) groups.database_files.push(f);
    else if (STRUCTURED_EXTS.has(f.ext)) groups.structured_files.push(f);
    else if (UNSTRUCTURED_EXTS.has(f.ext)) groups.unstructured_docs.push(f);
    else groups.unsupported.push(f);
  }
  return { files, groups };
}

async function projectListTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const r = await listProjects(ctx, { query: { search: params.search || "" }, body: {}, params: {} });
  return toolResult({ success: true, ...r.data });
}

async function projectCreateTool(agentContext, params = {}) {
  const name = String(params.name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const ctx = makeCtx(agentContext);
  const r = await createProject(ctx, { body: { name, description: params.description || "" }, params: {}, query: {} });
  const project = r.data;
  const createdProjectId = project?.id || project?.project_id;
  return withHostAction(
    { success: true, project, project_id: createdProjectId },
    {
      type: "workspace_event",
      event: {
        event: "project_created",
        project_id: createdProjectId,
        project,
        origin_project_id: String(agentContext?.project_id || "__chat__"),
        session_id: String(agentContext?.session_id || "") || null,
      },
    },
  );
}

async function projectOpenTool(agentContext, params = {}) {
  const targetProjectId = String(params.project_id || "").trim();
  if (!targetProjectId) return errorResult("project_id 为必填项");
  const r = await getProject(makeCtx(agentContext), { params: { id: targetProjectId }, body: {}, query: {} });
  return withHostAction(
    { success: true, project: r.data, project_id: targetProjectId },
    {
      type: "workspace_event",
      event: {
        event: "project_opened",
        project_id: targetProjectId,
        project: r.data,
        origin_project_id: String(agentContext?.project_id || "__chat__"),
      },
    },
  );
}

function conversationProjectId(agentContext, params = {}) {
  return String(params.project_id || agentContext?.project_id || "__chat__").trim() || "__chat__";
}

async function canCreateConversationInWorkspace(agentContext, pid) {
  if (pid === "__chat__") return true;
  const project = await agentContext.db.queryOne(
    `SELECT p.id
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id AND pm.deleted_at IS NULL
      WHERE p.id=$1 AND pm.user_id=$2 AND p.deleted_at IS NULL
      LIMIT 1`,
    [pid, agentContext?.user_id || ""],
  );
  return !!project;
}

async function conversationRecord(agentContext, params = {}) {
  const pid = conversationProjectId(agentContext, params);
  const sessionId = String(params.conversation_id || params.session_id || "").trim();
  if (!sessionId) return { error: "conversation_id 为必填项" };
  const session = await agentContext.db.queryOne(
    `SELECT id, project_id, title, description, status, message_count, source_type, action_type,
            created_at, updated_at
       FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
      LIMIT 1`,
    [sessionId, pid, agentContext?.user_id || ""],
  );
  if (!session) return { error: "对话不存在或无权限" };
  return { pid, sessionId, session };
}

async function conversationListTool(agentContext, params = {}) {
  const pid = conversationProjectId(agentContext, params);
  const archived = params.archived === true;
  const r = await listAgentSessions(makeCtx(agentContext), {
    params: { pid },
    body: {},
    query: archived ? { archived: "1" } : {},
  });
  return toolResult({
    success: true,
    project_id: pid,
    archived,
    conversations: r.data?.items || [],
  });
}

async function conversationCreateTool(agentContext, params = {}) {
  const pid = conversationProjectId(agentContext, params);
  if (!(await canCreateConversationInWorkspace(agentContext, pid))) {
    return errorResult("工作区不存在或无权限");
  }
  const title = String(params.title || "新对话").trim().slice(0, 60) || "新对话";
  const r = await createSession(makeCtx(agentContext), {
    params: { pid },
    query: {},
    body: {
      title,
      description: String(params.description || "").trim() || null,
      source_type: "agent",
      source_id: pid,
      action_type: "agentic_chat",
    },
  });
  return withHostAction(
    { success: true, project_id: pid, conversation: r.data, conversation_id: r.data?.id },
    {
      type: "workspace_event",
      event: {
        event: "conversation_created",
        project_id: pid,
        session_id: r.data?.id,
        conversation: r.data,
        open: params.open === true,
      },
    },
  );
}

async function conversationOpenTool(agentContext, params = {}) {
  const resolved = await conversationRecord(agentContext, params);
  if (resolved.error) return errorResult(resolved.error);
  return withHostAction(
    {
      success: true,
      project_id: resolved.pid,
      conversation_id: resolved.sessionId,
      conversation: resolved.session,
    },
    {
      type: "workspace_event",
      event: {
        event: "conversation_opened",
        project_id: resolved.pid,
        session_id: resolved.sessionId,
        conversation: resolved.session,
      },
    },
  );
}

async function conversationRenameTool(agentContext, params = {}) {
  const resolved = await conversationRecord(agentContext, params);
  if (resolved.error) return errorResult(resolved.error);
  const title = String(params.title || "").trim().slice(0, 60);
  if (!title) return errorResult("title 为必填项");
  const r = await updateSession(makeCtx(agentContext), {
    params: { pid: resolved.pid, sid: resolved.sessionId },
    query: {},
    body: { title },
  });
  return withHostAction(
    { success: true, project_id: resolved.pid, conversation_id: resolved.sessionId, conversation: r.data },
    {
      type: "workspace_event",
      event: {
        event: "conversation_updated",
        project_id: resolved.pid,
        session_id: resolved.sessionId,
        conversation: r.data,
      },
    },
  );
}

async function conversationArchiveTool(agentContext, params = {}) {
  const resolved = await conversationRecord(agentContext, params);
  if (resolved.error) return errorResult(resolved.error);
  const archived = params.archived !== false;
  const r = await updateSession(makeCtx(agentContext), {
    params: { pid: resolved.pid, sid: resolved.sessionId },
    query: {},
    body: { status: archived ? "archived" : "active" },
  });
  return withHostAction(
    {
      success: true,
      project_id: resolved.pid,
      conversation_id: resolved.sessionId,
      archived,
      conversation: r.data,
    },
    {
      type: "workspace_event",
      event: {
        event: archived ? "conversation_archived" : "conversation_unarchived",
        project_id: resolved.pid,
        session_id: resolved.sessionId,
        conversation: r.data,
      },
    },
  );
}

async function fileClassifyTool(_agentContext, params = {}) {
  const paths = normalizePaths(params.paths || params.path);
  if (!paths.length) return errorResult("paths 不能为空");
  const recursive = params.recursive !== false;
  const { files, groups } = classifyFiles(paths, recursive);
  return toolResult({
    success: true,
    scanned_count: files.length,
    truncated: files.length >= MAX_SCAN_FILES,
    groups,
  });
}

async function skillListTool(agentContext) {
  const ctx = makeCtx(agentContext);
  const skills = await listAppSkills(ctx);
  return toolResult({ success: true, skills });
}

async function skillCreateTool(agentContext, params = {}) {
  const ctx = makeCtx(agentContext);
  const skill = await createAppSkill(ctx, params, agentContext?.user_id || "");
  return toolResult({ success: true, skill });
}

async function skillUpdateTool(agentContext, params = {}) {
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const ctx = makeCtx(agentContext);
  const skill = await updateAppSkill(ctx, name, params, agentContext?.user_id || "");
  return toolResult({ success: true, skill });
}

async function skillToggleTool(agentContext, params = {}) {
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const patch = {};
  if (typeof params.is_enabled === "boolean") patch.is_enabled = params.is_enabled;
  if (!Object.keys(patch).length) return errorResult("is_enabled 为必填项");
  const ctx = makeCtx(agentContext);
  const skill = await setAppSkillEnabled(ctx, name, patch, agentContext?.user_id || "");
  return toolResult({ success: true, skill });
}

async function skillDeleteTool(agentContext, params = {}) {
  const name = String(params.name || params.skill_name || "").trim();
  if (!name) return errorResult("name 为必填项");
  const ctx = makeCtx(agentContext);
  const result = await deleteAppSkill(ctx, name, agentContext?.user_id || "");
  return toolResult({ success: true, ...result });
}

async function projectSkillListTool(agentContext, params = {}) {
  const pid = projectId(agentContext, params);
  if (!pid) return errorResult("缺少 project_id。请先创建或选择项目。");
  const ctx = makeCtx(agentContext);
  const skills = await listSkills(ctx, pid);
  return toolResult({ success: true, project_id: pid, skills });
}

function canvasToolSession(agentContext) {
  const sessionId = String(agentContext?.session_id || "").trim();
  if (!sessionId) return { error: "当前运行没有可用的对话，不能操作 Canvas。" };
  return { sessionId };
}

function canvasToolSource(agentContext, toolCallId) {
  return {
    type: "tool",
    turnId: agentContext?.runtime_turn_id || agentContext?.runtime?.turnId || agentContext?.task_id || null,
    runId: agentContext?.runtime?.runId || agentContext?.task_id || null,
    itemId: toolCallId || null,
    toolCallId: toolCallId || null,
  };
}

async function recordCanvasArtifact(agentContext, toolCallId, result, action) {
  if (typeof agentContext?.runtime?.recordArtifact !== "function") return;
  const canvas = result?.canvas || result;
  const version = canvas?.current_version || result?.version;
  if (!(canvas?.id && version?.id)) return;
  await agentContext.runtime.recordArtifact({
    callId: toolCallId || null,
    kind: "canvas",
    path: null,
    mimeType: canvas.kind === "site" ? "text/html" : canvas.kind === "code" ? "text/plain" : "text/markdown",
    sizeBytes: version.size_bytes || null,
    sha256: version.sha256 || null,
    metadata: {
      action,
      canvas_id: canvas.id,
      canvas_version_id: version.id,
      version_number: version.version_number,
      session_id: canvas.session_id,
    },
  }).catch(() => null);
}

function canvasHostAction(agentContext, canvas, event = "canvas_opened") {
  const resolvedEvent = canvas?.kind === "site"
    ? (event === "canvas_updated" ? "site_updated" : event === "canvas_opened" ? "site_opened" : event)
    : event;
  return {
    type: "workspace_event",
    event: {
      type: "workspace_event",
      event: resolvedEvent,
      session_id: canvas?.session_id || agentContext?.session_id || null,
      project_id: canvas?.project_id || agentContext?.project_id || null,
      canvas_id: canvas?.id || null,
      canvas,
      open: true,
    },
  };
}

async function canvasInspectTool(agentContext, params = {}) {
  const scope = canvasToolSession(agentContext);
  if (scope.error) return errorResult(scope.error);
  const canvasId = String(params.canvas_id || "").trim();
  if (!canvasId) return errorResult("canvas_id 为必填项");
  const canvas = await getCanvas(makeCtx(agentContext), {
    userId: agentContext?.user_id || "",
    sessionId: scope.sessionId,
    canvasId,
  });
  return toolResult({ success: true, canvas });
}

async function canvasCreateTool(agentContext, params = {}, toolCallId = null) {
  const scope = canvasToolSession(agentContext);
  if (scope.error) return errorResult(scope.error);
  const result = await createCanvas(makeCtx(agentContext), {
    userId: agentContext?.user_id || "",
    sessionId: scope.sessionId,
    title: params.title,
    kind: params.kind,
    language: params.language,
    content: typeof params.content === "string" ? params.content : "",
    changeSummary: params.change_summary,
    source: canvasToolSource(agentContext, toolCallId),
    metadata: { created_by: "canvas_create" },
  });
  await recordCanvasArtifact(agentContext, toolCallId, result, "create");
  return withHostAction({ success: true, ...result }, canvasHostAction(agentContext, result.canvas));
}

async function canvasEditTool(agentContext, params = {}, toolCallId = null) {
  const scope = canvasToolSession(agentContext);
  if (scope.error) return errorResult(scope.error);
  const canvasId = String(params.canvas_id || "").trim();
  const baseVersionId = String(params.base_version_id || "").trim();
  if (!(canvasId && baseVersionId)) return errorResult("canvas_id 和 base_version_id 为必填项");
  const result = await editCanvas(makeCtx(agentContext), {
    userId: agentContext?.user_id || "",
    sessionId: scope.sessionId,
    canvasId,
    baseVersionId,
    ...(typeof params.content === "string" ? { content: params.content } : { operations: params.operations }),
    changeSummary: params.change_summary,
    source: canvasToolSource(agentContext, toolCallId),
    metadata: { edited_by: "canvas_edit" },
  });
  await recordCanvasArtifact(agentContext, toolCallId, result, "edit");
  return withHostAction({ success: true, ...result }, canvasHostAction(agentContext, result.canvas, "canvas_updated"));
}

async function canvasSuggestTool(agentContext, params = {}, toolCallId = null) {
  const scope = canvasToolSession(agentContext);
  if (scope.error) return errorResult(scope.error);
  const canvasId = String(params.canvas_id || "").trim();
  const baseVersionId = String(params.base_version_id || "").trim();
  if (!(canvasId && baseVersionId)) return errorResult("canvas_id 和 base_version_id 为必填项");
  const suggestion = await createCanvasSuggestion(makeCtx(agentContext), {
    userId: agentContext?.user_id || "",
    sessionId: scope.sessionId,
    canvasId,
    baseVersionId,
    start: params.start,
    end: params.end,
    selectedText: params.selected_text,
    replacementText: params.replacement_text,
    instruction: params.instruction,
    source: canvasToolSource(agentContext, toolCallId),
  });
  const canvas = await getCanvas(makeCtx(agentContext), {
    userId: agentContext?.user_id || "",
    sessionId: scope.sessionId,
    canvasId,
  });
  return withHostAction(
    { success: true, suggestion, canvas },
    canvasHostAction(agentContext, canvas, "canvas_suggestion_created"),
  );
}

async function artifactPublishTool(agentContext, params = {}, toolCallId = null) {
  const currentProjectId = String(agentContext?.project_id || "").trim();
  const pid = String(params?.project_id || currentProjectId).trim();
  if (agentContext?.temporary === true || agentContext?.input_data?.temporary === true) {
    return errorResult("临时聊天不会保存到 Library；文件仍保留在本轮临时工作区中。");
  }
  if (!pid) {
    return errorResult("当前对话没有可用的产物库。");
  }
  if (pid !== currentProjectId) {
    return errorResult("只能把当前项目工作区中的文件发布到当前项目产物库。");
  }
  const path = String(params.path || params.file_path || "").trim();
  if (!path) return errorResult("path 为必填项");
  const result = await publishProjectArtifact(agentContext.db, {
    userId: agentContext?.user_id || "",
    projectId: pid,
    sourcePath: path,
    allowedRoots: agentContext?.workspace_roots || [],
    artifactId: params.artifact_id,
    name: params.name,
    kind: params.kind,
    description: params.description,
    changeSummary: params.change_summary,
    source: {
      sessionId: agentContext?.session_id || null,
      turnId: agentContext?.runtime_turn_id || agentContext?.runtime?.turnId || agentContext?.task_id || null,
      runId: agentContext?.runtime?.runId || agentContext?.task_id || null,
      itemId: toolCallId || null,
      toolCallId: toolCallId || null,
    },
    metadata: { published_by: "artifact_publish" },
  });
  const artifact = result.artifact;
  await recordProjectArtifact(agentContext, toolCallId, result, { action: "publish" });
  return withHostAction({
    success: true,
    created: result.created,
    deduplicated: result.deduplicated,
    artifact,
  }, {
    type: "workspace_event",
    event: {
      type: "workspace_event",
      event: "artifact_published",
      project_id: pid,
      artifact_id: artifact.id,
      artifact,
      open: true,
    },
  });
}

function artifactToolProject(agentContext, params = {}) {
  const currentProjectId = String(agentContext?.project_id || "").trim();
  const pid = String(params?.project_id || currentProjectId).trim();
  if (agentContext?.temporary === true || agentContext?.input_data?.temporary === true) {
    return { error: "临时聊天不会保存办公产物；请切换到普通聊天或项目聊天。" };
  }
  if (!pid) return { error: "当前对话没有可用的产物库。" };
  if (pid !== currentProjectId) return { error: "只能读取或修改当前项目的产物。" };
  return { pid };
}

function artifactToolSource(agentContext, toolCallId) {
  return {
    sessionId: agentContext?.session_id || null,
    turnId: agentContext?.runtime_turn_id || agentContext?.runtime?.turnId || agentContext?.task_id || null,
    runId: agentContext?.runtime?.runId || agentContext?.task_id || null,
    itemId: toolCallId || null,
    toolCallId: toolCallId || null,
  };
}

async function recordProjectArtifact(agentContext, toolCallId, result, metadata = {}) {
  if (typeof agentContext?.runtime?.recordArtifact !== "function") return;
  const artifact = result?.artifact;
  const version = artifact?.current_version;
  if (!artifact || !version) return;
  await agentContext.runtime.recordArtifact({
    callId: toolCallId || null,
    kind: "project_artifact",
    path: version.snapshot_path || null,
    mimeType: version.mime_type || null,
    sizeBytes: version.size_bytes || null,
    sha256: version.sha256 || null,
    metadata: {
      project_artifact_id: artifact.id,
      project_artifact_version_id: version.id || null,
      version_number: version.version_number || null,
      deduplicated: Boolean(result?.deduplicated),
      ...metadata,
    },
  }).catch(() => null);
}

async function artifactOfficeInspectTool(agentContext, params = {}) {
  const scope = artifactToolProject(agentContext, params);
  if (scope.error) return errorResult(scope.error);
  const artifactId = String(params.artifact_id || "").trim();
  if (!artifactId) return errorResult("artifact_id 为必填项");
  const data = await inspectProjectOfficeArtifact(makeCtx(agentContext), {
    projectId: scope.pid,
    artifactId,
    versionId: params.version_id,
  });
  return toolResult({ success: true, ...data });
}

function officeArtifactHostAction(pid, result, eventName = "artifact_published") {
  const artifact = result?.artifact;
  return {
    type: "workspace_event",
    event: {
      type: "workspace_event",
      event: eventName,
      project_id: pid,
      artifact_id: artifact?.id || null,
      artifact,
      open: true,
    },
  };
}

async function artifactOfficeCreateTool(agentContext, params = {}, toolCallId = null) {
  const scope = artifactToolProject(agentContext, params);
  if (scope.error) return errorResult(scope.error);
  const result = await createProjectOfficeArtifact(makeCtx(agentContext), {
    projectId: scope.pid,
    format: params.format,
    name: params.name,
    title: params.title,
    content: params.content,
    specification: params.specification,
    description: params.description,
    source: artifactToolSource(agentContext, toolCallId),
  });
  await recordProjectArtifact(agentContext, toolCallId, result, { action: "office_create", office_format: params.format });
  return withHostAction({ success: true, ...result }, officeArtifactHostAction(scope.pid, result, "artifact_published"));
}

async function artifactOfficeEditTool(agentContext, params = {}, toolCallId = null) {
  const scope = artifactToolProject(agentContext, params);
  if (scope.error) return errorResult(scope.error);
  const artifactId = String(params.artifact_id || "").trim();
  const baseVersionId = String(params.base_version_id || "").trim();
  if (!(artifactId && baseVersionId)) return errorResult("artifact_id 和 base_version_id 为必填项");
  const result = await editProjectOfficeArtifact(makeCtx(agentContext), {
    projectId: scope.pid,
    artifactId,
    baseVersionId,
    operations: params.operations,
    changeSummary: params.change_summary,
    source: artifactToolSource(agentContext, toolCallId),
  });
  await recordProjectArtifact(agentContext, toolCallId, result, {
    action: "office_edit",
    office_format: result?.edit?.format || null,
    operation_count: Array.isArray(params.operations) ? params.operations.length : 0,
  });
  return withHostAction({ success: true, ...result }, officeArtifactHostAction(scope.pid, result, "artifact_edited"));
}

const PRODUCT_TOOL_HANDLERS = {
  ui_render: uiRenderTool,
  project_list: projectListTool,
  project_create: projectCreateTool,
  project_open: projectOpenTool,
  conversation_list: conversationListTool,
  conversation_create: conversationCreateTool,
  conversation_open: conversationOpenTool,
  conversation_rename: conversationRenameTool,
  conversation_archive: conversationArchiveTool,
  file_classify: fileClassifyTool,
  canvas_inspect: canvasInspectTool,
  canvas_create: canvasCreateTool,
  canvas_edit: canvasEditTool,
  canvas_suggest: canvasSuggestTool,
  artifact_publish: artifactPublishTool,
  artifact_office_inspect: artifactOfficeInspectTool,
  artifact_office_create: artifactOfficeCreateTool,
  artifact_office_edit: artifactOfficeEditTool,
  skill_list: skillListTool,
  skill_create: skillCreateTool,
  skill_update: skillUpdateTool,
  skill_toggle: skillToggleTool,
  skill_delete: skillDeleteTool,
  project_skill_list: projectSkillListTool,
};

const PARAMS = {
  ui_render: GENERATIVE_UI_TOOL_INPUT_SCHEMA,
  project_list: Type.Object({
    search: Type.Optional(Type.String({ description: "按项目名称搜索(可选)" })),
  }),
  project_create: Type.Object({
    name: Type.String({ description: "项目名称" }),
    description: Type.Optional(Type.String({ description: "项目描述" })),
  }),
  project_open: Type.Object({
    project_id: Type.String({ description: "要打开的项目 ID，必须来自 project_list 或其他可信工具结果" }),
  }),
  conversation_list: Type.Object({
    project_id: Type.Optional(Type.String({ description: "工作区或项目 ID；省略时使用当前工作区" })),
    archived: Type.Optional(Type.Boolean({ description: "是否只列出已归档对话，默认 false" })),
  }),
  conversation_create: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标工作区或项目 ID；省略时使用当前工作区" })),
    title: Type.Optional(Type.String({ description: "对话标题，默认“新对话”" })),
    description: Type.Optional(Type.String({ description: "对话说明" })),
    open: Type.Optional(Type.Boolean({ description: "创建后是否立即在界面打开，默认 false" })),
  }),
  conversation_open: Type.Object({
    project_id: Type.Optional(Type.String({ description: "对话所在工作区或项目 ID；省略时使用当前工作区" })),
    conversation_id: Type.String({ description: "要打开的对话 ID，必须来自 conversation_list 或 conversation_create" }),
  }),
  conversation_rename: Type.Object({
    project_id: Type.Optional(Type.String({ description: "对话所在工作区或项目 ID；省略时使用当前工作区" })),
    conversation_id: Type.String({ description: "要重命名的对话 ID" }),
    title: Type.String({ description: "新的对话标题，最长 60 个字符" }),
  }),
  conversation_archive: Type.Object({
    project_id: Type.Optional(Type.String({ description: "对话所在工作区或项目 ID；省略时使用当前工作区" })),
    conversation_id: Type.String({ description: "要归档或恢复的对话 ID" }),
    archived: Type.Optional(Type.Boolean({ description: "true 归档，false 恢复，默认 true" })),
  }),
  file_classify: Type.Object({
    paths: Type.Array(Type.String(), { description: "本地文件或目录路径列表" }),
    recursive: Type.Optional(Type.Boolean({ description: "目录是否递归扫描,默认 true" })),
  }),
  canvas_inspect: Type.Object({
    canvas_id: Type.String({ description: "当前对话中的 Canvas ID" }),
  }),
  canvas_create: Type.Object({
    title: Type.Optional(Type.String({ description: "Canvas 标题；省略时从正文生成" })),
    kind: Type.Optional(Type.String({ description: "document | code | site，默认 document；site 表示本地单文件 HTML" })),
    language: Type.Optional(Type.String({ description: "代码语言；Site 固定使用 html；文档可省略" })),
    content: Type.Optional(Type.String({ description: "Canvas 初始全文；Site 必须提供完整的单文件 HTML" })),
    change_summary: Type.Optional(Type.String({ description: "创建说明" })),
  }),
  canvas_edit: Type.Object({
    canvas_id: Type.String({ description: "当前对话中的 Canvas ID" }),
    base_version_id: Type.String({ description: "canvas_inspect 返回的当前版本 ID" }),
    content: Type.Optional(Type.String({ description: "替换后的完整正文；与 operations 二选一" })),
    operations: Type.Optional(Type.Array(Type.Object({
      type: Type.String({ description: "replace_range | replace_all" }),
      start: Type.Optional(Type.Number({ description: "replace_range 的 UTF-16 起点" })),
      end: Type.Optional(Type.Number({ description: "replace_range 的 UTF-16 终点" })),
      text: Type.String({ description: "替换文字" }),
    }), { description: "基于同一不可变版本的精确修改；范围不能重叠" })),
    change_summary: Type.Optional(Type.String({ description: "本次修改摘要" })),
  }),
  canvas_suggest: Type.Object({
    canvas_id: Type.String({ description: "当前对话中的 Canvas ID" }),
    base_version_id: Type.String({ description: "canvas_inspect 返回的当前版本 ID" }),
    start: Type.Number({ description: "所选文字的 UTF-16 起点" }),
    end: Type.Number({ description: "所选文字的 UTF-16 终点" }),
    selected_text: Type.String({ description: "Canvas 当前版本中的原文字，服务端会逐字校验" }),
    replacement_text: Type.String({ description: "建议替换成的文字" }),
    instruction: Type.Optional(Type.String({ description: "建议理由或用户的改写要求" })),
  }),
  artifact_publish: Type.Object({
    project_id: Type.Optional(Type.String({ description: "当前项目 ID；在项目会话中省略" })),
    path: Type.String({ description: "当前项目授权目录或本轮运行工作区中的文件绝对路径" }),
    artifact_id: Type.Optional(Type.String({ description: "更新已有产物时使用其稳定 ID；首次发布或同一路径更新时省略" })),
    name: Type.Optional(Type.String({ description: "产物显示名称；省略时使用文件名" })),
    kind: Type.Optional(Type.String({ description: "report | document | table | image | code | template | file；省略时按文件判断" })),
    description: Type.Optional(Type.String({ description: "产物用途或内容说明" })),
    change_summary: Type.Optional(Type.String({ description: "本版相对上一版的简短变化说明" })),
  }),
  artifact_office_inspect: Type.Object({
    project_id: Type.Optional(Type.String({ description: "当前项目 ID；在项目会话中省略" })),
    artifact_id: Type.String({ description: "项目产物的稳定 ID" }),
    version_id: Type.Optional(Type.String({ description: "要读取的版本 ID；省略时读取当前版本" })),
  }),
  artifact_office_create: Type.Object({
    project_id: Type.Optional(Type.String({ description: "当前项目 ID；在项目会话中省略" })),
    format: Type.String({ description: "markdown | docx | xlsx | pptx | pdf" }),
    name: Type.Optional(Type.String({ description: "含正确扩展名的文件名；省略时根据标题生成" })),
    title: Type.Optional(Type.String({ description: "文档或演示文稿标题" })),
    content: Type.Optional(Type.String({ description: "新产物的基础正文" })),
    description: Type.Optional(Type.String({ description: "产物用途说明" })),
    specification: Type.Optional(Type.Object({}, { additionalProperties: true, description: "格式专用结构，例如工作表 rows 或幻灯片 slides" })),
  }),
  artifact_office_edit: Type.Object({
    project_id: Type.Optional(Type.String({ description: "当前项目 ID；在项目会话中省略" })),
    artifact_id: Type.String({ description: "项目产物的稳定 ID" }),
    base_version_id: Type.String({ description: "artifact_office_inspect 返回的当前版本 ID" }),
    operations: Type.Array(Type.Object({
      type: Type.String({ description: "replace_text | replace_range | set_cell | clear_cell | set_range | annotate_region | cover_text" }),
      anchor: Type.Optional(Type.String({ description: "检查结果返回的稳定锚点" })),
      text: Type.Optional(Type.String({ description: "替换文字或 PDF 批注内容" })),
      start: Type.Optional(Type.Any({ description: "文字起点，或 set_range 的 A1 起点" })),
      end: Type.Optional(Type.Number({ description: "文字终点" })),
      sheet: Type.Optional(Type.String({ description: "XLSX 工作表名" })),
      address: Type.Optional(Type.String({ description: "XLSX 单元格 A1 地址" })),
      value: Type.Optional(Type.Any({ description: "单元格值" })),
      formula: Type.Optional(Type.String({ description: "以 = 开头的 Excel 公式" })),
      values: Type.Optional(Type.Array(Type.Array(Type.Any()), { description: "set_range 使用的二维值数组" })),
      page: Type.Optional(Type.Number({ description: "PDF 页码，从 1 开始" })),
      rect: Type.Optional(Type.Object({
        x: Type.Number(), y: Type.Number(), width: Type.Number(), height: Type.Number(),
      }, { description: "PDF 页面 0 到 1 的比例坐标" })),
      color: Type.Optional(Type.String({ description: "PDF 标注颜色，例如 #8b5cf6" })),
    }, { additionalProperties: true }), { description: "按顺序执行的定点修改" }),
    change_summary: Type.Optional(Type.String({ description: "本次修改摘要" })),
  }),
  skill_list: Type.Object({}),
  skill_create: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
    description: Type.String({ description: "Skill 描述" }),
    instructions: Type.String({ description: "Skill 指令 Markdown" }),
    allow_implicit_invocation: Type.Optional(Type.Boolean({ description: "是否允许主 Agent 自动使用;默认 true" })),
    is_enabled: Type.Optional(Type.Boolean({ description: "是否启用;默认 true" })),
  }),
  skill_update: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
    description: Type.Optional(Type.String({ description: "Skill 描述" })),
    instructions: Type.Optional(Type.String({ description: "Skill 指令 Markdown" })),
    allow_implicit_invocation: Type.Optional(Type.Boolean({ description: "是否允许主 Agent 自动使用" })),
  }),
  skill_toggle: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
    is_enabled: Type.Boolean({ description: "Agent Skill 启用状态" }),
  }),
  skill_delete: Type.Object({
    name: Type.String({ description: "Skill 名称" }),
  }),
  project_skill_list: Type.Object({
    project_id: Type.Optional(Type.String({ description: "目标项目 ID;在项目会话中可省略" })),
  }),
};

export function createProductTools(agentContext) {
  const hasDb = !!agentContext?.db?.query && !!agentContext?.db?.queryOne;
  if (!hasDb) return [];
  return PRODUCT_TOOL_CATALOG.filter((def) => (
    def.implementation !== "delegated"
    && (def.name !== "ui_render" || agentContext?.generativeUi === true)
  )).map((def) => {
    return {
      name: def.name,
      description: def.description,
      parameters: PARAMS[def.name] || Type.Object({}),
      host_action_capable: HOST_ACTION_TOOL_NAMES.has(def.name),
      ...(def.output_contract ? { output_contract: def.output_contract } : {}),
      side_effect: def.safety || "read",
      execute: async (_toolCallId, params, callSignal = null) => {
        const handler = PRODUCT_TOOL_HANDLERS[def.name];
        if (!handler) return errorResult(`工具未实现: ${def.name}`);
        const signal = callSignal || agentContext?.signal || null;
        const context = invocationContext(agentContext, signal);
        try {
          throwIfAborted(signal);
          const result = await handler(context, params || {}, _toolCallId, signal);
          throwIfAborted(signal);
          return result;
        } catch (e) {
          if (signal?.aborted === true) throw e;
          return errorResult(e?.message || String(e), { tool: def.name });
        }
      },
    };
  });
}
