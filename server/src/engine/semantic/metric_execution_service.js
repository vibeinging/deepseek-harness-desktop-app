import { randomUUID } from "node:crypto";

export const METRIC_PLAN_TYPES = Object.freeze(["sql", "formula"]);
export const METRIC_SQL_PARAMETER_TYPES = Object.freeze(["string", "number", "integer", "boolean", "date"]);
const METRIC_SQL_PARAMETER_TYPE_SET = new Set(METRIC_SQL_PARAMETER_TYPES);

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function normalizePlanType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (!METRIC_PLAN_TYPES.includes(type)) {
    throw new Error(`plan_type 必须是 ${METRIC_PLAN_TYPES.join("、")}`);
  }
  return type;
}

function normalizedSql(sql) {
  return String(sql || "")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .trim();
}

function isReadOnlyMetricSql(sql) {
  const text = normalizedSql(sql).replace(/;+\s*$/, "");
  if (!text || !/^(select|with)\b/i.test(text) || text.includes(";")) return false;
  return !/\b(insert|update|delete|drop|alter|create|truncate|replace|merge|attach|detach|copy|vacuum|call)\b/i.test(text);
}

function normalizeSqlParameterValue(value, type, label) {
  if (value == null) return value;
  if (typeof value === "object") throw new Error(`${label} 必须是标量值`);
  if (type === "number" || type === "integer") {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || (type === "integer" && !Number.isInteger(numeric))) {
      throw new Error(`${label}${type === "integer" ? "必须是整数" : "必须是数字"}`);
    }
    return numeric;
  }
  if (type === "boolean") {
    if (value === true || value === false) return value;
    if ([1, "1", "true"].includes(value)) return true;
    if ([0, "0", "false"].includes(value)) return false;
    throw new Error(`${label}必须是布尔值`);
  }
  if (type === "date") {
    const text = String(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error(`${label}必须是 YYYY-MM-DD 日期`);
    return text;
  }
  return String(value);
}

function normalizeSqlParameterDefinitions(spec) {
  if (spec.parameters == null) {
    if (spec.parameter_order != null && (!Array.isArray(spec.parameter_order) || spec.parameter_order.length)) {
      throw new Error("spec.parameter_order 只能引用 spec.parameters 中已定义的参数");
    }
    return { ...spec, ...(spec.parameter_order == null ? {} : { parameter_order: [] }) };
  }
  if (!Array.isArray(spec.parameters)) {
    throw new Error("spec.parameters 必须是 JSON 数组");
  }
  const seen = new Set();
  const parameters = spec.parameters.map((parameter, index) => {
    if (!parameter || typeof parameter !== "object" || Array.isArray(parameter)) {
      throw new Error(`SQL 参数 #${index + 1} 必须是 JSON 对象`);
    }
    const name = String(parameter.name || "").trim();
    if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new Error(`SQL 参数 #${index + 1} 缺少合法名称`);
    }
    if (seen.has(name)) throw new Error(`SQL 参数名称重复: ${name}`);
    seen.add(name);
    const type = String(parameter.type || "string").trim().toLowerCase();
    if (!METRIC_SQL_PARAMETER_TYPE_SET.has(type)) {
      throw new Error(`SQL 参数 ${name} 的 type 必须是 ${METRIC_SQL_PARAMETER_TYPES.join("、")}`);
    }
    let allowedValues = parameter.allowed_values;
    if (allowedValues != null) {
      if (!Array.isArray(allowedValues)) throw new Error(`SQL 参数 ${name} 的 allowed_values 必须是数组`);
      allowedValues = allowedValues.map((value) => normalizeSqlParameterValue(value, type, `SQL 参数 ${name} 的允许值`));
    }
    const normalized = { ...parameter, name, type };
    if (allowedValues != null) normalized.allowed_values = allowedValues;
    if (parameter.default != null) {
      normalized.default = normalizeSqlParameterValue(parameter.default, type, `SQL 参数 ${name} 的默认值`);
    }
    return normalized;
  });
  const defaultOrder = parameters.map((parameter) => parameter.name);
  const order = spec.parameter_order == null ? defaultOrder : spec.parameter_order;
  if (!Array.isArray(order)) throw new Error("spec.parameter_order 必须是 JSON 数组");
  const normalizedOrder = order.map((name) => String(name || "").trim());
  if (new Set(normalizedOrder).size !== normalizedOrder.length) {
    throw new Error("spec.parameter_order 中的参数不能重复");
  }
  const unknown = normalizedOrder.filter((name) => !seen.has(name));
  const omitted = defaultOrder.filter((name) => !normalizedOrder.includes(name));
  if (unknown.length || omitted.length) {
    throw new Error("spec.parameter_order 必须且只能包含 spec.parameters 中定义的全部参数");
  }
  return { ...spec, parameters, parameter_order: normalizedOrder };
}

