// Migrated from backend/dsh_kernel/semantic_catalogs/business/entity_service_base.py
//
// Entity service base class that provides shared methods for entity management, used by DB and structured-data services.
// It is the dependency base for metric_service / metric_view / entity_service, and public method names are preserved 1:1.
//
// ============================ Desktop migration notes ============================
// 1. No ORM / AsyncSession: original Python uses SQLAlchemy select/func + db.add/flush/commit.
//    All DB access methods in this migration version take injected ctx/deps as first parameter:
//      { query(sql, params)->Promise<rows>, queryOne(sql, params)->Promise<row|null>,
//        execute(sql, params)->Promise<{rowCount}> } (consistent with other migrated files).
//    Desktop has no direct write/transaction interface; original db.add_all + db.flush bulk insert behavior
//    degrades here to returning rows ready for insertion, keeping public method names and return shape.
//    Vastbase treats empty string as NULL, so null checks use IS NOT NULL; all queries include deleted_at IS NULL soft-delete filter.
//    .in_() → = ANY($n).
// 2. Embedding/vector recall: core/llm.js embed() and VexDB cosine distance are connected.
//    search_similar_entities prefers vector recall and falls back to keyword scoring when the model,
//    extension, or stored vectors are unavailable. _generate_embeddings_for_entities writes vectors in
//    bounded batches, and _batch_get_entity_stats reports the real embedding coverage.
// 3. Table names (snake_case plural): entity_mappings / entity_mapping_configs / businesses (from models.__tablename__).
//    entity_mappings stores meta_data as Text(JSON string); entity_mapping_configs stores metadata_fields/sample_entities as JSONB
//    and pg driver returns objects/arrays.
// =======================================================================

import { NotFoundError } from '../core/exceptions.js';
import { t } from '../utils/i18n.js';
import { embed } from '../core/llm.js';
import { vectorReady } from '../../db.js';

// Embedding model name (aligned with default embed() model text-embedding-v3)
const EMBEDDING_MODEL = 'text-embedding-v3';

/**
 * Vectorize query text for vexdb_cosine_distance recall. If query_embedding is provided, use it directly;
 * otherwise call embed(). On any failure (no embedding model/extension not loaded), return null and caller falls back to keyword recall.
 * Follows embedQuestion style in schema_retrieval_service.js.
 * @param {string} queryText
 * @param {string|null} project_id
 * @param {number[]|null} query_embedding
 * @returns {Promise<number[]|null>}
 */
