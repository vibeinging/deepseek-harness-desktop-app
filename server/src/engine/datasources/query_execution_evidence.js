import { createHash, randomUUID } from "node:crypto";

import { query as dbQuery, queryOne as dbQueryOne } from "../../db.js";

function iso(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback.toISOString() : date.toISOString();
}

function stripIdentifier(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("`") && text.endsWith("`")) ||
    (text.startsWith("[") && text.endsWith("]"))
  ) return text.slice(1, -1).replace(/""/g, '"').replace(/``/g, "`").replace(/]]/g, "]");
  return text;
}

function stableValue(value) {
  if (value == null) return null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function finiteNumber(value) {
  if (value == null || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stableNumber(value) {
  return Number(Number(value).toPrecision(15));
}

export function buildResultFingerprint(rows = [], columns = []) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const names = [...new Set([
    ...(Array.isArray(columns) ? columns : []),
    ...safeRows.flatMap((row) => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : []),
  ].map(String))];
  const hash = createHash("sha256");
  for (const row of safeRows) hash.update(JSON.stringify(stableValue(row))).update("\n");
  const numericSummary = {};
  for (const name of names) {
    const values = safeRows.map((row) => finiteNumber(row?.[name])).filter((value) => value != null);
    if (!values.length) continue;
    const sum = values.reduce((total, value) => total + value, 0);
    numericSummary[name] = {
      count: values.length,
      min: stableNumber(Math.min(...values)),
      max: stableNumber(Math.max(...values)),
      sum: stableNumber(sum),
      average: stableNumber(sum / values.length),
    };
  }
  return {
    data_hash: `sha256:${hash.digest("hex")}`,
    numeric_summary: numericSummary,
  };
}

export function extractSqlTableReferences(sql) {
  const text = String(sql || "");
  const identifier = String.raw`(?:"(?:[^"]|"")+"|\x60(?:[^\x60]|\x60\x60)+\x60|\[(?:[^\]]|\]\])+\]|[A-Za-z_][A-Za-z0-9_$]*)`;
  const pattern = new RegExp(String.raw`\b(?:from|join)\s+(${identifier})(?:\s*\.\s*(${identifier}))?`, "gi");
  const refs = [];
  const seen = new Set();
  let match;
  while ((match = pattern.exec(text))) {
    const schema = match[2] ? stripIdentifier(match[1]) : null;
    const table = stripIdentifier(match[2] || match[1]);
    const key = `${String(schema || "").toLowerCase()}.${table.toLowerCase()}`;
    if (!table || seen.has(key)) continue;
    seen.add(key);
    refs.push({ schema, table });
  }
  return refs;
}

function mentionsIdentifier(sql, identifier) {
  const escaped = String(identifier || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(?:^|[^A-Za-z0-9_$])${escaped}(?:$|[^A-Za-z0-9_$])`, "i").test(String(sql || ""));
}

async function resolveSource(datasource, { queryOne = dbQueryOne } = {}) {
  const bindingId = String(datasource?.id || "").trim() || null;
  const connectionId = String(datasource?.connection_id || "").trim() || null;
  const [binding, connection] = await Promise.all([
    bindingId
      ? queryOne(
          `SELECT source_type, source_id FROM business_data_sources
            WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
          [bindingId],
        ).catch(() => null)
      : null,
    connectionId
      ? queryOne(
          `SELECT id, name, db_type, database, schema_config, updated_at
             FROM database_connections WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
          [connectionId],
        ).catch(() => null)
      : null,
  ]);
  return {
    binding_id: bindingId,
    source_type: binding?.source_type || datasource?.source_type || null,
    source_id: binding?.source_id || connectionId || bindingId,
    connection_id: connectionId,
    name: datasource?.datasource_name || connection?.name || null,
    database_type: datasource?.db_type || connection?.db_type || null,
    database: connection?.database || null,
    schema: connection?.schema_config || null,
    connection_updated_at: connection?.updated_at || null,
  };
}

async function resolveSchema(connectionId, sql, refs, { query = dbQuery } = {}) {
  if (!(connectionId && refs.length)) return { version: null, tables: [], columns: [] };
  const names = [...new Set(refs.map((ref) => ref.table.toLowerCase()))];
  const rows = await query(
    `SELECT t.id AS table_id, t.schema_name, t.table_name, t.updated_at AS table_updated_at,
            c.id AS column_id, c.column_name, c.data_type, c.updated_at AS column_updated_at
       FROM table_metadata t
       LEFT JOIN column_metadata c ON c.table_id=t.id AND c.deleted_at IS NULL
      WHERE t.database_connection_id=$1 AND t.deleted_at IS NULL
        AND lower(t.table_name) = ANY($2::text[])
      ORDER BY t.schema_name NULLS FIRST, t.table_name, c.id`,
    [connectionId, names],
  ).catch(() => []);
  const refByName = new Map(refs.map((ref) => [ref.table.toLowerCase(), ref]));
  const tableMap = new Map();
  const columns = [];
  for (const row of rows) {
    const ref = refByName.get(String(row.table_name || "").toLowerCase());
    if (ref?.schema && String(row.schema_name || "").toLowerCase() !== ref.schema.toLowerCase()) continue;
    if (!tableMap.has(row.table_id)) {
      tableMap.set(row.table_id, {
        id: row.table_id,
        schema_name: row.schema_name || null,
        table_name: row.table_name,
      });
    }
    if (row.column_id && mentionsIdentifier(sql, row.column_name)) {
      columns.push({
        id: row.column_id,
        table_id: row.table_id,
        column_name: row.column_name,
        data_type: row.data_type || null,
      });
    }
  }
  const versionInput = rows.map((row) => [
    row.table_id,
    row.schema_name || null,
    row.table_name,
    row.column_id || null,
    row.column_name || null,
    row.data_type || null,
  ]);
  const version = rows.length
    ? `sha256:${createHash("sha256").update(JSON.stringify(versionInput)).digest("hex")}`
    : null;
  return { version, tables: [...tableMap.values()], columns };
}

export async function buildQueryExecutionEvidence({
  datasource,
  statement,
  parameters = [],
  result,
  startedAt,
  finishedAt,
  resolver = {},
} = {}) {
  const started = iso(startedAt);
  const finished = iso(finishedAt);
  const sql = typeof statement === "string" ? statement : "";
  const source = await resolveSource(datasource, resolver);
  const references = extractSqlTableReferences(sql);
  const schema = await resolveSchema(source.connection_id, sql, references, resolver);
  const rowCount = Number(result?.row_count ?? result?.data?.length ?? 0);
  const totalCount = result?.total_count == null ? null : Number(result.total_count);
  const truncated = Boolean(result?.truncated || rowCount >= 1_000_000 || (totalCount != null && totalCount > rowCount));
  const success = result?.success !== false;
  const empty = success && rowCount === 0;
  const status = success ? (truncated ? "partial" : empty ? "empty" : "completed") : "failed";
  const fingerprint = buildResultFingerprint(result?.data, result?.columns);
  return {
    version: "query_execution.v1",
    evidence_id: `query_${randomUUID()}`,
    produced_by: "data_source_executor",
    source,
    statement: {
      language: sql ? "sql" : "query",
      text: typeof statement === "string" ? statement : JSON.stringify(statement ?? null),
      parameters: Array.isArray(parameters) ? parameters : [],
    },
    schema: {
      version: schema.version,
      referenced_tables: schema.tables,
      referenced_columns: schema.columns,
      unresolved_table_references: references.filter((ref) => !schema.tables.some((table) =>
        table.table_name.toLowerCase() === ref.table.toLowerCase() &&
        (!ref.schema || String(table.schema_name || "").toLowerCase() === ref.schema.toLowerCase()))),
    },
    result: {
      status,
      row_count: rowCount,
      total_count: totalCount,
      columns: Array.isArray(result?.columns) ? result.columns : [],
      empty,
      truncated,
      partial: status === "partial",
      error: success ? null : result?.message || "查询失败",
      ...fingerprint,
    },
    timing: {
      started_at: started,
      finished_at: finished,
      duration_ms: Math.max(0, new Date(finished).getTime() - new Date(started).getTime()),
    },
  };
}

export default { buildQueryExecutionEvidence, buildResultFingerprint, extractSqlTableReferences };
