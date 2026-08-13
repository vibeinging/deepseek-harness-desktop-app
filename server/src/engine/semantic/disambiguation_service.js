// Migrated from
// backend/agenticdata_kernel/semantic_catalogs/business/disambiguation_service.py.
//
// Disambiguation preference memory service.
//
// Maintains a per-business mapping of "user-selected literal -> true value" so align_value
// has long-term memory. It does not store embeddings or do similarity search. Lookup reads
// recent rows by (business, table, column) and leaves final text judgment to LLM.
//
// ============================ Desktop migration notes ============================
// DB access convention (consistent with migrated files): methods that need DB access
// receive a ctx/deps object as first parameter, in shape
// { query(sql, params)->Promise<rows>, queryOne(sql, params)->Promise<row|null> },
// injected by upper layer to align with Python db: AsyncSession location.
// This service does not connect directly to DB.
//
// Table: disambiguation_resolutions (from models.DisambiguationResolution.__tablename__).
// Columns: id / project_id / project_id / source_table / source_column /
//     normalized_keyword / chosen_value / chosen_value_meta / hit_count / last_used_at /
//     created_by / created_at / updated_at / deleted_at / deleted_by.
//
// Vastbase treats empty string as NULL, so use IS NOT NULL for empty checks and never use <> ''.
// All queries add deleted_at IS NULL for soft-delete filtering.
// partial unique (ux_disambig_res_active) = (project_id, source_table, source_column,
//   normalized_keyword, chosen_value) WHERE deleted_at IS NULL.
//
// Primary key id: desktop has no ORM default, so INSERT uses crypto.randomUUID() here
// (equivalent to Python uuid7 default). created_at/updated_at are explicitly set to now.
//
// embedding: this service does not use vectors and does not require fallback.
// fastapi_cache @cache -> migrated cache.js with withCache (120s).
// IntegrityError concurrency race -> if single-node pg throws unique-key conflict, same fallback
// branch is used; approximate detection uses error code/message containing
// 'unique'/'duplicate' (see _isUniqueViolation).
// ============================================================================

import { randomUUID } from 'crypto';

import { normalize_entity_key } from '../datasources/data_grep.js';
import { invalidate_cache, withCache, service_key_builder } from '../core/cache.js';
import { t } from '../utils/i18n.js';
import { ValidationError, NotFoundError } from '../core/exceptions.js';

const _LOOKUP_LIMIT_DEFAULT = 20;
const _CHOSEN_VALUE_MAX_LEN = 512;

// Time decay half-life in days: hit_count is roughly halved after 30 days.
// Balances historical team frequency and recent re-selections so old high-hit rows do not dominate forever.
const _DECAY_HALF_LIFE_DAYS = 30.0;

const _TABLE = 'disambiguation_resolutions';

/**
 * score = hit_count * exp(-Δdays / half_life)；hit_count<=0 视为 0 分。
 * @param {number} hit_count
 * @param {Date|string|null} last_used_at
 * @param {Date} now
 * @returns {number}
 */
function _decay_score(hit_count, last_used_at, now) {
  if (!hit_count || hit_count <= 0) return 0.0;
  if (last_used_at == null) return Number(hit_count);
  const last = last_used_at instanceof Date ? last_used_at : new Date(last_used_at);
  const delta_days = Math.max(0.0, (now.getTime() - last.getTime()) / 86400000.0);
  return hit_count * Math.exp(-delta_days / _DECAY_HALF_LIFE_DAYS);
}

// Session-level switch: "don't ask again in this session, auto-apply memory".
// After user checks it on chip, align_value memory hits short-circuit inside this session.
// If not checked, normal ask_user flow applies.
const _AUTO_APPLY_KEY_PREFIX = 'session_auto_apply_memory:';
const _AUTO_APPLY_TTL_SECONDS = 86400; // 24h, aligned with typical session lifetime

