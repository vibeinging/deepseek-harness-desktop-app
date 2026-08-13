// L1 use-case layer for business read-only endpoints:
// business detail / data source bindings / semantic resources (metrics, entities, metric views, examples).
// Copied from index.js GET handlers with line-by-line alignment.
// Signature is always async fn(ctx, input) -> { data, message }; throw ApiError on fail.
import { ApiError } from "../../errors.js";
import { listMetricExecutionPlans } from "../../engine/semantic/metric_execution_service.js";

function paging(input) {
  const page = Math.max(1, Number(input.query?.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(input.query?.page_size || 20)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function shapeMetric(row, executionPlans = []) {
  return {
    ...row,
    aliases: parseJson(row.aliases, []),
    execution_plans: executionPlans,
    related_tables: parseJson(row.related_tables, []),
    related_columns: parseJson(row.related_columns, {}),
    code_knowledge: parseJson(row.code_knowledge, null),
  };
}

function shapeMetricView(row) {
  return {
    ...row,
    aliases: parseJson(row.aliases, []),
    tables: parseJson(row.tables, []),
    fixed_predicates: parseJson(row.fixed_predicates, []),
    query_dimensions: parseJson(row.query_dimensions, []),
    time_dimension: parseJson(row.time_dimension, null),
    projections: parseJson(row.projections, []),
    group_by: parseJson(row.group_by, []),
    sort_spec: parseJson(row.sort_spec, {}),
  };
}

// GET /api/projects/:pid/businesses — business list (with data source count)
export async function listBusinesses(ctx, input) {
  const rows = await ctx.query(
    `SELECT b.id, b.project_id, b.name, b.description, b.created_at, b.updated_at,
            COALESCE(c.cnt, 0)::int AS data_source_count
       FROM businesses b
       LEFT JOIN (SELECT project_id, COUNT(*) AS cnt FROM business_data_sources WHERE deleted_at IS NULL GROUP BY project_id) c
         ON c.project_id = b.id
      WHERE b.project_id=$1 AND b.deleted_at IS NULL ORDER BY b.created_at DESC`,
    [input.params.pid],
  );
  return { data: { items: rows, total: rows.length }, message: "获取业务列表成功" };
}

// GET /api/projects/:pid/business — business detail by project (project is treated as business; no 404)
// Read businesses table by project_id; if not found, return a synthetic business object built from project_id
// so frontend always receives a business context.
export async function getBusiness(ctx, input) {
  const { pid } = input.params;
  const b = await ctx.queryOne(
    `SELECT id, project_id, name, description, created_at, updated_at
       FROM businesses WHERE project_id=$1 AND deleted_at IS NULL
       ORDER BY created_at ASC LIMIT 1`,
    [pid],
  );
  // Project is business: when no business row exists, build a synthetic object from project_id and keep frontend flow unchanged.
  const data = b || { id: pid, project_id: pid, name: "", description: null, created_at: null, updated_at: null };
  return { data, message: "获取业务成功" };
}

// GET /api/projects/:pid/businesses/:bid/data-sources — bound data sources (grouped by type)
export async function getBusinessDataSources(ctx, input) {
  const projectId = input.params.pid;
  const bindings = await ctx.query(
    `SELECT id, source_type, source_id FROM business_data_sources WHERE project_id=$1 AND deleted_at IS NULL`,
    [projectId],
  );
  const out = { database_connections: [], unstructured_data_sources: [], structured_data_sources: [], web_search_models: [] };
  const idsOf = (t) => bindings.filter((b) => b.source_type === t).map((b) => b.source_id);
  // Align with production contract: every item must include source_id = business_data_sources.id
  // (metric_view.source_id references this id). source_id maps to bds.id internally.
  const bdsIdBy = (t) => {
    const m = {};
    for (const b of bindings) if (b.source_type === t) m[b.source_id] = b.id;
    return m;
  };

  const dbIds = idsOf("database_connection");
  if (dbIds.length) {
    const map = bdsIdBy("database_connection");
    const conns = await ctx.query(
      `SELECT id, name, db_type, is_virtual, host, port, database AS db_name, description
         FROM database_connections
        WHERE id = ANY($1) AND project_id=$2 AND deleted_at IS NULL`,
      [dbIds, projectId],
    );
    out.database_connections = conns.map((c) => ({
      ...c, source_id: map[c.id] || c.id, database_connection_id: c.id, source_type: "database",
    }));
  }
  const usIds = idsOf("unstructured_data_source");
  if (usIds.length) {
    const map = bdsIdBy("unstructured_data_source");
    const rows = await ctx.query(
      `SELECT id, name, description, folder_path, is_active FROM unstructured_data_sources
        WHERE id = ANY($1) AND project_id=$2 AND deleted_at IS NULL`,
      [usIds, projectId],
    );
    out.unstructured_data_sources = rows.map((r) => ({ ...r, source_id: map[r.id] || r.id, source_type: "unstructured" }));
  }
  const sdIds = idsOf("structured_data_source");
  if (sdIds.length) {
    const map = bdsIdBy("structured_data_source");
    const rows = await ctx.query(
      `SELECT s.id, s.name, s.description, s.folder_path, s.is_active, s.database_connection_id
         FROM structured_data_sources s
         JOIN database_connections d ON d.id=s.database_connection_id AND d.deleted_at IS NULL
        WHERE s.id = ANY($1) AND s.project_id=$2 AND d.project_id=$2 AND s.deleted_at IS NULL`,
      [sdIds, projectId],
    );
    // Structured sources need database_connection_id to support metric_view table resolution through virtual DuckDB.
    out.structured_data_sources = rows.map((r) => ({ ...r, source_id: map[r.id] || r.id, source_type: "structured" }));
  }
  const wsIds = idsOf("web_search_model");
  if (wsIds.length) {
    const map = bdsIdBy("web_search_model");
    const rows = await ctx.query(
      `SELECT id, name, model, description, config_type, is_default,
              CASE WHEN api IS NULL OR api='' THEN false ELSE true END AS has_api
         FROM web_search_models
        WHERE id = ANY($1) AND project_id=$2 AND deleted_at IS NULL`,
      [wsIds, projectId],
    );
    out.web_search_models = rows.map(({ has_api, ...row }) => ({
      ...row,
      source_id: map[row.id] || row.id,
      api: has_api === true || Number(has_api) === 1 ? "********" : null,
    }));
  }
  return { data: out, message: "获取数据源列表成功" };
}

// GET /api/projects/:pid/businesses/:bid/metrics — metric list
export async function listMetrics(ctx, input) {
  const { page, pageSize, offset } = paging(input);
  const activeOnly = String(input.query?.active_only || "false") === "true";
  const filters = ["project_id=$1", "deleted_at IS NULL"];
  if (activeOnly) filters.push("is_active=true");
  const rows = await ctx.query(
    `SELECT id, project_id, name, description, aliases,
            related_tables, related_columns, code_knowledge, is_active, embedding_model,
            CASE WHEN embedding IS NOT NULL THEN true ELSE false END AS has_embedding,
            created_at, updated_at
       FROM metric_definitions WHERE ${filters.join(" AND ")} ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [input.params.pid, pageSize, offset],
  );
  const plans = await listMetricExecutionPlans(ctx, {
    project_id: input.params.pid,
    metric_ids: rows.map((row) => row.id),
  });
  const plansByMetric = new Map();
  for (const plan of plans) {
    const items = plansByMetric.get(plan.metric_id) || [];
    items.push(plan);
    plansByMetric.set(plan.metric_id, items);
  }
  const count = await ctx.queryOne(`SELECT COUNT(*) AS cnt FROM metric_definitions WHERE ${filters.join(" AND ")}`, [input.params.pid]);
  return {
    data: {
      items: rows.map((row) => shapeMetric(row, plansByMetric.get(row.id) || [])),
      total: Number(count?.cnt || 0), page, page_size: pageSize,
    },
    message: "获取指标列表成功",
  };
}

// GET /api/projects/:pid/businesses/:bid/metrics/embedding_pending_count — pending embedding count
export async function getMetricsEmbeddingPendingCount(ctx, input) {
  const row = await ctx.queryOne(
    `SELECT COUNT(*) AS cnt FROM metric_definitions
      WHERE project_id=$1 AND deleted_at IS NULL AND embedding IS NULL`,
    [input.params.pid],
  );
  const pending = Number(row?.cnt || 0);
  return { data: { pending, count: pending }, message: "ok" };
}

// GET /api/projects/:pid/businesses/:bid/entity_configs — entity config list
export async function listEntityConfigs(ctx, input) {
  const { page, pageSize, offset } = paging(input);
  const params = [input.params.pid];
  let filter = "project_id=$1 AND deleted_at IS NULL";
  if (input.query?.table_name) {
    params.push(input.query.table_name);
    filter += ` AND table_name=$${params.length}`;
  }
  params.push(pageSize, offset);
  const rows = await ctx.query(
    `SELECT cfg.id, cfg.project_id, cfg.config_name, cfg.import_type, cfg.source_id, cfg.source_type,
            cfg.database_connection_id, cfg.table_name, cfg.column_name, cfg.schema_name,
            cfg.entity_type, cfg.metadata_fields, cfg.sample_entities, cfg.rule, cfg.is_active,
            cfg.auto_promoted,
            cfg.created_at, cfg.updated_at,
            (SELECT COUNT(*) FROM entity_mappings em WHERE em.config_id=cfg.id AND em.deleted_at IS NULL) AS entity_count,
            (SELECT COUNT(*) FROM entity_mappings em WHERE em.config_id=cfg.id AND em.deleted_at IS NULL AND em.embedding IS NOT NULL) AS vector_count
       FROM entity_mapping_configs cfg WHERE ${filter}
      ORDER BY cfg.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const columnConfigIds = rows.filter((row) => row.entity_type === "column_name").map((row) => row.id);
  if (columnConfigIds.length) {
    const entityRows = await ctx.query(
      `SELECT config_id, name, meta_data, auto_promoted FROM entity_mappings
        WHERE config_id::text = ANY($1::text[]) AND deleted_at IS NULL ORDER BY created_at`,
      [columnConfigIds],
    );
    const byConfig = new Map();
    for (const entity of entityRows) {
      let meta = entity.meta_data || {};
      if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = {}; } }
      const current = byConfig.get(entity.config_id) || [];
      if (!meta.is_alias) current.push({
        column_name: meta.column_name || entity.name,
        description: meta.description || null,
        auto_promoted: Boolean(entity.auto_promoted),
      });
      byConfig.set(entity.config_id, current);
    }
    rows.forEach((row) => { if (row.entity_type === "column_name") row.columns = byConfig.get(row.id) || []; });
  }
  rows.forEach((row) => {
    row.metadata_fields = parseJson(row.metadata_fields, []);
    row.sample_entities = parseJson(row.sample_entities, []);
    row.auto_promoted = Boolean(row.auto_promoted);
    const entityCount = Number(row.entity_count || 0);
    const vectorCount = Number(row.vector_count || 0);
    row.entity_count = entityCount;
    row.vector_count = vectorCount;
    row.vector_status = entityCount > 0 && vectorCount === entityCount
      ? "已生成" : (vectorCount > 0 ? `部分生成(${vectorCount}/${entityCount})` : "未生成");
    row.vector_error = null;
  });
  const countParams = params.slice(0, -2);
  const count = await ctx.queryOne(`SELECT COUNT(*) AS cnt FROM entity_mapping_configs WHERE ${filter}`, countParams);
  return { data: { items: rows, total: Number(count?.cnt || 0), page, page_size: pageSize }, message: "获取实体配置成功" };
}

// GET /api/projects/:pid/businesses/:bid/entities — entity list
export async function listEntities(ctx, input) {
  const { page, pageSize, offset } = paging(input);
  const params = [input.params.pid];
  let filter = "project_id=$1 AND deleted_at IS NULL";
  if (input.query?.config_id) {
    params.push(input.query.config_id);
    filter += ` AND config_id=$${params.length}`;
  }
  params.push(pageSize, offset);
  const rows = await ctx.query(
    `SELECT id, project_id, name, source_id, source_type, entity_type, config_id, meta_data,
            embedding_model, CASE WHEN embedding IS NOT NULL THEN true ELSE false END AS has_embedding,
            created_at, updated_at
       FROM entity_mappings WHERE ${filter} ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const count = await ctx.queryOne(`SELECT COUNT(*) AS cnt FROM entity_mappings WHERE ${filter}`, params.slice(0, -2));
  return { data: { items: rows, total: Number(count?.cnt || 0), page, page_size: pageSize }, message: "获取实体列表成功" };
}

// GET /api/projects/:pid/businesses/:bid/metric-views — metric view list
export async function listMetricViews(ctx, input) {
  const { page, pageSize, offset } = paging(input);
  const params = [input.params.pid];
  const filters = ["project_id=$1", "deleted_at IS NULL"];
  if (String(input.query?.active_only || "false") === "true") filters.push("status='active'");
  if (input.query?.source_id) { params.push(input.query.source_id); filters.push(`source_id=$${params.length}`); }
  if (input.query?.status) { params.push(input.query.status); filters.push(`status=$${params.length}`); }
  const keyword = String(input.query?.keyword || "").trim();
  if (keyword) {
    params.push(`%${keyword}%`);
    filters.push(`(
      LOWER(name) LIKE LOWER($${params.length})
      OR LOWER(COALESCE(description, '')) LIKE LOWER($${params.length})
      OR LOWER(CAST(aliases AS TEXT)) LIKE LOWER($${params.length})
    )`);
  }
  params.push(pageSize, offset);
  const rows = await ctx.query(
    `SELECT id, project_id, source_id, name, description, aliases, tables, fixed_predicates,
            query_dimensions, time_dimension, projections, group_by, sort_spec, status, embedding_model,
            created_at, updated_at
       FROM metric_view_definitions WHERE ${filters.join(" AND ")} ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const count = await ctx.queryOne(`SELECT COUNT(*) AS cnt FROM metric_view_definitions WHERE ${filters.join(" AND ")}`, params.slice(0, -2));
  return { data: { items: rows.map(shapeMetricView), total: Number(count?.cnt || 0), page, page_size: pageSize }, message: "获取指标视图成功" };
}

// GET /api/projects/:pid/businesses/:bid/metric-views/:mvid — metric view detail
export async function getMetricView(ctx, input) {
  const mv = await ctx.queryOne(
    `SELECT id, project_id, source_id, name, description, aliases, tables, fixed_predicates,
            query_dimensions, time_dimension, projections, group_by, sort_spec, status, created_at, updated_at
       FROM metric_view_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [input.params.mvid, input.params.pid],
  );
  if (!mv) throw new ApiError("指标视图不存在", 404);
  return { data: shapeMetricView(mv), message: "获取指标视图成功" };
}

// GET /api/projects/:pid/businesses/:bid/examples — example list (remove embedding columns)
export async function listExamples(ctx, input) {
  const { page, pageSize, offset } = paging(input);
  const params = [input.params.pid];
  let filter = "project_id=$1 AND deleted_at IS NULL";
  if (input.query?.example_type) { params.push(input.query.example_type); filter += ` AND example_type=$${params.length}`; }
  params.push(pageSize, offset);
  const rows = await ctx.query(
    `SELECT id, project_id, example_type, question, content, description, is_active,
            source_id, source_type, embedding_model,
            CASE WHEN embedding IS NOT NULL THEN true ELSE false END AS has_embedding,
            created_at, updated_at
       FROM examples WHERE ${filter} ORDER BY created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  ).catch(() => []);
  const count = await ctx.queryOne(`SELECT COUNT(*) AS cnt FROM examples WHERE ${filter}`, params.slice(0, -2));
  return { data: { items: rows, total: Number(count?.cnt || 0), page, page_size: pageSize }, message: "获取示例成功" };
}

// GET /api/projects/:pid/businesses/:bid/examples/stats
export async function getExamplesStats(ctx, input) {
  const rows = await ctx.query(
    `SELECT example_type, COUNT(*) AS cnt FROM examples
      WHERE project_id=$1 AND deleted_at IS NULL GROUP BY example_type`,
    [input.params.pid],
  );
  const by_type = {};
  let total = 0;
  rows.forEach((row) => { const count = Number(row.cnt || 0); by_type[row.example_type || "unknown"] = count; total += count; });
  return { data: { total, by_type }, message: "ok" };
}
