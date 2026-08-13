// Migrated from backend/dsh_kernel/semantic_catalogs/database/schema_retrieval_service.py
//
// Schema recall/retrieval service (core schema/table structure retrieval for Agent)
// Handles schema recall, pruning, and related retrieval for downstream modules (e.g. nl2sql) with 1:1 import compatibility.
//
// ============================ Desktop migration notes ============================
// The original Python service uses vector/embedding (pgvector cosine_distance + core.llm.embed) for table/column recall.
// The desktop version has no ORM/session, so this implementation uses:
//   - direct reads of PG metadata tables through injected query/queryOne
//     (table_metadata / column_metadata / relationship_metadata / database_connections / business_data_sources);
//   - core/llm.js embed() plus VexDB cosine distance for table and column recall;
//   - keyword/name/description scoring as the fallback when the model, extension, or stored vectors are unavailable.
//     Both paths keep the same response shape and relative-threshold filtering.
//
// DB access convention (aligned with other migrated files): methods needing DB access take ctx/deps
// as first arg, shaped like { query(sql, params)->Promise<rows>, queryOne(sql, params)->Promise<row|null> },
// injected from upper layers (aligned with Python AsyncSession usage). This service does not connect directly.
// Vastbase treats empty string as NULL, so checks use IS NOT NULL instead of <> ''.
// =======================================================================

import { NotFoundError } from '../core/exceptions.js';
import { t } from '../utils/i18n.js';
import { filter_by_relative_threshold } from './similarity_filter.js';
import { embed } from '../core/llm.js';
import { vectorReady } from '../../db.js';

/**
 * Vectorize question for vexdb_cosine_distance recall. Use query_embedding directly when provided;
 * otherwise call embed(). On failure (no EMBEDDING model/ext not loaded), return null and callers fallback to keywords.
 * @returns {Promise<number[]|null>}
 */
