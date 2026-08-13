import {
  createCanvas,
  createCanvasSuggestion,
  decideCanvasSuggestion,
  editCanvas,
  getCanvas,
  getCanvasVersion,
  listSessionCanvases,
  restoreCanvasVersion,
} from "../../engine/agents/canvas_store.js";

function clean(value) {
  return String(value || "").trim();
}

function manualSource() {
  return { type: "user" };
}

// GET /api/agent/sessions/:sid/canvases
export async function listCanvases(ctx, input) {
  const items = await listSessionCanvases(ctx, {
    userId: ctx.userId,
    sessionId: input.params?.sid,
    limit: input.query?.limit,
  });
  return { data: { items }, message: "获取 Canvas 成功" };
}

// POST /api/agent/sessions/:sid/canvases
export async function createSessionCanvas(ctx, input) {
  const result = await createCanvas(ctx, {
    userId: ctx.userId,
    sessionId: input.params?.sid,
    title: input.body?.title,
    kind: input.body?.kind,
    language: input.body?.language,
    content: typeof input.body?.content === "string" ? input.body.content : "",
    changeSummary: input.body?.change_summary,
    source: manualSource(),
    metadata: { created_from: "canvas_ui" },
  });
  return { data: result, message: result.deduplicated ? "Canvas 已存在" : "已创建 Canvas" };
}

// GET /api/agent/sessions/:sid/canvases/:canvasId
export async function getSessionCanvas(ctx, input) {
  const data = await getCanvas(ctx, {
    userId: ctx.userId,
    sessionId: input.params?.sid,
    canvasId: input.params?.canvasId,
  });
  return { data, message: "获取 Canvas 详情成功" };
}

// GET /api/agent/sessions/:sid/canvases/:canvasId/versions/:versionId
export async function getSessionCanvasVersion(ctx, input) {
  const data = await getCanvasVersion(ctx, {
    userId: ctx.userId,
    sessionId: input.params?.sid,
    canvasId: input.params?.canvasId,
    versionId: input.params?.versionId,
  });
  return { data, message: "获取 Canvas 版本成功" };
}

// POST /api/agent/sessions/:sid/canvases/:canvasId/edits
export async function editSessionCanvas(ctx, input) {
  const hasContent = typeof input.body?.content === "string";
  const result = await editCanvas(ctx, {
    userId: ctx.userId,
    sessionId: input.params?.sid,
    canvasId: input.params?.canvasId,
    baseVersionId: input.body?.base_version_id,
    ...(hasContent ? { content: input.body.content } : { operations: input.body?.operations }),
    changeSummary: input.body?.change_summary,
    source: manualSource(),
    metadata: { edited_from: "canvas_ui" },
  });
  return { data: result, message: result.deduplicated ? "Canvas 内容没有变化" : "已保存 Canvas 新版本" };
}

// POST /api/agent/sessions/:sid/canvases/:canvasId/restore
export async function restoreSessionCanvas(ctx, input) {
  const result = await restoreCanvasVersion(ctx, {
    userId: ctx.userId,
    sessionId: input.params?.sid,
    canvasId: input.params?.canvasId,
    baseVersionId: input.body?.base_version_id,
    versionId: input.body?.version_id,
    changeSummary: input.body?.change_summary,
    source: manualSource(),
  });
  return { data: result, message: result.deduplicated ? "该版本已经是当前内容" : "已恢复为新的 Canvas 版本" };
}

// POST /api/agent/sessions/:sid/canvases/:canvasId/suggestions
export async function addSessionCanvasSuggestion(ctx, input) {
  const suggestion = await createCanvasSuggestion(ctx, {
    userId: ctx.userId,
    sessionId: input.params?.sid,
    canvasId: input.params?.canvasId,
    baseVersionId: input.body?.base_version_id,
    start: input.body?.start,
    end: input.body?.end,
    selectedText: input.body?.selected_text,
    replacementText: input.body?.replacement_text,
    instruction: input.body?.instruction,
    source: manualSource(),
  });
  return { data: { suggestion }, message: "已添加 Canvas 建议" };
}

// POST /api/agent/sessions/:sid/canvases/:canvasId/suggestions/:suggestionId/decision
export async function decideSessionCanvasSuggestion(ctx, input) {
  const decision = clean(input.body?.decision);
  const result = await decideCanvasSuggestion(ctx, {
    userId: ctx.userId,
    sessionId: input.params?.sid,
    canvasId: input.params?.canvasId,
    suggestionId: input.params?.suggestionId,
    decision,
    source: manualSource(),
  });
  return { data: result, message: decision === "accept" ? "已接受 Canvas 建议" : "已拒绝 Canvas 建议" };
}

export default {
  listCanvases,
  createSessionCanvas,
  getSessionCanvas,
  getSessionCanvasVersion,
  editSessionCanvas,
  restoreSessionCanvas,
  addSessionCanvasSuggestion,
  decideSessionCanvasSuggestion,
};
