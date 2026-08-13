// L1 use-case layer for Metric Views CRUD + embeddings, aligned line-by-line with routes/business_crud.js.
// Signature is always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
//
// Coverage (implemented):
//   POST preview/embeddings/column-distinct-values — validation and generation
//   recommendations start/latest/task/apply         — full recommendation flow
//   PATCH /:mvid/status and POST/PUT/DELETE          — CRUD
//
// Note: app/business/ is one layer deeper than routes/, so engine/db uses ../../.
import { ApiError } from "../../errors.js";
import { MetricViewService } from "../../engine/semantic/metric_view_service.js";
import { MetricViewRecommendationService } from "../../engine/semantic/metric_view_recommendation_service.js";
import { canonicalize_metric_view_definition } from "../../engine/semantic/metric_view_canonicalizer.js";
import {
  _normalize_op_case_in_list,
  _normalize_sql_op,
  upgrade_metric_view_payload,
} from "../../engine/semantic/metric_view_definition.js";
import { DatabaseDataSource } from "../../engine/datasources/database_data_source.js";
import { assertBusiness } from "./business.js";
import { compileMetricViewPreview } from "./metric_view_runtime.js";

const RECOMMENDATION_STALE_AFTER_MS = 30 * 60 * 1000;
const RECOMMENDATION_STALE_ERROR = "推荐任务超过 30 分钟没有进展，可能因应用重启或处理超时中断，请重新发起分析";

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function taskShape(row) {
  if (!row) return null;
  return {
    ...row,
    task_id: row.id,
    input_params: parseJson(row.input_params, {}),
    candidates: parseJson(row.candidates, []),
    user_selections: parseJson(row.user_selections, []),
    applied_view_ids: parseJson(row.applied_view_ids, []),
    stats: parseJson(row.stats, {}),
  };
}

