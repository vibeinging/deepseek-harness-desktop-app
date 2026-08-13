// L1 use-case layer for Metrics CRUD, aligned line-by-line with routes/business_crud.js.
// Signature is always async fn(ctx, input) -> { data, message } | throw ApiError; no direct req/res usage.
//
// Coverage:
//   PATCH batch_update_status / :mid/status
//   POST  generate_embeddings
//   POST/PUT/DELETE /metrics[/:mid]  (supports batch DELETE)
//   bulk_import / search / code_values import|export
//
// Note: app/business/ is one layer deeper than routes/, so engine/db uses ../../.
import { ApiError } from "../../errors.js";
import { BusinessDataSources } from "../../engine/datasources/business_data_sources.js";
import { MetricService } from "../../engine/semantic/metric_service.js";
import {
  listMetricExecutionPlans,
  replaceMetricExecutionPlans,
  validateMetricExecutionPlan,
} from "../../engine/semantic/metric_execution_service.js";
import { ExecuteMetricTool } from "../../engine/tools/execute_metric_tool.js";
import { assertBusiness } from "./business.js";

// ════════════════════════════════════════════
// Metrics CRUD
// ════════════════════════════════════════════

const INLINE_EXECUTION_FIELDS = [
  "sql_template", "execution_type", "execution_spec", "evidence_policy", "source_id", "source_type",
];

function assertPlanOnlyContract(body = {}) {
  const found = INLINE_EXECUTION_FIELDS.filter((key) => Object.prototype.hasOwnProperty.call(body, key));
  if (found.length) throw new ApiError(`指标接口不接受旧字段: ${found.join("、")}`, 400);
}

function summarizeEvidenceItem(item = {}) {
  const source = item.source && typeof item.source === "object" ? {
    source_type: item.source.source_type || null,
    source_id: item.source.source_id || null,
    name: item.source.name || null,
    database_type: item.source.database_type || null,
  } : null;
  const result = item.result && typeof item.result === "object" ? {
    status: item.result.status || null,
    row_count: Number.isFinite(Number(item.result.row_count)) ? Number(item.result.row_count) : null,
    total_count: item.result.total_count == null ? null : Number(item.result.total_count),
    columns: Array.isArray(item.result.columns) ? item.result.columns.map(String) : [],
    empty: item.result.empty === true,
    truncated: item.result.truncated === true,
    data_hash: item.result.data_hash || null,
  } : null;
  return {
    evidence_id: item.evidence_id || null,
    produced_by: item.produced_by || null,
    validation_status: item.validation_status || null,
    source,
    result,
    file_name: item.file_name || null,
    page_no: item.page_no ?? null,
    row_path: Array.isArray(item.row_path) ? item.row_path : [],
    matched_label: item.matched_label || null,
  };
}

function metricExecutionResponse(metric, execution = {}, toolResult = {}) {
  const evidence = Array.isArray(execution.evidence) ? execution.evidence : [];
  const success = toolResult.success !== false && execution.success !== false;
  const needsClarification = execution.needs_clarification === true;
  return {
    success,
    executed: execution.executed === true,
    needs_clarification: needsClarification,
    metric_id: execution.definition_id || metric.id,
    metric_name: execution.definition_name || metric.name,
    plan_type: execution.plan_type || null,
    result: {
      value: execution.value ?? null,
      raw_value: execution.raw_value ?? null,
      value_column: execution.value_column || null,
      unit: execution.unit || null,
      operands: Array.isArray(execution.operands) ? execution.operands : [],
    },
    required_parameters: Array.isArray(execution.required_parameters) ? execution.required_parameters : [],
    invalid_parameters: Array.isArray(execution.invalid_parameters) ? execution.invalid_parameters : [],
    error: success
      ? null
      : needsClarification
        ? execution.error || "指标参数需要补充或修改"
        : "指标试跑失败，请检查指标定义和数据源配置",
    validation_status: execution.validation_status || null,
    evidence_summary: {
      count: evidence.length,
      validation_status: execution.validation_status || null,
      items: evidence.map(summarizeEvidenceItem),
    },
  };
}

async function metricWithPlans(ctx, projectId, metricId) {
  const row = await ctx.queryOne(`SELECT * FROM metric_definitions WHERE id=$1 AND project_id=$2`, [metricId, projectId]);
  const executionPlans = await listMetricExecutionPlans(ctx, {
    project_id: projectId,
    metric_ids: [metricId],
  });
  return { ...row, execution_plans: executionPlans };
}