function parseObject(value, label) {
  if (value == null || value === "") return {};
  const parsed = typeof value === "string" ? parseJson(value, null) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是有效的 JSON 对象`);
  }
  return parsed;
}

function planSpec(input = {}) {
  return parseObject(input.spec, "spec");
}

function canonicalJson(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (!item || typeof item !== "object") return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
  };
  return JSON.stringify(normalize(value));
}

function comparablePlan(plan) {
  return {
    id: plan.id,
    plan_type: plan.plan_type,
    source_id: plan.source_id || null,
    source_type: plan.source_type || null,
    spec: plan.spec || {},
    evidence_policy: plan.evidence_policy || {},
    priority: Number(plan.priority ?? 100),
    is_active: plan.is_active !== false && plan.is_active !== 0,
  };
}

export function validateMetricExecutionPlan(input = {}, { defer_sql_safety = false } = {}) {
  const legacyKeys = ["execution_type", "execution_spec", "sql_template"]
    .filter((key) => Object.prototype.hasOwnProperty.call(input, key));
  if (legacyKeys.length) {
    throw new Error(`执行计划不接受旧字段: ${legacyKeys.join("、")}`);
  }
  const planType = normalizePlanType(input.plan_type);
  let spec = planSpec(input);
  const evidencePolicy = parseObject(input.evidence_policy, "evidence_policy");
  if (planType === "sql") {
    const sql = String(spec.sql_template || "").trim();
    if (!sql) throw new Error("SQL 执行计划必须在 spec.sql_template 提供 SQL");
    if (!defer_sql_safety && !isReadOnlyMetricSql(sql)) {
      throw new Error("SQL 指标只允许单条只读 SELECT/WITH 语句");
    }
    spec = normalizeSqlParameterDefinitions(spec);
  }
  if (planType === "formula") {
    if (!String(spec.expression || "").trim()) {
      throw new Error("公式执行计划必须在 spec.expression 提供表达式");
    }
    if (!spec.operands || typeof spec.operands !== "object" || Array.isArray(spec.operands)) {
      throw new Error("公式执行计划必须在 spec.operands 提供计算项");
    }
  }
  const priority = Number.isFinite(Number(input.priority)) ? Number(input.priority) : 100;
  return {
    id: String(input.id || "").trim() || null,
    plan_type: planType,
    source_id: input.source_id || null,
    source_type: input.source_type || null,
    spec,
    evidence_policy: {
      accepted_statuses: ["verified_source"],
      require_evidence: true,
      ...evidencePolicy,
    },
    priority,
    is_active: input.is_active !== false && input.is_active !== 0,
  };
}

export async function replaceMetricExecutionPlans(ctx, {
  project_id,
  metric_id,
  execution_plans,
} = {}) {
  if (!project_id || !metric_id) throw new Error("project_id 和 metric_id 不能为空");
  if (!Array.isArray(execution_plans) || !execution_plans.length) {
    throw new Error("execution_plans 必须是至少包含一项的数组");
  }
  const plans = execution_plans.map((item) => validateMetricExecutionPlan(item));
  if (!plans.some((item) => item.is_active)) throw new Error("指标至少需要一个启用的执行计划");
  const ids = plans.map((item) => item.id).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error("execution_plans 中的 id 不能重复");
  const current = await listMetricExecutionPlans(ctx, { project_id, metric_ids: [metric_id] });
  const currentIds = new Set(current.map((item) => String(item.id)));
  const foreignIds = ids.filter((id) => !currentIds.has(String(id)));
  if (foreignIds.length) {
    throw new Error(`执行计划 id 不属于当前指标: ${foreignIds.join("、")}`);
  }
  if (ids.length === plans.length) {
    if (current.length === plans.length
      && canonicalJson(current.map(comparablePlan)) === canonicalJson(plans.map(comparablePlan))) {
      return current;
    }
  }

  const saved = [];
  for (const plan of plans) {
    const id = plan.id || randomUUID();
    await ctx.query(
      `INSERT INTO metric_execution_plans
         (id, project_id, metric_id, plan_type, source_id, source_type, spec,
          evidence_policy, priority, version, is_active, created_at, updated_at, deleted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,now(),now(),NULL)
       ON CONFLICT(id) DO UPDATE SET
         project_id=excluded.project_id, metric_id=excluded.metric_id,
         plan_type=excluded.plan_type, source_id=excluded.source_id, source_type=excluded.source_type,
         spec=excluded.spec, evidence_policy=excluded.evidence_policy, priority=excluded.priority,
         version=metric_execution_plans.version+1, is_active=excluded.is_active,
         deleted_at=NULL, updated_at=now()`,
      [
        id, project_id, metric_id, plan.plan_type, plan.source_id, plan.source_type,
        JSON.stringify(plan.spec), JSON.stringify(plan.evidence_policy), plan.priority, plan.is_active,
      ],
    );
    saved.push({ ...plan, id });
  }
  await ctx.query(
    `UPDATE metric_execution_plans
        SET is_active=false, deleted_at=now(), updated_at=now()
      WHERE project_id=$1 AND metric_id=$2 AND deleted_at IS NULL
        AND id::text <> ALL($3::text[])`,
    [project_id, metric_id, saved.map((item) => item.id)],
  );
  return saved;
}

export async function listMetricExecutionPlans(ctx, { project_id, metric_ids } = {}) {
  const ids = [...new Set((metric_ids || []).map(String).filter(Boolean))];
  if (!project_id || !ids.length) return [];
  const rows = await ctx.query(
    `SELECT id, metric_id, plan_type, source_id, source_type, spec, evidence_policy,
            priority, version, is_active, created_at, updated_at
       FROM metric_execution_plans
      WHERE project_id=$1 AND metric_id::text = ANY($2::text[]) AND deleted_at IS NULL
      ORDER BY metric_id, priority ASC, version DESC, id ASC`,
    [project_id, ids],
  );
  return rows.map((row) => ({
    ...row,
    spec: parseJson(row.spec, {}),
    evidence_policy: parseJson(row.evidence_policy, {}),
    is_active: row.is_active !== false && row.is_active !== 0,
  }));
}

function sqlParameterValues(spec, supplied = {}) {
  const definitions = Array.isArray(spec.parameters) ? spec.parameters : [];
  const order = Array.isArray(spec.parameter_order)
    ? spec.parameter_order.map(String)
    : definitions.map((item) => String(item?.name || "")).filter(Boolean);
  const byName = new Map(definitions.map((item) => [String(item?.name || ""), item || {}]));
  const missing = [];
  const invalid = [];
  const values = order.map((name) => {
    const definition = byName.get(name) || {};
    const hasValue = Object.prototype.hasOwnProperty.call(supplied || {}, name);
    const hasDefault = definition.default !== undefined && definition.default !== null;
    if (!hasValue && !hasDefault && definition.required !== false) missing.push(name);
    const raw = hasValue ? supplied[name] : hasDefault ? definition.default : null;
    if (raw == null) return null;
    const type = String(definition.type || "string").toLowerCase();
    let value = raw;
    if (type === "number" || type === "integer") {
      value = Number(raw);
      if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
        invalid.push({ name, error: type === "integer" ? "必须是整数" : "必须是数字" });
        return raw;
      }
    } else if (type === "boolean") {
      if (raw === true || raw === false) value = raw;
      else if ([1, "1", "true"].includes(raw)) value = true;
      else if ([0, "0", "false"].includes(raw)) value = false;
      else invalid.push({ name, error: "必须是布尔值" });
    } else if (type === "date") {
      value = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid.push({ name, error: "必须是 YYYY-MM-DD 日期" });
    } else if (type === "string") {
      if (typeof raw === "object") invalid.push({ name, error: "必须是文字" });
      else value = String(raw);
    }
    if (Array.isArray(definition.allowed_values)
      && !definition.allowed_values.some((allowed) => allowed === value)) {
      invalid.push({ name, error: `必须是允许值之一: ${definition.allowed_values.join("、")}` });
    }
    return value;
  });
  return { order, values, missing, invalid, definitions };
}

function scalarSqlResult(result, spec) {
  const rows = Array.isArray(result?.data) ? result.data : [];
  if (rows.length !== 1) {
    return { success: false, error: `SQL 指标必须返回 1 行，实际返回 ${rows.length} 行` };
  }
  const columns = Array.isArray(result?.columns) && result.columns.length
    ? result.columns.map(String)
    : Object.keys(rows[0] || {});
  const requested = String(spec?.result?.value_column || spec?.value_column || "").trim();
  const valueColumn = requested || (columns.length === 1 ? columns[0] : "");
  if (!valueColumn || !columns.includes(valueColumn)) {
    return {
      success: false,
      error: requested
        ? `SQL 指标结果缺少数值列: ${requested}`
        : "SQL 指标返回多列，必须在 spec.result.value_column 指定数值列",
    };
  }
  const rawValue = rows[0]?.[valueColumn];
  if (rawValue == null || rawValue === "") return { success: false, error: "SQL 指标结果为空" };
  const numeric = Number(rawValue);
  return {
    success: true,
    value: Number.isFinite(numeric) ? numeric : rawValue,
    raw_value: rawValue,
    value_column: valueColumn,
    row: rows[0],
  };
}

class FormulaParser {
  constructor(expression, values) {
    this.tokens = String(expression).match(/[\p{L}_][\p{L}\p{N}_]*|(?:\d+(?:\.\d+)?)|[()+\-*/]/gu) || [];
    this.index = 0;
    this.values = values;
    if (this.tokens.join("") !== String(expression).replace(/\s+/g, "")) throw new Error("公式包含不支持的字符");
  }
  peek() { return this.tokens[this.index]; }
  take() { return this.tokens[this.index++]; }
  parse() {
    const value = this.expression();
    if (this.index !== this.tokens.length) throw new Error("公式格式不正确");
    return value;
  }
  expression() {
    let value = this.term();
    while (["+", "-"].includes(this.peek())) value = this.take() === "+" ? value + this.term() : value - this.term();
    return value;
  }
  term() {
    let value = this.factor();
    while (["*", "/"].includes(this.peek())) {
      const op = this.take();
      const right = this.factor();
      if (op === "/" && right === 0) throw new Error("公式不能除以 0");
      value = op === "*" ? value * right : value / right;
    }
    return value;
  }
  factor() {
    const token = this.take();
    if (token === "-") return -this.factor();
    if (token === "(") {
      const value = this.expression();
      if (this.take() !== ")") throw new Error("公式括号不完整");
      return value;
    }
    if (/^\d/.test(token || "")) return Number(token);
    if (!(token in this.values)) throw new Error(`公式缺少计算项: ${token}`);
    return Number(this.values[token]);
  }
}

export class MetricExecutionService {
  static async execute(ctx, {
    project_id,
    metric_id,
    sql_runner = null,
    parameters = {},
    visited = new Set(),
  } = {}) {
    if (!project_id || !metric_id) throw new Error("project_id 和 metric_id 不能为空");
    if (visited.has(metric_id)) throw new Error(`指标公式存在循环引用: ${metric_id}`);
    const nextVisited = new Set(visited).add(metric_id);
    const metric = await ctx.queryOne(
      `SELECT id, project_id, name, description
         FROM metric_definitions
        WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL AND (is_active=true OR is_active IS NULL)`,
      [metric_id, project_id],
    );
    if (!metric) throw new Error("指标不存在或未启用");
    const plan = await ctx.queryOne(
      `SELECT id, plan_type, source_id, source_type, spec, evidence_policy, version
         FROM metric_execution_plans
        WHERE metric_id=$1 AND project_id=$2 AND deleted_at IS NULL AND is_active=true
        ORDER BY priority ASC, version DESC, id ASC LIMIT 1`,
      [metric_id, project_id],
    );
    if (!plan) throw new Error("指标没有可用的执行计划");
    // Legacy rows may predate save-time SQL validation. Defer only the read-only
    // check here so execution can return the existing safe, non-executed result.
    const contract = validateMetricExecutionPlan(plan, { defer_sql_safety: true });
    if (contract.plan_type === "sql") {
      if (typeof sql_runner !== "function") {
        return {
          success: false,
          executed: false,
          plan_type: "sql",
          metric_id: metric.id,
          metric_name: metric.name,
          error: "SQL 指标缺少可用的数据源执行器",
        };
      }
      const sql = String(contract.spec.sql_template || "").trim();
      if (!isReadOnlyMetricSql(sql)) {
        return {
          success: false, executed: false, plan_type: "sql",
          metric_id: metric.id, metric_name: metric.name,
          error: "SQL 指标只允许单条只读 SELECT/WITH 语句",
        };
      }
      const bound = sqlParameterValues(contract.spec, parameters);
      if (bound.missing.length) {
        return {
          success: false,
          executed: false,
          needs_clarification: true,
          plan_type: "sql",
          metric_id: metric.id,
          metric_name: metric.name,
          error: `SQL 指标缺少参数: ${bound.missing.join("、")}`,
          required_parameters: bound.definitions.filter((item) => bound.missing.includes(String(item?.name || ""))),
        };
      }
      if (bound.invalid.length) {
        return {
          success: false,
          executed: false,
          needs_clarification: true,
          plan_type: "sql",
          metric_id: metric.id,
          metric_name: metric.name,
          error: `SQL 指标参数格式不正确: ${bound.invalid.map((item) => `${item.name}${item.error}`).join("；")}`,
          invalid_parameters: bound.invalid,
          required_parameters: bound.definitions.filter((item) => bound.invalid.some(
            (invalid) => invalid.name === String(item?.name || ""),
          )),
        };
      }
      const queryResult = await sql_runner({
        metric,
        plan: contract,
        sql,
        parameters: bound.values,
        parameter_names: bound.order,
        spec: contract.spec,
      });
      if (!queryResult || queryResult.success === false) {
        return {
          success: false, executed: false, plan_type: "sql",
          metric_id: metric.id, metric_name: metric.name,
          error: queryResult?.message || queryResult?.error || "SQL 指标执行失败",
          evidence: queryResult?.evidence ? [queryResult.evidence] : [],
        };
      }
      const selected = scalarSqlResult(queryResult, contract.spec);
      if (!selected.success) {
        return {
          ...selected, executed: false, plan_type: "sql",
          metric_id: metric.id, metric_name: metric.name,
          evidence: queryResult.evidence ? [queryResult.evidence] : [],
        };
      }
      if (contract.evidence_policy.require_evidence && !queryResult.evidence) {
        return {
          success: false, executed: false, plan_type: "sql",
          metric_id: metric.id, metric_name: metric.name,
          error: "SQL 指标要求数据源证据，但执行器没有返回证据",
          evidence: [],
        };
      }
      return {
        success: true,
        executed: true,
        plan_type: "sql",
        metric_id: metric.id,
        metric_name: metric.name,
        plan_id: plan.id,
        value: selected.value,
        raw_value: selected.raw_value,
        value_column: selected.value_column,
        unit: contract.spec.unit || contract.spec.result?.unit || null,
        sql,
        parameters: bound.values,
        parameter_names: bound.order,
        source_id: contract.source_id,
        source_type: contract.source_type,
        evidence: queryResult.evidence ? [queryResult.evidence] : [],
        validation_status: queryResult.evidence ? "verified_source" : "needs_review",
      };
    }
    const values = {};
    const evidence = [];
    const traces = [];
    for (const [name, operand] of Object.entries(contract.spec.operands || {})) {
      let result;
      if (operand && typeof operand === "object" && operand.metric_id) {
        result = await MetricExecutionService.execute(ctx, {
          project_id, metric_id: operand.metric_id, sql_runner,
          parameters: operand.parameters || parameters, visited: nextVisited,
        });
      } else if (operand && typeof operand === "object" && Number.isFinite(Number(operand.value))) {
        result = { success: true, value: Number(operand.value), evidence: [] };
      } else {
        throw new Error(`公式计算项 ${name} 缺少 metric_id 或 value`);
      }
      if (!result.success || result.executed === false) {
        return { ...result, metric_id: metric.id, metric_name: metric.name, operand: name };
      }
      values[name] = Number(result.value);
      evidence.push(...(result.evidence || []));
      traces.push({ name, metric_id: operand?.metric_id || null, value: result.value });
    }
    if (contract.evidence_policy.require_evidence && evidence.length === 0) {
      return {
        success: false,
        executed: false,
        plan_type: "formula",
        metric_id: metric.id,
        metric_name: metric.name,
        error: "公式指标要求原始证据，但所有计算项都没有证据",
      };
    }
    const value = new FormulaParser(contract.spec.expression, values).parse();
    return {
      success: true,
      executed: true,
      plan_type: "formula",
      metric_id: metric.id,
      metric_name: metric.name,
      plan_id: plan.id,
      value,
      unit: contract.spec.unit || null,
      formula: contract.spec.expression,
      operands: traces,
      evidence,
      validation_status: evidence.length === 0
        ? "not_required"
        : evidence.every((item) => item.validation_status === "verified_source")
          ? "verified_source"
          : "needs_review",
    };
  }

}
