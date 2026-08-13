// 迁移自 dsh_kernel/data_sources/datasource/data_grep.py
//
// Schema 探索器
// 提供统一的 Schema 探索功能,支持多种召回策略。
//
// 功能:
// - grep_tables(): 搜索/列出表;数据库数据源当前走 LIKE,中间数据源走 profile()
// - grep_columns(): 搜索/列出列
// - grep_entities(): 实体对齐(向量(vexdb,经 EntityServiceBase)+ LIKE 双路 + 缓存/single-flight)
//
// 注:grep_entities 向量路已接通(经 EntityServiceBase.search_similar_entities,内部 vexdb_cosine_distance,
// 无 embedding/扩展时自动退化关键词);grep_tables/grep_columns 仍有单独的上层接入缺口,
// 集中记录在 docs/analysis/2026-08-04_known-feature-gaps.md。

import { Profile } from './profile.js';
import { DatabaseDataSource } from './database_data_source.js';
import { IntermediateDataSource } from './intermediate_data_source.js';
import { query, queryOne } from '../../db.js';
import { EntityServiceBase } from '../semantic/entity_service_base.js';

// grep_entities (align_value) 进程内 TTL 缓存 + per-key single-flight。
// 与 Python 一致:TTL 内复用结果;同 key 并发 miss 只让第一个真正干活,后来者 await 同一 Promise。
const _GREP_ENTITIES_CACHE_TTL = 300_000; // 5 分钟(ms)
/** @type {Map<string, {ts:number, value:Array<object>}>} */
const _grep_entities_cache = new Map();
/** @type {Map<string, Promise<Array<object>>>} */
const _grep_entities_inflight = new Map();

/**
 * 归一化字面量:NFKC 全/半角统一 + trim + lowercase(对应 normalize_entity_key)。
 * JS 无 casefold,用 toLowerCase 近似(NFKC 已统一大部分全角)。
 * @param {any} v
 * @returns {string}
 */
export function normalize_entity_key(v) {
  return String(v ?? '').normalize('NFKC').trim().toLowerCase();
}

/** 构造 grep_entities 缓存 key(对应 _make_grep_entities_cache_key) */
function _make_grep_entities_cache_key(business_id, database_name, table_name, column_name, keyword, limit, similarity_threshold) {
  return [
    business_id || '',
    database_name || '',
    table_name || '',
    column_name || '',
    normalize_entity_key(keyword),
    String(limit),
    String(similarity_threshold),
  ].join('');
}

/**
 * 主动失效缓存(对应 invalidate_grep_entities_cache)。
 * @param {string|null} [business_id=null]
 * @returns {number} 清掉的条目数
 */
export function invalidate_grep_entities_cache(business_id = null) {
  if (business_id == null) {
    const n = _grep_entities_cache.size;
    _grep_entities_cache.clear();
    return n;
  }
  const prefix = `${business_id}`;
  let n = 0;
  for (const k of [..._grep_entities_cache.keys()]) {
    if (k.startsWith(prefix)) { _grep_entities_cache.delete(k); n += 1; }
  }
  return n;
}

export class DataGrep {
  /**
   * @param {import('./business_data_sources.js').BusinessDataSources} data_sources_container
   */
  constructor(data_sources_container) {
    this._container = data_sources_container;
  }

  get business_id() { return this._container.business_id; }

  get project_id() { return this._container.project_id; }

  /** @returns {Map<string, any>} */
  get data_sources() { return this._container.data_sources; }

  // ==================== 核心方法 ====================

  /**
   * 搜索/列出表(对应 grep_tables)。
   * @param {object} [opts]
   * @param {string|null} [opts.query=null]
   * @param {string|null} [opts.database_name=null]
   * @param {number} [opts.limit=50]
   * @param {number} [opts.offset=0]
   * @param {number} [opts.similarity_threshold=0.3]
   * @returns {Promise<Array<Profile>>}
   */
  async grep_tables({ query: queryStr = null, database_name = null, limit = 50, offset = 0, similarity_threshold = 0.3 } = {}) {
    const resolvedDbName = await this._resolve_datasource_name(database_name);

    if (queryStr) {
      return this._dual_recall_tables({ query: queryStr, database_name: resolvedDbName, limit, similarity_threshold });
    }
    // 分页列出
    let allProfiles = await this._container.get_all_profiles();
    if (resolvedDbName) allProfiles = allProfiles.filter((p) => p.database === resolvedDbName);
    return allProfiles.slice(offset, offset + limit);
  }

