// L1 use-case layer for read-only datasource endpoints: connection list/details, tables/columns, relationships,
// sync-pending state, structured/unstructured sources, and supported types.
// Copied from index.js GET handlers with line-by-line alignment.
// Signature is always async fn(ctx, input) -> { data, message } | throw ApiError.
import { ApiError } from "../../errors.js";
import { PluginRegistry } from "../../engine/datasources/plugins/index.js";
import {
  requireProjectDatabaseConnection,
  requireProjectTable,
} from "../datasource/project_database_access.js";

async function embeddingModelOptions(ctx, projectId) {
  const rows = await ctx.query(
    `SELECT id, model_name, display_name
       FROM llm_models
      WHERE category='EMBEDDING' AND deleted_at IS NULL
        AND (project_id=$1 OR project_id IS NULL)
        AND company_id=(SELECT company_id FROM users WHERE id=$2 LIMIT 1)
      ORDER BY is_enabled DESC, created_at DESC`,
    [projectId, ctx.userId],
  );
  const seen = new Set();
  return rows.flatMap((row) => {
    const name = String(row.display_name || row.model_name || "").trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [{ value: name, label: name }];
  });
}

// GET /api/projects/:pid/databases — list database connections (hide password, expose only has_password)
export async function listDatabases(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, name, db_type, is_virtual, host, port, username, database AS db_name,
            description, created_at, updated_at,
            CASE WHEN password IS NULL OR password='' THEN false ELSE true END AS has_password
       FROM database_connections WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取数据库连接成功" };
}

// GET /api/projects/:pid/databases/meta/supported-types — supported database types (from plugin registry)
// Frontend GuideStepSelectType reads data.items[].{value,label,default_port,multiple_schema,description}.
// Return as {items} and keep multiple_schema as 'True'/'False' strings (normalized in selectableTypes).
export async function listSupportedDbTypes(_ctx, _input) {
  const items = PluginRegistry.selectableTypes();
  return { data: { items, total: items.length }, message: "获取支持的数据库类型成功" };
}

// GET /api/projects/:pid/structured-data-sources — structured data sources (hyphenated path)
export async function listStructuredDataSourcesHyphen(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, name, description, folder_path, is_active, database_connection_id, created_at
       FROM structured_data_sources WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取结构化数据源成功" };
}

// GET /api/projects/:pid/unstructured-data-sources — unstructured data sources (hyphenated path)
export async function listUnstructuredDataSourcesHyphen(ctx, input) {
  const rows = await ctx.query(
    `SELECT id, project_id, name, description, folder_path, is_active, created_at
       FROM unstructured_data_sources WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取非结构化数据源成功" };
}

// GET /api/projects/:pid/structured-datasources — structured data sources (actual backend path, no hyphen; includes embedding model name)
export async function listStructuredDatasources(ctx, input) {
  const [rows, modelOptions] = await Promise.all([
    ctx.query(
      `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active, s.database_connection_id,
              s.embedding_model_id, m.display_name AS embedding_model_name, s.duckdb_path, s.created_at, s.updated_at
         FROM structured_data_sources s LEFT JOIN llm_models m ON m.id = s.embedding_model_id
        WHERE s.project_id=$1 AND s.deleted_at IS NULL ORDER BY s.created_at DESC`,
      [input.params.pid],
    ),
    embeddingModelOptions(ctx, input.params.pid),
  ]);
  return {
    data: { items: rows, total: rows.length, embedding_model_options: modelOptions },
    message: "获取结构化数据源成功",
  };
}

// GET /api/projects/:pid/unstructured-datasources — unstructured data sources (actual backend path, no hyphen)
export async function listUnstructuredDatasources(ctx, input) {
  const [rows, modelOptions] = await Promise.all([
    ctx.query(
      `SELECT s.id, s.project_id, s.name, s.description, s.folder_path, s.is_active, s.embedding_model_id,
              m.display_name AS embedding_model_name, s.created_at, s.updated_at
         FROM unstructured_data_sources s LEFT JOIN llm_models m ON m.id = s.embedding_model_id
        WHERE s.project_id=$1 AND s.deleted_at IS NULL ORDER BY s.created_at DESC`,
      [input.params.pid],
    ),
    embeddingModelOptions(ctx, input.params.pid),
  ]);
  return {
    data: { items: rows, total: rows.length, embedding_model_options: modelOptions },
    message: "获取非结构化数据源成功",
  };
}

// GET /api/projects/:pid/databases/:cid — database connection detail
export async function getDatabase(ctx, input) {
  const c = await ctx.queryOne(
    `SELECT id, project_id, name, db_type, is_virtual, host, port, username, database AS db_name,
            description, schema_config, extra_config, business_rules, created_at, updated_at
       FROM database_connections WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [input.params.cid, input.params.pid],
  );
  if (!c) throw new ApiError("数据库连接不存在", 404);
  return { data: c, message: "获取连接成功" };
}