async function embedQuestion(question, project_id = null, query_embedding = null) {
  if (Array.isArray(query_embedding) && query_embedding.length) return query_embedding;
  if (!vectorReady || !question || !String(question).trim()) return null;
  try {
    const v = await embed(question, { project_id });
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) {
    console.warn(`[SchemaRetrieval] embed failed, fallback to keyword recall: ${e?.message ?? e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helper: parse example_values (stored as JSON string array in PG).
// Matches ColumnMetadata.example_values_list.
// ---------------------------------------------------------------------------
function parseExampleValues(raw) {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Internal helper: parse enum_mappings (JSONB) to object.
// ---------------------------------------------------------------------------
function parseEnumMappings(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Internal helper: normalize PG bool columns to JS boolean (pg driver usually returns boolean; string fallback here).
// ---------------------------------------------------------------------------
function toBool(v) {
  if (v === true || v === false) return v;
  if (v == null) return false;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).toLowerCase();
  return s === 't' || s === 'true' || s === '1' || s === 'y';
}

// ---------------------------------------------------------------------------
// Keyword scoring helper (embedding fallback path).
// Split question into mixed language/digit tokens and compute hit count for candidate text -> pseudo similarity 0~1.
// ---------------------------------------------------------------------------
function tokenizeQuestion(question) {
  if (!question) return [];
  const lower = String(question).toLowerCase();
  // English/digits split by word, Chinese by character (fallback to char n-gram when no tokenizer).
  const asciiTokens = lower.match(/[a-z0-9_]+/g) || [];
  const cjkChars = lower.match(/[一-鿿]/g) || [];
  // Add Chinese bigrams to increase short-term matching for terms like "order"/"amount".
  const cjkBigrams = [];
  for (let i = 0; i + 1 < cjkChars.length; i += 1) {
    cjkBigrams.push(cjkChars[i] + cjkChars[i + 1]);
  }
  const tokens = new Set([...asciiTokens, ...cjkChars, ...cjkBigrams].filter((tk) => tk && tk.length >= 1));
  return [...tokens];
}

/** Count token hits within a text using case-insensitive substring matching. */
function countHits(text, tokens) {
  if (!text || !tokens.length) return 0;
  const hay = String(text).toLowerCase();
  let hits = 0;
  for (const tk of tokens) {
    if (hay.includes(tk)) hits += 1;
  }
  return hits;
}

export class SchemaRetrievalService {
  // ==================== schema-aware key ====================

  /**
   * Build schema-aware unique table key for dedupe.
   * If schema_name is null or 'default', fallback to plain table_name for single-schema compatibility.
   * @param {string|null} schema_name
   * @param {string} table_name
   * @returns {string}
   */
  static _table_key(schema_name, table_name) {
    if (schema_name && schema_name !== 'default') {
      return `${schema_name}.${table_name}`;
    }
    return table_name;
  }

  // ==================== private helpers ====================

  /**
   * Validate database connection existence (route permissions are enforced upstream), return connection row.
   *
   * Self-healing: upstream callers may pass business_data_sources binding id as connection_id
   * (DatabaseDataSource.id is binding id, not the real connection id). If direct query misses,
   * try resolving to source_id and retry, then recover connection.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @returns {Promise<object>} connection row (includes raw fields like extra_config)
   */
  static async _validate_connection(ctx, connection_id) {
    const connection = await ctx.queryOne(
      `SELECT id, project_id, db_type, schema_config, extra_config
         FROM database_connections
        WHERE id = $1 AND deleted_at IS NULL`,
      [connection_id],
    );
    if (connection) return connection;

    // Self-heal: resolve passed id as business_data_sources binding id back to the real connection.
    const recovered = await SchemaRetrievalService._recover_connection_from_binding(ctx, connection_id);
    if (recovered != null) return recovered;

    throw new NotFoundError(t('数据库连接不存在'));
  }

  /**
   * Resolve possible business_data_sources binding id to actual database_connections row.
   * On hit (binding id maps to a valid source_id), return connection and log warning;
   * otherwise return null and let caller return 404. Do not throw to break main flow.
   *
   * @param {{queryOne:Function}} ctx
   * @param {string} maybe_binding_id
   * @returns {Promise<object|null>}
   */
  static async _recover_connection_from_binding(ctx, maybe_binding_id) {
    try {
      const bindingRow = await ctx.queryOne(
        `SELECT source_id FROM business_data_sources
          WHERE id = $1
            AND source_type = 'database_connection'
            AND deleted_at IS NULL`,
        [maybe_binding_id],
      );
      const realSourceId = bindingRow ? bindingRow.source_id : null;
      if (!realSourceId) return null;

      const connection = await ctx.queryOne(
        `SELECT id, project_id, db_type, schema_config, extra_config
           FROM database_connections
          WHERE id = $1 AND deleted_at IS NULL`,
        [realSourceId],
      );
      if (connection != null) {
        console.warn(
          '[CONN-RECOVER] input is business_data_sources binding id, recovered to real connection | '
          + `binding_id=${maybe_binding_id} -> connection_id=${realSourceId}`,
        );
      }
      return connection;
    } catch (e) {
      console.error(`[CONN-RECOVER] self-heal recovery failed: ${e?.message ?? e}`);
      return null;
    }
  }

  /**
   * Parse connection.extra_config (JSON text) into object. Corresponds to extra_config_dict.
   * @param {object} connection
   * @returns {object}
   */
  static _extraConfigDict(connection) {
    const raw = connection && connection.extra_config;
    if (!raw) return {};
    if (typeof raw === 'object') return raw;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  /**
   * Format table recall result.
   * @param {object} table table row (id/table_name/schema_name/description)
   * @param {string} retrieval_method
   * @param {number|null} [distance=null]
   * @returns {object}
   */
  static _format_table_result(table, retrieval_method, distance = null) {
    const result = {
      id: table.id,
      table_name: table.table_name,
      schema_name: table.schema_name,
      description: table.description,
      retrieval_method,
    };
    if (distance != null) {
      result.similarity = 1.0 - (Number(distance) / 2.0);
      result.distance = Number(distance);
    }
    return result;
  }

  /**
   * Format column recall result (shared column formatter).
   * @param {object} column column row (PG row with column_name/data_type/is_xxx flags/example_values/enum_mappings)
   * @param {boolean} [include_example_values=true] include all example values (false keeps top 3)
   * @returns {object}
   */
  static _format_column_result(column, include_example_values = true) {
    const result = {
      column_name: column.column_name,
      data_type: column.data_type,
    };

    // Build enum_hint for LLM-friendly enum description.
    const enumMappingsObj = parseEnumMappings(column.enum_mappings);
    if (enumMappingsObj) {
      result.enum_mappings = enumMappingsObj;
      try {
        const mappings = (enumMappingsObj.mappings) || [];
        if (mappings.length) {
          const hintLines = [];
          for (const m of mappings) {
            if (!m || typeof m !== 'object') continue;
            const code = String(m.code ?? '').trim();
            const label = String(m.label ?? '').trim();
            if (!code || !label) continue;
            hintLines.push(`${code}=${label}`);
          }
          if (hintLines.length) {
            const enumHint = `枚举值说明：${hintLines.join(', ')}`;
            result.enum_hint = enumHint;
          }
        }
      } catch (_) {
        // Ignore failures when generating enum hint.
      }
    }

    // Optional fields.
    if (column.description) result.description = column.description;

    const exampleList = parseExampleValues(column.example_values);
    if (exampleList && exampleList.length > 0) {
      result.example_values = include_example_values ? exampleList : exampleList.slice(0, 3);
    }
    if (toBool(column.is_primary_key)) result.is_primary_key = true;
    if (toBool(column.is_indexed)) result.is_indexed = true;
    if (toBool(column.is_foreign_key)) result.is_foreign_key = true;
    if (toBool(column.is_high_recall)) result.is_high_recall = true;

    const defaultValue = column.default_value;
    if (defaultValue && !['NULL', '', 'none', 'None'].includes(defaultValue)) {
      result.default_value = defaultValue;
    }
    // is_nullable is only output when explicitly false.
    if (Object.prototype.hasOwnProperty.call(column, 'is_nullable') && !toBool(column.is_nullable)) {
      result.is_nullable = false;
    }

    return result;
  }

  /**
   * Build SQL snippet for high-recall columns (high_recall, primary key, foreign key).
   * Returns a boolean expression that can be directly appended to WHERE (no params).
   * @returns {string}
   */
  static _build_high_recall_condition() {
    return '(is_high_recall = TRUE OR is_primary_key = TRUE OR is_foreign_key = TRUE)';
  }

  // ==================== table recall methods ====================

  /**
   * Search relevant tables by similarity with dynamic-threshold filtering (route permission already checked).
   *
   * Prefer VexDB cosine distance over table embeddings; fall back to keyword scoring over
   * table_name/description when vectors are unavailable or empty.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {string} question
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {number} [opts.max_limit=20]
   * @param {number} [opts.similarity_threshold=0.3]
   * @param {Array<number>|null} [opts.query_embedding=null] optional precomputed query vector
   * @returns {Promise<Array<object>>}
   */
  static async search_relevant_tables_vector(ctx, connection_id, question, {
    project_id = null, max_limit = 20, similarity_threshold = 0.3, query_embedding = null,
  } = {}) {
    try {
      await SchemaRetrievalService._validate_connection(ctx, connection_id);

      // 1) Prefer true vector recall(vexdb_cosine_distance); fallback to keywords when it fails or vector missing.
      let tables = null;
      const qvec = await embedQuestion(question, project_id, query_embedding);
      if (qvec) {
        tables = await SchemaRetrievalService._vectorScoreTables(ctx, connection_id, qvec, max_limit);
        if (tables && tables.length) console.log(`vector recall(vexdb): ${tables.length} tables`);
      }

      // 2) Keyword fallback when no vector result.
      if (!tables || !tables.length) {
        const rows = await ctx.query(
          `SELECT id, table_name, schema_name, description, is_high_recall
             FROM table_metadata
            WHERE database_connection_id = $1 AND deleted_at IS NULL`,
          [connection_id],
        );
        if (!rows.length) return [];
        tables = SchemaRetrievalService._keywordScoreTables(rows, question, max_limit);
        console.log(`keyword fallback recall (vector empty): ${tables.length} tables`);
      }

      // Apply top gap filtering.
      return filter_by_relative_threshold(tables, {
        score_key: 'similarity',
        threshold: similarity_threshold,
        higher_is_better: true,
      });
    } catch (e) {
      console.error(`vector recall failed: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * Vector recall tables using vexdb_cosine_distance; top-N by ascending cosine distance for embedding tables on this connection.
   * similarity = 1 - distance, retrieval_method='vector'.
   * @returns {Promise<Array<object>>}
   */
  static async _vectorScoreTables(ctx, connection_id, queryVec, max_limit) {
    const rows = await ctx.query(
      `SELECT id, table_name, schema_name, description, is_high_recall,
              vexdb_cosine_distance(embedding, vexdb_f32($1)) AS distance
         FROM table_metadata
        WHERE database_connection_id = $2 AND embedding IS NOT NULL AND deleted_at IS NULL
        ORDER BY distance ASC
        LIMIT $3`,
      [JSON.stringify(queryVec), connection_id, max_limit],
    ).catch((e) => { console.warn(`[SchemaRetrieval] vector table recall SQL failed: ${e?.message ?? e}`); return []; });
    return rows.map((tb) => {
      const res = SchemaRetrievalService._format_table_result(tb, 'vector', tb.distance);
      res.similarity = Math.max(0, 1.0 - Number(tb.distance ?? 1));
      res.distance = Number(tb.distance ?? 1);
      return res;
    });
  }

  /**
   * Score tables by keyword hits and sort by pseudo similarity; take top max_limit.
   * Similarity normalized as min(1, hits / cap); no-hit rows get a low baseline.
   * @param {Array<object>} rows table rows
   * @param {string} question
   * @param {number} max_limit
   * @returns {Array<object>}
   */
  static _keywordScoreTables(rows, question, max_limit) {
    const tokens = tokenizeQuestion(question);
    const norm = Math.max(1, Math.min(tokens.length, 5)); // Hit normalization cap (max 5 tokens)
    const scored = rows.map((tb) => {
      const hits = countHits(tb.table_name, tokens) + countHits(tb.description, tokens);
      // If no question/tokens, return neutral score to keep fallback behavior ("empty recall -> all tables").
      const similarity = tokens.length
        ? Math.min(1.0, hits / norm)
        : 0.5;
      const res = SchemaRetrievalService._format_table_result(tb, 'keyword', null);
      res.similarity = similarity;
      res.distance = (1.0 - similarity) * 2.0; // Keep distance field for downstream compatibility (inverse of similarity)
      res._hits = hits;
      return res;
    });
    // Hit-first sorting; keep no-hit rows and let filter_by_relative_threshold drop them if needed.
    scored.sort((a, b) => (b.similarity - a.similarity));
    const limited = scored.slice(0, max_limit);
    // Clean up internal field.
    for (const r of limited) delete r._hits;
    return limited;
  }

  /**
   * Search high-recall tables (all priority tables, no limit), route permissions already validated.
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @returns {Promise<Array<object>>}
   */
  static async search_high_recall_tables(ctx, connection_id) {
    try {
      await SchemaRetrievalService._validate_connection(ctx, connection_id);

      const tablesOrm = await ctx.query(
        `SELECT id, table_name, schema_name, description
           FROM table_metadata
          WHERE is_high_recall = TRUE
            AND database_connection_id = $1
            AND deleted_at IS NULL`,
        [connection_id],
      );

      const tables = tablesOrm.map((tb) => SchemaRetrievalService._format_table_result(tb, 'high_recall'));
      console.log(`high_recall找到 ${tables.length} 个相关表`);
      return tables;
    } catch (e) {
      console.error(`high_recall failed: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * Merge vector/keyword and high-recall table results with dedupe and retrieval method tags.
   * @param {Array<object>} vector_results
   * @param {Array<object>|null} [high_recall_results=null]
   * @returns {Array<object>}
   */
  static _merge_results(vector_results, high_recall_results = null) {
    const tableMap = new Map();

    // High-recall tables first.
    if (high_recall_results) {
      for (const result of high_recall_results) {
        result.retrieval_method = 'high_recall';
        tableMap.set(result.id, result);
      }
    }

    // Vector recall results.
    for (const result of vector_results) {
      const tableId = result.id;
      if (!tableMap.has(tableId)) {
        result.retrieval_method = 'vector';
        tableMap.set(tableId, result);
      } else {
        const existing = tableMap.get(tableId);
        const existingMethods = existing.retrieval_method.split(',');
        if (!existingMethods.includes('vector')) {
          existing.retrieval_method = [...existingMethods, 'vector'].sort().join(',');
        }
      }
    }

    return [...tableMap.values()];
  }

  // ==================== column recall methods ====================

  /**
   * Recall relevant columns across tables (column-first strategy). Route permissions already verified.
   *
   * Prefer VexDB cosine distance for cross-table column recall; fall back to keyword scoring on
   * column_name/description/example_values when vectors are unavailable or empty.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {string} question
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {number} [opts.max_limit=30]
   * @param {number} [opts.similarity_threshold=0.3]
   * @param {Array<number>|null} [opts.query_embedding=null] optional precomputed query vector
   * @returns {Promise<Array<object>>}
   */
  static async search_relevant_columns_cross_tables(ctx, connection_id, question, {
    project_id = null, max_limit = 30, similarity_threshold = 0.3, query_embedding = null,
  } = {}) {
    try {
      await SchemaRetrievalService._validate_connection(ctx, connection_id);

      // 1) Prefer vector recall first; fallback to keywords on failure/missing embedding.
      let columns = null;
      const qvec = await embedQuestion(question, project_id, query_embedding);
      if (qvec) {
        columns = await SchemaRetrievalService._vectorScoreColumns(ctx, connection_id, qvec, max_limit);
        if (columns && columns.length) console.log(`vector recall columns(vexdb): ${columns.length} columns`);
      }

      // 2) Keyword fallback.
      if (!columns || !columns.length) {
        const rows = await ctx.query(
          `SELECT c.id            AS column_id,
                  c.column_name   AS column_name,
                  c.table_id      AS table_id,
                  c.data_type     AS data_type,
                  c.is_nullable   AS is_nullable,
                  c.is_high_recall AS is_high_recall,
                  c.is_primary_key AS is_primary_key,
                  c.is_foreign_key AS is_foreign_key,
                  c.is_indexed    AS is_indexed,
                  c.description   AS description,
                  c.example_values AS example_values,
                  c.default_value AS default_value,
                  t.table_name    AS table_name,
                  t.schema_name   AS schema_name,
                  t.description   AS table_description
             FROM column_metadata c
             JOIN table_metadata t ON c.table_id = t.id
            WHERE t.database_connection_id = $1
              AND c.deleted_at IS NULL
              AND t.deleted_at IS NULL`,
          [connection_id],
        );
        if (!rows.length) return [];
        columns = SchemaRetrievalService._keywordScoreColumns(rows, question, max_limit);
        console.log(`cross-table column fallback (vector empty): ${columns.length} columns`);
      }

      // Two-level filtering: relative threshold + absolute threshold, with smart degrade.
      const filteredColumns = filter_by_relative_threshold(columns, {
        score_key: 'similarity',
        threshold: similarity_threshold,
        higher_is_better: true,
        min_absolute_threshold: 0.5,
      });

      console.log(`cross-table column recall after filtering: ${filteredColumns.length} columns`);
      return filteredColumns;
    } catch (e) {
      console.error(`cross-table column recall failed: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * Score cross-table columns with keyword hits, keep top max_limit, and keep col_data structure compatible with original.
   * @param {Array<object>} rows joined column rows
   * @param {string} question
   * @param {number} max_limit
   * @returns {Array<object>}
   */
  static _keywordScoreColumns(rows, question, max_limit) {
    const tokens = tokenizeQuestion(question);
    const norm = Math.max(1, Math.min(tokens.length, 5));

    const scored = rows.map((column) => {
      const exampleList = parseExampleValues(column.example_values);
      const exampleText = exampleList.length ? exampleList.join(' ') : '';
      const hits = countHits(column.column_name, tokens)
        + countHits(column.description, tokens)
        + countHits(exampleText, tokens);
      const similarity = tokens.length ? Math.min(1.0, hits / norm) : 0.5;
      return SchemaRetrievalService._columnRowToData(column, similarity, (1.0 - similarity) * 2.0);
    });

    scored.sort((a, b) => (b.similarity - a.similarity));
    return scored.slice(0, max_limit);
  }

  /** Build unified col_data from JOIN rows + similarity/distance (shared by keyword/vector paths). */
  static _columnRowToData(column, similarity, distance) {
    const exampleList = parseExampleValues(column.example_values);
    const colData = {
      column_id: column.column_id,
      column_name: column.column_name,
      table_id: column.table_id,
      table_name: column.table_name,
      schema_name: column.schema_name,
      table_description: column.table_description || '',
      description: column.description || '',
      similarity,
      distance,
      data_type: column.data_type,
      is_nullable: column.is_nullable,
      is_high_recall: toBool(column.is_high_recall),
      is_primary_key: toBool(column.is_primary_key),
      is_foreign_key: toBool(column.is_foreign_key),
    };
    if (exampleList.length > 0) colData.example_values = exampleList;
    if (toBool(column.is_indexed)) colData.is_indexed = true;
    const defaultValue = column.default_value;
    if (defaultValue && !['NULL', '', 'none', 'None'].includes(defaultValue)) {
      colData.default_value = defaultValue;
    }
    return colData;
  }

  /**
   * Vector cross-table column recall using vexdb_cosine_distance: top-N by ascending cosine distance for embedded columns.
   * @returns {Promise<Array<object>>}
   */
  static async _vectorScoreColumns(ctx, connection_id, queryVec, max_limit) {
    const rows = await ctx.query(
      `SELECT c.id AS column_id, c.column_name AS column_name, c.table_id AS table_id,
              c.data_type AS data_type, c.is_nullable AS is_nullable, c.is_high_recall AS is_high_recall,
              c.is_primary_key AS is_primary_key, c.is_foreign_key AS is_foreign_key, c.is_indexed AS is_indexed,
              c.description AS description, c.example_values AS example_values, c.default_value AS default_value,
              t.table_name AS table_name, t.schema_name AS schema_name, t.description AS table_description,
              vexdb_cosine_distance(c.embedding, vexdb_f32($1)) AS distance
         FROM column_metadata c
         JOIN table_metadata t ON c.table_id = t.id
        WHERE t.database_connection_id = $2 AND c.embedding IS NOT NULL
          AND c.deleted_at IS NULL AND t.deleted_at IS NULL
        ORDER BY distance ASC
        LIMIT $3`,
      [JSON.stringify(queryVec), connection_id, max_limit],
    ).catch((e) => { console.warn(`[SchemaRetrieval] vector column recall SQL failed: ${e?.message ?? e}`); return []; });
    return rows.map((c) => SchemaRetrievalService._columnRowToData(c, Math.max(0, 1.0 - Number(c.distance ?? 1)), Number(c.distance ?? 1)));
  }

  /**
   * Aggregate tables from recalled columns and supplement high-recall elements (route permissions already validated).
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {Array<object>} recalled_columns from search_relevant_columns_cross_tables
   * @param {string} connection_id
   * @returns {Promise<Array<object>>}
   */
  static async aggregate_tables_from_columns(ctx, recalled_columns, connection_id) {
    try {
      await SchemaRetrievalService._validate_connection(ctx, connection_id);

      // 1) Group recalled columns by table_id
      const tableColumnsMap = new Map(); // table_id -> {table_info, columns, column_ids:Set}
      for (const col of recalled_columns) {
        const tableId = col.table_id;
        if (!tableColumnsMap.has(tableId)) {
          tableColumnsMap.set(tableId, {
            table_info: {
              id: tableId,
              table_name: col.table_name,
              schema_name: col.schema_name ?? null,
              description: col.table_description,
              retrieval_method: 'vector',
            },
            columns: [],
            column_ids: new Set(),
          });
        }
        const entry = tableColumnsMap.get(tableId);
        entry.columns.push(SchemaRetrievalService._format_column_result_from_dict(col));
        entry.column_ids.add(col.column_id);
      }

    console.log(`Aggregated ${tableColumnsMap.size} tables from recalled columns`);

      // 2) For each table, add high-recall columns, PK, FK
      for (const [tableId, tableData] of tableColumnsMap.entries()) {
        const recalledColumnIds = [...tableData.column_ids];
        const additionalColumns = await SchemaRetrievalService._queryColumns(ctx, {
          table_id: tableId,
          excludeIds: recalledColumnIds,
          highRecallOnly: true,
        });
        for (const col of additionalColumns) {
          tableData.columns.push(SchemaRetrievalService._format_column_result(col));
        }
        if (additionalColumns.length) {
          console.log(`Table ${tableData.table_info.table_name} supplemented with ${additionalColumns.length} columns`);
        }
      }

      // 3) Query and add high-recall tables and all their columns
      const highRecallTables = await ctx.query(
        `SELECT id, table_name, schema_name, description
           FROM table_metadata
          WHERE database_connection_id = $1
            AND is_high_recall = TRUE
            AND deleted_at IS NULL`,
        [connection_id],
      );

      for (const table of highRecallTables) {
        const tableId = table.id;

        if (tableColumnsMap.has(tableId)) {
          // Table already in map: merge retrieval methods and fill missing columns
          const entry = tableColumnsMap.get(tableId);
          const existingMethods = entry.table_info.retrieval_method.split(',');
          if (!existingMethods.includes('high_recall')) {
            entry.table_info.retrieval_method = [...existingMethods, 'high_recall'].sort().join(',');
          }

          const recalledColumnIds = [...entry.column_ids];
          const missingColumns = await SchemaRetrievalService._queryColumns(ctx, {
            table_id: tableId,
            excludeIds: recalledColumnIds,
          });
          for (const col of missingColumns) {
            entry.columns.push(SchemaRetrievalService._format_column_result(col));
            entry.column_ids.add(col.id);
          }
          if (missingColumns.length) {
            console.log(`High-recall table ${table.table_name} was vector-recalled; added ${missingColumns.length} missing columns`);
          }
        } else {
          // Add new high-recall table with all columns
          const allColumns = await SchemaRetrievalService._queryColumns(ctx, { table_id: tableId });
          tableColumnsMap.set(tableId, {
            table_info: {
              id: tableId,
              table_name: table.table_name,
              schema_name: table.schema_name,
              description: table.description || '',
              retrieval_method: 'high_recall',
            },
            columns: allColumns.map((col) => SchemaRetrievalService._format_column_result(col)),
            column_ids: new Set(allColumns.map((col) => col.id)),
          });
          console.log(`Added high-recall table ${table.table_name}, with ${allColumns.length} columns`);
        }
      }

      // 4) Build final result
      const finalTables = [];
      for (const tableData of tableColumnsMap.values()) {
        const tableInfo = tableData.table_info;
        tableInfo.columns = tableData.columns;
        finalTables.push(tableInfo);
      }

      console.log(`Aggregation complete, total ${finalTables.length} tables`);
      return finalTables;
    } catch (e) {
      console.error(`Table aggregation failed: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * Internal: query columns by condition for a table, with centralized SELECT builder to avoid inline SQL everywhere.
   * @param {{query:Function}} ctx
   * @param {object} opts
   * @param {string} opts.table_id
   * @param {Array<string>} [opts.excludeIds=[]] column IDs to exclude
   * @param {boolean} [opts.highRecallOnly=false] only high-recall columns (high_recall/PK/FK)
   * @param {Array<string>|null} [opts.entityColNames=null] extra entity-hit column names ORed with high-recall condition
   * @returns {Promise<Array<object>>}
   */
  static async _queryColumns(ctx, {
    table_id, excludeIds = [], highRecallOnly = false, entityColNames = null,
  }) {
    const params = [table_id];
    let sql = `SELECT id, table_id, column_name, data_type, is_nullable, default_value,
                      is_primary_key, is_foreign_key, is_indexed, is_high_recall,
                      enum_mappings, description, example_values
                 FROM column_metadata
                WHERE table_id = $1 AND deleted_at IS NULL`;

    if (excludeIds && excludeIds.length) {
      params.push(excludeIds);
      sql += ` AND id <> ALL($${params.length})`;
    }

    if (highRecallOnly && entityColNames && entityColNames.length) {
      params.push(entityColNames);
      sql += ` AND (${SchemaRetrievalService._build_high_recall_condition()} OR column_name = ANY($${params.length}))`;
    } else if (highRecallOnly) {
      sql += ` AND ${SchemaRetrievalService._build_high_recall_condition()}`;
    } else if (entityColNames && entityColNames.length) {
      params.push(entityColNames);
      sql += ` AND (${SchemaRetrievalService._build_high_recall_condition()} OR column_name = ANY($${params.length}))`;
    }

    sql += ' ORDER BY id';
    return ctx.query(sql, params);
  }

  /**
   * Format column result from dict (used in cross-table recall).
   * @param {object} col_dict
   * @returns {object}
   */
  static _format_column_result_from_dict(col_dict) {
    const result = {
      id: col_dict.column_id,
      column_name: col_dict.column_name,
      data_type: col_dict.data_type,
      nullable: col_dict.is_nullable != null ? col_dict.is_nullable : true,
    };

    if (col_dict.example_values) result.example_values = col_dict.example_values;
    if (col_dict.is_primary_key) result.is_primary_key = true;
    if (col_dict.is_indexed) result.is_indexed = true;
    if (col_dict.is_foreign_key) result.is_foreign_key = true;
    if (col_dict.description) result.description = col_dict.description;
    if (col_dict.is_high_recall) result.is_high_recall = true;
    if (col_dict.default_value) result.default_value = col_dict.default_value;
    if (col_dict.similarity != null) result.similarity = col_dict.similarity;

    return result;
  }

  /**
   * Smart column recall with keyword similarity + priority rules + dynamic threshold filtering.
   *
   * Priority rules:
   * 1) is_high_recall=true columns (required)
   * 2) is_primary_key / is_foreign_key columns (required)
   * 3) keyword similarity + top-gap filtering
   *
   * Embedding fallback: original step 3 used vector similarity; desktop uses keyword hit scoring.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} table_id
   * @param {string} question
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {number} [opts.max_limit=20]
   * @param {number} [opts.similarity_threshold=0.3]
   * @param {Array<number>|null} [opts.query_embedding=null] reserved for compatibility, currently ignored
   * @returns {Promise<Array<object>>}
   */
  static async search_relevant_columns(ctx, table_id, question, {
    project_id = null, max_limit = 20, similarity_threshold = 0.3, query_embedding = null,
  } = {}) {
    try {
      // 1) Validate table permission.
      const table = await ctx.queryOne(
        `SELECT id, database_connection_id FROM table_metadata
          WHERE id = $1 AND deleted_at IS NULL`,
        [table_id],
      );
      if (!table) {
        console.warn(`Table ${table_id} not found`);
        return [];
      }
      await SchemaRetrievalService._validate_connection(ctx, table.database_connection_id);

      // 2) Load all columns.
      const allColumns = await SchemaRetrievalService._queryColumns(ctx, { table_id });
      if (!allColumns.length) return [];

      // 3) Split required columns and optional columns.
      const mustIncludeColumns = [];
      const optionalColumns = [];
      for (const col of allColumns) {
        if (toBool(col.is_high_recall) || toBool(col.is_primary_key) || toBool(col.is_foreign_key)) {
          mustIncludeColumns.push(col);
        } else {
          optionalColumns.push(col);
        }
      }

      // 4) Keyword recall: score optional columns and apply dynamic threshold.
      const remainingSlots = max_limit;
      let vectorRankedColumns = [];

      if (optionalColumns.length) {
        const tokens = tokenizeQuestion(question);
        if (tokens.length) {
          const norm = Math.max(1, Math.min(tokens.length, 5));
          const vectorWithScores = optionalColumns.map((col) => {
            const exampleList = parseExampleValues(col.example_values);
            const exampleText = exampleList.length ? exampleList.join(' ') : '';
            const hits = countHits(col.column_name, tokens)
              + countHits(col.description, tokens)
              + countHits(exampleText, tokens);
            return { column: col, similarity: Math.min(1.0, hits / norm) };
          });

          const filteredVector = filter_by_relative_threshold(vectorWithScores, {
            score_key: 'similarity',
            threshold: similarity_threshold,
            higher_is_better: true,
          });
          vectorRankedColumns = filteredVector
            .slice(0, remainingSlots)
            .map((item) => item.column);
        } else {
          // Fallback: if no question/tokens, sort by column_name.
          console.warn('No query keywords, using fallback strategy');
          vectorRankedColumns = [...optionalColumns]
            .sort((a, b) => String(a.column_name).localeCompare(String(b.column_name)))
            .slice(0, remainingSlots);
        }
      }

      // 5) Merge required columns and filtered keyword columns.
      const finalColumns = [...mustIncludeColumns, ...vectorRankedColumns];

      // 6) Format output.
      const result = finalColumns.map((col) => SchemaRetrievalService._format_column_result(col));

      console.log(
        `Table ${table_id} smart recall columns: `
        + `必选列=${mustIncludeColumns.length}, `
        + `关键词召回列=${vectorRankedColumns.length}, `
        + `总计=${result.length}`,
      );

      return result;
    } catch (e) {
      console.error(`Smart column recall failed: ${e?.message ?? e}`);
      return [];
    }
  }

  // ==================== combined recall methods (table + columns) ====================

  /**
   * Column-first recall flow (no LLM filtering, route permissions already validated).
   * 1) cross-table keyword column recall with dynamic threshold
   * 2) aggregate tables and supplement high-recall columns/tables
   * 3) return final result
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {string} question
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {string|null} [opts.user_id=null]
   * @param {number} [opts.table_limit=5]
   * @returns {Promise<Array<object>>}
   */
  static async search_relevant_schema_column_first(ctx, connection_id, question, {
    project_id = null, user_id = null, table_limit = 5,
  } = {}) {
    try {
      // Column recall count = table_limit * 3 (about 3 columns per table)
      const columnLimit = table_limit * 3;
      const recalledColumns = await SchemaRetrievalService.search_relevant_columns_cross_tables(
        ctx, connection_id, question, {
          project_id,
          max_limit: columnLimit,
          similarity_threshold: 0.3,
        },
      );

      console.log(`Column-first recall: cross-table recall returned ${recalledColumns.length} columns`);

      if (!recalledColumns.length) {
        console.warn('Column-first recall: no related columns found');
        return [];
      }

      const tablesWithColumns = await SchemaRetrievalService.aggregate_tables_from_columns(
        ctx, recalledColumns, connection_id,
      );

      console.log(`Column-first recall: returned ${tablesWithColumns.length} related tables with columns`);
      return tablesWithColumns;
    } catch (e) {
      console.error(`Column-first recall failed: ${e?.message ?? e}`);
      return [];
    }
  }

  /**
   * Smart recall tables and columns, using db config to choose strategy.
   *
   * Strategy is controlled by connection.extra_config:
   * - retrieval_mode: 'table' or 'column'
   * - table_limit: max number of tables (default 5)
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {string} question
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {number|null} [opts.limit=null] table limit override, takes precedence over extraConfig.table_limit
   * @returns {Promise<Array<object>>}
   */
  static async search_relevant_tables_with_columns(ctx, connection_id, question, {
    project_id = null, limit = null,
  } = {}) {
    try {
      console.log('🔍 [SchemaRetrieval] ===== Schema recall started =====');
      console.log(`🔍 [SchemaRetrieval] connection_id: ${connection_id}`);
      console.log(`🔍 [SchemaRetrieval] project_id: ${project_id}`);
      const qPreview = question && question.length > 100 ? `${question.slice(0, 100)}...` : question;
      console.log(`🔍 [SchemaRetrieval] question: ${qPreview}`);

      // Read retrieval mode and limits from connection config.
      const connection = await SchemaRetrievalService._validate_connection(ctx, connection_id);
      const extraConfig = SchemaRetrievalService._extraConfigDict(connection);
      const retrievalMode = extraConfig.retrieval_mode ?? 'table';
      const tableLimit = limit != null ? limit : (extraConfig.table_limit ?? 5);

      console.log(`🔍 [SchemaRetrieval] database ${connection_id} retrievalMode: ${retrievalMode}, tableLimit: ${tableLimit}`);

      if (retrievalMode === 'column') {
        console.log('Using column-first recall strategy');
        return await SchemaRetrievalService.search_relevant_schema_column_first(
          ctx, connection_id, question, { project_id, table_limit: tableLimit },
        );
      }

      // Default: table-first recall.
      console.log('Using table-first recall strategy');

      let vectorResults = [];
      let highRecallResults = [];

      // Keyword fallback candidate pool is 4x final table limit.
      try {
        vectorResults = await SchemaRetrievalService.search_relevant_tables_vector(
          ctx, connection_id, question, {
            project_id,
            max_limit: tableLimit * 4,
            similarity_threshold: 0.20,
          },
        );
        console.log(`Found ${vectorResults.length} vector-recalled tables`);
      } catch (e) {
        console.error(`Vector recall exception: ${e?.message ?? e}`);
      }

      // High-priority table recall (no row limit, not counted against table_limit).
      try {
        highRecallResults = await SchemaRetrievalService.search_high_recall_tables(ctx, connection_id);
        console.log(`Found ${highRecallResults.length} high-priority tables`);
      } catch (e) {
        console.error(`High-priority table recall exception: ${e?.message ?? e}`);
      }

      // Limit vector-recalled tables; keep all high-priority tables.
      const vectorResultsLimited = vectorResults.slice(0, tableLimit);
      const mergedResults = SchemaRetrievalService._merge_results(vectorResultsLimited, highRecallResults);

      console.log(
        `Final recall: ${highRecallResults.length} high-priority tables + ${vectorResultsLimited.length} vector tables `
        + `= total ${mergedResults.length} tables`,
      );

      // For recalled tables, append columns (all columns in table-first mode).
      const tablesWithColumns = [];
      for (const table of mergedResults) {
        const tableId = table.id;
        if (tableId) {
          const allColumns = await SchemaRetrievalService._queryColumns(ctx, { table_id: tableId });
          table.columns = allColumns.map((col) => SchemaRetrievalService._format_column_result(col));
          tablesWithColumns.push(table);
        }
      }

      console.log(`Smart recall returned ${tablesWithColumns.length} related tables with columns`);
      return tablesWithColumns;
    } catch (e) {
      console.error(`Smart recall failed: ${e?.message ?? e}`);
      return [];
    }
  }

  // ==================== table relationship queries ====================

  /**
   * Get relationships among recalled tables.
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {Array<string>} table_names recalled table names (plain name)
   * @param {Set<string>|null} [table_keys=null] schema-aware table keys for strict filtering (optional)
   * @returns {Promise<Array<object>>}
   */
  static async get_table_relationships(ctx, connection_id, table_names, table_keys = null) {
    if (!table_names || table_names.length < 2) return [];

    try {
      // Query relationships touching these tables; join source-table metadata (plain name can match multiple rows).
      const rows = await ctx.query(
        `SELECT r.source_table_id   AS source_table_id,
                r.target_table_id   AS target_table_id,
                r.source_column     AS source_column,
                r.target_column     AS target_column,
                r.relationship_type AS relationship_type,
                t.table_name        AS source_table_name,
                t.schema_name       AS source_schema_name
           FROM relationship_metadata r
           JOIN table_metadata t ON r.source_table_id = t.id
          WHERE r.database_connection_id = $1
            AND r.deleted_at IS NULL
            AND t.table_name::text = ANY($2::text[])`,
        [connection_id, table_names],
      );
      if (!rows.length) return [];

      // Build target table info mapping.
      const targetIds = [...new Set(rows.map((row) => row.target_table_id))];
      if (!targetIds.length) return [];

      const targetRows = await ctx.query(
        `SELECT id, table_name, schema_name FROM table_metadata
          WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
        [targetIds],
      );
      const targetInfoMap = new Map();
      for (const r of targetRows) targetInfoMap.set(r.id, [r.table_name, r.schema_name]);

      // Use schema-aware key for strict filtering.
      const filterKeys = table_keys || new Set(table_names);

      const relationships = [];
      for (const rel of rows) {
        const targetInfo = targetInfoMap.get(rel.target_table_id);
        if (!targetInfo) continue;
        const [targetName, targetSchema] = targetInfo;
        const sourceName = rel.source_table_name;
        const sourceSchema = rel.source_schema_name;

        const sourceKey = SchemaRetrievalService._table_key(sourceSchema, sourceName);
        const targetKey = SchemaRetrievalService._table_key(targetSchema, targetName);

        if (filterKeys.has(sourceKey) && filterKeys.has(targetKey)) {
          const sourceFull = sourceSchema && sourceSchema !== 'default' ? `${sourceSchema}.${sourceName}` : sourceName;
          const targetFull = targetSchema && targetSchema !== 'default' ? `${targetSchema}.${targetName}` : targetName;
          relationships.push({
            source_table: sourceFull,
            source_column: rel.source_column,
            target_table: targetFull,
            target_column: rel.target_column,
            relationship_type: rel.relationship_type,
          });
        }
      }

      return relationships;
    } catch (e) {
      console.warn(`Failed to query table relationships: ${e?.message ?? e}`);
      return [];
    }
  }

  // ==================== relationship-driven table expansion ====================

  /**
   * Expand related tables that were not recalled, based on relationships of already recalled tables.
   * Only relationship columns (PK/FK/high-recall columns) are considered; expansion depth is 1.
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {Array<object>} existing_tables recalled table list (mutated/in-place append)
   * @param {number} [max_expand=3] max tables to expand
   * @returns {Promise<Array<object>>}
   */
  static async expand_tables_by_relationships(ctx, connection_id, existing_tables, max_expand = 3) {
    try {
      const recalledTableKeys = new Set(
        existing_tables.map((tb) => SchemaRetrievalService._table_key(tb.schema_name, tb.table_name || '')),
      );
      const recalledTableNames = [...new Set(existing_tables.map((tb) => tb.table_name || ''))];
      if (!recalledTableNames.length) return existing_tables;

      // Resolve recalled table_ids (plain name query, then filter by schema-aware key)
      const recalledRows = await ctx.query(
        `SELECT id, table_name, schema_name FROM table_metadata
          WHERE database_connection_id = $1
            AND table_name::text = ANY($2::text[])
            AND deleted_at IS NULL`,
        [connection_id, recalledTableNames],
      );
      const recalledIds = new Set();
      for (const r of recalledRows) {
        const tkey = SchemaRetrievalService._table_key(r.schema_name, r.table_name);
        if (recalledTableKeys.has(tkey)) recalledIds.add(r.id);
      }
      if (!recalledIds.size) return existing_tables;

      // Single-ended matching: find relations where at least one side is already recalled.
      const recalledIdArr = [...recalledIds];
      const allRels = await ctx.query(
        `SELECT source_table_id, target_table_id, source_column, target_column
           FROM relationship_metadata
          WHERE database_connection_id = $1
            AND deleted_at IS NULL
            AND (source_table_id::text = ANY($2::text[]) OR target_table_id::text = ANY($2::text[]))`,
        [connection_id, recalledIdArr],
      );
      if (!allRels.length) return existing_tables;

      // Count references for unrecalled tables (higher count = higher priority).
      const candidateRefCount = new Map(); // table_id -> count
      const candidateRelColumns = new Map(); // table_id -> Set<col>
      for (const rel of allRels) {
        let tid;
        let col;
        if (recalledIds.has(rel.source_table_id) && !recalledIds.has(rel.target_table_id)) {
          tid = rel.target_table_id;
          col = rel.target_column;
        } else if (recalledIds.has(rel.target_table_id) && !recalledIds.has(rel.source_table_id)) {
          tid = rel.source_table_id;
          col = rel.source_column;
        } else {
          continue; // skip if both ends are already recalled or both unrecalled
        }
        candidateRefCount.set(tid, (candidateRefCount.get(tid) || 0) + 1);
        if (!candidateRelColumns.has(tid)) candidateRelColumns.set(tid, new Set());
        candidateRelColumns.get(tid).add(col);
      }
      if (!candidateRefCount.size) return existing_tables;

      // Sort by reference count and take top N.
      const sortedCandidates = [...candidateRefCount.entries()].sort((a, b) => b[1] - a[1]);
      const topCandidates = sortedCandidates.slice(0, max_expand);

      // Load candidate table metadata.
      const candidateIds = topCandidates.map(([tid]) => tid);
      const candidateRows = await ctx.query(
        `SELECT id, table_name, schema_name FROM table_metadata
          WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
        [candidateIds],
      );
      const candidateTables = new Map();
      for (const tb of candidateRows) candidateTables.set(tb.id, tb);

      for (const [tid, refCount] of topCandidates) {
        const tableOrm = candidateTables.get(tid);
        if (!tableOrm) continue;
        const tkey = SchemaRetrievalService._table_key(tableOrm.schema_name, tableOrm.table_name);
        if (recalledTableKeys.has(tkey)) continue;

        const relColNames = [...(candidateRelColumns.get(tid) || new Set())];
        const columns = await SchemaRetrievalService._get_columns_for_entity_table(ctx, tid, relColNames);

        existing_tables.push({
          table_name: tableOrm.table_name,
          schema_name: tableOrm.schema_name,
          columns,
          retrieval_method: 'relationship_expansion',
        });
        recalledTableKeys.add(tkey);
          console.log(
            `  ✅ Relationship expansion: ${tableOrm.table_name} is referenced by ${refCount} recalled tables, added ${columns.length} columns`,
          );
      }

      return existing_tables;
    } catch (e) {
      console.warn(`Relationship-driven table expansion failed: ${e?.message ?? e}`);
      return existing_tables;
    }
  }

  // ==================== entity-assisted recall methods ====================

  /**
   * Supplement tables hit by entities that were not recalled by vector results (route permissions already validated).
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} connection_id
   * @param {Array<object>} existing_tables recalled table list (mutated in place or appended)
   * @param {Set<string>} entity_tables entity-hit table names (may include "schema.table")
   * @param {Object<string, Set<string>>|null} [entity_columns=null] entity-hit columns {table_name: Set(col)}
   * @param {Set<string>|null} [full_recall_tables=null] table names that should return all columns (schema_hint)
   * @returns {Promise<Array<object>>}
   */
  static async supplement_entity_tables(
    ctx, connection_id, existing_tables, entity_tables, entity_columns = null, full_recall_tables = null,
  ) {
    try {
      if (!entity_tables || (entity_tables.size != null ? entity_tables.size === 0 : !entity_tables.length)) {
        return existing_tables;
      }

      const entityColumns = entity_columns || {};
      const fullRecallTables = full_recall_tables || new Set();
      const entityTablesSet = entity_tables instanceof Set ? entity_tables : new Set(entity_tables);

    // Deduplicate by schema-aware keys.
      const recalledTableKeys = new Set(
        existing_tables.map((tb) => SchemaRetrievalService._table_key(tb.schema_name, tb.table_name || '')),
      );

      // entity_tables may include "schema.table"; compare against recalledTableKeys.
      const missingTables = new Set([...entityTablesSet].filter((k) => !recalledTableKeys.has(k)));

      // Even if table was vector-recalled, supplement associated metric columns when needed.
      for (const tableName of entityTablesSet) {
        const requiredColumns = entityColumns[tableName];
        if (requiredColumns && (requiredColumns.size != null ? requiredColumns.size : requiredColumns.length)) {
          const requiredSet = requiredColumns instanceof Set ? requiredColumns : new Set(requiredColumns);
          if (recalledTableKeys.has(tableName)) {
            for (const table of existing_tables) {
              const existingKey = SchemaRetrievalService._table_key(table.schema_name, table.table_name || '');
              if (existingKey === tableName) {
                const existingCols = new Set((table.columns || []).map((c) => c.column_name));
                const missingCols = [...requiredSet].filter((c) => !existingCols.has(c));
                if (missingCols.length) {
                console.log(`🔗 [entity recall] table ${tableName} recalled but missing columns: ${missingCols.join(', ')}`);
                  missingTables.add(tableName);
                }
                break;
              }
            }
          }
        }
      }

      if (!missingTables.size) {
        console.log('All entity-hit tables were already recalled by vector, and column info is complete');
        return existing_tables;
      }

      console.log(`🔗 [entity recall] supplementing tables: ${[...missingTables].join(', ')}`);

      for (const tableName of missingTables) {
        // tableName may be "schema.table" or plain table name.
        let schemaPart = null;
        let tablePart = tableName;
        const dotIdx = tableName.indexOf('.');
        if (dotIdx >= 0) {
          schemaPart = tableName.slice(0, dotIdx);
          tablePart = tableName.slice(dotIdx + 1);
        }

        // Same table name may exist across schemas; process all matches one by one.
        const params = [connection_id, tablePart];
        let sql = `SELECT id, table_name, schema_name, description, is_high_recall
                     FROM table_metadata
                    WHERE database_connection_id = $1
                      AND table_name = $2
                      AND deleted_at IS NULL`;
        if (schemaPart) {
          params.push(schemaPart);
          sql += ` AND schema_name = $${params.length}`;
        }
        const tableOrmList = await ctx.query(sql, params);

        for (const tableOrm of tableOrmList) {
          const tkey = SchemaRetrievalService._table_key(tableOrm.schema_name, tableOrm.table_name);
          const entityColRaw = entityColumns[tableName];
          const entityColNames = entityColRaw
            ? [...(entityColRaw instanceof Set ? entityColRaw : new Set(entityColRaw))]
            : [];

          if (recalledTableKeys.has(tkey)) {
            // Table already recalled, only supplement missing columns.
            for (const existingTable of existing_tables) {
              const existingKey = SchemaRetrievalService._table_key(
                existingTable.schema_name, existingTable.table_name || '',
              );
              if (existingKey === tkey) {
                const existingColNames = new Set((existingTable.columns || []).map((c) => c.column_name));
                const columns = await SchemaRetrievalService._get_columns_for_entity_table(
                  ctx, tableOrm.id, entityColNames,
                );
                const supplementCols = columns.filter((c) => !existingColNames.has(c.column_name));
                if (!existingTable.columns) existingTable.columns = [];
                existingTable.columns.push(...supplementCols);
                console.log(
                  `  ✅ Supplemented table ${tkey} with ${supplementCols.length} columns (total ${existingTable.columns.length})`,
                );
                break;
              }
            }
          } else {
            // Table not recalled: add full table entry.
            const isFullRecall = toBool(tableOrm.is_high_recall) || fullRecallTables.has(tableName);
            let columns;
            if (isFullRecall) {
              const allColumns = await SchemaRetrievalService._queryColumns(ctx, { table_id: tableOrm.id });
              columns = allColumns.map((col) => SchemaRetrievalService._format_column_result(col));
              const source = toBool(tableOrm.is_high_recall) ? 'high_recall table' : 'schema_hint';
              console.log(`  ✅ Supplemented ${source} ${tkey}, returning all ${columns.length} columns`);
            } else {
              columns = await SchemaRetrievalService._get_columns_for_entity_table(
                ctx, tableOrm.id, entityColNames,
              );
              console.log(`  ✅ Supplemented table ${tkey}, ${columns.length} columns (high-recall + entity columns)`);
            }

            existing_tables.push({
              table_name: tableOrm.table_name,
              schema_name: tableOrm.schema_name,
              columns,
              retrieval_method: 'entity',
            });
            recalledTableKeys.add(tkey);
          }
        }
      }

      return existing_tables;
    } catch (e) {
      console.error(`Entity-assisted recall failed: ${e?.message ?? e}`);
      return existing_tables;
    }
  }

  /**
   * Get entity table columns (high-recall + PK/FK + entity-hit columns).
   * Keep only first 3 examples; include_example_values=false.
   * @param {{query:Function}} ctx
   * @param {string} table_id
   * @param {Array<string>|Set<string>|null} [entity_col_names=null]
   * @returns {Promise<Array<object>>}
   */
  static async _get_columns_for_entity_table(ctx, table_id, entity_col_names = null) {
    const entityColNames = entity_col_names
      ? [...(entity_col_names instanceof Set ? entity_col_names : new Set(entity_col_names))]
      : [];

    const columnsOrm = await SchemaRetrievalService._queryColumns(ctx, {
      table_id,
      highRecallOnly: true,
      entityColNames: entityColNames.length ? entityColNames : null,
    });

    return columnsOrm.map((col) => SchemaRetrievalService._format_column_result(col, false));
  }
}

export default SchemaRetrievalService;