  /**
   * 获取/搜索表的列信息(对应 grep_columns)。
   * @param {object} opts
   * @param {string} opts.table_name
   * @param {string|null} [opts.query=null]
   * @param {string|null} [opts.database_name=null]
   * @param {number} [opts.limit=50]
   * @returns {Promise<Profile|null>}
   */
  async grep_columns({ table_name, query: queryStr = null, database_name = null, limit = 50 } = {}) {
    const resolvedDbName = await this._resolve_datasource_name(database_name);
    const allProfiles = await this._container.get_all_profiles();

    let schemaPart = null;
    let tablePart = null;
    if (table_name.includes('.')) {
      const idx = table_name.indexOf('.');
      schemaPart = table_name.slice(0, idx);
      tablePart = table_name.slice(idx + 1);
    }

    for (const p of allProfiles) {
      if (schemaPart && tablePart) {
        if (!(p.name === tablePart && p.schema_name === schemaPart)) continue;
      } else if (p.name !== table_name) {
        continue;
      }
      if (resolvedDbName && p.database !== resolvedDbName) continue;

      if (queryStr) {
        const qLower = queryStr.toLowerCase();
        const filteredColumns = p.columns.filter((col) => {
          const colName = col.name.toLowerCase();
          const colDesc = (col.description || '').toLowerCase();
          return colName.includes(qLower) || colDesc.includes(qLower);
        });
        return new Profile(
          p.database, p.name, p.description, p.size,
          filteredColumns.slice(0, limit), p.sample_rows, p.listable,
          { data_source_type: p.datasource_type, schema_name: p.schema_name },
        );
      }
      return p;
    }
    return null;
  }

  /**
   * 实体对齐对外入口:含 TTL cache + per-key single-flight + 跨租户隔离(对应 grep_entities)。
   * @param {object} opts
   * @param {string} opts.table_name
   * @param {string} opts.column_name
   * @param {string} opts.keyword
   * @param {string|null} [opts.database_name=null]
   * @param {number} [opts.limit=20]
   * @param {number} [opts.similarity_threshold=0.35]
   * @returns {Promise<Array<object>>}
   */
  async grep_entities({ table_name, column_name, keyword, database_name = null, limit = 20, similarity_threshold = 0.35 } = {}) {
    const kw = (keyword || '').trim();
    if (!kw) return [];
    const resolvedDbName = await this._resolve_datasource_name(database_name);

    const useCache = Boolean(this.business_id);
    if (!useCache) {
      return this._grep_entities_compute(table_name, column_name, kw, resolvedDbName, limit, similarity_threshold);
    }

    const cacheKey = _make_grep_entities_cache_key(
      this.business_id, resolvedDbName, table_name, column_name, kw, limit, similarity_threshold,
    );

    // 1) cache hit
    const cached = _grep_entities_cache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < _GREP_ENTITIES_CACHE_TTL) {
      return [...cached.value];
    }

    // 2) single-flight
    const existing = _grep_entities_inflight.get(cacheKey);
    if (existing) {
      try {
        return [...(await existing)];
      } catch (_) {
        // 第一个失败,自己重跑
      }
    }

