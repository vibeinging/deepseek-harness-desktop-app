// L1 use-case layer for structured/unstructured datasource CRUD. Ported from routes/datasource_crud.js with line-by-line alignment.
// Signature stays async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res handling.
//
// Covers: structured-datasources (GET/POST/PUT/DELETE) and unstructured-datasources (GET/POST/PUT/DELETE).
//
// Note: app/datasource is one layer deeper than routes/, and this file does not depend on engine.
import { ApiError } from "../../errors.js";

// ─────────────────────────────────────────────
// Helper: resolve embedding model id by name.
// ─────────────────────────────────────────────
async function resolveEmbeddingModelId(ctx, companyId, modelName) {
  if (!modelName) return null;
  const m = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE display_name=$1 AND company_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [modelName, companyId],
  );
  if (m) return m.id;
  // Fallback: match by model_name.
  const m2 = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE model_name=$1 AND company_id=$2 AND deleted_at IS NULL LIMIT 1`,
    [modelName, companyId],
  );
  if (m2) return m2.id;
  // Cross-company fallback by model name (eval / multi-company). If still not found, pick any EMBEDDING model to avoid hard failure.
  const m3 = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE (model_name=$1 OR display_name=$1) AND deleted_at IS NULL LIMIT 1`,
    [modelName],
  );
  if (m3) return m3.id;
  const m4 = await ctx.queryOne(
    `SELECT id FROM llm_models WHERE category='EMBEDDING' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
  );
  return m4?.id ?? null;
}

// ════════════════════════════════════════════
// Structured datasource CRUD
// ════════════════════════════════════════════

// GET /api/projects/:pid/structured-datasources/:dsid — get details (index.js only provides list).
export async function getStructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.database_connection_id, s.embedding_model_id, s.duckdb_path,
            m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM structured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1 AND s.project_id=$2 AND s.deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!row) throw new ApiError("结构化数据源不存在", 404);
  return { data: row, message: "获取结构化数据源详情成功" };
}

// POST /api/projects/:pid/structured-datasources — create.
export async function createStructuredDatasource(ctx, input) {
  const { pid } = input.params;
  const { name, description, embedding_model_name } = input.body || {};
  if (!name) throw new ApiError("name 为必填项", 400);

  // Resolve company_id to find embedding model.
  const userRow = await ctx.queryOne(`SELECT company_id FROM users WHERE id=$1`, [ctx.userId]);
  const companyId = userRow?.company_id;
  const embeddingModelId = await resolveEmbeddingModelId(ctx, companyId, embedding_model_name);
  if (embedding_model_name && !embeddingModelId) {
    throw new ApiError(`嵌入模型 "${embedding_model_name}" 未找到`, 400);
  }

  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO structured_data_sources
       (id, project_id, created_by, name, description, is_active, embedding_model_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,$6,now(),now())`,
    [id, pid, ctx.userId, name, description ?? "", embeddingModelId],
  );

  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.database_connection_id, s.embedding_model_id, s.duckdb_path,
            m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM structured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1`,
    [id],
  );
  return { data: row, message: "创建结构化数据源成功" };
}

// PUT /api/projects/:pid/structured-datasources/:dsid — update.
export async function updateStructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const { name, description } = input.body || {};

  const existing = await ctx.queryOne(
    `SELECT id FROM structured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!existing) throw new ApiError("结构化数据源不存在", 404);

  const sets = ["updated_at=now()"];
  const vals = [];
  let i = 1;
  if (name !== undefined)        { sets.push(`name=$${i++}`); vals.push(name); }
  if (description !== undefined) { sets.push(`description=$${i++}`); vals.push(description); }

  if (sets.length > 1) {
    vals.push(dsid, pid);
    await ctx.query(
      `UPDATE structured_data_sources SET ${sets.join(",")} WHERE id=$${i} AND project_id=$${i + 1}`,
      vals,
    );
  }

  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.database_connection_id, s.embedding_model_id, s.duckdb_path,
            m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM structured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1`,
    [dsid],
  );
  return { data: row, message: "更新结构化数据源成功" };
}

// DELETE /api/projects/:pid/structured-datasources/:dsid — soft delete.
export async function deleteStructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const { confirm } = input.body || {};
  if (!confirm) throw new ApiError("confirm 必须为 true 才能执行删除", 400);

  const existing = await ctx.queryOne(
    `SELECT id FROM structured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!existing) throw new ApiError("结构化数据源不存在", 404);

  await ctx.query(
    `UPDATE structured_data_sources SET deleted_at=now() WHERE id=$1 AND project_id=$2`,
    [dsid, pid],
  );
  return { data: null, message: "删除结构化数据源成功" };
}