// POST /api/projects/:pid/businesses/:bid/metrics/generate_embeddings — batch generate metric embeddings
export async function generateMetricEmbeddings(ctx, input) {
  const { pid } = input.params;
  const metricId = input.query?.metric_id || input.body?.metric_id || null;
  const r = await MetricService.generate_metric_embeddings(
    { query: ctx.query, queryOne: ctx.queryOne }, { project_id: pid, metric_id: metricId },
  );
  if (metricId && (r.total || 0) === 0) throw new ApiError("指标不存在或无需生成向量", 404);
  if ((r.total || 0) > 0 && (r.processed || 0) === 0) {
    throw new ApiError(r.message || "指标向量未生成", 503);
  }
  return { data: r, message: "指标向量生成" };
}

// POST /api/projects/:pid/metrics/bulk_import
export async function bulkImportMetrics(ctx, input) {
  const { pid } = input.params;
  const sourceId = input.query?.source_id || input.body?.source_id || null;
  const sourceType = input.query?.source_type || input.body?.source_type || null;
  const overwrite = String(input.query?.overwrite ?? input.body?.overwrite ?? "false") === "true";
  const fileBytes = input.body?.file || input.body;
  const result = await MetricService.bulk_import_metrics_from_excel(
    { query: ctx.query, queryOne: ctx.queryOne },
    { project_id: pid, source_id: sourceId, source_type: sourceType, file_bytes: fileBytes, overwrite },
  );
  return { data: result, message: result.message || "指标导入完成" };
}

// GET /api/projects/:pid/metrics/search
export async function searchMetrics(ctx, input) {
  const { pid } = input.params;
  const queryText = String(input.query?.query || input.body?.query || "").trim();
  if (!queryText) throw new ApiError("query 不能为空", 400);
  const limit = Math.min(100, Math.max(1, Number(input.query?.limit || input.body?.limit || 5)));
  const offset = Math.max(0, Math.floor(Number(input.query?.offset || input.body?.offset || 0) || 0));
  const page = await MetricService.search_metrics(
    { query: ctx.query, queryOne: ctx.queryOne },
    { project_id: pid, query_text: queryText, limit: limit + 1, offset },
  );
  const hasMore = page.length > limit;
  const semanticItems = page.slice(0, limit);
  const plans = await listMetricExecutionPlans(ctx, {
    project_id: pid,
    metric_ids: semanticItems.map((item) => item.id),
  });
  const plansByMetric = new Map();
  for (const plan of plans) {
    const items = plansByMetric.get(plan.metric_id) || [];
    items.push(plan);
    plansByMetric.set(plan.metric_id, items);
  }
  const items = semanticItems.map((item) => ({
    ...item,
    execution_plans: plansByMetric.get(item.id) || [],
  }));
  return {
    data: {
      items,
      total: items.length,
      limit,
      offset,
      has_more: hasMore,
      next_offset: hasMore ? offset + limit : null,
    },
    message: "搜索指标成功",
  };
}

// POST /api/projects/:pid/metrics/:mid/execute — run one saved metric definition read-only.
export async function executeMetric(ctx, input) {
  const { pid, mid } = input.params;
  const parameters = input.body?.parameters ?? {};
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    throw new ApiError("parameters 必须是 JSON 对象", 400);
  }
  const metric = await ctx.queryOne(
    `SELECT id, name FROM metric_definitions
      WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mid, pid],
  );
  if (!metric) throw new ApiError("指标不存在", 404);

  const businessDataSources = new BusinessDataSources(pid, pid);
  await businessDataSources.load_sources();
  const tool = new ExecuteMetricTool({ business_data_sources: businessDataSources });
  const toolResult = await tool.execute(
    {
      project_id: pid,
      session_id: null,
      db_ctx: { query: ctx.query, queryOne: ctx.queryOne },
      input_data: {
        project_id: pid,
        data_sources_info: { business_data_sources: businessDataSources },
      },
    },
    { definition_id: mid, parameters },
  );
  const data = metricExecutionResponse(metric, toolResult.data || {}, toolResult);
  return {
    data,
    message: data.needs_clarification
      ? "指标试跑需要补充参数"
      : data.success && data.executed ? "指标试跑完成" : "指标试跑未完成",
  };
}

// POST /api/projects/:pid/metrics/code_values/import
export async function importCodeValues(ctx, input) {
  const { pid } = input.params;
  const result = await MetricService.import_code_values_from_excel(
    { query: ctx.query, queryOne: ctx.queryOne },
    {
      project_id: pid,
      source_id: input.query?.source_id || input.body?.source_id || null,
      source_type: input.query?.source_type || input.body?.source_type || null,
      import_format: input.query?.import_format || input.body?.import_format || "by-metric",
      file_bytes: input.body?.file || input.body,
    },
  );
  return { data: result, message: result.message || "码值导入完成" };
}

// GET /api/projects/:pid/metrics/code_values/export
export async function exportCodeValues(ctx, input) {
  const { pid } = input.params;
  const options = {
    project_id: pid,
    source_id: input.query?.source_id || null,
    source_type: input.query?.source_type || null,
  };
  const exportType = input.query?.export_type || "excel";
  if (exportType === "json") {
    const json = await MetricService.export_code_values_to_json(
      { query: ctx.query, queryOne: ctx.queryOne }, options,
    );
    return {
      data: Buffer.from(json, "utf8"), _binary: true,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": 'attachment; filename="metric-code-values.json"',
      },
    };
  }
  const sheet = await MetricService.export_code_values_to_excel(
    { query: ctx.query, queryOne: ctx.queryOne },
    { ...options, export_format: input.query?.export_format || "by-metric" },
  );
  const xlsxModule = await import("xlsx");
  const XLSX = xlsxModule.default || xlsxModule;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sheet.rows), sheet.sheet_name || "export");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return {
    data: buffer, _binary: true,
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": 'attachment; filename="metric-code-values.xlsx"',
    },
  };
}

// PATCH /api/projects/:pid/businesses/:bid/metrics/batch_update_status — batch update status
export async function batchUpdateMetricStatus(ctx, input) {
  const { pid } = input.params;
  const { metric_ids, is_active } = input.body || {};
  if (!Array.isArray(metric_ids) || !metric_ids.length)
    throw new ApiError("metric_ids 不能为空", 400);
  if (is_active === undefined) throw new ApiError("is_active 不能为空", 400);
  // Count existing ids first, then update
  const existing = await ctx.query(
    `SELECT id FROM metric_definitions WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
    [pid, metric_ids],
  );
  if (existing.length) {
    await ctx.query(
      `UPDATE metric_definitions SET is_active=$1, updated_at=now()
        WHERE project_id=$2 AND id::text = ANY($3::text[]) AND deleted_at IS NULL`,
      [!!is_active, pid, metric_ids],
    );
  }
  const updated_count = existing.length;
  return { data: { updated_count }, message: `成功${is_active ? "启用" : "禁用"} ${updated_count} 个指标` };
}