/**
 * Read session-level auto-apply flag. Returns false as safe fallback when Redis unavailable.
 * @param {string} session_id
 * @returns {Promise<boolean>}
 */
export async function is_session_auto_apply_memory(session_id) {
  if (!session_id) return false;
  try {
    const { get_cache_redis_client } = await import('../core/redis_manager.js');
    const client = await get_cache_redis_client();
    const value = await client.get(_AUTO_APPLY_KEY_PREFIX + session_id);
    return value === '1' || value === 1 || value === true;
  } catch (e) {
    console.warn(`[auto_apply_memory] Failed to read flag, treated as disabled: ${e}`);
    return false;
  }
}

/**
 * Write session-level auto-apply flag. Delete key directly when enabled is false.
 * @param {string} session_id
 * @param {boolean} enabled
 * @returns {Promise<void>}
 */
export async function set_session_auto_apply_memory(session_id, enabled) {
  if (!session_id) return;
  try {
    const { get_cache_redis_client } = await import('../core/redis_manager.js');
    const client = await get_cache_redis_client();
    const key = _AUTO_APPLY_KEY_PREFIX + session_id;
    if (enabled) {
      await client.set(key, '1', { ex: _AUTO_APPLY_TTL_SECONDS });
    } else {
      await client.delete(key);
    }
  } catch (e) {
    console.warn(`[auto_apply_memory] Failed to write flag: ${e}`);
  }
}

// Reuse the same normalization method as data_grep.
// If normalizations differ, align_value-recalled values and memory lookup keys can drift,
// causing duplicate memories for one entity or weird lookup misses.
export const normalize_keyword = normalize_entity_key;

/**
 * Fine-grain invalidation by tuple (project_id, source_table, source_column).
 * @param {string} project_id
 * @param {string} source_table
 * @param {string} source_column
 * @returns {Promise<void>}
 */
async function _invalidate_lookup_cache(project_id, source_table, source_column) {
  await invalidate_cache('lookup_by_keyword', {
    project_id,
    source_table,
    source_column,
  });
}

/**
 * Approximate unique-constraint conflict detection (maps to SQLAlchemy IntegrityError).
 * PostgreSQL unique constraint violation SQLSTATE is 23505; fallback checks message text for compatibility.
 * @param {any} e
 * @returns {boolean}
 */
function _isUniqueViolation(e) {
  if (!e) return false;
  if (e.code === '23505') return true;
  const msg = String(e.message || e).toLowerCase();
  return msg.includes('unique') || msg.includes('duplicate') || msg.includes('23505');
}

