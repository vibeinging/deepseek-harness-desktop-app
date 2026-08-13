import { ApiError } from "../../errors.js";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FIXED_OPS = new Set(["=", "!=", ">", ">=", "<", "<=", "like", "in", "between", "is_null", "is_not_null"]);
const DYNAMIC_OPS = new Set(["=", "!=", ">", ">=", "<", "<=", "like", "in", "between"]);
const PROJECTION_KINDS = new Set(["field", "aggregate", "expression"]);
const MUTATING_SQL = /\b(insert|update|delete|drop|alter|create|truncate|replace|merge|attach|detach|copy|vacuum|call|grant|revoke)\b/i;

function ident(value, label = "标识符") {
  const text = String(value || "").trim();
  if (!IDENT.test(text)) throw new ApiError(`${label}不合法: ${text}`, 400);
  return `"${text}"`;
}

function outputAlias(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new ApiError(`投影别名不合法: ${text}`, 400);
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function tableRef(value) {
  const parts = String(value || "").trim().split(".");
  if (!parts.length || parts.length > 2 || parts.some((part) => !part)) {
    throw new ApiError(`表名不合法: ${value}`, 400);
  }
  return parts.map((part) => ident(part, "表名")).join(".");
}

function literal(value) {
  if (value === null || value === undefined || value === "") return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return `'${String(value).replace(/'/g, "''")}'`;
}

function parseField(field, tableMap) {
  if (!field?.table_key || !field?.column_name) throw new ApiError("字段引用不完整", 400);
  if (!tableMap.has(field.table_key)) throw new ApiError(`字段引用了未知表: ${field.table_key}`, 400);
  return `${ident(field.table_key, "表别名")}.${ident(field.column_name, "列名")}`;
}

function expressionTemplate(value, tableMap) {
  const raw = String(value || "").trim();
  if (!raw || /;|--|\/\*/.test(raw) || MUTATING_SQL.test(raw)) {
    throw new ApiError("表达式为空或包含不安全内容", 400);
  }
  const compiled = raw.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g,
    (_match, tableKey, columnName) => parseField({ table_key: tableKey, column_name: columnName }, tableMap));
  if (/\{\{|\}\}/.test(compiled)) throw new ApiError("表达式包含无法识别的字段引用", 400);
  return compiled;
}

function projectionSql(projection, tableMap) {
  const kind = String(projection?.kind || "").trim();
  if (!PROJECTION_KINDS.has(kind)) {
    throw new ApiError("投影 kind 必须是 field、aggregate 或 expression", 400);
  }
  const alias = projection.alias ? ` AS ${outputAlias(projection.alias)}` : "";
  if (kind === "expression") return `${expressionTemplate(projection.expression_template, tableMap)}${alias}`;
  const field = parseField(projection.field, tableMap);
  if (kind === "field") return `${field}${alias}`;
  const fn = String(projection.function || "").toLowerCase();
  if (!fn) throw new ApiError("聚合投影缺少 function", 400);
  if (fn === "count_distinct") return `COUNT(DISTINCT ${field})${alias}`;
  if (fn === "round") return `ROUND(${field}, ${Math.max(0, Math.min(10, Number(projection.precision ?? 2)))})${alias}`;
  if (!["sum", "avg", "count", "max", "min"].includes(fn)) throw new ApiError(`不支持的聚合函数: ${fn}`, 400);
  return `${fn.toUpperCase()}(${field})${alias}`;
}

function fixedPredicateSql(predicate, tableMap) {
  if (predicate.kind === "template") return expressionTemplate(predicate.expression_template, tableMap);
  const field = parseField(predicate.field, tableMap);
  const op = String(predicate.operator || "=").toLowerCase();
  if (!FIXED_OPS.has(op)) throw new ApiError(`不支持的条件操作符: ${op}`, 400);
  if (op === "is_null") return `${field} IS NULL`;
  if (op === "is_not_null") return `${field} IS NOT NULL`;
  if (op === "in") {
    const values = Array.isArray(predicate.values) ? predicate.values : [];
    if (!values.length) throw new ApiError("IN 条件不能为空", 400);
    return `${field} IN (${values.map(literal).join(", ")})`;
  }
  if (op === "between") return `${field} BETWEEN ${literal(predicate.start)} AND ${literal(predicate.end)}`;
  return `${field} ${op.toUpperCase()} ${literal(predicate.value)}`;
}