// PATCH /api/projects/:pid/businesses/:bid/metrics/:mid/status — update single metric status
export async function updateMetricStatus(ctx, input) {
  const { pid, mid } = input.params;
  const { is_active } = input.body || {};
  if (is_active === undefined) throw new ApiError("is_active 不能为空", 400);
  const check = await ctx.queryOne(
    `SELECT id FROM metric_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mid, pid],
  );
  if (!check) throw new ApiError("指标不存在", 404);
  await ctx.query(
    `UPDATE metric_definitions SET is_active=$1, updated_at=now()
      WHERE id=$2 AND project_id=$3 AND deleted_at IS NULL`,
    [!!is_active, mid, pid],
  );
  return { data: { updated: true }, message: is_active ? "已启用" : "已禁用" };
}

// POST /api/projects/:pid/businesses/:bid/metrics — create metric
export async function createMetric(ctx, input) {
  const { pid, bid } = input.params;
  const b = await assertBusiness(pid, bid);
  if (!b) throw new ApiError("业务不存在", 404);
  const body = input.body || {};
  assertPlanOnlyContract(body);
  const {
    name, description, related_tables, related_columns,
    aliases, code_knowledge, execution_plans,
  } = body;
  if (!name || !name.trim()) throw new ApiError("指标名称不能为空", 400);
  if (!Array.isArray(execution_plans) || !execution_plans.length) {
    throw new ApiError("execution_plans 必须是至少包含一项的数组", 400);
  }
  try {
    execution_plans.forEach((plan) => validateMetricExecutionPlan(plan));
  } catch (error) {
    throw new ApiError(error.message, 400);
  }

  const id = crypto.randomUUID();
  await ctx.query(
    `INSERT INTO metric_definitions
       (id, project_id, name, description, related_tables, related_columns,
        aliases, code_knowledge, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,now(),now())`,
    [
      id, pid, name.trim(), description || null,
      JSON.stringify(related_tables || []),
      JSON.stringify(related_columns || {}),
      JSON.stringify(aliases || []),
      code_knowledge ? JSON.stringify(code_knowledge) : null,
    ],
  );
  try {
    await replaceMetricExecutionPlans(ctx, {
      project_id: pid,
      metric_id: id,
      execution_plans,
    });
  } catch (error) {
    await ctx.query(`DELETE FROM metric_execution_plans WHERE project_id=$1 AND metric_id=$2`, [pid, id]);
    await ctx.query(`DELETE FROM metric_definitions WHERE project_id=$1 AND id=$2`, [pid, id]);
    throw error;
  }
  const row = await metricWithPlans(ctx, pid, id);
  // Generate this metric embedding in background (non-blocking response; search_metrics falls back to keyword before ready)
  // Return immediately and keep async behavior via queueMicrotask.
  queueMicrotask(() => {
    MetricService.generate_metric_embeddings(
      { query: ctx.query, queryOne: ctx.queryOne }, { project_id: pid, metric_id: id },
    ).catch((e) => console.warn(`[metric embed] ${e?.message ?? e}`));
  });
  return { data: row, message: "创建指标成功" };
}

// PUT /api/projects/:pid/businesses/:bid/metrics/:mid — update metric
export async function updateMetric(ctx, input) {
  const { pid, mid } = input.params;
  const existing = await ctx.queryOne(
    `SELECT * FROM metric_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mid, pid],
  );
  if (!existing) throw new ApiError("指标不存在", 404);

  const body = input.body || {};
  assertPlanOnlyContract(body);
  const {
    name, description, related_tables, related_columns,
    is_active, aliases, code_knowledge, execution_plans,
  } = body;
  if (execution_plans !== undefined) {
    if (!Array.isArray(execution_plans) || !execution_plans.length) {
      throw new ApiError("execution_plans 必须是至少包含一项的数组", 400);
    }
    try {
      execution_plans.forEach((plan) => validateMetricExecutionPlan(plan));
    } catch (error) {
      throw new ApiError(error.message, 400);
    }
  }

  const sets = ["updated_at=now()"];
  const vals = [];
  const add = (col, val) => { sets.push(`${col}=$${vals.length + 1}`); vals.push(val); };

  if (name !== undefined) add("name", name);
  if (description !== undefined) add("description", description);
  if (related_tables !== undefined) add("related_tables", JSON.stringify(related_tables));
  if (related_columns !== undefined) add("related_columns", JSON.stringify(related_columns));
  if (is_active !== undefined) add("is_active", !!is_active);
  if (aliases !== undefined) add("aliases", JSON.stringify(aliases));
  if (code_knowledge !== undefined) add("code_knowledge", JSON.stringify(code_knowledge));

  if (execution_plans !== undefined) {
    await replaceMetricExecutionPlans(ctx, {
      project_id: pid,
      metric_id: mid,
      execution_plans,
    });
  }
  vals.push(mid);
  await ctx.query(`UPDATE metric_definitions SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  const row = await metricWithPlans(ctx, pid, mid);
  return { data: row, message: "更新指标成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/metrics/:mid — delete single metric
export async function deleteMetric(ctx, input) {
  const { pid, mid } = input.params;
  const check = await ctx.queryOne(
    `SELECT id FROM metric_definitions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mid, pid],
  );
  if (!check) throw new ApiError("指标不存在", 404);
  await ctx.query(
    `UPDATE metric_definitions SET deleted_at=now(), updated_at=now() WHERE id=$1`,
    [mid],
  );
  await ctx.query(
    `UPDATE metric_execution_plans SET deleted_at=now(), is_active=false, updated_at=now()
      WHERE metric_id=$1 AND project_id=$2 AND deleted_at IS NULL`,
    [mid, pid],
  );
  return { data: null, message: "删除指标成功" };
}

