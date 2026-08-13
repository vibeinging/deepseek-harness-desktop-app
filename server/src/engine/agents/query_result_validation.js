import { randomUUID } from "node:crypto";

export const QUERY_VALIDATION_SCOPES = Object.freeze({
  EXECUTION_ONLY: "execution_only",
  RESULT_CONTRACT: "result_contract",
  SAVED_DEFINITION: "saved_definition",
});

export const QUERY_VALIDATION_REQUIREMENT_KEYS = Object.freeze([
  "required_columns",
  "non_null_columns",
  "key_columns",
  "numeric_ranges",
  "required_sql_fragments",
  "required_predicates",
  "aggregation",
  "time_range",
  "expected_unit",
  "reconcile",
]);

const QUERY_VALIDATION_OPTION_KEYS = Object.freeze([
  "require_non_empty",
  ...QUERY_VALIDATION_REQUIREMENT_KEYS,
]);

const COMPLETION_VALIDATION_SCOPES = new Set([
  QUERY_VALIDATION_SCOPES.RESULT_CONTRACT,
  QUERY_VALIDATION_SCOPES.SAVED_DEFINITION,
]);

export function withQueryValidationScope(validation, scope) {
  return {
    ...(validation || {}),
    scope: Object.values(QUERY_VALIDATION_SCOPES).includes(scope)
      ? scope
      : QUERY_VALIDATION_SCOPES.EXECUTION_ONLY,
  };
}

export function isAcceptedQueryValidation(validation) {
  return String(validation?.status || "").toLowerCase() === "passed"
    && COMPLETION_VALIDATION_SCOPES.has(String(validation?.scope || "").toLowerCase());
}

export function hasQueryValidationContract(requirements = {}) {
  return QUERY_VALIDATION_REQUIREMENT_KEYS.some((key) => {
    const value = requirements?.[key];
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return String(value ?? "").trim().length > 0;
  });
}

export function mergeQueryValidationRequirements(planned = {}, supplied = {}) {
  const merged = {};
  for (const key of QUERY_VALIDATION_OPTION_KEYS) {
    const base = planned?.[key];
    const extra = supplied?.[key];
    if (Array.isArray(base) || Array.isArray(extra)) {
      const seen = new Set();
      const values = [];
      for (const value of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
        const signature = JSON.stringify(value);
        if (seen.has(signature)) continue;
        seen.add(signature);
        values.push(value);
      }
      if (values.length) merged[key] = values;
      continue;
    }
    if (base && typeof base === "object") {
      merged[key] = { ...(extra && typeof extra === "object" ? extra : {}), ...base };
      continue;
    }
    if (base !== undefined) merged[key] = base;
    else if (extra !== undefined) merged[key] = extra;
  }
  return merged;
}

function normalizeSql(sql) {
  return String(sql || "")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .trim();
}

function stripSqlComments(sql) {
  const text = String(sql || "");
  let output = "";
  let state = "plain";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (state === "line") {
      if (char === "\n" || char === "\r") { state = "plain"; output += char; }
      else output += " ";
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") { state = "plain"; output += "  "; index += 1; }
      else output += char === "\n" ? "\n" : " ";
      continue;
    }
    if (state === "single") {
      output += char;
      if (char === "'" && next === "'") { output += next; index += 1; }
      else if (char === "'") state = "plain";
      continue;
    }
    if (state === "double") {
      output += char;
      if (char === '"' && next === '"') { output += next; index += 1; }
      else if (char === '"') state = "plain";
      continue;
    }
    if (char === "-" && next === "-") { state = "line"; output += "  "; index += 1; continue; }
    if (char === "/" && next === "*") { state = "block"; output += "  "; index += 1; continue; }
    if (char === "'") state = "single";
    else if (char === '"') state = "double";
    output += char;
  }
  return output;
}

function predicateTokens(sql) {
  return stripSqlComments(sql).match(
    /'(?:''|[^'])*'|(?:(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*))*)|-?\d+(?:\.\d+)?|<>|!=|<=|>=|=|\(|\)|,/g,
  ) || [];
}

function predicateField(token) {
  const value = String(token || "").replace(/\s+/g, "");
  if (!/^(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*))*$/.test(value)) return "";
  const last = value.split(".").at(-1).replace(/^"|"$/g, "").replace(/""/g, '"');
  if (["select", "where", "and", "or", "in", "not", "as", "from", "join", "on"].includes(last.toLowerCase())) return "";
  return last.toLowerCase();
}

function predicateLiteral(token) {
  const value = String(token || "");
  if (/^'(?:''|[^'])*'$/.test(value)) return value.slice(1, -1).replace(/''/g, "'").normalize("NFKC").toLowerCase();
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return String(Number(value));
  if (/^(true|false|null)$/i.test(value)) return value.toLowerCase();
  return null;
}

