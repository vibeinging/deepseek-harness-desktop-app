// Schema embedding: generate embeddings for table_metadata and column_metadata of a
// connection.
// Auto-called after datasource schema sync to enable embedding-based recall, and can
// also be reused by build_vector_index.
//
// Embeddings are stored as JSON text and consumed by
// vexdb_cosine_distance(embedding, vexdb_f32($q)).

import { embed } from '../core/llm.js';
import { vectorReady, query } from '../../db.js';

const BATCH = 16;

function jstr(v) {
  if (v == null) return '';
  if (typeof v === 'string') {
    const s = v.trim();
    if (s && (s[0] === '[' || s[0] === '{')) {
      try { const o = JSON.parse(s); return Array.isArray(o) ? o.join(' ') : Object.values(o).join(' '); } catch { return s; }
    }
    return s;
  }
  if (Array.isArray(v)) return v.join(' ');
  return String(v);
}

async function embedRows(rows, textFn, table, projectId) {
  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    let vecs = [];
    try { vecs = await embed(chunk.map(textFn), { project_id: projectId }); }
    catch (e) { console.warn(`[schema_embedding] embed 失败(${table} batch ${i}): ${e?.message ?? e}`); break; }
    for (let j = 0; j < chunk.length; j += 1) {
      if (!vecs[j]) continue;
      await query(
        `UPDATE ${table} SET embedding = $1, embedding_model = 'text-embedding-v3', updated_at = now() WHERE id = $2`,
        [JSON.stringify(vecs[j]), chunk[j].id],
      ).catch(() => {});
      done += 1;
    }
  }
  return done;
}

/**
 * Generate schema embeddings for one connection.
 * By default only rows with empty embedding are processed; use force=true for full rebuild.
 * @param {string} connectionId
 * @param {{projectId?:string, force?:boolean, tableIds?:string[]|null, scope?:'all'|'tables'|'columns'}} [opts]
 * @returns {Promise<{tables:number, columns:number, skipped?:string, error?:string}>}
 */
export async function embedConnectionSchema(connectionId, {
  projectId = null,
  force = false,
  tableIds = null,
  scope = 'all',
} = {}) {
  if (!vectorReady) return { tables: 0, columns: 0, skipped: '向量扩展未加载' };
  try {
    const blank = force ? '' : "AND (embedding IS NULL OR embedding = '')";
    const blankC = force ? '' : "AND (c.embedding IS NULL OR c.embedding = '')";
    const ids = Array.isArray(tableIds) ? tableIds.map(String).filter(Boolean) : [];
    const tableFilter = ids.length ? 'AND id = ANY($2)' : '';
    const columnFilter = ids.length ? 'AND c.table_id = ANY($2)' : '';
    const params = ids.length ? [connectionId, ids] : [connectionId];
    const includeTables = scope === 'all' || scope === 'tables';
    const includeColumns = scope === 'all' || scope === 'columns';

    let tCount = 0;
    if (includeTables) {
      const tables = await query(
        `SELECT id, table_name, description, keywords FROM table_metadata
          WHERE database_connection_id = $1 AND deleted_at IS NULL ${tableFilter} ${blank}`,
        params,
      );
      tCount = await embedRows(
        tables, (r) => `${jstr(r.table_name)} ${jstr(r.description)} ${jstr(r.keywords)}`.trim(), 'table_metadata', projectId,
      );
    }

    let cCount = 0;
    if (includeColumns) {
      const cols = await query(
        `SELECT c.id, c.column_name, c.description, c.example_values
           FROM column_metadata c JOIN table_metadata t ON c.table_id = t.id
          WHERE t.database_connection_id = $1 AND c.deleted_at IS NULL AND t.deleted_at IS NULL ${columnFilter} ${blankC}`,
        params,
      );
      cCount = await embedRows(
        cols, (r) => `${jstr(r.column_name)} ${jstr(r.description)} ${jstr(r.example_values)}`.trim(), 'column_metadata', projectId,
      );
    }

    return { tables: tCount, columns: cCount };
  } catch (e) {
    console.warn(`[schema_embedding] 失败: ${e?.message ?? e}`);
    return { tables: 0, columns: 0, error: String(e?.message ?? e) };
  }
}

/**
 * Use plugin getExampleValues to sample column examples and store into
 * column_metadata.example_values (as JSON stringified arrays).
 * Called after schema sync to improve NL2SQL context and embedding quality.
 * Skip for DuckDB when plugin is unavailable.
 * @param {string} connectionId
 * @param {object} plugin PluginRegistry.get(db_type) instance
 * @param {object} config {db_type,host,port,username,password,database}
 * @param {{limit?:number, onlyEmpty?:boolean, tableIds?:string[]|null}} [opts]
 * @returns {Promise<{tables:number, columns:number, skipped?:string}>}
 */
export async function populateExampleValues(connectionId, plugin, config, {
  limit = 3,
  onlyEmpty = true,
  tableIds = null,
} = {}) {
  if (!plugin || typeof plugin.getExampleValues !== 'function') {
    return { tables: 0, columns: 0, skipped: '插件不支持 getExampleValues' };
  }
  // If onlyEmpty=true, only include tables with empty example_values to avoid
  // re-sampling already-covered tables during re-sync.
  const trustedTableIds = Array.isArray(tableIds) ? [...new Set(tableIds.map(String).filter(Boolean))] : [];
  const targetClause = trustedTableIds.length ? `AND t.id::text = ANY($2::text[])` : '';
  const tableSql = onlyEmpty
    ? `SELECT DISTINCT t.id, t.schema_name, t.table_name
         FROM table_metadata t JOIN column_metadata c ON c.table_id = t.id
        WHERE t.database_connection_id = $1 AND t.deleted_at IS NULL AND c.deleted_at IS NULL
          AND (c.example_values IS NULL OR c.example_values = '') ${targetClause}`
    : `SELECT id, schema_name, table_name FROM table_metadata
        WHERE database_connection_id = $1 AND deleted_at IS NULL ${trustedTableIds.length ? `AND id::text = ANY($2::text[])` : ''}`;
  const tables = await query(tableSql, trustedTableIds.length ? [connectionId, trustedTableIds] : [connectionId]).catch(() => []);
  let tCount = 0; let cCount = 0;
  for (const tb of tables) {
    let examples;
    try {
      examples = await plugin.getExampleValues(config, tb.table_name, { schemaName: tb.schema_name, limit });
    } catch (e) {
      console.warn(`[example_values] 表 ${tb.table_name} 采样失败: ${e?.message ?? e}`);
      continue;
    }
    if (!examples || typeof examples !== 'object') continue;
    tCount += 1;
    for (const [colName, values] of Object.entries(examples)) {
      if (!Array.isArray(values) || !values.length) continue;
      const blank = onlyEmpty ? "AND (example_values IS NULL OR example_values = '')" : '';
      await query(
        `UPDATE column_metadata SET example_values = $1, updated_at = now()
          WHERE table_id = $2 AND column_name = $3 AND deleted_at IS NULL ${blank}`,
        [JSON.stringify(values), tb.id, colName],
      ).catch(() => {});
      cCount += 1;
    }
  }
  return { tables: tCount, columns: cCount };
}

export default embedConnectionSchema;