/** Convert value to ISO string, null-safe. */
function _iso(v) {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** lookup_by_keyword cache implementation core. */
async function _lookup_by_keyword_impl(ctx, project_id, source_table, source_column, keyword) {
  if (!(project_id && source_table && source_column && keyword)) return [];

  const normalized = normalize_keyword(keyword);
  if (!normalized) return [];

  const rows = await ctx.query(
    `SELECT id, normalized_keyword, chosen_value, hit_count, last_used_at, created_at, created_by
       FROM ${_TABLE}
      WHERE project_id = $1
        AND source_table = $2
        AND source_column = $3
        AND normalized_keyword = $4
        AND deleted_at IS NULL`,
    [project_id, source_table, source_column, normalized],
  );

  const now = new Date();
  // At most a few rows per keyword (partial unique by chosen_value), JS sort is fine.
  // Some PG-compatible versions do not support exp() in ORDER BY; calculate in app layer here.
  const rows_sorted = [...(rows || [])].sort((a, b) => {
    const sa = _decay_score(Number(a.hit_count || 0), a.last_used_at, now);
    const sb = _decay_score(Number(b.hit_count || 0), b.last_used_at, now);
    if (sa !== sb) return sb - sa;
    const ta = a.last_used_at ? new Date(a.last_used_at).getTime() : now.getTime();
    const tb = b.last_used_at ? new Date(b.last_used_at).getTime() : now.getTime();
    return tb - ta;
  });

  return rows_sorted.map((r) => ({
    id: r.id,
    normalized_keyword: r.normalized_keyword,
    chosen_value: r.chosen_value,
    hit_count: Number(r.hit_count || 0),
    last_used_at: _iso(r.last_used_at),
    created_at: _iso(r.created_at),
    created_by: r.created_by,
  }));
}

// @cache(expire=120, key_builder=service_key_builder) -> withCache (memory-based, 120s).
// Important: ctx is a per-request injected plain object and is not auto-excluded by
// service_key_builder. If included, cache misses always happen and invalidate matching gets polluted.
// So define a custom keyBuilder.
// Use named kwargs (project_id/source_table/source_column/keyword) to build key and skip ctx.
// Resulting key like 'lookup_by_keyword:project_id=..:keyword=..:source_column=..:source_table=..'
// aligns with invalidate_cache('lookup_by_keyword', {project_id, source_table, source_column})
// substring matching, equivalent to Python excluding AsyncSession.
const _LOOKUP_KEY_FN = Object.assign(function lookup_by_keyword() {}, {});

function _lookup_key_builder(_fn, _ns, { args = [] } = {}) {
  const [, project_id, source_table, source_column, keyword] = args;
  return service_key_builder(_LOOKUP_KEY_FN, '', {
    kwargs: { project_id, source_table, source_column, keyword },
  });
}

const _lookup_by_keyword_cached = withCache({ expire: 120, keyBuilder: _lookup_key_builder })(
  function lookup_by_keyword(ctx, project_id, source_table, source_column, keyword) {
    return _lookup_by_keyword_impl(ctx, project_id, source_table, source_column, keyword);
  },
);


export class DisambiguationService {
  /**
   * Fetch historical memory exactly by (business, table, column, normalize(keyword)).
   *
   * Returns only entries whose normalized_keyword equals the current keyword normalization.
 * Other keywords' history under the same table/column does not pollute candidates.
   *
   * Sorting uses app-side score = hit_count * exp(-Δdays / 30).
   * Fresh choices can outrank stale but high hit_count entries.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} project_id
   * @param {string} source_table
   * @param {string} source_column
   * @param {string} keyword
   * @returns {Promise<Array<object>>}
   */
  static async lookup_by_keyword(ctx, project_id, source_table, source_column, keyword) {
    return _lookup_by_keyword_cached(ctx, project_id, source_table, source_column, keyword);
  }

  /**
   * Write or upsert one disambiguation memory after ask_user response.
   *
   * - chosen_value must be in candidates (P0-10 anti prompt injection).
   * - Reject when too long (>512), no silent truncation.
   * - same (business, table, column, keyword, chosen_value) => hit_count++.
   * - same keyword with different chosen_value => insert a new row (accumulate, do not overwrite).
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @returns {Promise<string|null>} Inserted row id; returns null on validation/write failure.
   */
  static async record_resolution(
    ctx,
    {
      project_id,
      source_table,
      source_column,
      keyword,
      chosen_value,
      candidates = null,
      created_by = null,
    } = {},
  ) {
    if (!(project_id && source_table && source_column)) return null;

    const normalized = normalize_keyword(keyword);
    const chosen = (chosen_value || '').trim();
    if (!normalized || !chosen) return null;
    if (chosen.length > _CHOSEN_VALUE_MAX_LEN) {
      console.warn(`[DisambiguationService] chosen_value 超长 (${chosen.length})，拒绝写入`);
      return null;
    }

    if (candidates != null) {
      const candidate_values = new Set(
        (candidates || []).map((c) =>
          c && typeof c === 'object' && !Array.isArray(c) ? c.value : String(c),
        ),
      );
      if (!candidate_values.has(chosen)) {
        console.warn(
          `[DisambiguationService] record rejected: chosen_value ${JSON.stringify(chosen)} not in candidates`,
        );
        return null;
      }
    }

    let meta = null;
    if (candidates) {
      for (const c of candidates) {
        if (c && typeof c === 'object' && !Array.isArray(c) && c.value === chosen) {
          try {
            meta = JSON.stringify(c);
          } catch (_) {
            meta = null;
          }
          break;
        }
      }
    }

    const now = new Date();
    // App-layer upsert. Some PG-compatible variants (including local compatible engines)
    // do not support `ON CONFLICT ... WHERE` partial index upsert, so use
    // SELECT-then-INSERT/UPDATE with unique-conflict concurrency fallback.
    const row_id = await DisambiguationService._upsert_active_row(ctx, {
      project_id,
      source_table,
      source_column,
      normalized,
      chosen,
      meta,
      created_by,
      now,
    });
    if (row_id == null) return null;

    await _invalidate_lookup_cache(project_id, source_table, source_column);
    return row_id;
  }

  /**
   * SELECT-then-INSERT/UPDATE upsert; update when partial unique key matches.
   *
   * same (business, table, column, keyword, chosen_value) => hit_count++.
   * same keyword with different chosen_value => insert new row (accumulate multiple history choices).
   * Concurrency: two processes INSERT at same time => unique conflict => fallback SELECT + UPDATE.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @returns {Promise<string|null>}
   */
  static async _upsert_active_row(
    ctx,
    { project_id, source_table, source_column, normalized, chosen, meta, created_by, now },
  ) {
    const selectExisting = () =>
      ctx.queryOne(
        `SELECT id, hit_count
           FROM ${_TABLE}
          WHERE project_id = $1
            AND source_table = $2
            AND source_column = $3
            AND normalized_keyword = $4
            AND chosen_value = $5
            AND deleted_at IS NULL`,
        [project_id, source_table, source_column, normalized, chosen],
      );

    const doUpdate = async (existing) => {
      await ctx.query(
        `UPDATE ${_TABLE}
            SET chosen_value_meta = $1,
                hit_count = COALESCE(hit_count, 0) + 1,
                last_used_at = $2,
                updated_at = $2
          WHERE id = $3`,
        [meta, now, existing.id],
      );
      return existing.id;
    };

    let existing = await selectExisting();
    if (existing != null) {
      try {
        return await doUpdate(existing);
      } catch (e) {
        console.error(`[DisambiguationService] update failed: ${e}`, e);
        return null;
      }
    }

    // Insert new row; desktop manually generates UUID pk to match Python uuid7 default.
    const newId = randomUUID();
    try {
      await ctx.query(
        `INSERT INTO ${_TABLE}
           (id, project_id, source_table, source_column,
            normalized_keyword, chosen_value, chosen_value_meta, hit_count,
            last_used_at, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $8, $8)`,
        [
          newId,
          project_id,
          source_table,
          source_column,
          normalized,
          chosen,
          meta,
          now,
          created_by,
        ],
      );
      return newId;
    } catch (e) {
      if (_isUniqueViolation(e)) {
        // 并发 race：另一个进程刚 insert 了同唯一键 → 回退 UPDATE。
        existing = await selectExisting();
        if (existing == null) {
          console.error(
            '[DisambiguationService] unique conflict but existing row not found; ' +
              'possibly field conflict beyond partial unique constraint',
          );
          return null;
        }
        try {
          return await doUpdate(existing);
        } catch (e2) {
          console.error(`[DisambiguationService] race fallback update failed: ${e2}`, e2);
          return null;
        }
      }
      console.error(`[DisambiguationService] insert failed: ${e}`, e);
      return null;
    }
  }

  /**
   * Hit recognition: batch hit++ for multiple (table, column, chosen_value) rows in one SQL.
   *
   * Same as record_resolution: service-level submit + exact invalidation.
   * Returns number of rows updated.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @param {string} opts.project_id
   * @param {Array<{table:string, column:string, value:string}>} opts.hits
   * @returns {Promise<number>}
   */
  static async update_hit_on_reuse(ctx, { project_id, hits } = {}) {
    if (!project_id || !hits || !hits.length) return 0;

    const keys = hits
      .filter((h) => h && h.table && h.column && h.value)
      .map((h) => [h.table, h.column, h.value]);
    if (!keys.length) return 0;

    const now = new Date();
    // tuple IN -> expand parameterized "(col1,col2,col3) IN (VALUES ...)".
    const valueTuples = [];
    const params = [project_id];
    let p = params.length;
    for (const [tbl, col, val] of keys) {
      valueTuples.push(`($${p + 1}, $${p + 2}, $${p + 3})`);
      params.push(tbl, col, val);
      p += 3;
    }

    let rows;
    try {
      rows = await ctx.query(
        `UPDATE ${_TABLE}
            SET hit_count = hit_count + 1,
                last_used_at = $${params.length + 1},
                updated_at = $${params.length + 1}
          WHERE project_id = $1
            AND deleted_at IS NULL
            AND (source_table, source_column, chosen_value) IN (${valueTuples.join(', ')})
        RETURNING source_table, source_column`,
        [...params, now],
      );
    } catch (e) {
      console.warn(`[DisambiguationService] update_hit_on_reuse failed (ignored): ${e}`);
      return 0;
    }

    rows = rows || [];
    const seen = new Set();
    for (const r of rows) {
      const k = `${r.source_table} ${r.source_column}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await _invalidate_lookup_cache(project_id, r.source_table, r.source_column);
    }
    return rows.length;
  }

  /**
   * Admin UI list query: all undeleted memories under project, sorted by last_used_at DESC.
   *
   * LEFT JOIN users resolves created_by into display name (full_name first, username fallback).
   * search matches any of keyword/chosen_value/source_table/source_column using ILIKE.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} project_id
   * @param {{limit?:number, offset?:number, search?:string|null}} [opts]
   * @returns {Promise<{items:Array<object>, total:number}>}
   */
  static async list_resolutions(ctx, project_id, { limit = 200, offset = 0, search = null } = {}) {
    if (!project_id) return { items: [], total: 0 };

    limit = Math.max(1, Math.min(Number(limit || 200), 1000));
    offset = Math.max(0, Number(offset || 0));

    const filters = ['d.project_id = $1', 'd.deleted_at IS NULL'];
    const params = [project_id];
    if (search && String(search).trim()) {
      const kw = `%${String(search).trim()}%`;
      params.push(kw);
      const i = params.length;
      filters.push(
        `(d.normalized_keyword ILIKE $${i} OR d.chosen_value ILIKE $${i} ` +
          `OR d.source_table ILIKE $${i} OR d.source_column ILIKE $${i})`,
      );
    }
    const whereClause = filters.join(' AND ');

    const countRow = await ctx.queryOne(
      `SELECT COUNT(*) AS cnt FROM ${_TABLE} d WHERE ${whereClause}`,
      params,
    );
    const total = Number(countRow?.cnt || 0);

    const rows = await ctx.query(
      `SELECT d.id, d.project_id, d.project_id, d.source_table, d.source_column,
              d.normalized_keyword, d.chosen_value, d.hit_count, d.last_used_at,
              d.created_at, d.created_by,
              u.username AS username, u.full_name AS full_name
         FROM ${_TABLE} d
         LEFT JOIN users u ON u.id = d.created_by AND u.deleted_at IS NULL
        WHERE ${whereClause}
        ORDER BY d.last_used_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );

    const items = (rows || []).map((r) => ({
      id: r.id,
      project_id: r.project_id,
      project_id: r.project_id,
      source_table: r.source_table,
      source_column: r.source_column,
      normalized_keyword: r.normalized_keyword,
      chosen_value: r.chosen_value,
      hit_count: Number(r.hit_count || 0),
      last_used_at: _iso(r.last_used_at),
      created_at: _iso(r.created_at),
      created_by: r.created_by,
      created_by_name: r.full_name || r.username || null,
    }));
    return { items, total: Number(total) };
  }

  /**
   * Bulk import disambiguation memories from Excel.
   *
   * Desktop has no pandas/xlsx parse dependency. This method accepts a row array `rows`
   * already parsed by caller (each row with source_table/source_column/keyword/chosen_value),
   * and uses it first. If rows is missing but file_bytes exists, throw with instruction that
   * upper layer should parse Excel first (TODO(excel)).
   * Each row is upserted independently (same unique key => update chosen_value + hit++).
   * No candidates validation is performed (manual input from business is trusted). Failed rows
   * are collected into errors.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @param {string} opts.project_id
   * @param {string} opts.project_id
   * @param {Array<object>} [opts.rows] - 已解析的 Excel 行（推荐）
   * @param {Buffer|Uint8Array} [opts.file_bytes] - 原始 Excel 字节（桌面版需上层先解析）
   * @param {string|null} [opts.created_by]
   * @param {boolean} [opts.overwrite=true]
   * @returns {Promise<object>}
   */
  static async bulk_import_from_excel(
    ctx,
    { project_id, rows = null, file_bytes = null, created_by = null, overwrite = true } = {},
  ) {
    if (!project_id) {
      throw new ValidationError(t('缺少 project_id'));
    }

    if (rows == null) {
      if (file_bytes != null) {
        // TODO(excel): Desktop Node has no xlsx parser dependency; upper layer should
        // parse Excel into rows and pass them.
        throw new ValidationError(
          t('Excel 解析失败: {}', '桌面版需由上层解析 Excel 后传入 rows 数组'),
        );
      }
      rows = [];
    }
    if (!Array.isArray(rows)) {
      throw new ValidationError(t('Excel 解析失败: {}', 'rows 必须是行数组'));
    }

    const required = ['source_table', 'source_column', 'keyword', 'chosen_value'];
    // Validate header row (if any) contains required columns; skip schema check on empty table.
    if (rows.length) {
      const first = rows[0] || {};
      const missing = required.filter((c) => !(c in first));
      if (missing.length) {
        throw new ValidationError(
          t('Excel 缺少必需列: {}', missing.join(', ')) +
            t('（必需列: source_table / source_column / keyword / chosen_value）'),
        );
      }
    }

    let success_count = 0;
    let updated_count = 0;
    let skipped_count = 0;
    /** @type {Array<{row:number, error:string}>} */
    const error_rows = [];
    /** @type {Set<string>} */
    const affected_invalidations = new Set();

    const _cell = (value) => {
      if (value == null || (typeof value === 'number' && Number.isNaN(value))) return '';
      return String(value).trim();
    };

    for (let idx = 0; idx < rows.length; idx++) {
      const row = rows[idx] || {};
      const row_num = idx + 2; // Excel is 1-based and header row is skipped.
      try {
        const src_table = _cell(row.source_table);
        const src_column = _cell(row.source_column);
        const keyword = _cell(row.keyword);
        const chosen = _cell(row.chosen_value);

        if (!(src_table && src_column && keyword && chosen)) {
          error_rows.push({ row: row_num, error: '四个字段都必须非空' });
          continue;
        }
        if (chosen.length > _CHOSEN_VALUE_MAX_LEN) {
          error_rows.push({
            row: row_num,
            error: `chosen_value 超长（${chosen.length} > ${_CHOSEN_VALUE_MAX_LEN}）`,
          });
          continue;
        }

        const normalized = normalize_keyword(keyword);
        if (!normalized) {
          error_rows.push({ row: row_num, error: 'keyword 规范化后为空' });
          continue;
        }

        // Check if record exists (for distinguishing new insert vs overwrite stats / skip when overwrite=false).
        const existing = await ctx.queryOne(
          `SELECT id FROM ${_TABLE}
            WHERE project_id = $1
              AND source_table = $2
              AND source_column = $3
              AND normalized_keyword = $4
              AND deleted_at IS NULL`,
          [project_id, src_table, src_column, normalized],
        );

        if (existing && !overwrite) {
          skipped_count += 1;
          continue;
        }

        const row_id = await DisambiguationService._upsert_active_row(ctx, {
          project_id,
          source_table: src_table,
          source_column: src_column,
          normalized,
          chosen,
          meta: null,
          created_by,
          now: new Date(),
        });

        if (row_id == null) {
          error_rows.push({ row: row_num, error: '数据库写入失败' });
          continue;
        }
        if (existing) updated_count += 1;
        else success_count += 1;
        affected_invalidations.add(`${src_table} ${src_column}`);
      } catch (e) {
        error_rows.push({ row: row_num, error: String(e?.message || e) });
      }
    }

    // Bulk exact cache invalidation, once per (table, column).
    for (const tc of affected_invalidations) {
      const [tbl, col] = tc.split(' ');
      await _invalidate_lookup_cache(project_id, tbl, col);
    }

    return {
      total: rows.length,
      success_count,
      updated_count,
      skipped_count,
      error_count: error_rows.length,
      errors: error_rows,
      message: t(
        '导入完成：新增 {}，覆盖 {}，跳过 {}，失败 {}',
        success_count,
        updated_count,
        skipped_count,
        error_rows.length,
      ),
    };
  }

  /**
   * Soft-delete one memory. Atomic UPDATE to avoid TOCTOU.
   * Front-end "cancel reselect" also uses this endpoint; no separate dispute path.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {string} resolution_id
   * @param {{deleted_by?:string|null}} [opts]
   * @returns {Promise<boolean>}
   */
  static async delete_resolution(ctx, resolution_id, { deleted_by = null } = {}) {
    if (!resolution_id) return false;

    const now = new Date();
    const row = await ctx.queryOne(
      `UPDATE ${_TABLE}
          SET deleted_at = $1, deleted_by = $2, updated_at = $1
        WHERE id = $3 AND deleted_at IS NULL
      RETURNING project_id, source_table, source_column`,
      [now, deleted_by, resolution_id],
    );
    if (!row) return false;

    await _invalidate_lookup_cache(row.project_id, row.source_table, row.source_column);
    return true;
  }

  /**
   * Batch soft-delete. Returns actual count deleted.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @param {string[]} opts.ids
   * @param {string} opts.project_id
   * @param {string|null} [opts.deleted_by]
   * @returns {Promise<number>}
   */
  static async bulk_delete_resolutions(ctx, { ids, project_id, deleted_by = null } = {}) {
    if (!ids || !ids.length || !project_id) return 0;

    const now = new Date();
    const rows = await ctx.query(
      `UPDATE ${_TABLE}
          SET deleted_at = $1, deleted_by = $2, updated_at = $1
        WHERE id::text = ANY($3::text[])
          AND project_id = $4
          AND deleted_at IS NULL
      RETURNING source_table, source_column`,
      [now, deleted_by, ids, project_id],
    );

    const list = rows || [];
    const seen = new Set();
    for (const r of list) {
      const k = `${r.source_table} ${r.source_column}`;
      if (seen.has(k)) continue;
      seen.add(k);
      await _invalidate_lookup_cache(project_id, r.source_table, r.source_column);
    }
    return list.length;
  }

  /**
   * Manually create one memory (for admin UI). No candidates validation; manual business input is trusted.
   * If same unique key exists, perform upsert (hit++ + update chosen_value), same as Excel import.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @returns {Promise<string|null>}
   */
  static async create_manual(
    ctx,
    { project_id, source_table, source_column, keyword, chosen_value, created_by = null } = {},
  ) {
    if (!(project_id && source_table && source_column)) {
      throw new ValidationError(t('project_id / source_table / source_column 必填'));
    }

    const normalized = normalize_keyword(keyword);
    const chosen = (chosen_value || '').trim();
    if (!normalized) throw new ValidationError(t('keyword 规范化后为空'));
    if (!chosen) throw new ValidationError(t('chosen_value 不能为空'));
    if (chosen.length > _CHOSEN_VALUE_MAX_LEN) {
      throw new ValidationError(t('chosen_value 超长（{} > {}）', chosen.length, _CHOSEN_VALUE_MAX_LEN));
    }

    const st = source_table.trim();
    const sc = source_column.trim();
    const row_id = await DisambiguationService._upsert_active_row(ctx, {
      project_id,
      source_table: st,
      source_column: sc,
      normalized,
      chosen,
      meta: null,
      created_by,
      now: new Date(),
    });
    if (row_id != null) {
      await _invalidate_lookup_cache(project_id, st, sc);
    }
    return row_id;
  }

  /**
   * Update one memory. Supports changing any of chosen_value / source_table / source_column / keyword.
   * If updated keyword/table/column conflicts with other memories (partial unique hit), throw ValidationError.
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {object} opts
   * @returns {Promise<boolean>}
   */
  static async update_resolution(
    ctx,
    {
      resolution_id,
      project_id,
      chosen_value = null,
      source_table = null,
      source_column = null,
      keyword = null,
    } = {},
  ) {
    const existing = await ctx.queryOne(
      `SELECT id, source_table, source_column, normalized_keyword, chosen_value
         FROM ${_TABLE}
        WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
      [resolution_id, project_id],
    );
    if (!existing) throw new NotFoundError(t('记忆不存在或已被删除'));

    const old_table = existing.source_table;
    const old_column = existing.source_column;
    const now = new Date();
    let changed = false;

    // Build field list for UPDATE.
    const sets = [];
    const params = [];
    const next = { source_table: old_table, source_column: old_column };

    if (chosen_value != null) {
      const chosen = String(chosen_value).trim();
      if (!chosen) throw new ValidationError(t('chosen_value 不能为空'));
      if (chosen.length > _CHOSEN_VALUE_MAX_LEN) {
        throw new ValidationError(t('chosen_value 超长（{} > {}）', chosen.length, _CHOSEN_VALUE_MAX_LEN));
      }
      params.push(chosen);
      sets.push(`chosen_value = $${params.length}`);
      params.push(null);
      sets.push(`chosen_value_meta = $${params.length}`);
      changed = true;
    }

    if (source_table != null) {
      const st = String(source_table).trim();
      params.push(st);
      sets.push(`source_table = $${params.length}`);
      next.source_table = st;
      changed = true;
    }
    if (source_column != null) {
      const sc = String(source_column).trim();
      params.push(sc);
      sets.push(`source_column = $${params.length}`);
      next.source_column = sc;
      changed = true;
    }
    if (keyword != null) {
      const normalized = normalize_keyword(keyword);
      if (!normalized) throw new ValidationError(t('keyword 规范化后为空'));
      params.push(normalized);
      sets.push(`normalized_keyword = $${params.length}`);
      changed = true;
    }

    if (!changed) return false;

    params.push(now);
    sets.push(`updated_at = $${params.length}`);
    params.push(resolution_id);

    try {
      await ctx.query(`UPDATE ${_TABLE} SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
    } catch (e) {
      if (_isUniqueViolation(e)) {
        throw new ValidationError(t('更新后的 (table, column, keyword) 与已有记忆冲突'));
      }
      throw e;
    }

    // Both old and new (table, column) require cache invalidation.
    await _invalidate_lookup_cache(project_id, old_table, old_column);
    if (next.source_table !== old_table || next.source_column !== old_column) {
      await _invalidate_lookup_cache(project_id, next.source_table, next.source_column);
    }
    return true;
  }
}

export default DisambiguationService;