function sqlPredicateValues(sql) {
  const tokens = predicateTokens(sql);
  const values = new Map();
  const add = (field, value) => {
    if (!(field && value != null)) return;
    if (!values.has(field)) values.set(field, new Set());
    values.get(field).add(value);
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const field = predicateField(tokens[index]);
    if (!field) continue;
    const operator = String(tokens[index + 1] || "").toLowerCase();
    if (operator === "=") {
      add(field, predicateLiteral(tokens[index + 2]));
      continue;
    }
    if (operator === "in" && tokens[index + 2] === "(") {
      for (let cursor = index + 3; cursor < tokens.length && tokens[cursor] !== ")"; cursor += 1) {
        if (tokens[cursor] !== ",") add(field, predicateLiteral(tokens[cursor]));
      }
    }
  }
  return values;
}

function predicateSatisfied(actual, requirement) {
  if (!["eq", "in"].includes(String(requirement?.operator || "").trim().toLowerCase())) return false;
  const field = predicateField(requirement?.field);
  const expected = (Array.isArray(requirement?.values) ? requirement.values : [requirement?.value])
    .map((value) => predicateLiteral(typeof value === "string" ? `'${value.replace(/'/g, "''")}'` : String(value)))
    .filter((value) => value != null);
  const present = actual.get(field) || new Set();
  return Boolean(field && expected.length && expected.every((value) => present.has(value)));
}

function aggregationCheck(statement, columns, requirement) {
  if (!(requirement && typeof requirement === "object")) return { passed: true, verification: "not_required" };
  const operator = String(requirement.operator || "").trim().toLowerCase();
  const subjectColumn = String(requirement.subject_column || "").trim().toLowerCase();
  const outputColumn = String(requirement.output_column || "").trim();
  if (!/^(count|sum|avg|min|max)$/.test(operator) || !subjectColumn || !outputColumn) {
    return { passed: false, verification: "invalid_contract", operator, subject_column: subjectColumn, output_column: outputColumn };
  }
  const text = stripSqlComments(statement);
  const escapedOperator = operator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`\\b${escapedOperator}\\s*\\(\\s*(distinct\\s+)?((?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\\s*\\.\\s*(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_$]*))*|\\*)\\s*\\)`, "i"));
  const actualSubject = match ? (predicateField(match[2]) || String(match[2] || "").trim()) : "";
  const distinct = Boolean(match?.[1]);
  const expectsDistinct = requirement.distinct === true;
  return {
    passed: Boolean(
      match
      && actualSubject.toLowerCase() === subjectColumn
      && (!expectsDistinct || distinct)
      && columns.includes(outputColumn)
    ),
    verification: "aggregate_expression",
    operator,
    subject_column: subjectColumn,
    actual_subject_column: actualSubject || null,
    output_column: outputColumn,
    output_column_present: columns.includes(outputColumn),
    distinct,
    expected_distinct: expectsDistinct,
  };
}

export function isReadOnlyQueryStatement(sql) {
  const text = normalizeSql(sql).replace(/;+\s*$/, "");
  if (!text || !/^(select|with)\b/i.test(text)) return false;
  if (text.includes(";")) return false;
  return !/\b(insert|update|delete|drop|alter|create|truncate|replace|merge|attach|detach|copy|vacuum|call)\b/i.test(text);
}

function columnNames(rows, evidence) {
  const fromEvidence = Array.isArray(evidence?.result?.columns) ? evidence.result.columns : [];
  const fromRows = rows.length ? Object.keys(rows[0] || {}) : [];
  return [...new Set([...fromEvidence, ...fromRows].map(String))];
}