async function embedQuestion(queryText, project_id = null, query_embedding = null) {
  if (Array.isArray(query_embedding) && query_embedding.length) return query_embedding;
  if (!vectorReady || !queryText || !String(queryText).trim()) return null;
  try {
    const v = await embed(queryText, { project_id });
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) {
    console.warn(`[EntityServiceBase] embed failed, fallback to keyword recall: ${e?.message ?? e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Keyword scoring utility (embedding fallback implementation, aligned with schema_retrieval_service.js)
// Tokenize query_text (Chinese/English/numeric mix) and count hits against candidate texts -> pseudo similarity (0~1).
// ---------------------------------------------------------------------------
function tokenizeQuery(queryText) {
  if (!queryText) return [];
  const lower = String(queryText).toLowerCase();
  const asciiTokens = lower.match(/[a-z0-9_]+/g) || [];
  const cjkChars = lower.match(/[一-鿿]/g) || [];
  const cjkBigrams = [];
  for (let i = 0; i + 1 < cjkChars.length; i += 1) {
    cjkBigrams.push(cjkChars[i] + cjkChars[i + 1]);
  }
  const tokens = new Set(
    [...asciiTokens, ...cjkChars, ...cjkBigrams].filter((tk) => tk && tk.length >= 1),
  );
  return [...tokens];
}

/** Count token hits in a text using case-insensitive substring match. */
function countHits(text, tokens) {
  if (!text || !tokens.length) return 0;
  const hay = String(text).toLowerCase();
  let hits = 0;
  for (const tk of tokens) {
    if (hay.includes(tk)) hits += 1;
  }
  return hits;
}

export class EntityServiceBase {
  // ==================== Shared helper methods ====================

  /**
   * Validate business (after migrating business layer, scope is always project_id; no businesses table lookup).
   * Keeps method name for downstream imports; signature is simplified to accept project_id only and pass through.
   * @param {{queryOne:Function}} ctx
   * @param {string} project_id
   * @returns {Promise<object>} { id: project_id }
   */
  static async _validate_business(ctx, project_id) {
    return { id: project_id, project_id };
  }

  /**
   * Convert DB value to JSON-serializable format.
   * Corresponds to Python handling for Decimal/datetime/date/time/UUID/bytes.
   * pg driver in JS usually returns native types; this is a fallback conversion.
   * @param {*} value
   * @returns {*}
   */
  static _to_json_serializable(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string'
      || typeof value === 'number'
      || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'bigint') return Number(value);
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Uint8Array || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))) {
      try {
        return Buffer.from(value).toString('utf-8');
      } catch (_) {
        return Buffer.from(value).toString('hex');
      }
    }
    if (Array.isArray(value)) {
      return value.map((item) => EntityServiceBase._to_json_serializable(item));
    }
    if (typeof value === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = EntityServiceBase._to_json_serializable(v);
      }
      return result;
    }
    return String(value);
  }

  /**
   * Select sample entities with diverse lengths.
   * @param {Array<string>} entities
   * @param {number} [count=3]
   * @returns {Array<string>}
   */
  static get_diverse_length_samples(entities, count = 3) {
    if (!entities || !entities.length) return [];
    const uniqueEntities = [...new Set(entities)];
    if (uniqueEntities.length <= count) return uniqueEntities;
    const sortedEntities = [...uniqueEntities].sort((a, b) => String(a).length - String(b).length);
    const bucketSize = Math.floor(sortedEntities.length / count);
    const samples = [];
    for (let i = 0; i < count; i += 1) {
      const idx = i * bucketSize + Math.floor(bucketSize / 2);
      samples.push(sortedEntities[Math.min(idx, sortedEntities.length - 1)]);
    }
    return samples;
  }

  /**
   * Calculate vector status.
   * @param {number} entity_count
   * @param {number} vector_count
   * @returns {string}
   */
  static _calculate_vector_status(entity_count, vector_count) {
    if (entity_count === 0) return '未生成';
    if (vector_count === entity_count) return '已生成';
    if (vector_count > 0) return `部分生成(${vector_count}/${entity_count})`;
    return '未生成';
  }

  /**
   * Parse meta_data JSON string.
   * @param {string|object|null} meta_data_str
   * @returns {object}
   */
  static _parse_meta_data(meta_data_str) {
    if (!meta_data_str) return {};
    if (typeof meta_data_str === 'object') return meta_data_str;
    try {
      const parsed = JSON.parse(meta_data_str);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  // ==================== Batch store entities ====================

  /**
   * Build entity rows in batch (equivalent to original _store_entities_batch).
   *
   * ⚠️ Desktop has no write/transaction interface: original Python really inserts and flushes via db.add_all + db.flush.
   *    This layer degrades to "build and return rows pending insertion", leaving persistence to caller while keeping method names/return shapes.
   *    Each row matches entity_mappings columns:
   *      { business_id, name, source_id, source_type, entity_type, config_id, meta_data(JSON string) }.
   *
   * @param {object} ctx Injected deps (position param kept; no direct DB writes here)
   * @param {string} project_id
   * @param {string} source_id
   * @param {string} source_type
   * @param {Array<object>} entity_values
   * @param {string} table_name
   * @param {string} column_name
   * @param {object} [opts]
   * @param {string|null} [opts.config_id=null]
   * @param {string} [opts.entity_type='column_value']
   * @param {boolean} [opts.include_source_value=true] Include source_value field in meta_data
   * @param {string|null} [opts.schema_name=null] schema name (multi-schema scenario)
   * @returns {Promise<Array<object>>} Array of entity rows pending insertion
   */
  static async _store_entities_batch(
    ctx,
    project_id,
    source_id,
    source_type,
    entity_values,
    table_name,
    column_name,
    {
      config_id = null,
      entity_type = 'column_value',
      include_source_value = true,
      schema_name = null,
    } = {},
  ) {
    const entityMappings = [];
    for (const entityData of entity_values) {
      const entityName = entityData.entity_name;

      // Build meta_data.
      const metaData = {
        table_name,
        column_name,
      };

      // Add schema_name for same-table-name differentiation across schemas.
      if (schema_name) {
        metaData.schema_name = schema_name;
      }

      if (include_source_value) {
        metaData.source_value = entityData.source_value ?? entityName;
      }

      // Add remaining metadata fields.
      for (const [key, value] of Object.entries(entityData)) {
        if (!['entity_name', 'table_name', 'column_name', 'source_value'].includes(key)) {
          metaData[key] = value;
        }
      }

      entityMappings.push({
        project_id,
        name: entityName,
        source_id,
        source_type,
        entity_type,
        config_id,
        meta_data: JSON.stringify(metaData),
      });
    }

    // Desktop: return pending rows; original db.add_all + db.flush is handled by caller.
    return entityMappings;
  }

  // ==================== Batch stats query ====================

  /**
   * Get entity stats in batch (entity count and vector count).
   * @param {{query:Function}} ctx
   * @param {Array<string>} config_ids
   * @returns {Promise<Object<string,{entity_count:number, vector_count:number}>>}
   */
  static async _batch_get_entity_stats(ctx, config_ids) {
    if (!config_ids || !config_ids.length) return {};

    const rows = await ctx.query(
      `SELECT config_id,
              COUNT(id)        AS entity_count,
              COUNT(embedding) AS vector_count
         FROM entity_mappings
        WHERE config_id::text = ANY($1::text[])
          AND deleted_at IS NULL
        GROUP BY config_id`,
      [config_ids],
    );

    const result = {};
    for (const row of rows) {
      result[row.config_id] = {
        entity_count: Number(row.entity_count) || 0,
        vector_count: Number(row.vector_count) || 0,
      };
    }
    return result;
  }

  /**
   * Get entity previews in batch by config.
   * @param {{query:Function}} ctx
   * @param {Array<string>} config_ids
   * @param {number} [limit_per_config=20]
   * @returns {Promise<Object<string, Array<object>>>}
   */
  static async _batch_get_entity_previews(ctx, config_ids, limit_per_config = 20) {
    if (!config_ids || !config_ids.length) return {};

    const rows = await ctx.query(
      `SELECT config_id, name, meta_data
         FROM entity_mappings
        WHERE config_id::text = ANY($1::text[])
          AND deleted_at IS NULL
        ORDER BY config_id, name`,
      [config_ids],
    );

    const previewsByConfig = {};
    const currentCounts = {};

    for (const row of rows) {
      const configId = row.config_id;

      if (!(configId in previewsByConfig)) {
        previewsByConfig[configId] = [];
        currentCounts[configId] = 0;
      }

      if (currentCounts[configId] >= limit_per_config) continue;

      // Parse meta_data to read description and actual column name
      let description = null;
      let actualColumnName = null;
      let isAlias = false;
      if (row.meta_data) {
        const meta = EntityServiceBase._parse_meta_data(row.meta_data);
        description = meta.description ?? null;
        actualColumnName = meta.column_name ?? null; // actual English column name
        isAlias = meta.is_alias ?? false;
      }

      previewsByConfig[configId].push({
        name: row.name,
        column_name: actualColumnName, // actual English column name
        description,
        is_alias: isAlias, // comment-based alias
      });
      currentCounts[configId] += 1;
    }

    return previewsByConfig;
  }

  // ==================== Entity search (generic) ====================

  /**
   * Search similar entities (generic).
   *
   * Recall strategy:
   * 1) Prefer true vector recall (vexdb_cosine_distance) over entity_mappings.embedding, ordered by cosine distance ascending top-N;
   * 2) If vector is unavailable (no embedding model/extension loaded or no rows with embedding for this business), fallback to keyword hit scoring
   *    across name/meta_data(table_name/column_name/description).
   *   Both paths return exactly the same structure for downstream dependencies.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} business_id
   * @param {string} query_text
   * @param {string} project_id Used by embed for vector recall
   * @param {object} [opts]
   * @param {Array<string>|null} [opts.config_ids=null] config IDs (alternative to source_id/source_type)
   * @param {string|null} [opts.source_id=null]
   * @param {string|null} [opts.source_type=null]
   * @param {number} [opts.limit=10]
   * @param {Array<number>|null} [opts.query_embedding=null] precomputed query embedding vector (used directly if provided)
   * @param {boolean} [opts.throw_on_error=false] Surface storage failures instead of treating them as no matches
   * @returns {Promise<Array<object>>}
   */
  static async search_similar_entities(ctx, business_id, query_text, project_id, {
    config_ids = null, source_id = null, source_type = null, limit = 10, query_embedding = null, throw_on_error = false,
  } = {}) {
    try {
      // Build query conditions: keyword fallback does not depend on embedding, so do not enforce embedding IS NOT NULL;
      // otherwise desktop without vectors always returns empty. Prefer filtering by config_ids.
      const conditions = ['em.deleted_at IS NULL'];
      const params = [];

      if (config_ids && config_ids.length) {
        params.push(config_ids);
        conditions.push(`em.config_id = ANY($${params.length})`);
      } else if (business_id) {
        // Backward compatibility: fallback to business_id filter when config_ids is missing.
        params.push(business_id);
        conditions.push(`em.business_id = $${params.length}`);
      }
      if (source_id) {
        params.push(source_id);
        conditions.push(`em.source_id = $${params.length}`);
      }
      if (source_type) {
        params.push(source_type);
        conditions.push(`em.source_type = $${params.length}`);
      }

      // 1) Prefer vector recall (vexdb_cosine_distance); fallback to keywords on failure/no embedding
      let entities = null;
      const qvec = await embedQuestion(query_text, project_id, query_embedding);
      if (qvec) {
        entities = await EntityServiceBase._vectorScoreEntities(ctx, conditions, params, qvec, limit);
        if (entities && entities.length) {
          console.info(`🔍 [EntitySearch] vector recall (vexdb) '${query_text}' hit ${entities.length} entities`);
        }
      }

      // 2) Keyword fallback when vector returns empty
      if (!entities || !entities.length) {
        // JOIN mapping config to fetch rule; keep return fields aligned with original.
        const rows = await ctx.query(
          `SELECT em.id           AS id,
                  em.name         AS name,
                  em.entity_type  AS entity_type,
                  em.meta_data    AS meta_data,
                  emc.rule        AS rule
             FROM entity_mappings em
             JOIN entity_mapping_configs emc ON em.config_id = emc.id
            WHERE ${conditions.join(' AND ')}`,
          params,
        );
        if (!rows.length) return [];
        entities = EntityServiceBase._keywordScoreEntities(rows, query_text, limit);
        console.info(`🔍 [EntitySearch] keyword fallback (vector empty) '${query_text}' hit ${entities.length} entities`);
      }

      for (const e of entities.slice(0, 5)) { // print only first 5
        const simStr = Number(e.similarity).toFixed(3);
        console.info(
          `🔍 [EntitySearch]   - ${e.entity_name} (sim=${simStr}, type=${e.source_type}, table=${e.table_name})`,
        );
      }

      return entities;
    } catch (e) {
      console.error(`Failed to search similar entities: ${e?.message ?? e}`);
      if (throw_on_error) throw e;
      return [];
    }
  }

  /**
   * Vector recall with vexdb_cosine_distance: add embedding IS NOT NULL to built filters,
   * sort by cosine distance ascending top-N; similarity = max(0, 1 - distance). Return structure matches keyword path.
   * @param {{query:Function}} ctx
   * @param {Array<string>} conditions Built WHERE conditions (including em.deleted_at IS NULL, etc.)
   * @param {Array} params Parameters corresponding to conditions
   * @param {number[]} queryVec Query vector
   * @param {number} limit
   * @returns {Promise<Array<object>>}
   */
  static async _vectorScoreEntities(ctx, conditions, params, queryVec, limit) {
    // Clone conditions/params to avoid mutating caller; keyword fallback still needs original conditions/params.
    const vecParams = [JSON.stringify(queryVec), ...params];
    // Shift original params placeholders by one position ($1 is reserved for query vector).
    const shiftedConditions = conditions.map(
      (c) => c.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + 1}`),
    );
    const limitIdx = vecParams.length + 1;
    vecParams.push(limit);

    const rows = await ctx.query(
      `SELECT em.id           AS id,
              em.name         AS name,
              em.entity_type  AS entity_type,
              em.meta_data    AS meta_data,
              emc.rule        AS rule,
              vexdb_cosine_distance(em.embedding, vexdb_f32($1)) AS distance
         FROM entity_mappings em
         JOIN entity_mapping_configs emc ON em.config_id = emc.id
        WHERE ${shiftedConditions.join(' AND ')}
          AND em.embedding IS NOT NULL
        ORDER BY distance ASC
        LIMIT $${limitIdx}`,
      vecParams,
    ).catch((e) => {
      console.warn(`[EntityServiceBase] entity vector recall SQL failed, fallback to keywords: ${e?.message ?? e}`);
      return [];
    });

    return rows.map((row) => {
      const metaData = EntityServiceBase._parse_meta_data(row.meta_data);
      const sourceType = metaData.source_type || row.entity_type || 'column_value';
      const columnName = metaData.column_name
        || (sourceType === 'column_name' ? row.name : '');
      const distance = Number(row.distance ?? 1);
      return {
        id: row.id,
        name: row.name,
        entity_name: row.name, // front-end compatibility field
        similarity: Math.max(0, 1.0 - distance),
        distance,
        meta_data: metaData,
        table_name: metaData.table_name || '',
        schema_name: metaData.schema_name || '',
        column_name: columnName,
        source_type: sourceType,
        rule: row.rule ?? null,
      };
    });
  }

  /**
   * Score entity hits by keyword and sort by pseudo similarity; take top `limit` and return structure consistent with legacy code.
   * @param {Array<object>} rows Joined rows from entity_mappings
   * @param {string} query_text
   * @param {number} limit
   * @returns {Array<object>}
   */
  static _keywordScoreEntities(rows, query_text, limit) {
    const tokens = tokenizeQuery(query_text);
    const norm = Math.max(1, Math.min(tokens.length, 5));

    const scored = rows.map((row) => {
      const metaData = EntityServiceBase._parse_meta_data(row.meta_data);

      // Resolve source_type: prefer meta_data, fallback to entity.entity_type
      const sourceType = metaData.source_type || row.entity_type || 'column_value';

      // Resolve column_name:
      // - column_name entity may be English column name or Chinese comment alias; derive from meta_data
      // - column_value entity: derive from meta_data
      const columnName = metaData.column_name
        || (sourceType === 'column_name' ? row.name : '');

      // Hit scoring: name + meta_data description / column_name / table_name
      const hits = countHits(row.name, tokens)
        + countHits(metaData.description, tokens)
        + countHits(metaData.column_name, tokens)
        + countHits(metaData.table_name, tokens);
      const similarity = tokens.length ? Math.min(1.0, hits / norm) : 0.5;

      return {
        id: row.id,
        name: row.name,
        entity_name: row.name, // front-end compatibility field
        similarity,
        meta_data: metaData,
        table_name: metaData.table_name || '',
        schema_name: metaData.schema_name || '',
        column_name: columnName,
        source_type: sourceType, // column_value or column_name data type
        rule: row.rule ?? null,
        _hits: hits,
      };
    });

    scored.sort((a, b) => (b.similarity - a.similarity));
    const limited = scored.slice(0, limit);
    for (const r of limited) delete r._hits;
    return limited;
  }

  // ==================== Batch embedding generation ====================

  /**
   * Build text for entity embedding: name plus meta_data description / column_name / table_name.
   * @param {object} row Entity row from entity_mappings (contains name / meta_data)
   * @returns {string}
   */
  static _entityEmbeddingText(row) {
    const meta = EntityServiceBase._parse_meta_data(row.meta_data);
    const parts = [
      row.name,
      meta.description,
      meta.column_name,
      meta.table_name,
    ].filter((s) => s != null && String(s).trim());
    return parts.join(' ').trim();
  }

  /**
   * Generate entity embeddings in batch (generic method).
   *
   * For entities under this source where embedding IS NULL, build batches of up to 16 texts, call embed(),
   * and UPDATE embedding/embedding_model/updated_at row by row.
   * If no embedding model / vector extension is unavailable / embed fails, keep graceful fallback (no throw),
   * and processed counts successfully written rows.
   *
   * @param {{query:Function, queryOne:Function, execute?:Function}} ctx Injected deps
   * @param {string} business_id
   * @param {string} source_id
   * @param {string} source_type
   * @param {string} project_id Used for embed
   * @param {number} [batch_size=100] max rows to fetch (actual embed batch size remains ≤16)
   * @returns {Promise<{total:number, processed:number}>}
   */
  static async _generate_embeddings_for_entities(
    ctx, business_id, source_id, source_type, project_id, batch_size = 100,
  ) {
    try {
      if (!vectorReady) {
        console.warn('[EntityServiceBase] vector extension is not ready, skipping entity embedding generation');
        return { total: 0, processed: 0 };
      }

      // Fetch entities pending embedding for this source (embedding IS NULL).
      const conditions = ['em.deleted_at IS NULL', 'em.embedding IS NULL'];
      const params = [];
      if (source_id) {
        params.push(source_id);
        conditions.push(`em.source_id = $${params.length}`);
      }
      if (source_type) {
        params.push(source_type);
        conditions.push(`em.source_type = $${params.length}`);
      }
      if (!source_id && business_id) {
        params.push(business_id);
        conditions.push(`em.business_id = $${params.length}`);
      }
      params.push(batch_size);
      const rows = await ctx.query(
        `SELECT em.id AS id, em.name AS name, em.meta_data AS meta_data
           FROM entity_mappings em
          WHERE ${conditions.join(' AND ')}
          LIMIT $${params.length}`,
        params,
      );

      const total = rows.length;
      if (!total) return { total: 0, processed: 0 };

      let processed = 0;
      const EMBED_BATCH = 16;
      for (let i = 0; i < rows.length; i += EMBED_BATCH) {
        const batch = rows.slice(i, i + EMBED_BATCH);
        const texts = batch.map((r) => EntityServiceBase._entityEmbeddingText(r));
        let vecs;
        try {
          vecs = await embed(texts, { project_id });
        } catch (e) {
          console.warn(`[EntityServiceBase] entity embed failed; fallback retained: ${e?.message ?? e}`);
          break; // No embedding model/invocation failure: stop this round; already written rows are not rolled back
        }
        if (!Array.isArray(vecs) || !vecs.length) break;

        for (let j = 0; j < batch.length; j += 1) {
          const vec = vecs[j];
          if (!Array.isArray(vec) || !vec.length) continue;
          await EntityServiceBase._updateEntityEmbedding(ctx, batch[j].id, vec);
          processed += 1;
        }
      }

      console.info(`[EntityServiceBase] entity embedding generation complete: total=${total}, processed=${processed}`);
      return { total, processed };
    } catch (e) {
      console.error(`Entity embedding generation failed: ${e?.message ?? e}`);
      return { total: 0, processed: 0 };
    }
  }

  /**
   * Write embedding for one entity (embedding/embedding_model/updated_at). Prefer ctx.execute, fallback to ctx.query.
   * @param {{query:Function, execute?:Function}} ctx
   * @param {string} id
   * @param {number[]} vec
   * @returns {Promise<void>}
   */
  static async _updateEntityEmbedding(ctx, id, vec) {
    const sql = 'UPDATE entity_mappings SET embedding = $1, embedding_model = $2, updated_at = now() WHERE id = $3';
    const sqlParams = [JSON.stringify(vec), EMBEDDING_MODEL, id];
    if (typeof ctx.execute === 'function') {
      await ctx.execute(sql, sqlParams);
    } else {
      await ctx.query(sql, sqlParams);
    }
  }
}

export default EntityServiceBase;
