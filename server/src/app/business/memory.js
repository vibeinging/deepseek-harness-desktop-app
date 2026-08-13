// L1 use-case layer for disambiguation memory (team mapping memory) CRUD, aligned line-by-line with routes/business_crud.js.
// Python implementation is api/routes/memory.py; service logic is in engine/semantic/disambiguation_service.js.
// Signature is always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
//
// Coverage: GET(list/pagination/search), POST(create one/many keywords), PUT(:rid),
//          POST bulk_import / bulk_delete, DELETE /:rid
//
// Note: app/business/ is one layer deeper than routes/, so engine/db uses ../../.
import { ApiError } from "../../errors.js";
import { DisambiguationService } from "../../engine/semantic/disambiguation_service.js";

// ─────────────────────────────────────────────
// Service exceptions with BaseAPIError (statusCode) map to HTTP status.
// routes memErr(res, e) behavior is preserved here by throwing ApiError.
// Keep 5xx logs.
// ─────────────────────────────────────────────
function toApiError(e) {
  const code = e?.statusCode || e?.status_code || 500;
  if (code >= 500) console.warn(`[memory] ${e?.stack || e?.message || e}`);
  return new ApiError(e?.message || "操作失败", code);
}

// GET /api/projects/:pid/businesses/:bid/memory — list (pagination + search)
export async function listMemory(ctx, input) {
  const { pid } = input.params;
  const limit = Math.min(Math.max(parseInt(input.query.limit, 10) || 20, 1), 1000);
  const offset = Math.max(parseInt(input.query.offset, 10) || 0, 0);
  const search = input.query.search || null;
  const svcCtx = { query: ctx.query, queryOne: ctx.queryOne };
  try {
    const result = await DisambiguationService.list_resolutions(svcCtx, pid, { limit, offset, search });
    return { data: { items: result.items, total: result.total }, message: "获取消歧记忆成功" };
  } catch (e) { throw toApiError(e); }
}

// POST /api/projects/:pid/businesses/:bid/memory — create (supports one keyword or keywords[]; same unique-key upsert)
export async function createMemory(ctx, input) {
  const { pid, bid } = input.params;
  const b = input.body || {};
  const svcCtx = { query: ctx.query, queryOne: ctx.queryOne };
  const keywords = (Array.isArray(b.keywords) && b.keywords.length) ? b.keywords : (b.keyword ? [b.keyword] : []);
  if (!keywords.length) throw new ApiError("keyword 或 keywords 不能为空", 400);
  const ids = []; const failed = [];
  for (const kw of keywords) {
    try {
      const id = await DisambiguationService.create_manual(svcCtx, {
        project_id: pid,
        source_table: b.source_table, source_column: b.source_column,
        keyword: kw, chosen_value: b.chosen_value, created_by: ctx.userId,
      });
      if (id) ids.push(id);
    } catch (e) {
      if (e?.statusCode && e.statusCode < 500) failed.push(kw);
      else throw toApiError(e);
    }
  }
  return {
    data: { ids, success_count: ids.length, failed_keywords: failed },
    message: failed.length ? `成功 ${ids.length},失败 ${failed.length}(关键词:${failed.join(", ")})` : `已创建 ${ids.length} 条记忆`,
  };
}

// PUT /api/projects/:pid/businesses/:bid/memory/:rid — update one
export async function updateMemory(ctx, input) {
  const { pid, rid } = input.params;
  const b = input.body || {};
  const svcCtx = { query: ctx.query, queryOne: ctx.queryOne };
  try {
    await DisambiguationService.update_resolution(svcCtx, {
      resolution_id: rid, project_id: pid,
      chosen_value: b.chosen_value ?? null, source_table: b.source_table ?? null,
      source_column: b.source_column ?? null, keyword: b.keyword ?? null,
    });
    return { data: { id: rid }, message: "更新成功" };
  } catch (e) { throw toApiError(e); }
}

// POST /api/projects/:pid/businesses/:bid/memory/bulk_import — bulk import (frontend parses Excel into rows[])
export async function bulkImportMemory(ctx, input) {
  const { pid } = input.params;
  const b = input.body || {};
  const svcCtx = { query: ctx.query, queryOne: ctx.queryOne };
  try {
    const result = await DisambiguationService.bulk_import_from_excel(svcCtx, {
      project_id: pid, rows: b.rows || null,
      created_by: ctx.userId, overwrite: b.overwrite !== false,
    });
    return { data: result, message: result?.message || "导入完成" };
  } catch (e) { throw toApiError(e); }
}

// POST /api/projects/:pid/businesses/:bid/memory/bulk_delete — bulk delete
export async function bulkDeleteMemory(ctx, input) {
  const { pid } = input.params;
  const ids = (input.body || {}).ids;
  const svcCtx = { query: ctx.query, queryOne: ctx.queryOne };
  if (!Array.isArray(ids) || !ids.length) throw new ApiError("ids 不能为空", 400);
  try {
    const deleted = await DisambiguationService.bulk_delete_resolutions(svcCtx, { ids, project_id: pid, deleted_by: ctx.userId });
    return { data: { deleted_count: deleted, requested: ids.length }, message: `已删除 ${deleted} 条` };
  } catch (e) { throw toApiError(e); }
}

// DELETE /api/projects/:pid/businesses/:bid/memory/:rid — delete one
export async function deleteMemory(ctx, input) {
  const { rid } = input.params;
  const svcCtx = { query: ctx.query, queryOne: ctx.queryOne };
  try {
    const deleted = await DisambiguationService.delete_resolution(svcCtx, rid, { deleted_by: ctx.userId });
    if (!deleted) throw new ApiError("记忆不存在或已删除", 404);
    return { data: { id: rid, deleted: true }, message: "删除成功" };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw toApiError(e);
  }
}
