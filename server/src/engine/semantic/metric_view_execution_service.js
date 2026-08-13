import {
  compileMetricViewExecution,
  describeMetricViewParameters,
  metricViewOutputColumns,
} from "./metric_view_runtime.js";

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function metricViewDefinitionFromRow(row = {}) {
  return {
    id: row.id,
    project_id: row.project_id,
    source_id: row.source_id,
    name: row.name,
    description: row.description || null,
    aliases: parseJson(row.aliases, []),
    tables: parseJson(row.tables, []),
    fixed_predicates: parseJson(row.fixed_predicates, []),
    query_dimensions: parseJson(row.query_dimensions, []),
    time_dimension: parseJson(row.time_dimension, null),
    projections: parseJson(row.projections, []),
    group_by: parseJson(row.group_by, []),
    sort_spec: parseJson(row.sort_spec, { order_by: [], limit_default: 100 }),
    status: row.status,
  };
}

function enrichEvidence(evidence, definition, compiled) {
  if (!evidence || typeof evidence !== "object") return evidence || null;
  return {
    ...evidence,
    produced_by: "metric_view_executor",
    business_definition: {
      definition_id: definition.id,
      definition_kind: "query_view",
      output_shape: "table",
      name: definition.name,
      plan_type: "relational_query",
      parameter_names: compiled.parameter_names,
    },
  };
}

export class MetricViewExecutionService {
  static async findActiveDefinition(ctx, { project_id, definition_id } = {}) {
    if (!project_id || !definition_id) return null;
    const row = await ctx.queryOne(
      `SELECT id, project_id, source_id, name, description, aliases, tables, fixed_predicates,
              query_dimensions, time_dimension, projections, group_by, sort_spec, status
         FROM metric_view_definitions
        WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL AND status='active'`,
      [definition_id, project_id],
    );
    return row ? metricViewDefinitionFromRow(row) : null;
  }

  static async execute(ctx, {
    project_id,
    definition_id,
    definition = null,
    parameters = {},
    query_runner = null,
  } = {}) {
    if (!project_id || !definition_id) throw new Error("project_id 和 definition_id 不能为空");
    const selected = definition || await MetricViewExecutionService.findActiveDefinition(ctx, {
      project_id,
      definition_id,
    });
    if (!selected) throw new Error("业务视图不存在或未启用");
    const compiled = compileMetricViewExecution(selected, parameters);
    if (!compiled.success) {
      return {
        success: false,
        executed: false,
        needs_clarification: true,
        definition_id: selected.id,
        definition_kind: "query_view",
        definition_name: selected.name,
        output_shape: "table",
        plan_type: "relational_query",
        error: compiled.missing_parameters?.length
          ? `业务视图缺少参数: ${compiled.missing_parameters.join("、")}`
          : `业务视图参数格式不正确: ${(compiled.invalid_parameters || []).map((item) => `${item.name}${item.error}`).join("；")}`,
        missing_parameters: compiled.missing_parameters || [],
        invalid_parameters: compiled.invalid_parameters || [],
        required_parameters: compiled.required_parameters || [],
      };
    }
    if (typeof query_runner !== "function") {
      return {
        success: false,
        executed: false,
        definition_id: selected.id,
        definition_kind: "query_view",
        definition_name: selected.name,
        output_shape: "table",
        plan_type: "relational_query",
        error: "业务视图缺少可用的数据源执行器",
      };
    }
    const executed = await query_runner({
      definition: selected,
      source_id: selected.source_id,
      sql: compiled.sql,
      parameters: compiled.parameters,
      parameter_names: compiled.parameter_names,
    });
    const queryResult = executed?.query_result || executed;
    if (!queryResult || queryResult.success === false) {
      return {
        success: false,
        executed: false,
        definition_id: selected.id,
        definition_kind: "query_view",
        definition_name: selected.name,
        output_shape: "table",
        plan_type: "relational_query",
        error: queryResult?.message || queryResult?.error || "业务视图执行失败",
        evidence: queryResult?.evidence || null,
      };
    }
    const evidence = enrichEvidence(queryResult.evidence, selected, compiled);
    if (evidence) queryResult.evidence = evidence;
    return {
      success: true,
      executed: true,
      definition_id: selected.id,
      definition_kind: "query_view",
      definition_name: selected.name,
      description: selected.description,
      output_shape: "table",
      plan_type: "relational_query",
      source_id: selected.source_id,
      source_name: executed?.source_name || evidence?.source?.name || null,
      parameters: compiled.parameters,
      parameter_names: compiled.parameter_names,
      parameter_specs: describeMetricViewParameters(selected),
      output_columns: metricViewOutputColumns(selected),
      sql: compiled.sql,
      query_result: queryResult,
      evidence,
    };
  }
}

export default MetricViewExecutionService;