function viewDefinitionFromRow(row) {
  if (!row) return null;
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

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function textFromContentItems(value) {
  const items = parseJson(value, []);
  if (!Array.isArray(items)) return "";
  const preferred = items.find((item) => {
    const type = String(item?.content_type || item?.type || "").toLowerCase();
    return ["text", "user_query", "question", "message"].includes(type)
      && typeof item?.content === "string" && item.content.trim();
  });
  if (preferred) return preferred.content.trim();
  const fallback = items.find((item) => typeof item?.content === "string" && item.content.trim());
  return fallback ? fallback.content.trim() : "";
}

async function collectRecommendationQuestions(ctx, pid, userId, inputParams) {
  const cutoff = new Date(Date.now() - inputParams.time_range_days * 86400000).toISOString();
  const rows = await ctx.query(
    `SELECT sm.id AS question_id, sm.session_id, sm.content_items, sm.created_at
       FROM session_messages sm
       JOIN sessions s ON s.id=sm.session_id
      WHERE s.project_id=$1 AND s.created_by=$2 AND s.deleted_at IS NULL
        AND (s.action_type IS NULL OR s.action_type NOT IN ('agentic_chat','report'))
        AND sm.role='user' AND sm.deleted_at IS NULL AND sm.created_at >= $3
      ORDER BY sm.created_at DESC LIMIT $4`,
    [pid, userId, cutoff, Math.min(200, inputParams.max_questions * 4)],
  );
  let dislikedQuestions = new Set();
  if (!inputParams.include_negative_feedback) {
    const dislikes = await ctx.query(
      `SELECT user_question FROM message_feedbacks
        WHERE project_id=$1 AND user_id=$2 AND feedback_type='dislike'
          AND deleted_at IS NULL AND user_question IS NOT NULL`,
      [pid, userId],
    );
    dislikedQuestions = new Set(dislikes.map((item) => String(item.user_question || "").trim()).filter(Boolean));
  }
  const seen = new Set();
  const questions = [];
  for (const row of rows) {
    const text = textFromContentItems(row.content_items).slice(0, 1000);
    if (!text || seen.has(text) || dislikedQuestions.has(text)) continue;
    seen.add(text);
    questions.push({
      question_id: String(row.question_id),
      message_id: String(row.question_id),
      session_id: String(row.session_id),
      text,
      created_at: row.created_at || null,
    });
    if (questions.length >= inputParams.max_questions) break;
  }
  return questions;
}

async function recommendationCatalog(ctx, pid, sourceFilter) {
  let bindings = await ctx.query(
    `SELECT id, source_id, source_type FROM business_data_sources
      WHERE project_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`,
    [pid],
  );
  if (sourceFilter) {
    bindings = bindings.filter((item) => String(item.id) === String(sourceFilter));
    if (!bindings.length) throw new ApiError("指定数据源未绑定到当前项目", 404);
  }
  const bindingByAnyId = new Map();
  for (const binding of bindings) {
    let connectionId = null;
    if (binding.source_type === "database_connection") connectionId = binding.source_id;
    if (binding.source_type === "structured_data_source") {
      const structured = await ctx.queryOne(
        `SELECT database_connection_id FROM structured_data_sources
          WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
        [binding.source_id, pid],
      );
      connectionId = structured?.database_connection_id || null;
    }
    const schemaRows = connectionId ? await ctx.query(
      `SELECT tm.schema_name, tm.table_name, cm.column_name
         FROM table_metadata tm
         LEFT JOIN column_metadata cm ON cm.table_id=tm.id AND cm.deleted_at IS NULL
        WHERE tm.database_connection_id=$1 AND tm.deleted_at IS NULL
        ORDER BY tm.schema_name, tm.table_name, cm.column_name`,
      [connectionId],
    ) : [];
    const availableTables = {};
    for (const row of schemaRows) {
      const tableRef = row.schema_name && row.schema_name !== "default"
        ? `${row.schema_name}.${row.table_name}` : row.table_name;
      if (!availableTables[tableRef]) availableTables[tableRef] = [];
      if (row.column_name && !availableTables[tableRef].includes(row.column_name)) {
        availableTables[tableRef].push(row.column_name);
      }
    }
    const shaped = { ...binding, connection_id: connectionId, available_tables: availableTables };
    bindingByAnyId.set(String(binding.id), shaped);
    bindingByAnyId.set(String(binding.source_id), shaped);
    if (connectionId) bindingByAnyId.set(String(connectionId), shaped);
  }
  const metricRows = await ctx.query(
    `SELECT m.id, m.name, m.description, m.aliases, m.related_tables, m.related_columns,
            p.id AS plan_id, p.plan_type, p.spec AS plan_spec, p.source_id
       FROM metric_definitions m
       JOIN metric_execution_plans p
         ON p.project_id=m.project_id AND p.metric_id=m.id
        AND p.deleted_at IS NULL AND p.is_active=true AND p.plan_type='sql'
        AND p.id=(
          SELECT p2.id
            FROM metric_execution_plans p2
           WHERE p2.project_id=m.project_id AND p2.metric_id=m.id
             AND p2.deleted_at IS NULL AND p2.is_active=true AND p2.plan_type='sql'
           ORDER BY p2.priority ASC, p2.version DESC, p2.id ASC
           LIMIT 1
        )
      WHERE m.project_id=$1 AND m.deleted_at IS NULL AND m.is_active=true
      ORDER BY m.updated_at DESC, p.priority ASC, p.version DESC LIMIT 100`,
    [pid],
  );
  const metrics = metricRows.map((metric) => {
    const binding = bindingByAnyId.get(String(metric.source_id || ""));
    if (!binding || !Object.keys(binding.available_tables).length) return null;
    return {
      ...metric,
      aliases: parseJson(metric.aliases, []),
      related_tables: parseJson(metric.related_tables, []),
      related_columns: parseJson(metric.related_columns, {}),
      execution_plan: {
        id: metric.plan_id,
        plan_type: metric.plan_type,
        spec: parseJson(metric.plan_spec, {}),
      },
      binding_id: binding.id,
      available_tables: binding.available_tables,
    };
  }).filter(Boolean);
  const existingViews = await ctx.query(
    `SELECT id, name FROM metric_view_definitions
      WHERE project_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 100`,
    [pid],
  );
  return { metrics, existingViews };
}

async function resolveSource(ctx, pid, sourceId) {
  const binding = await ctx.queryOne(
    `SELECT id, source_id, source_type FROM business_data_sources
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [sourceId, pid],
  );
  if (!binding) throw new ApiError("数据源未绑定到当前项目", 404);
  if (binding.source_type === "database_connection") return { binding, connectionId: binding.source_id };
  if (binding.source_type === "structured_data_source") {
    const structured = await ctx.queryOne(
      `SELECT database_connection_id FROM structured_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
      [binding.source_id, pid],
    );
    if (!structured?.database_connection_id) throw new ApiError("结构化数据源缺少数据库连接", 400);
    return { binding, connectionId: structured.database_connection_id };
  }
  throw new ApiError("该数据源不支持业务视图查询", 400);
}

async function validateMetricViewDefinition(ctx, pid, rawDefinition) {
  const definition = rawDefinition && typeof rawDefinition === "object" ? rawDefinition : {};
  const sourceId = definition.source_id;
  if (!sourceId) throw new ApiError("source_id 不能为空", 400);
  await resolveSource(ctx, pid, sourceId);
  let normalized;
  try {
    const timeDimension = definition.time_dimension && typeof definition.time_dimension === "object"
      ? {
        ...definition.time_dimension,
        op: definition.time_dimension.op
          ? _normalize_sql_op(definition.time_dimension.op)
          : definition.time_dimension.op,
      }
      : definition.time_dimension ?? null;
    const upgraded = upgrade_metric_view_payload({
      ...definition,
      name: definition.name,
      source_id: sourceId,
      aliases: definition.aliases || [],
      tables: definition.tables || [],
      projections: definition.projections || [],
      fixed_predicates: _normalize_op_case_in_list(definition.fixed_predicates || [], "operator"),
      query_dimensions: _normalize_op_case_in_list(definition.query_dimensions || [], "op"),
      time_dimension: timeDimension,
      group_by: definition.group_by || [],
      sort_spec: definition.sort_spec || { order_by: [], limit_default: 100 },
    });
    normalized = await canonicalize_metric_view_definition(ctx, {
      ...upgraded,
      aliases: upgraded.aliases || [],
      tables: upgraded.tables || [],
      fixed_predicates: upgraded.fixed_predicates || [],
      query_dimensions: upgraded.query_dimensions || [],
      time_dimension: upgraded.time_dimension ?? null,
      projections: upgraded.projections || [],
      group_by: upgraded.group_by || [],
      sort_spec: upgraded.sort_spec || { order_by: [], limit_default: 100 },
    }, { source_id: sourceId, strict_source_resolution: true });
  } catch (error) {
    throw new ApiError(error?.message || "指标视图定义不合法", 400);
  }
  const preview = compileMetricViewPreview(normalized);
  if (preview.validation.status === "error") {
    throw new ApiError(preview.validation.errors[0] || "业务视图定义不合法", 400);
  }
  return { definition: normalized, preview };
}

function jsonOrNull(value) {
  return value == null ? null : JSON.stringify(value);
}

// ════════════════════════════════════════════
// Metric Views CRUD
// ════════════════════════════════════════════

// POST /api/projects/:pid/businesses/:bid/metric-views/embeddings — generate metric view embeddings
export async function generateMetricViewEmbeddings(ctx, input) {
  const { pid } = input.params;
  const metricViewId = input.query?.metric_view_id || input.body?.metric_view_id || null;
  if (metricViewId) {
    const exists = await ctx.queryOne(
      `SELECT id FROM metric_view_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
      [metricViewId, pid],
    );
    if (!exists) throw new ApiError("业务视图不存在", 404);
  }
  const r = await MetricViewService.generate_embeddings(
    { query: ctx.query, queryOne: ctx.queryOne }, { project_id: pid, metric_view_id: metricViewId },
  );
  if ((r.total || 0) > 0 && (r.processed || 0) === 0) throw new ApiError(r.message || "业务视图向量未生成", 503);
  return { data: r, message: "指标视图向量生成" };
}

// POST /api/projects/:pid/metric-views/preview — compile and validate the structured definition.
export async function previewMetricView(ctx, input) {
  const { definition, preview: result } = await validateMetricViewDefinition(
    ctx,
    input.params.pid,
    input.body || {},
  );
  result.definition = definition;
  return { data: result, message: result.validation.status === "error" ? "业务视图校验失败" : "业务视图预览生成成功" };
}

// POST /api/projects/:pid/metric-views/column-distinct-values
export async function getColumnDistinctValues(ctx, input) {
  const { pid } = input.params;
  const { source_id, table_ref, column_name, keyword = null } = input.body || {};
  if (!source_id || !table_ref || !column_name) throw new ApiError("source_id、table_ref 和 column_name 为必填项", 400);
  const { connectionId } = await resolveSource(ctx, pid, source_id);
  const page = Math.max(1, Number(input.body?.page || 1));
  const pageSize = Math.min(200, Math.max(1, Number(input.body?.page_size || 20)));
  const [schemaName, tableName] = String(table_ref).includes(".")
    ? String(table_ref).split(".", 2) : [null, String(table_ref)];
  const dataSource = new DatabaseDataSource(null, pid, connectionId);
  const values = await dataSource.query_distinct_values(tableName, column_name, {
    keyword, limit: pageSize, offset: (page - 1) * pageSize, schema_name: schemaName,
  });
  const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
  const qualified = schemaName ? `${quote(schemaName)}.${quote(tableName)}` : quote(tableName);
  const safeKeyword = keyword ? String(keyword).replace(/'/g, "''") : null;
  const where = safeKeyword ? ` WHERE LOWER(CAST(${quote(column_name)} AS VARCHAR)) LIKE LOWER('%${safeKeyword}%')` : "";
  const countResult = await dataSource.query(
    `SELECT COUNT(DISTINCT ${quote(column_name)}) AS total_count FROM ${qualified}${where}`,
    { project_id: pid },
  );
  const totalCount = Number(countResult?.data?.[0]?.total_count || values.length);
  return { data: { values, total_count: totalCount, page, page_size: pageSize }, message: "获取枚举值成功" };
}

export async function executeMetricViewRecommendationTask(ctx, { taskId, pid, userId, inputParams }) {
  const startedAt = Date.now();
  let questionsScanned = 0;
  let llmCalls = 0;
  try {
    await ctx.query(
      `UPDATE metric_view_recommendation_tasks SET status='extracting', updated_at=now() WHERE id=$1`,
      [taskId],
    );
    const [questions, catalog] = await Promise.all([
      collectRecommendationQuestions(ctx, pid, userId, inputParams),
      recommendationCatalog(ctx, pid, inputParams.source_id),
    ]);
    questionsScanned = questions.length;
    await ctx.query(
      `UPDATE metric_view_recommendation_tasks SET status='synthesizing', updated_at=now() WHERE id=$1`,
      [taskId],
    );
    const generated = await MetricViewRecommendationService.recommend({
      projectId: pid,
      questions,
      metrics: catalog.metrics,
      existingViews: catalog.existingViews,
    });
    llmCalls = generated.llmCalls;
    const skipped = [...generated.skipped];
    const candidates = generated.candidates.filter((candidate) => {
      const preview = compileMetricViewPreview(candidate);
      if (preview.validation.status !== "error") return true;
      skipped.push(`${candidate.name}: ${preview.validation.errors[0] || "结构校验失败"}`);
      return false;
    });
    const stats = {
      questions_scanned: questionsScanned,
      clusters: generated.candidates.length,
      candidates: candidates.length,
      llm_calls: llmCalls,
      elapsed_ms: Date.now() - startedAt,
      skipped_clusters: skipped,
    };
    await ctx.query(
      `UPDATE metric_view_recommendation_tasks
          SET status='completed', candidates=$1, stats=$2, error_message=NULL, updated_at=now()
        WHERE id=$3 AND project_id=$4 AND initiated_by=$5`,
      [JSON.stringify(candidates), JSON.stringify(stats), taskId, pid, userId],
    );
  } catch (error) {
    const stats = {
      questions_scanned: questionsScanned,
      clusters: 0,
      candidates: 0,
      llm_calls: Math.max(llmCalls, Number(error?.attempts || 0)),
      elapsed_ms: Date.now() - startedAt,
      skipped_clusters: [],
    };
    await ctx.query(
      `UPDATE metric_view_recommendation_tasks
          SET status='failed', stats=$1, error_message=$2, updated_at=now()
        WHERE id=$3 AND project_id=$4 AND initiated_by=$5`,
      [JSON.stringify(stats), error?.message || String(error), taskId, pid, userId],
    );
  }
  return taskShape(await ctx.queryOne(
    `SELECT * FROM metric_view_recommendation_tasks WHERE id=$1 AND project_id=$2 AND initiated_by=$3`,
    [taskId, pid, userId],
  ));
}

export async function reconcileMetricViewRecommendationTasks(ctx, { pid, userId = ctx.userId } = {}) {
  if (!pid || !userId) return;
  const staleCutoff = new Date(Date.now() - RECOMMENDATION_STALE_AFTER_MS).toISOString();
  await ctx.query(
    `UPDATE metric_view_recommendation_tasks
        SET status='failed', error_message=$3, updated_at=now()
      WHERE project_id=$1 AND initiated_by=$2
        AND status IN ('pending','extracting','clustering','synthesizing')
        AND deleted_at IS NULL AND COALESCE(updated_at, created_at) < $4`,
    [pid, userId, RECOMMENDATION_STALE_ERROR, staleCutoff],
  );
}

// POST /api/projects/:pid/metric-views/recommendations — create a real background AI task.
export async function runMetricViewRecommendation(ctx, input) {
  const { pid } = input.params;
  const inputParams = {
    source_id: input.body?.source_id || null,
    time_range_days: clampInteger(input.body?.time_range_days, 90, 1, 365),
    max_questions: clampInteger(input.body?.max_questions, 30, 5, 50),
    include_negative_feedback: Boolean(input.body?.include_negative_feedback),
  };
  if (inputParams.source_id) {
    const binding = await ctx.queryOne(
      `SELECT id FROM business_data_sources WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
      [inputParams.source_id, pid],
    );
    if (!binding) throw new ApiError("指定数据源未绑定到当前项目", 404);
  }
  await reconcileMetricViewRecommendationTasks(ctx, { pid });
  const active = await ctx.queryOne(
    `SELECT id FROM metric_view_recommendation_tasks
      WHERE project_id=$1 AND initiated_by=$2
        AND status IN ('pending','extracting','clustering','synthesizing') AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [pid, ctx.userId],
  );
  if (active) throw new ApiError("已有正在进行的推荐任务，请等待完成后再试", 409);

  const taskId = crypto.randomUUID();
  const stats = { questions_scanned: 0, clusters: 0, candidates: 0, llm_calls: 0, elapsed_ms: 0, skipped_clusters: [] };
  await ctx.query(
    `INSERT INTO metric_view_recommendation_tasks
       (id, project_id, initiated_by, status, input_params, candidates, user_selections,
        applied_view_ids, stats, error_message, created_at, updated_at)
     VALUES ($1,$2,$3,'pending',$4,'[]','[]','[]',$5,NULL,now(),now())`,
    [taskId, pid, ctx.userId, JSON.stringify(inputParams), JSON.stringify(stats)],
  );
  queueMicrotask(() => {
    executeMetricViewRecommendationTask(ctx, {
      taskId, pid, userId: ctx.userId, inputParams,
    }).catch((error) => console.error(`[metric_view_recommendation] task ${taskId} failed: ${error?.message || error}`));
  });
  const row = await ctx.queryOne(`SELECT * FROM metric_view_recommendation_tasks WHERE id=$1`, [taskId]);
  return { data: taskShape(row), message: "业务视图推荐任务已开始" };
}

export async function getLatestMetricViewRecommendation(ctx, input) {
  await reconcileMetricViewRecommendationTasks(ctx, { pid: input.params.pid });
  const row = await ctx.queryOne(
    `SELECT * FROM metric_view_recommendation_tasks
      WHERE project_id=$1 AND initiated_by=$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [input.params.pid, ctx.userId],
  );
  return { data: taskShape(row), message: row ? "获取推荐任务成功" : "暂无推荐任务" };
}

export async function getMetricViewRecommendationTask(ctx, input) {
  await reconcileMetricViewRecommendationTasks(ctx, { pid: input.params.pid });
  const row = await ctx.queryOne(
    `SELECT * FROM metric_view_recommendation_tasks
      WHERE id=$1 AND project_id=$2 AND initiated_by=$3 AND deleted_at IS NULL`,
    [input.params.taskId, input.params.pid, ctx.userId],
  );
  if (!row) throw new ApiError("推荐任务不存在", 404);
  return { data: taskShape(row), message: "获取推荐任务成功" };
}

export async function applyMetricViewRecommendation(ctx, input) {
  const taskResult = await getMetricViewRecommendationTask(ctx, input);
  const task = taskResult.data;
  if (task.status !== "completed") throw new ApiError("推荐任务尚未完成", 409);
  const candidates = new Map(task.candidates.map((candidate) => [candidate.candidate_id, candidate]));
  const selections = Array.isArray(input.body?.selections) ? input.body.selections : [];
  if (!selections.length) throw new ApiError("selections 不能为空", 400);
  const results = [];
  const applied = [...task.applied_view_ids];
  for (const selection of selections) {
    const candidate = candidates.get(selection.candidate_id);
    if (!candidate) {
      results.push({ candidate_id: selection.candidate_id, success: false, error: "候选不存在" });
      continue;
    }
    try {
      const created = await createMetricView(ctx, {
        params: { pid: input.params.pid },
        body: { ...candidate, ...(selection.overrides || {}), status: "draft" },
      });
      results.push({ candidate_id: candidate.candidate_id, success: true, view_id: created.data.id });
      applied.push({ candidate_id: candidate.candidate_id, view_id: created.data.id });
    } catch (error) {
      results.push({ candidate_id: candidate.candidate_id, success: false, error: error?.message || String(error) });
    }
  }
  await ctx.query(
    `UPDATE metric_view_recommendation_tasks
        SET user_selections=$1, applied_view_ids=$2, updated_at=now() WHERE id=$3`,
    [JSON.stringify(selections), JSON.stringify(applied), task.id],
  );
  const updated = await getMetricViewRecommendationTask(ctx, input);
  return { data: { results, task: updated.data }, message: "推荐应用完成" };
}

// PATCH /api/projects/:pid/businesses/:bid/metric-views/:mvid/status — toggle view status
export async function updateMetricViewStatus(ctx, input) {
  const { pid, mvid } = input.params;
  const { status } = input.body || {};
  if (!status) throw new ApiError("status 不能为空", 400);
  const allowed = ["draft", "active", "inactive"];
  if (!allowed.includes(status)) throw new ApiError(`status 必须是 ${allowed.join("/")} 之一`, 400);
  const check = await ctx.queryOne(
    `SELECT * FROM metric_view_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mvid, pid],
  );
  if (!check) throw new ApiError("指标视图不存在", 404);
  if (status === "active") {
    const { definition } = await validateMetricViewDefinition(ctx, pid, viewDefinitionFromRow(check));
    await ctx.query(
      `UPDATE metric_view_definitions
          SET status=$1, source_id=$2, aliases=$3, tables=$4, fixed_predicates=$5,
              query_dimensions=$6, time_dimension=$7, projections=$8, group_by=$9,
              sort_spec=$10, updated_at=now()
        WHERE id=$11 AND project_id=$12 AND deleted_at IS NULL`,
      [
        status, definition.source_id, jsonOrNull(definition.aliases), jsonOrNull(definition.tables),
        jsonOrNull(definition.fixed_predicates), jsonOrNull(definition.query_dimensions),
        jsonOrNull(definition.time_dimension), jsonOrNull(definition.projections),
        jsonOrNull(definition.group_by), jsonOrNull(definition.sort_spec), mvid, pid,
      ],
    );
    return { data: { updated: true, status }, message: "状态已更新" };
  }
  await ctx.query(
    `UPDATE metric_view_definitions SET status=$1, updated_at=now() WHERE id=$2 AND deleted_at IS NULL`,
    [status, mvid],
  );
  return { data: { updated: true, status }, message: "状态已更新" };
}

// POST /api/projects/:pid/businesses/:bid/metric-views — create metric view
export async function createMetricView(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const {
    name, description, aliases, source_id, tables, fixed_predicates,
    query_dimensions, time_dimension, projections, group_by, sort_spec, status,
  } = input.body || {};
  if (!name || !name.trim()) throw new ApiError("名称不能为空", 400);
  if (!source_id) throw new ApiError("source_id 不能为空", 400);
  if (!Array.isArray(tables)) throw new ApiError("tables 不能为空", 400);
  if (!Array.isArray(projections)) throw new ApiError("projections 不能为空", 400);
  const nextStatus = status || "active";
  if (!["draft", "active", "inactive"].includes(nextStatus)) {
    throw new ApiError("status 必须是 draft/active/inactive 之一", 400);
  }
  const { definition } = await validateMetricViewDefinition(ctx, pid, input.body || {});

  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO metric_view_definitions
       (id, project_id, source_id, name, description, aliases, tables, fixed_predicates,
        query_dimensions, time_dimension, projections, group_by, sort_spec, status, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),now())`,
    [
      id, pid, definition.source_id, name.trim(), description || null,
      jsonOrNull(definition.aliases),
      jsonOrNull(definition.tables),
      jsonOrNull(definition.fixed_predicates),
      jsonOrNull(definition.query_dimensions),
      jsonOrNull(definition.time_dimension),
      jsonOrNull(definition.projections),
      jsonOrNull(definition.group_by),
      jsonOrNull(definition.sort_spec),
      nextStatus,
    ],
  );
  const row = await ctx.queryOne(`SELECT * FROM metric_view_definitions WHERE id=$1`, [id]);
  return { data: row, message: "创建指标视图成功" };
}

// PUT /api/projects/:pid/businesses/:bid/metric-views/:mvid — update metric view
export async function updateMetricView(ctx, input) {
  const { pid, mvid } = input.params;
  const existing = await ctx.queryOne(
    `SELECT * FROM metric_view_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mvid, pid],
  );
  if (!existing) throw new ApiError("指标视图不存在", 404);

  const {
    name, description, aliases, source_id, tables, fixed_predicates,
    query_dimensions, time_dimension, projections, group_by, sort_spec, status,
  } = input.body || {};

  if (status !== undefined && !["draft", "active", "inactive"].includes(status)) {
    throw new ApiError("status 必须是 draft/active/inactive 之一", 400);
  }
  const merged = viewDefinitionFromRow({ ...existing, ...input.body });
  const { definition } = await validateMetricViewDefinition(ctx, pid, merged);

  const sets = ["updated_at=now()"];
  const vals = [];
  const add = (col, val) => { sets.push(`${col}=$${vals.length + 1}`); vals.push(val); };

  if (name !== undefined) add("name", name);
  if (description !== undefined) add("description", description);
  add("aliases", jsonOrNull(definition.aliases));
  add("source_id", definition.source_id);
  add("tables", jsonOrNull(definition.tables));
  add("fixed_predicates", jsonOrNull(definition.fixed_predicates));
  add("query_dimensions", jsonOrNull(definition.query_dimensions));
  add("time_dimension", jsonOrNull(definition.time_dimension));
  add("projections", jsonOrNull(definition.projections));
  add("group_by", jsonOrNull(definition.group_by));
  add("sort_spec", jsonOrNull(definition.sort_spec));
  if (status !== undefined) add("status", status);

  vals.push(mvid);
  await ctx.query(`UPDATE metric_view_definitions SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  const row = await ctx.queryOne(`SELECT * FROM metric_view_definitions WHERE id=$1`, [mvid]);
  return { data: row, message: "更新指标视图成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/metric-views/:mvid — delete metric view
export async function deleteMetricView(ctx, input) {
  const { pid, mvid } = input.params;
  const check = await ctx.queryOne(
    `SELECT id FROM metric_view_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mvid, pid],
  );
  if (!check) throw new ApiError("指标视图不存在", 404);
  await ctx.query(
    `UPDATE metric_view_definitions SET deleted_at=now(), updated_at=now() WHERE id=$1`,
    [mvid],
  );
  return { data: null, message: "删除指标视图成功" };
}