// GET /api/projects/:pid/databases/:cid/tables — table list
export async function listTables(ctx, input) {
  await requireProjectDatabaseConnection(ctx, input.params.pid, input.params.cid);
  const rows = await ctx.query(
    `WITH column_stats AS (
       SELECT c.table_id,
              COUNT(*) AS column_count,
              SUM(CASE WHEN c.description IS NOT NULL AND TRIM(c.description) <> '' THEN 1 ELSE 0 END)
                AS columns_with_description,
              SUM(CASE WHEN c.embedding IS NOT NULL AND TRIM(CAST(c.embedding AS TEXT)) <> '' THEN 1 ELSE 0 END)
                AS columns_with_vectors
         FROM column_metadata c
         JOIN table_metadata target ON target.id=c.table_id
        WHERE c.deleted_at IS NULL AND target.deleted_at IS NULL
          AND target.database_connection_id=$1
        GROUP BY c.table_id
     )
     SELECT t.id, t.database_connection_id, t.schema_name, t.table_name, t.table_type,
            t.description, t.keywords, t.row_count, t.is_view, t.is_materialized,
            t.is_high_recall, t.structured_document_id, t.last_analyzed_at,
            t.created_at, t.updated_at,
            COALESCE(cs.column_count, 0) AS column_count,
            COALESCE(cs.columns_with_description, 0) AS columns_with_description,
            CASE WHEN t.embedding IS NOT NULL AND TRIM(CAST(t.embedding AS TEXT)) <> ''
              THEN 1 ELSE 0 END AS has_embedding,
            COALESCE(cs.columns_with_vectors, 0) AS columns_with_vectors
       FROM table_metadata t
       LEFT JOIN column_stats cs ON cs.table_id=t.id
      WHERE t.database_connection_id=$1 AND t.deleted_at IS NULL
      ORDER BY t.schema_name, t.table_name`,
    [input.params.cid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取表列表成功" };
}

// GET /api/projects/:pid/databases/:cid/tables/:tid/columns — column list
export async function listColumns(ctx, input) {
  await requireProjectTable(ctx, input.params.pid, input.params.cid, input.params.tid);
  const rows = await ctx.query(
    `SELECT id, table_id, column_name, data_type, is_nullable, default_value, is_primary_key,
            is_foreign_key, is_unique, is_indexed, distinct_values, description, keywords,
            example_values, is_high_recall, created_at, updated_at
       FROM column_metadata WHERE table_id=$1 AND deleted_at IS NULL ORDER BY created_at`,
    [input.params.tid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取字段列表成功" };
}

// GET /api/projects/:pid/databases/:cid/relationships — table relationships
export async function listRelationships(ctx, input) {
  await requireProjectDatabaseConnection(ctx, input.params.pid, input.params.cid);
  const rows = await ctx.query(
    `SELECT r.id, r.database_connection_id, r.source_table_id, r.target_table_id,
            r.source_column, r.target_column, r.relationship_type, r.constraint_name,
            r.description, r.created_at, r.updated_at,
            st.table_name AS source_table_name, st.schema_name AS source_schema_name,
            tt.table_name AS target_table_name, tt.schema_name AS target_schema_name
       FROM relationship_metadata r
       LEFT JOIN table_metadata st ON st.id = r.source_table_id
       LEFT JOIN table_metadata tt ON tt.id = r.target_table_id
      WHERE r.database_connection_id=$1 AND r.deleted_at IS NULL
      ORDER BY r.created_at DESC`,
    [input.params.cid],
  ).catch(() => []);
  return { data: { items: rows, total: rows.length }, message: "获取表关系成功" };
}

// GET /api/projects/:pid/databases/:cid/sync_pending — sync pending status
export async function getSyncPending(ctx, input) {
  await requireProjectDatabaseConnection(ctx, input.params.pid, input.params.cid);
  return {
    data: { pending: false, count: 0, is_full_sync: true, table_ids: [], table_keys: [] },
    message: "无待同步",
  };
}
