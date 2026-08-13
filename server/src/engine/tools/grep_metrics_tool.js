import { BaseTool, Result } from "../core/base_tool.js";
import * as defaultDb from "../../db.js";
import { SemanticDefinitionCatalogService } from "../semantic/semantic_definition_catalog_service.js";

const DESCRIPTION = `统一召回项目中已经保存的业务定义。业务定义可以返回一个值，也可以返回多行结果。

传入用户完整问题，不要只截取一个短词。返回的 candidates 只包含选择所需的业务含义、参数和结果形状。
模型阅读候选后自行选择；无法区分时调用 ask_user；当前页不合适且 has_more=true 时，用 next_offset
读取下一页。这里不使用相似度阈值自动拍板。

选择后，把 definition_id 原样传给 execute_metric。`;

function agentParameter(parameter = {}) {
  const key = String(parameter.name || parameter.key || "").trim();
  if (!key) return null;
  const allowedValues = Array.isArray(parameter.allowed_values) ? parameter.allowed_values : [];
  return {
    key,
    label: parameter.description || parameter.label || key,
    type: parameter.type || "string",
    required: parameter.required !== false,
    ...(allowedValues.length ? { allowed_values: allowedValues } : {}),
  };
}

export function projectDefinitionCandidateForAgent(candidate = {}) {
  const parameters = (Array.isArray(candidate.parameters) ? candidate.parameters : [])
    .map(agentParameter)
    .filter(Boolean);
  return {
    definition_id: candidate.definition_id || null,
    name: candidate.name || null,
    summary: candidate.description || null,
    aliases: Array.isArray(candidate.aliases) ? candidate.aliases : [],
    output: {
      shape: candidate.output_shape || null,
      unit: candidate.unit || null,
      columns: Array.isArray(candidate.output_columns) ? candidate.output_columns : [],
    },
    parameters,
  };
}

export function projectDefinitionCatalogForAgent(data = {}) {
  const candidates = (Array.isArray(data.candidates) ? data.candidates : [])
    .map(projectDefinitionCandidateForAgent);
  return {
    question: data.question || "",
    candidates,
    count: candidates.length,
    limit: Number(data.limit) || candidates.length,
    offset: Math.max(0, Number(data.offset) || 0),
    has_more: data.has_more === true,
    next_offset: data.next_offset == null ? null : Number(data.next_offset),
  };
}

export class GrepMetricsTool extends BaseTool {
  constructor(kwargs = {}) {
    super("align_metric", DESCRIPTION, kwargs);
    this.inputs = {
      question: { type: "string", description: "用户完整问题原文" },
      limit: { type: "integer", description: "返回数量，默认 5", optional: true, default: 5 },
      offset: { type: "integer", description: "候选偏移量，默认 0", optional: true, default: 0 },
    };
    this.output_type = "object";
  }

  static resolveDbContext(context) {
    const injected = context?.db_ctx || context?.dbCtx || context?.input_data?.db_ctx;
    if (injected && typeof injected.query === "function") return injected;
    return { query: defaultDb.query, queryOne: defaultDb.queryOne };
  }

  async execute(context, kwargs = {}) {
    const question = String(kwargs.question || "").trim();
    const projectId = context?.project_id || context?.input_data?.project_id || "";
    if (!question) return Result.createError("缺少必填参数 question");
    if (!projectId) return Result.createError("缺少 project_id");
    try {
      const data = await SemanticDefinitionCatalogService.search(
        GrepMetricsTool.resolveDbContext(context),
        {
          question,
          project_id: projectId,
          limit: kwargs.limit,
          offset: kwargs.offset,
        },
      );
      return Result.create(
        data,
        data.candidates.length ? `召回 ${data.candidates.length} 个业务定义候选` : "未找到匹配的业务定义",
      );
    } catch (error) {
      console.error(`[align_metric] 召回失败: ${error?.message || error}`);
      return Result.createError(`业务定义召回失败: ${error?.message || error}`);
    }
  }
}

export default GrepMetricsTool;