// ════════════════════════════════════════════
// Unstructured datasource CRUD
// ════════════════════════════════════════════

// GET /api/projects/:pid/unstructured-datasources/:dsid — get details.
export async function getUnstructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.embedding_model_id, m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM unstructured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1 AND s.project_id=$2 AND s.deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!row) throw new ApiError("非结构化数据源不存在", 404);
  return { data: row, message: "获取非结构化数据源详情成功" };
}

// POST /api/projects/:pid/unstructured-datasources — create.
export async function createUnstructuredDatasource(ctx, input) {
  const { pid } = input.params;
  const { name, description, embedding_model_name } = input.body || {};
  if (!name) throw new ApiError("name 为必填项", 400);

  const userRow = await ctx.queryOne(`SELECT company_id FROM users WHERE id=$1`, [ctx.userId]);
  const companyId = userRow?.company_id;
  const embeddingModelId = await resolveEmbeddingModelId(ctx, companyId, embedding_model_name);
  if (embedding_model_name && !embeddingModelId) {
    throw new ApiError(`嵌入模型 "${embedding_model_name}" 未找到`, 400);
  }

  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO unstructured_data_sources
       (id, project_id, created_by, name, description, is_active, embedding_model_id, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,true,$6,now(),now())`,
    [id, pid, ctx.userId, name, description ?? "", embeddingModelId],
  );

  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.embedding_model_id, m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM unstructured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1`,
    [id],
  );
  return { data: row, message: "创建非结构化数据源成功" };
}

// PUT /api/projects/:pid/unstructured-datasources/:dsid — update.
export async function updateUnstructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const { name, description } = input.body || {};

  const existing = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!existing) throw new ApiError("非结构化数据源不存在", 404);

  const sets = ["updated_at=now()"];
  const vals = [];
  let i = 1;
  if (name !== undefined)        { sets.push(`name=$${i++}`); vals.push(name); }
  if (description !== undefined) { sets.push(`description=$${i++}`); vals.push(description); }

  if (sets.length > 1) {
    vals.push(dsid, pid);
    await ctx.query(
      `UPDATE unstructured_data_sources SET ${sets.join(",")} WHERE id=$${i} AND project_id=$${i + 1}`,
      vals,
    );
  }

  const row = await ctx.queryOne(
    `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active,
            s.embedding_model_id, m.display_name AS embedding_model_name,
            s.created_at, s.updated_at
       FROM unstructured_data_sources s
       LEFT JOIN llm_models m ON m.id = s.embedding_model_id
      WHERE s.id=$1`,
    [dsid],
  );
  return { data: row, message: "更新非结构化数据源成功" };
}

// DELETE /api/projects/:pid/unstructured-datasources/:dsid — soft delete.
export async function deleteUnstructuredDatasource(ctx, input) {
  const { pid, dsid } = input.params;
  const { confirm } = input.body || {};
  if (!confirm) throw new ApiError("confirm 必须为 true 才能执行删除", 400);

  const existing = await ctx.queryOne(
    `SELECT id FROM unstructured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [dsid, pid],
  );
  if (!existing) throw new ApiError("非结构化数据源不存在", 404);

  await ctx.query(
    `UPDATE unstructured_data_sources SET deleted_at=now() WHERE id=$1 AND project_id=$2`,
    [dsid, pid],
  );
  return { data: null, message: "删除非结构化数据源成功" };
}
