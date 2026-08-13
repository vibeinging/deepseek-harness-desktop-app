// Unified semantic enrichment orchestration for connection sync and structured file import (P8 migration completion).
// Both flows share one function to keep enrichment behavior consistent (fixed a
// structural drop source of about 24%).
//
// Required order: example values -> distinct values/enums -> column descriptions -> table descriptions -> schema embeddings.
// Reason: example values/distinct values/descriptions are all embedding text inputs, so embeddings must run last.

import { queryOne } from '../../db.js';
import { PluginRegistry } from '../datasources/plugins/index.js';
import { populateExampleValues, embedConnectionSchema } from './schema_embedding.js';
import { populateDistinctAndEnum } from './distinct_enum.js';
import { generateColumnsDescriptions } from './column_description.js';
import { generateTableDescriptions } from './table_description.js';

function pluginConfigOf(conn) {
  return {
    db_type: conn.db_type, host: conn.host, port: conn.port,
    username: conn.username, password: conn.password, database: conn.database,
  };
}

/**
 * Run full semantic enrichment for one connection. Each step uses an independent
 * try/catch so one failure does not block following steps (aligned with Python
 * behavior: fail-open with logs).
 * @param {string} connectionId
 * @param {{projectId?:string|null, extraNotes?:string|null, descriptions?:boolean, force?:boolean}} [opts]
 *   When descriptions=false, skip LLM description generation (sampling + embeddings
 *   only, for fast / lower-token scenarios).
 * @returns {Promise<object>} Step-by-step statistics.
 */
export async function enrichConnection(connectionId, { projectId = null, extraNotes = null, descriptions = true, force = false } = {}) {
  const conn = await queryOne(
    `SELECT id, name, db_type, host, port, username, password, database
       FROM database_connections WHERE id=$1 AND deleted_at IS NULL`,
    [connectionId],
  ).catch(() => null);
  if (!conn) return { skipped: '连接不存在' };

  const plugin = PluginRegistry.get(conn.db_type);
  if (!plugin) return { skipped: `无插件: ${conn.db_type}` };
  const config = pluginConfigOf(conn);
  const stats = {};

  // 1. Sample column example values.
  try { stats.example = await populateExampleValues(connectionId, plugin, config); }
  catch (e) { stats.example = { error: String(e?.message ?? e) }; }

  // 2. Distinct values + auto-enum for low-cardinality columns.
  try { stats.distinct = await populateDistinctAndEnum(connectionId, plugin, config); }
  catch (e) { stats.distinct = { error: String(e?.message ?? e) }; }

  // 3. Column descriptions (LLM) - relies on example values prepared above.
  if (descriptions) {
    try { stats.columns = await generateColumnsDescriptions(connectionId, { projectId, extraNotes }); }
    catch (e) { stats.columns = { error: String(e?.message ?? e) }; }
    // 4. Table descriptions (LLM) - relies on column descriptions prepared above.
    try { stats.tables = await generateTableDescriptions(connectionId, { projectId }); }
    catch (e) { stats.tables = { error: String(e?.message ?? e) }; }
  }

  // 5. Schema embeddings (last) - text includes descriptions/example values/enums.
  try { stats.embed = await embedConnectionSchema(connectionId, { projectId, force }); }
  catch (e) { stats.embed = { error: String(e?.message ?? e) }; }

  console.info(`[enrich] 连接 ${connectionId}:`, JSON.stringify(stats));
  return stats;
}
