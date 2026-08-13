import { BaseTool, Result } from "../core/base_tool.js";
import * as defaultDb from "../../db.js";
import { MetricExecutionService } from "../semantic/metric_execution_service.js";
import { MetricViewExecutionService } from "../semantic/metric_view_execution_service.js";

const DESCRIPTION = `执行 align_metric 选中的业务定义。服务端根据已保存且经过审核的规则返回一个值或多行结果，
并生成可核验的证据。模型只提供业务参数，不能查看、选择或改写内部执行规则。

把候选中的 definition_id 原样传入。若返回 needs_clarification=true，必须根据 required_parameters 或
invalid_parameters 补充参数；用户语义不明确时调用 ask_user，不能自行猜值。`;
const SQL_PLAN_SOURCE_TYPES = new Set(["database", "database_connection", "structured", "structured_data_source"]);

function scalarDefinitionResult(data = {}) {
  const { metric_id: metricId, metric_name: metricName, ...rest } = data;
  return {
    ...rest,
    definition_id: metricId,
    definition_kind: "metric",
    definition_name: metricName || null,
    output_shape: "scalar",
  };
}

export class ExecuteMetricTool extends BaseTool {
  constructor(kwargs = {}) {
    super("execute_metric", DESCRIPTION, kwargs);
    this.businessDataSources = kwargs.business_data_sources || null;
    this.inputs = {
      definition_id: { type: "string", description: "从 align_metric 候选逐字复制的业务定义 ID" },
      parameters: { type: "object", description: "候选 parameters 所列的期间、组织或维度参数", optional: true },
    };
    this.output_type = "object";
  }

  static resolveDbContext(context) {
    const injected = context?.db_ctx || context?.dbCtx || context?.input_data?.db_ctx;
    if (injected && typeof injected.query === "function") return injected;
    return { query: defaultDb.query, queryOne: defaultDb.queryOne };
  }

  resolveBusinessDataSources(context) {
    return context?.input_data?.data_sources_info?.business_data_sources
      || context?.data_sources_info?.business_data_sources
      || context?.business_data_sources
      || this.businessDataSources
      || null;
  }

  resolveDatasource(bds, sourceRef, sourceName = "", { requiredType = null } = {}) {
    let datasource = null;
    const hasExplicitSource = Boolean(String(sourceRef || "").trim());
    if (hasExplicitSource) {
      if (typeof bds?.get_data_source === "function") datasource = bds.get_data_source(sourceRef);
      if (datasource && requiredType && datasource.source_type !== requiredType) return null;
      // 显式 source_id 不存在或类型错误时必须失败关闭，不能回退到项目唯一数据库。
      return datasource;
    }
    if (!datasource && sourceName && typeof bds?.get_data_source_by_name === "function") {
      try { datasource = bds.get_data_source_by_name(sourceName); } catch { datasource = null; }
    }
    if (datasource && requiredType && datasource.source_type !== requiredType) datasource = null;
    if (!datasource && typeof bds?.get_database_sources === "function") {
      const sources = bds.get_database_sources();
      if (sources.length === 1) datasource = sources[0];
    }
    return datasource;
  }

  createSqlRunner(context) {
    const bds = this.resolveBusinessDataSources(context);
    if (!bds || typeof bds.query !== "function") return null;
    return async ({ plan, sql, parameters, spec }) => {
      const sourceRef = plan?.source_id || null;
      const sourceName = String(spec?.source_name || "").trim();
      const declaredSourceType = String(plan?.source_type || "").trim().toLowerCase();
      const declaredTypeMismatch = Boolean(sourceRef && declaredSourceType
        && !SQL_PLAN_SOURCE_TYPES.has(declaredSourceType));
      const datasource = declaredTypeMismatch
        ? null
        : this.resolveDatasource(bds, sourceRef, sourceName, { requiredType: "database_connection" });
      if (!datasource?.datasource_name) {
        const count = typeof bds.get_database_sources === "function" ? bds.get_database_sources().length : 0;
        return {
          success: false,
          message: !sourceRef && count > 1
            ? "SQL 指标未绑定数据源，且项目存在多个数据库来源"
            : "SQL 指标绑定的数据源不存在或不可用",
        };
      }
      return bds.query(datasource.datasource_name, sql, {
        project_id: context?.project_id || context?.input_data?.project_id || null,
        session_id: context?.session_id || context?.input_data?.session_id || null,
        parameters,
      });
    };
  }

  createViewQueryRunner(context) {
    const bds = this.resolveBusinessDataSources(context);
    if (!bds || typeof bds.query !== "function") return null;
    return async ({ source_id: sourceId, sql, parameters }) => {
      const datasource = this.resolveDatasource(bds, sourceId);
      if (!datasource?.datasource_name) {
        return { success: false, message: "业务视图绑定的数据源不存在或不可用" };
      }
      const queryResult = await bds.query(datasource.datasource_name, sql, {
        project_id: context?.project_id || context?.input_data?.project_id || null,
        session_id: context?.session_id || context?.input_data?.session_id || null,
        parameters,
      });
      return { query_result: queryResult, source_name: datasource.datasource_name };
    };
  }

  async execute(context, kwargs = {}) {
    const projectId = context?.project_id || context?.input_data?.project_id || "";
    const definitionId = String(kwargs.definition_id || "").trim();
    if (!projectId) return Result.createError("缺少 project_id");
    if (!definitionId) return Result.createError("缺少 definition_id");
    const ctx = ExecuteMetricTool.resolveDbContext(context);
    try {
      const viewDefinition = await MetricViewExecutionService.findActiveDefinition(ctx, {
        project_id: projectId,
        definition_id: definitionId,
      });
      const data = viewDefinition
        ? await MetricViewExecutionService.execute(ctx, {
          project_id: projectId,
          definition_id: definitionId,
          definition: viewDefinition,
          parameters: kwargs.parameters || {},
          query_runner: this.createViewQueryRunner(context),
        })
        : scalarDefinitionResult(await MetricExecutionService.execute(ctx, {
          project_id: projectId,
          metric_id: definitionId,
          parameters: kwargs.parameters || {},
          sql_runner: this.createSqlRunner(context),
        }));
      return Result.create(
        data,
        data.needs_clarification
          ? "业务定义参数需要确认"
          : data.executed === false ? "业务定义未执行" : "业务定义执行完成",
      );
    } catch (error) {
      return Result.createError(`业务定义执行失败: ${error?.message || error}`);
    }
  }
}

export default ExecuteMetricTool;
