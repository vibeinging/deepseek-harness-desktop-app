// Migrated from backend entity/column distinct-value sampling and low-cardinality auto-enum.
// - column_metadata.distinct_values: deduplicated candidate values for low-cardinality
//   columns (<= threshold), used by NL2SQL WHERE value matching.
// - column_metadata.enum_mappings: auto-enum mapping for low-cardinality
//   columns (code=label=value), aligned with intelligent_sampler sync strategy.
//
// Note: Node `column_metadata` does not store raw column comments, so the Python
// "regex-parsing of comment code values" path has no input here.
// We only do auto-enum by distinct values; true code-value label translation
// (for example, 0=enabled) needs source comments or LLM in a later step.

import { query } from '../../db.js';

const DEFAULT_THRESHOLD = 50; // Max distinct values; above this is not treated as enum.
const ENUM_MAX = 50; // Max enum size for auto mapping.

function isLikelyCategorical(dataType) {
  const t = String(dataType || '').toLowerCase();
  // Skip numeric-like enum extraction for continuous/big-text/time columns.
  if (/(float|double|decimal|real|numeric|timestamp|datetime|date|time|blob|json|text)/.test(t)) return false;
  return true;
}

/**
 * Populate distinct_values and auto enum_mappings for low-cardinality columns of a
 * connection.
 * @param {string} connectionId
 * @param {object} plugin PluginRegistry.get(db_type) instance (requires getDistinctValues)
 * @param {object} config {db_type,host,port,username,password,database}
 * @param {{threshold?:number, onlyEmpty?:boolean, tableIds?:string[]|null}} [opts]
 * @returns {Promise<{columns:number, enums:number, skipped?:string}>}
 */
export async function populateDistinctAndEnum(connectionId, plugin, config, {
  threshold = DEFAULT_THRESHOLD,
  onlyEmpty = true,
  tableIds = null,
} = {}) {
  if (!plugin || typeof plugin.getDistinctValues !== 'function') {
    return { columns: 0, enums: 0, skipped: '插件不支持 getDistinctValues' };
  }
  const blank = onlyEmpty ? "AND (c.distinct_values IS NULL OR c.distinct_values = '')" : '';
  const trustedTableIds = Array.isArray(tableIds) ? [...new Set(tableIds.map(String).filter(Boolean))] : [];
  const targetClause = trustedTableIds.length ? "AND t.id::text = ANY($2::text[])" : '';
  const cols = await query(
    `SELECT c.id, c.column_name, c.data_type, t.table_name, t.schema_name
       FROM column_metadata c JOIN table_metadata t ON c.table_id = t.id
      WHERE t.database_connection_id = $1 AND c.deleted_at IS NULL AND t.deleted_at IS NULL ${blank} ${targetClause}`,
    trustedTableIds.length ? [connectionId, trustedTableIds] : [connectionId],
  ).catch(() => []);

  let cCount = 0; let eCount = 0;
  for (const col of cols) {
    if (!isLikelyCategorical(col.data_type)) continue;
    let res;
    try {
      res = await plugin.getDistinctValues(config, col.table_name, col.column_name, {
        schemaName: col.schema_name, limit: threshold + 1,
      });
    } catch (e) {
      continue;
    }
    if (!res?.success || !Array.isArray(res.data)) continue;
    const values = res.data.filter((v) => v !== null && v !== undefined && String(v) !== '');
    // Over threshold: not an enum candidate, skip distinct values.
    if (!values.length || values.length > threshold) continue;

    await query(
      `UPDATE column_metadata SET distinct_values=$1, updated_at=now() WHERE id=$2`,
      [JSON.stringify(values), col.id],
    ).catch(() => {});
    cCount += 1;

    // Auto enum (code=label=value): only build when 1 < len <= ENUM_MAX.
    if (values.length > 1 && values.length <= ENUM_MAX) {
      const mapping = {};
      for (const v of values) mapping[String(v)] = String(v);
      await query(
        `UPDATE column_metadata SET enum_mappings=$1, updated_at=now() WHERE id=$2`,
        [JSON.stringify(mapping), col.id],
      ).catch(() => {});
      eCount += 1;
    }
  }
  return { columns: cCount, enums: eCount };
}