function number(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function equalValue(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

const COUNT_UNIT_NAMES = new Set([
  "count",
  "计数",
  "数量",
  "个数",
  "条数",
  "件数",
  "人数",
  "次数",
]);

function unitCheck({ expectedUnit, statement, columns, rows, evidence }) {
  if (!expectedUnit) return { passed: true, verification: "not_required", numeric_columns: [] };
  const normalizedUnit = expectedUnit.toLowerCase().replace(/\s+/g, "");
  const unitHints = [
    ...columns,
    ...((evidence?.schema?.referenced_columns || []).map((column) => column.column_name)),
  ].join(" ");
  if (!COUNT_UNIT_NAMES.has(normalizedUnit)) {
    return {
      passed: unitHints.toLowerCase().includes(expectedUnit.toLowerCase()),
      verification: "metadata",
      metadata_text: unitHints,
      numeric_columns: [],
    };
  }

  const numericSummary = evidence?.result?.numeric_summary && typeof evidence.result.numeric_summary === "object"
    ? evidence.result.numeric_summary
    : {};
  const numericColumns = columns.filter((column) => (
    rows.some((row) => number(row?.[column]) != null)
    || number(numericSummary?.[column]?.count) != null
  ));
  return {
    passed: /\bcount\s*\(/i.test(normalizeSql(statement)) && numericColumns.length > 0,
    verification: "count_aggregate",
    metadata_text: unitHints,
    numeric_columns: numericColumns,
  };
}

export function validateQueryResultEvidence({
  evidence,
  rows = [],
  rowsComplete = true,
  requirements = {},
  reconcileEvidence = null,
  reconcileRows = [],
} = {}) {
  const checks = [];
  const add = (name, passed, detail = {}, severity = "error") => {
    checks.push({ name, passed: Boolean(passed), severity, detail });
  };
  const safeRows = Array.isArray(rows) ? rows : [];
  const columns = columnNames(safeRows, evidence);
  const statement = String(evidence?.statement?.text || "");

  add("executor_evidence", ["data_source_executor", "metric_executor", "metric_view_executor"].includes(evidence?.produced_by), {
    produced_by: evidence?.produced_by || null,
  });
  add("query_succeeded", !["failed"].includes(String(evidence?.result?.status || "")), {
    status: evidence?.result?.status || null,
    error: evidence?.result?.error || null,
  });
  add("sql_read_only", evidence?.statement?.language !== "sql" || isReadOnlyQueryStatement(statement), {
    language: evidence?.statement?.language || null,
  });

  const expectedRows = Number(evidence?.result?.row_count ?? 0);
  const hasMaterializedRows = Boolean(evidence?.materialization?.intermediate_table);
  add(
    "execution_consistency",
    !hasMaterializedRows || (rowsComplete && expectedRows === safeRows.length),
    {
      evidence_row_count: expectedRows,
      materialized_row_count: safeRows.length,
      checked: hasMaterializedRows,
      complete: Boolean(rowsComplete),
    },
  );

  const requireNonEmpty = requirements.require_non_empty !== false;
  add("non_empty", !requireNonEmpty || expectedRows > 0, {
    required: requireNonEmpty,
    row_count: expectedRows,
  });

  const requiredColumns = Array.isArray(requirements.required_columns) ? requirements.required_columns.map(String) : [];
  const missingColumns = requiredColumns.filter((name) => !columns.includes(name));
  add("required_columns", missingColumns.length === 0, { required: requiredColumns, missing: missingColumns, actual: columns });

  const nonNullColumns = Array.isArray(requirements.non_null_columns) ? requirements.non_null_columns.map(String) : [];
  const nullCounts = Object.fromEntries(nonNullColumns.map((name) => [
    name,
    safeRows.filter((row) => row?.[name] == null || row?.[name] === "").length,
  ]));
  add(
    "non_null",
    nonNullColumns.length === 0 || (rowsComplete && nonNullColumns.every((name) => columns.includes(name) && nullCounts[name] === 0)),
    { columns: nonNullColumns, null_counts: nullCounts, complete: Boolean(rowsComplete) },
  );

  const keyColumns = Array.isArray(requirements.key_columns) ? requirements.key_columns.map(String) : [];
  const seenKeys = new Set();
  let duplicateCount = 0;
  if (keyColumns.length && keyColumns.every((name) => columns.includes(name))) {
    for (const row of safeRows) {
      const key = JSON.stringify(keyColumns.map((name) => row?.[name]));
      if (seenKeys.has(key)) duplicateCount += 1;
      else seenKeys.add(key);
    }
  }
  add(
    "unique_keys",
    keyColumns.length === 0 || (rowsComplete && keyColumns.every((name) => columns.includes(name)) && duplicateCount === 0),
    { columns: keyColumns, duplicate_count: duplicateCount, complete: Boolean(rowsComplete) },
  );

  const ranges = Array.isArray(requirements.numeric_ranges) ? requirements.numeric_ranges : [];
  const rangeFailures = [];
  for (const range of ranges) {
    const name = String(range?.column || "");
    if (!columns.includes(name)) {
      rangeFailures.push({ column: name, reason: "missing_column" });
      continue;
    }
    safeRows.forEach((row, index) => {
      const value = number(row?.[name]);
      if (value == null) {
        rangeFailures.push({ column: name, row: index, reason: "not_numeric", value: row?.[name] });
        return;
      }
      if (range.min != null && value < Number(range.min)) rangeFailures.push({ column: name, row: index, reason: "below_min", value });
      if (range.max != null && value > Number(range.max)) rangeFailures.push({ column: name, row: index, reason: "above_max", value });
    });
  }
  add(
    "numeric_ranges",
    ranges.length === 0 || (rowsComplete && rangeFailures.length === 0),
    { ranges, failures: rangeFailures.slice(0, 20), complete: Boolean(rowsComplete) },
  );

  const actualPredicates = sqlPredicateValues(statement);
  const filterFragments = Array.isArray(requirements.required_sql_fragments)
    ? requirements.required_sql_fragments.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const normalizedStatement = stripSqlComments(statement).replace(/\s+/g, " ").trim().toLowerCase();
  const missingFragments = filterFragments.filter((fragment) => {
    const fragmentPredicates = sqlPredicateValues(fragment);
    if (fragmentPredicates.size) {
      return [...fragmentPredicates].some(([field, values]) => (
        [...values].some((value) => !(actualPredicates.get(field) || new Set()).has(value))
      ));
    }
    return !normalizedStatement.includes(stripSqlComments(fragment).replace(/\s+/g, " ").trim().toLowerCase());
  });
  add("critical_filters", missingFragments.length === 0, { required_fragments: filterFragments, missing: missingFragments });

  const requiredPredicates = Array.isArray(requirements.required_predicates) ? requirements.required_predicates : [];
  const missingPredicates = requiredPredicates.filter((requirement) => !predicateSatisfied(actualPredicates, requirement));
  add("required_predicates", missingPredicates.length === 0, {
    required: requiredPredicates,
    missing: missingPredicates,
  });

  const aggregation = aggregationCheck(statement, columns, requirements.aggregation);
  add("aggregation", aggregation.passed, aggregation, requirements.aggregation ? "error" : "info");

  const timeRange = requirements.time_range && typeof requirements.time_range === "object"
    ? requirements.time_range
    : null;
  const timeFailures = [];
  if (timeRange) {
    const name = String(timeRange.column || "");
    const start = timeRange.start ? new Date(timeRange.start) : null;
    const end = timeRange.end ? new Date(timeRange.end) : null;
    if (!columns.includes(name)) timeFailures.push({ column: name, reason: "missing_column" });
    else safeRows.forEach((row, index) => {
      const value = new Date(row?.[name]);
      if (Number.isNaN(value.getTime())) timeFailures.push({ row: index, reason: "invalid_time", value: row?.[name] });
      else if (start && value < start) timeFailures.push({ row: index, reason: "before_start", value: row?.[name] });
      else if (end && value > end) timeFailures.push({ row: index, reason: "after_end", value: row?.[name] });
    });
  }
  add(
    "time_range",
    !timeRange || (rowsComplete && timeFailures.length === 0),
    { requirement: timeRange, failures: timeFailures.slice(0, 20), complete: Boolean(rowsComplete) },
  );

  const expectedUnit = String(requirements.expected_unit || "").trim();
  const unit = unitCheck({ expectedUnit, statement, columns, rows: safeRows, evidence });
  add(
    "unit",
    unit.passed,
    {
      expected_unit: expectedUnit || null,
      metadata_text: unit.metadata_text || "",
      verification: unit.verification,
      numeric_columns: unit.numeric_columns,
    },
    expectedUnit ? "error" : "info",
  );

  const reconcile = requirements.reconcile && typeof requirements.reconcile === "object"
    ? requirements.reconcile
    : null;
  if (reconcile) {
    const aggregateColumn = String(reconcile.aggregate_column || "");
    const detailColumn = String(reconcile.detail_value_column || "");
    const tolerance = Math.max(0, Number(reconcile.tolerance || 0));
    const aggregateValue = number(safeRows[0]?.[aggregateColumn]);
    const detailValues = reconcileRows.map((row) => number(row?.[detailColumn]));
    const detailSum = detailValues.every((value) => value != null)
      ? detailValues.reduce((sum, value) => sum + value, 0)
      : null;
    const passed = Boolean(
      reconcileEvidence && aggregateValue != null && detailSum != null &&
      Math.abs(aggregateValue - detailSum) <= tolerance,
    );
    add("aggregate_detail_reconciliation", passed, {
      detail_evidence_id: reconcile.evidence_id || null,
      aggregate_column: aggregateColumn,
      detail_value_column: detailColumn,
      aggregate_value: aggregateValue,
      detail_sum: detailSum,
      tolerance,
    });
  }

  const failedChecks = checks.filter((check) => check.severity === "error" && !check.passed);
  return {
    version: "query_validation.v1",
    validation_id: `validation_${randomUUID()}`,
    evidence_id: evidence?.evidence_id || null,
    status: failedChecks.length ? "failed" : "passed",
    summary: {
      total: checks.length,
      passed: checks.filter((check) => check.passed).length,
      failed: failedChecks.length,
    },
    checks,
  };
}

export function findEvidence(items, evidenceId) {
  return (Array.isArray(items) ? items : []).find((item) => equalValue(item?.evidence_id, evidenceId)) || null;
}

export default {
  QUERY_VALIDATION_SCOPES,
  QUERY_VALIDATION_REQUIREMENT_KEYS,
  findEvidence,
  hasQueryValidationContract,
  isAcceptedQueryValidation,
  isReadOnlyQueryStatement,
  mergeQueryValidationRequirements,
  validateQueryResultEvidence,
  withQueryValidationScope,
};