    // 3) 自己干活
    const promise = (async () => {
      const final = await this._grep_entities_compute(
        table_name, column_name, kw, resolvedDbName, limit, similarity_threshold,
      );
      _grep_entities_cache.set(cacheKey, { ts: Date.now(), value: [...final] });
      return final;
    })();
    _grep_entities_inflight.set(cacheKey, promise);
    try {
      return await promise;
    } finally {
      _grep_entities_inflight.delete(cacheKey);
    }
  }

  /**
   * 实际查询逻辑:向量召回(vexdb,经 EntityServiceBase)+ LIKE 召回 双路。纯函数语义,对应 _grep_entities_compute。
   * @returns {Promise<Array<object>>}
   */
  async _grep_entities_compute(table_name, column_name, keyword, database_name, limit, similarity_threshold) {
    let schemaPart = null;
    let tablePart = table_name;
    if (table_name.includes('.')) {
      const idx = table_name.indexOf('.');
      schemaPart = table_name.slice(0, idx);
      tablePart = table_name.slice(idx + 1);
    }

    // 匹配的数据库数据源(支持多源)
    const dbSources = [];
    for (const source of this.data_sources.values()) {
      if (source instanceof DatabaseDataSource) {
        if (database_name) {
          if (source.datasource_name === database_name) { dbSources.push(source); break; }
        } else {
          dbSources.push(source);
        }
      }
    }
    if (!dbSources.length) {
      console.warn('[DataGrep] grep_entities: 未找到数据库数据源');
      return [];
    }

    const results = [];
    const seenKeys = new Set();
    const PREFIX_LEN_DIFF = 4;

    const likeScore = (val, kw2) => {
      const vNorm = normalize_entity_key(val);
      const kNorm = normalize_entity_key(kw2);
      if (vNorm === kNorm) return 1.0;
      if (vNorm.startsWith(kNorm) && (vNorm.length - kNorm.length) <= PREFIX_LEN_DIFF) return 0.9;
      if (kNorm.startsWith(vNorm) && (kNorm.length - vNorm.length) <= PREFIX_LEN_DIFF) return 0.9;
      return 0.7;
    };

    // 1. 向量召回(从实体词典 entity_mappings,遍历所有匹配的数据源)。
    //    先按 (source_id, table, column[, schema]) 定位 entity_mapping_configs,
    //    再用 EntityServiceBase.search_similar_entities 在这些 config 下做向量(vexdb)召回;
    //    无 embedding/扩展时该函数内部自动退化为关键词兜底,similarity_threshold 在此过滤。
    try {
      const ctx = { query, queryOne };
      for (const ds of dbSources) {
        // entity_mapping_configs.source_id 存的是 connection_id(见 entity_service 配置写入/查询)。
        // 注:桌面端 ds.id = source_id(业务绑定关系 id)|| connection_id,绑定后即业务关系 id,
        //     不能直接用;实体配置按连接维度组织,故用 ds.connection_id。
        const condSql = ['source_id = $1', "source_type = 'database'", 'table_name = $2', 'column_name = $3', 'is_active = 1', 'deleted_at IS NULL'];
        const condParams = [ds.connection_id, tablePart, column_name];
        if (schemaPart && schemaPart !== 'default') {
          condParams.push(schemaPart);
          condSql.push(`schema_name = $${condParams.length}`);
        } else {
          condSql.push('schema_name IS NULL');
        }
        const cfgRows = await query(
          `SELECT id FROM entity_mapping_configs WHERE ${condSql.join(' AND ')}`, condParams,
        ).catch(() => []);
        const configIds = cfgRows.map((r) => r.id);
        if (!configIds.length) continue;

        const entities = await EntityServiceBase.search_similar_entities(
          ctx, null, keyword, this.project_id, { config_ids: configIds, limit },
        );
        for (const ent of entities) {
          const val = ent.entity_name ?? ent.name;
          const sim = ent.similarity ?? 0;
          if (!val || sim < similarity_threshold) continue;
          const key = normalize_entity_key(val);
          if (seenKeys.has(key)) continue;
          const item = { value: val, similarity: Math.round(sim * 1000) / 1000, source: 'vector' };
          if (ent.rule) item.rule = ent.rule;
          if (ent.meta_data && Object.keys(ent.meta_data).length) item.meta_data = ent.meta_data;
          results.push(item);
          seenKeys.add(key);
        }
      }
    } catch (e) {
      console.warn(`[DataGrep] 向量召回实体失败: ${e?.message ?? e}`);
    }

    // 2. LIKE 查询(遍历所有匹配的数据源)
    for (const ds of dbSources) {
      try {
        const likeValues = await ds.query_distinct_values(tablePart, column_name, {
          keyword, limit, schema_name: schemaPart,
        });
        for (const val of likeValues) {
          if (val == null) continue;
          const key = normalize_entity_key(val);
          if (seenKeys.has(key)) continue;
          const score = likeScore(val, keyword);
          let source;
          if (score >= 1.0) source = 'like_exact';
          else if (score >= 0.9) source = 'like_prefix';
          else source = 'like_contains';
          results.push({ value: val, similarity: score, source });
          seenKeys.add(key);
        }
      } catch (e) {
        console.warn(`[DataGrep] LIKE 查询实体失败(${ds.datasource_name}): ${e?.message ?? e}`);
      }
    }

    // 统一排序:similarity 降序,tiebreaker value 字典序
    results.sort((a, b) => {
      const sa = a.similarity || 0;
      const sb = b.similarity || 0;
      if (sb !== sa) return sb - sa;
      return String(a.value ?? '').localeCompare(String(b.value ?? ''));
    });

    return results.slice(0, limit);
  }

  // ==================== 辅助方法 ====================

  /**
   * 解析 datasource_name:不匹配数据源时当作表名查找,返回包含该表的数据源名(兜底)。
   * 对应 _resolve_datasource_name。
   * @param {string|null} database_name
   * @returns {Promise<string|null>}
   */
  async _resolve_datasource_name(database_name) {
    if (!database_name) return null;

    // 1. 精确匹配数据源名称
    for (const ds of this.data_sources.values()) {
      if (ds.datasource_name === database_name) return database_name;
    }

    // 2. 当作表名查找
    console.warn(`[DataGrep] datasource_name='${database_name}' 未匹配到数据源，尝试按表名查找`);
    const allProfiles = await this._container.get_all_profiles();
    for (const p of allProfiles) {
      if (p.name === database_name) {
        console.info(`[DataGrep] 将表名 '${database_name}' 修正为数据源 '${p.database}'`);
        return p.database;
      }
    }

    // 3. 原样返回
    console.warn(`[DataGrep] '${database_name}' 既不是数据源名也不是表名，原样传递`);
    return database_name;
  }

  // ==================== 内部方法 ====================

  /**
   * 合并召回表：中间数据源 profile + 数据库 LIKE；数据库向量路径见方法内待办。
   * 对应 _dual_recall_tables。
   * @returns {Promise<Array<Profile>>}
   */
  async _dual_recall_tables({ query: queryStr, database_name = null, limit = 50, similarity_threshold = 0.3 } = {}) {
    /** @type {Map<string, Profile>} */
    const seenTables = new Map();

    const keyOf = (p) => {
      const schemaPart = (p.schema_name && p.schema_name !== 'default') ? `${p.schema_name}.` : '';
      return `${p.database}:${schemaPart}${p.name}`;
    };

    // 1. 中间数据源直接使用 profile()；数据库数据源的向量接入见下方待办。
    for (const ds of this.data_sources.values()) {
      if (database_name && ds.datasource_name !== database_name) continue;

      if (ds instanceof IntermediateDataSource) {
        try {
          const profiles = await ds.profile(queryStr);
          for (const p of profiles) {
            const key = keyOf(p);
            if (!seenTables.has(key)) seenTables.set(key, p);
          }
        } catch (e) {
          console.warn(`[DataGrep] 召回中间表失败 ${ds.id}: ${e?.message ?? e}`);
        }
      }
      // TODO: DatabaseDataSource 向量召回(SchemaRetrievalService.search_relevant_tables_with_columns)
      //       依赖 embedding,数据访问层不实现;由下方 LIKE 路覆盖。
    }

    // 2. LIKE 匹配(数据库数据源)
    try {
      const likeProfiles = await this._like_grep_tables({ pattern: queryStr, database_name, limit });
      for (const p of likeProfiles) {
        const key = keyOf(p);
        if (!seenTables.has(key)) seenTables.set(key, p);
      }
    } catch (e) {
      console.warn(`[DataGrep] LIKE 匹配表失败: ${e?.message ?? e}`);
    }

    const resultsArr = [...seenTables.values()];
    resultsArr.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    return resultsArr.slice(0, limit);
  }

  /**
   * LIKE 模糊匹配表(读 PG table_metadata + column_metadata 计列数)。
   * 对应 _like_grep_tables。
   * @returns {Promise<Array<Profile>>}
   */
  async _like_grep_tables({ pattern, database_name = null, limit = 50 } = {}) {
    const profiles = [];

    for (const ds of this.data_sources.values()) {
      if (!(ds instanceof DatabaseDataSource)) continue;
      if (database_name && ds.datasource_name !== database_name) continue;

      try {
        const likePattern = `%${pattern}%`;
        const tables = await query(
          `SELECT id, table_name, schema_name, description, row_count
             FROM table_metadata
            WHERE database_connection_id = $1 AND deleted_at IS NULL
              AND (table_name ILIKE $2 OR description ILIKE $2)
            LIMIT $3`,
          [ds.id, likePattern, limit],
        );

        const dsName = ds.datasource_name || ds.id.slice(0, 8);
        for (const table of tables) {
          const colRow = await query(
            `SELECT COUNT(id) AS cnt FROM column_metadata WHERE table_id = $1 AND deleted_at IS NULL`,
            [table.id],
          ).catch(() => [{ cnt: 0 }]);
          const colCount = Number(colRow?.[0]?.cnt || 0);

          profiles.push(new Profile(
            dsName,
            table.table_name,
            table.description || '',
            [table.row_count || 0, colCount],
            [],
            [],
            false,
            { data_source_type: 'SQLDatabase', schema_name: table.schema_name },
          ));
        }
      } catch (e) {
        console.warn(`[DataGrep] _like_grep_tables ${ds.id} 失败: ${e?.message ?? e}`);
      }
    }

    return profiles.slice(0, limit);
  }
}

export default DataGrep;