// DELETE /api/projects/:pid/businesses/:bid/metrics — batch delete metrics
export async function deleteMetrics(ctx, input) {
  const { pid } = input.params;
  const { metric_ids, delete_all } = input.body || {};
  let deleted_count = 0;
  if (delete_all) {
    const existing = await ctx.query(
      `SELECT id FROM metric_definitions WHERE project_id=$1 AND deleted_at IS NULL`,
      [pid],
    );
    deleted_count = existing.length;
    if (deleted_count) {
      await ctx.query(
        `UPDATE metric_definitions SET deleted_at=now(), updated_at=now()
          WHERE project_id=$1 AND deleted_at IS NULL`,
        [pid],
      );
      await ctx.query(
        `UPDATE metric_execution_plans SET deleted_at=now(), is_active=false, updated_at=now()
          WHERE project_id=$1 AND deleted_at IS NULL`,
        [pid],
      );
    }
  } else {
    if (!Array.isArray(metric_ids) || !metric_ids.length)
      throw new ApiError("metric_ids 不能为空", 400);
    const existing = await ctx.query(
      `SELECT id FROM metric_definitions WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
      [pid, metric_ids],
    );
    deleted_count = existing.length;
    if (deleted_count) {
      await ctx.query(
        `UPDATE metric_definitions SET deleted_at=now(), updated_at=now()
          WHERE project_id=$1 AND id::text = ANY($2::text[]) AND deleted_at IS NULL`,
        [pid, metric_ids],
      );
      await ctx.query(
        `UPDATE metric_execution_plans SET deleted_at=now(), is_active=false, updated_at=now()
          WHERE project_id=$1 AND metric_id::text = ANY($2::text[]) AND deleted_at IS NULL`,
        [pid, metric_ids],
      );
    }
  }
  return { data: { deleted_count }, message: `成功删除 ${deleted_count} 个指标` };
}