function isMissing(value) {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

function parameterSpecForDimension(dimension) {
  const op = String(dimension?.op || "=").toLowerCase();
  return {
    name: String(dimension?.name || "").trim(),
    type: op === "between" ? "range" : op === "in" ? "array" : String(dimension?.param_type || "string"),
    required: dimension?.required !== false,
    allowed_values: Array.isArray(dimension?.allowed_values) ? dimension.allowed_values : [],
    description: String(dimension?.description || "").trim() || null,
  };
}

export function describeMetricViewParameters(definition = {}) {
  const parameters = (definition.query_dimensions || []).map(parameterSpecForDimension).filter((item) => item.name);
  if (definition.time_dimension) {
    const op = String(definition.time_dimension.op || "between").toLowerCase();
    parameters.push({
      name: "time_range",
      type: op === "between" ? "date_range" : "date",
      required: definition.time_dimension.required !== false,
      allowed_values: [],
      description: "时间范围",
    });
  }
  return parameters;
}

function validateDynamicParameters(definition, supplied = {}) {
  const values = supplied && typeof supplied === "object" && !Array.isArray(supplied) ? supplied : {};
  const missing = [];
  const invalid = [];
  const activeDimensions = new Map();

  for (const dimension of definition.query_dimensions || []) {
    const spec = parameterSpecForDimension(dimension);
    if (!spec.name) {
      invalid.push({ name: "", error: "查询维度缺少参数名称" });
      continue;
    }
    const value = values[spec.name];
    if (isMissing(value)) {
      if (spec.required) missing.push(spec.name);
      continue;
    }
    const op = String(dimension.op || "=").toLowerCase();
    if (!DYNAMIC_OPS.has(op)) {
      invalid.push({ name: spec.name, error: `不支持操作符 ${op}` });
      continue;
    }
    if (op === "between") {
      if (!value || typeof value !== "object" || Array.isArray(value) || isMissing(value.start) || isMissing(value.end)) {
        invalid.push({ name: spec.name, error: "必须是包含 start 和 end 的范围对象" });
        continue;
      }
    } else if (op === "in") {
      if (!Array.isArray(value) || value.length === 0 || value.some(isMissing)) {
        invalid.push({ name: spec.name, error: "必须是非空数组" });
        continue;
      }
    } else if (typeof value === "object") {
      invalid.push({ name: spec.name, error: "必须是单个值" });
      continue;
    }
    const candidateValues = op === "in" ? value : op === "between" ? [value.start, value.end] : [value];
    if (spec.allowed_values.length && op !== "between") {
      const illegal = candidateValues.filter((item) => !spec.allowed_values.some((allowed) => allowed === item));
      if (illegal.length) {
        invalid.push({ name: spec.name, error: `必须是允许值之一: ${spec.allowed_values.join("、")}` });
        continue;
      }
    }
    activeDimensions.set(spec.name, value);
  }

  let timeValue;
  if (definition.time_dimension) {
    timeValue = values.time_range;
    const required = definition.time_dimension.required !== false;
    const op = String(definition.time_dimension.op || "between").toLowerCase();
    if (isMissing(timeValue)) {
      if (required) missing.push("time_range");
    } else if (!DYNAMIC_OPS.has(op) || op === "in") {
      invalid.push({ name: "time_range", error: `不支持时间操作符 ${op}` });
    } else if (op === "between"
      && (!timeValue || typeof timeValue !== "object" || Array.isArray(timeValue)
        || isMissing(timeValue.start) || isMissing(timeValue.end))) {
      invalid.push({ name: "time_range", error: "必须是包含 start 和 end 的时间范围对象" });
    } else if (op !== "between" && typeof timeValue === "object") {
      invalid.push({ name: "time_range", error: "必须是单个时间值" });
    }
  }

  return { values, missing, invalid, activeDimensions, timeValue };
}

function buildDemoInputs(definition) {
  const provided = definition.demo_inputs || {};
  const dimensions = {};
  for (const dim of definition.query_dimensions || []) {
    if (Object.prototype.hasOwnProperty.call(provided.dimension_values || {}, dim.name)) {
      dimensions[dim.name] = provided.dimension_values[dim.name];
    } else if (dim.param_type === "range" || dim.op === "between") {
      dimensions[dim.name] = { start: dim.allowed_values?.[0] || "", end: dim.allowed_values?.[1] || "" };
    } else if (dim.op === "in") {
      dimensions[dim.name] = dim.allowed_values?.slice(0, 2) || [];
    } else {
      dimensions[dim.name] = dim.allowed_values?.[0] || "";
    }
  }
  return {
    dimension_values: dimensions,
    time_range: { start: provided.time_range?.start || "", end: provided.time_range?.end || "" },
  };
}

function dynamicPredicateSql(field, op, value, mode, name, bindings) {
  if (!DYNAMIC_OPS.has(op)) throw new ApiError(`不支持的维度操作符: ${op}`, 400);
  const bind = (item, suffix = "") => {
    if (mode === "template") return `:${name}${suffix}`;
    if (mode === "demo") return literal(item);
    bindings.names.push(`${name}${suffix}`);
    bindings.values.push(item);
    return "?";
  };
  if (op === "between") return `${field} BETWEEN ${bind(value?.start, "_start")} AND ${bind(value?.end, "_end")}`;
  if (op === "in") {
    const items = Array.isArray(value) ? value : [];
    const placeholders = mode === "template" ? `:${name}` : items.map((item, index) => bind(item, `_${index}`)).join(", ");
    return `${field} IN (${placeholders || "NULL"})`;
  }
  return `${field} ${op.toUpperCase()} ${bind(value)}`;
}

function compile(definition, inputs, mode, activeDimensions = null, includeTime = true) {
  const tables = Array.isArray(definition.tables) ? definition.tables : [];
  if (!tables.length) throw new ApiError("至少需要一张表", 400);
  const tableMap = new Map();
  tables.forEach((table, index) => {
    const key = table.table_key || (index === 0 ? "main" : `join_${index}`);
    if (tableMap.has(key)) throw new ApiError(`表别名重复: ${key}`, 400);
    tableMap.set(key, { ...table, table_key: key });
  });
  const projections = Array.isArray(definition.projections) ? definition.projections : [];
  if (!projections.length) throw new ApiError("至少需要一个投影字段", 400);
  const select = projections.map((item) => projectionSql(item, tableMap)).join(",\n  ");
  const first = tableMap.values().next().value;
  let from = `${tableRef(first.table_ref)} AS ${ident(first.table_key, "表别名")}`;
  for (const table of [...tableMap.values()].slice(1)) {
    const conditions = (table.join_conditions || []).map((condition) => {
      if (condition.kind !== "field_compare") throw new ApiError("只支持字段对字段的 JOIN 条件", 400);
      const op = String(condition.operator || "=");
      if (!["=", "!=", ">", ">=", "<", "<="].includes(op)) throw new ApiError(`JOIN 操作符不合法: ${op}`, 400);
      return `${parseField(condition.left, tableMap)} ${op} ${parseField(condition.right, tableMap)}`;
    });
    if (!conditions.length) throw new ApiError(`关联表 ${table.table_ref} 缺少 JOIN 条件`, 400);
    const joinType = String(table.join_type || "inner").toUpperCase();
    if (!["INNER", "LEFT", "RIGHT", "FULL"].includes(joinType)) throw new ApiError(`JOIN 类型不合法: ${joinType}`, 400);
    from += `\n${joinType} JOIN ${tableRef(table.table_ref)} AS ${ident(table.table_key, "表别名")} ON ${conditions.join(" AND ")}`;
  }

  const bindings = { names: [], values: [] };
  const predicates = (definition.fixed_predicates || []).map((item) => fixedPredicateSql(item, tableMap));
  for (const dimension of definition.query_dimensions || []) {
    if (activeDimensions && !activeDimensions.has(dimension.name)) continue;
    const value = activeDimensions ? activeDimensions.get(dimension.name) : inputs.dimension_values?.[dimension.name];
    predicates.push(dynamicPredicateSql(
      parseField(dimension.field, tableMap),
      String(dimension.op || "=").toLowerCase(),
      value,
      mode,
      dimension.name,
      bindings,
    ));
  }
  if (definition.time_dimension && includeTime) {
    const op = String(definition.time_dimension.op || "between").toLowerCase();
    const value = mode === "bound" ? inputs.time_range : inputs.time_range;
    predicates.push(dynamicPredicateSql(
      parseField(definition.time_dimension.field, tableMap),
      op,
      value,
      mode,
      "time_range",
      bindings,
    ));
  }

  const groupBy = (definition.group_by || []).map((item) => item.kind === "expression"
    ? expressionTemplate(item.expression_template, tableMap)
    : parseField(item.field, tableMap));
  const projectionByKey = new Map(projections.map((projection) => [projection.projection_key, projection]));
  const orderBy = (definition.sort_spec?.order_by || []).map((item) => {
    let target;
    if (item.kind === "field") target = parseField(item.field, tableMap);
    else if (item.kind === "projection") {
      const projection = projectionByKey.get(item.projection_key);
      if (!projection) throw new ApiError(`排序引用了未知投影: ${item.projection_key}`, 400);
      target = projection.alias ? outputAlias(projection.alias) : projectionSql(projection, tableMap).replace(/\s+AS\s+.+$/i, "");
    } else target = expressionTemplate(item.expression_template, tableMap);
    const direction = String(item.direction || "ASC").toUpperCase();
    if (!["ASC", "DESC"].includes(direction)) throw new ApiError(`排序方向不合法: ${direction}`, 400);
    return `${target} ${direction}`;
  });
  const limit = Math.min(10000, Math.max(1, Number(definition.sort_spec?.limit_default || 100)));
  const sql = [
    `SELECT\n  ${select}`,
    `FROM ${from}`,
    predicates.length ? `WHERE ${predicates.join("\n  AND ")}` : "",
    groupBy.length ? `GROUP BY ${groupBy.join(", ")}` : "",
    orderBy.length ? `ORDER BY ${orderBy.join(", ")}` : "",
    `LIMIT ${limit}`,
  ].filter(Boolean).join("\n");
  if (MUTATING_SQL.test(sql) || /;|--|\/\*/.test(sql)) throw new ApiError("生成的查询包含不安全内容", 400);
  return { sql, parameters: bindings.values, parameter_names: bindings.names };
}

export function compileMetricViewExecution(definition = {}, suppliedParameters = {}) {
  const validation = validateDynamicParameters(definition, suppliedParameters);
  const parameterSpecs = describeMetricViewParameters(definition);
  if (validation.missing.length || validation.invalid.length) {
    return {
      success: false,
      needs_clarification: true,
      missing_parameters: validation.missing,
      invalid_parameters: validation.invalid,
      required_parameters: parameterSpecs.filter((item) => validation.missing.includes(item.name)
        || validation.invalid.some((invalid) => invalid.name === item.name)),
    };
  }
  const hasTime = Boolean(definition.time_dimension) && !isMissing(validation.timeValue);
  const compiled = compile(
    definition,
    { time_range: validation.timeValue },
    "bound",
    validation.activeDimensions,
    hasTime,
  );
  return { success: true, ...compiled, parameter_specs: parameterSpecs };
}

export function metricViewOutputColumns(definition = {}) {
  return (definition.projections || []).map((projection, index) => ({
    name: projection.alias || projection.field?.column_name || projection.projection_key || `column_${index + 1}`,
    kind: projection.kind || "field",
  }));
}

export function compileMetricViewPreview(definition) {
  const errors = [];
  const warnings = [];
  const demoInputs = buildDemoInputs(definition || {});
  let templateSql = "";
  let demoSql = "";
  try {
    templateSql = compile(definition || {}, demoInputs, "template").sql;
    const demoDimensions = new Map();
    for (const dim of definition.query_dimensions || []) {
      const value = demoInputs.dimension_values?.[dim.name];
      if (!isMissing(value)) demoDimensions.set(dim.name, value);
    }
    const timeOp = String(definition.time_dimension?.op || "between").toLowerCase();
    const timeValue = timeOp === "between"
      ? demoInputs.time_range
      : demoInputs.time_range?.start || demoInputs.time_range?.end || "";
    const hasDemoTime = timeOp === "between"
      ? !isMissing(timeValue?.start) && !isMissing(timeValue?.end)
      : !isMissing(timeValue);
    demoSql = compile(
      definition || {},
      { ...demoInputs, time_range: timeValue },
      "demo",
      demoDimensions,
      Boolean(definition.time_dimension) && hasDemoTime,
    ).sql;
    for (const dim of definition.query_dimensions || []) {
      const value = demoInputs.dimension_values?.[dim.name];
      const missingDemo = String(dim.op || "=").toLowerCase() === "between"
        ? isMissing(value?.start) || isMissing(value?.end)
        : isMissing(value);
      if (dim.required !== false && missingDemo) {
        warnings.push(`维度 ${dim.name} 尚未填写演示值`);
      }
    }
    if (definition.time_dimension && (!demoInputs.time_range.start || !demoInputs.time_range.end)) {
      warnings.push("时间维度尚未填写演示范围");
    }
  } catch (error) {
    errors.push(error?.message || String(error));
  }
  const tableCount = Array.isArray(definition?.tables) ? definition.tables.length : 0;
  return {
    summary: {
      table_count: tableCount,
      join_count: Math.max(0, tableCount - 1),
      fixed_predicate_count: definition?.fixed_predicates?.length || 0,
      query_dimension_count: definition?.query_dimensions?.length || 0,
      has_time_dimension: Boolean(definition?.time_dimension),
      projection_count: definition?.projections?.length || 0,
    },
    validation: { status: errors.length ? "error" : (warnings.length ? "warning" : "success"), errors, warnings },
    template_sql: templateSql,
    demo_sql: demoSql,
    demo_inputs: demoInputs,
  };
}

export default {
  compileMetricViewExecution,
  compileMetricViewPreview,
  describeMetricViewParameters,
  metricViewOutputColumns,
};
