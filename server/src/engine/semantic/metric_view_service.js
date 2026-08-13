// 迁移自 backend/dsh_kernel/semantic_catalogs/business/metric_view_service.py
//
// 指标视图定义管理服务（物化/虚拟指标视图：8 元组结构化定义的 CRUD + 召回）。
// 对外 class MetricViewService 及主要方法名 1:1 保留，供下游 import 不改调用方。
//
// ============================ 桌面版迁移要点 ============================
// 1) DB 访问：桌面版无 ORM/AsyncSession。所有需要查库的方法第一个参数改为 ctx 对象，
//    形如 { query(sql, params)->Promise<rows>, queryOne(sql, params)->Promise<row|null> }，
//    由上层注入（对齐 Python 版 db: AsyncSession 的位置）。本服务【不直接连库】。
//    SQLAlchemy 的 select/where/exists/update → 参数化 SQL（$1...）。
//    .in_() → = ANY($n)。所有查询带 deleted_at IS NULL 软删过滤。
//    Vastbase 把空串当 NULL：判空用 IS NOT NULL，不用 <> ''。
//    record 是从 ctx 取出的普通行对象（plain object），写库需要显式 UPDATE/INSERT，
//    不再有 ORM 的 db.add/commit/refresh，所以这里用显式 SQL（事务由 ctx 上层管理）。
//
// 2) embedding/向量召回：当前已接入 core/llm.js 的 embed() 和 VexDB 余弦距离查询。
//    generate_embeddings 会为 active 视图写入真实向量；search 优先使用向量候选，并在
//    无模型、扩展未就绪、向量为空或调用失败时回退名称/别名/描述的关键词打分。
//    has_active_views 只判断是否存在 active 视图，因为关键词路径不依赖 embedding。
//
// 3) 指标视图职责已经拆分：旧定义升级在 metric_view_definition.js，数据源校验和表引用
//    规范化在 metric_view_canonicalizer.js，召回排序在 metric_view_retrieval.js，存储字段
//    转换在 metric_view_storage.js。本文件只保留服务门面、读写、向量生成和查询编排。
//
// 4) fastapi_cache @cache → 用已迁 cache.js 的 withCache；invalidate_cache 同名复用。
// =======================================================================

import { EntityServiceBase } from './entity_service_base.js';
import { NotFoundError, ValidationError } from '../core/exceptions.js';
import { withCache, invalidate_cache } from '../core/cache.js';
import { embed } from '../core/llm.js';
import { vectorReady } from '../../db.js';
import {
  _normalize_op_case_in_list,
  _normalize_sql_op,
  to_metric_view_definition,
  upgrade_metric_view_payload,
} from './metric_view_definition.js';
import { canonicalize_metric_view_definition } from './metric_view_canonicalizer.js';
import { prioritize_metric_view_matches } from './metric_view_retrieval.js';
import { _json_or_null, _stable_json, normalizeMetricViewRow } from './metric_view_storage.js';

/**
 * 把问题向量化(供 vexdb_cosine_distance 召回)。query_embedding 已给则直接用;
 * 否则调 embed()。任何失败(无 EMBEDDING 模型/扩展未加载)返回 null → 调用方回退关键词。
 * @returns {Promise<number[]|null>}
 */
async function embedQuestion(question, project_id = null, query_embedding = null) {
  if (query_embedding === false) return null;
  if (Array.isArray(query_embedding) && query_embedding.length) return query_embedding;
  if (!vectorReady || !question || !String(question).trim()) return null;
  try {
    const v = await embed(question, { project_id });
    return Array.isArray(v) && v.length ? v : null;
  } catch (e) {
    console.warn(`[MetricView] embed 失败,回退关键词召回: ${e?.message ?? e}`);
    return null;
  }
}

const METRIC_VIEW_EMBEDDING_MODEL = 'text-embedding-v3';
const METRIC_VIEW_EMBEDDING_BATCH = 16;

// ===== 状态常量（迁移自 models/metric_view_definition.py）=====
const METRIC_VIEW_STATUS_DRAFT = 'draft';
const METRIC_VIEW_STATUS_ACTIVE = 'active';
const METRIC_VIEW_STATUS_INACTIVE = 'inactive';
const METRIC_VIEW_STATUSES = [
  METRIC_VIEW_STATUS_DRAFT,
  METRIC_VIEW_STATUS_ACTIVE,
  METRIC_VIEW_STATUS_INACTIVE,
];

// metric_view_definitions 表全列（用于 _serialize_record / SELECT *）
const METRIC_VIEW_COLUMNS = [
  'id',
  'created_at',
  'updated_at',
  'deleted_at',
  'deleted_by',
  'project_id',
  'source_id',
  'name',
  'description',
  'aliases',
  'tables',
  'fixed_predicates',
  'query_dimensions',
  'time_dimension',
  'projections',
  'group_by',
  'sort_spec',
  'embedding',
  'embedding_model',
  'status',
];

//  关键词召回打分（向量不可用或无命中时的保底路径）
// ===========================================================================

/** 把文本切成关键词（中英文/数字混合的连续片段 + 单字中文）。 */
function _tokenize(text) {
  if (!text) return [];
  const lower = String(text).toLowerCase();
  const tokens = new Set();
  // 英文/数字连续片段
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    if (m[0].length >= 2) tokens.add(m[0]);
  }
  // 中文单字 + 2gram（粗粒度，够做子串召回）
  const cjk = lower.match(/[一-鿿]+/g) || [];
  for (const seg of cjk) {
    for (let i = 0; i < seg.length; i += 1) {
      tokens.add(seg[i]);
      if (i + 1 < seg.length) tokens.add(seg.slice(i, i + 2));
    }
  }
  return [...tokens];
}

/**
 * 关键词伪 similarity：query token 在候选文本中命中数 / query token 总数，归一到 0~1。
 * 仅用于向量不可用或无命中时的保底召回。
 */
function _keyword_similarity(queryText, candidateText) {
  const queryTokens = _tokenize(queryText);
  if (!queryTokens.length) return 0.0;
  const haystack = String(candidateText || '').toLowerCase();
  let hits = 0;
  for (const token of queryTokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits / queryTokens.length;
}

// ===========================================================================
//  MetricViewService
// ===========================================================================

export class MetricViewService extends EntityServiceBase {
  /** 指标视图定义管理服务 */

  static _EMBEDDING_ALLOWED_VALUES_LIMIT = 20;

  /**
   * 业务下是否有任何激活视图（给 Agent 工具门控用，高频路径走缓存）。
   *
   * 桌面版无 embedding 列写入，故不再要求 embedding 非空——只问"项目里有没有 active 视图"。
   * 失效协议：写操作后调 invalidate_metric_view_cache 同步清除。
   *
   * @param {object} ctx - 注入的查库上下文 { query, queryOne }
   * @param {string} project_id
   * @returns {Promise<boolean>}
   */
  static async has_active_views(ctx, project_id) {
    if (!project_id) return false;
    return MetricViewService._has_active_views_cached(ctx, project_id);
  }

  // 缓存键必须只由 project_id 决定（ctx 每次注入、不能进 key）。这里用自定义 keyBuilder
  // 显式构造 `has_active_views:project_id=<id>`，从而：
  //   1) 不同 project_id 互不串缓存；2) invalidate_cache('has_active_views',{project_id}) 精确匹配清除。
  static _has_active_views_cached = withCache({
    expire: 120,
    keyBuilder: (fn, _ns, { args = [] } = {}) => `${fn.name}:project_id=${args[1]}`,
  })(
    async function has_active_views(ctx, project_id) {
      const row = await ctx.queryOne(
        `SELECT 1
           FROM metric_view_definitions
          WHERE project_id = $1
            AND deleted_at IS NULL
            AND status = $2
          LIMIT 1`,
        [project_id, METRIC_VIEW_STATUS_ACTIVE],
      );
      return Boolean(row);
    },
  );

  /** 清除指标视图相关缓存——项目方 create/update/delete/embedding 后调用。 */
  static async invalidate_metric_view_cache(project_id) {
    if (!project_id) return;
    await invalidate_cache('has_active_views', { project_id });
  }

  /**
   * 构建指标视图召回文本（Phase 1 轻量规则增强）。
   * @param {object} record - metric_view_definition 行对象
   * @returns {string}
   */
  static _build_embedding_text(record) {
    const parts = [record.name];
    if (record.aliases) {
      for (const alias of record.aliases) {
        if (alias) parts.push(String(alias));
      }
    }
    if (record.description) parts.push(record.description);

    if (record.tables) {
      const tableNames = [];
      for (const table of record.tables) {
        if (_is_plain_object(table)) {
          const tableRef = table.table_ref || table.table_key || table.alias;
          if (tableRef) tableNames.push(String(tableRef));
        }
      }
      if (tableNames.length) parts.push(`tables ${tableNames.join(' ')}`);
    }

    if (record.query_dimensions) {
      const dimNames = [];
      const discreteValueTokens = [];
      for (const dim of record.query_dimensions) {
        if (!_is_plain_object(dim)) continue;
        if (dim.name) dimNames.push(String(dim.name));
        const field = dim.field || {};
        if (_is_plain_object(field)) {
          for (const token of [field.table_key, field.column_name]) {
            if (token) dimNames.push(String(token));
          }
        }
        const allowedValues = dim.allowed_values || [];
        if (
          dim.param_type === 'discrete'
          && allowedValues.length
          && allowedValues.length <= MetricViewService._EMBEDDING_ALLOWED_VALUES_LIMIT
        ) {
          for (const value of allowedValues.slice(0, MetricViewService._EMBEDDING_ALLOWED_VALUES_LIMIT)) {
            if (value) discreteValueTokens.push(String(value));
          }
        }
      }
      if (dimNames.length) parts.push(`dimensions ${dimNames.join(' ')}`);
      if (discreteValueTokens.length) parts.push(`dimension_values ${discreteValueTokens.join(' ')}`);
    }

    if (record.time_dimension && _is_plain_object(record.time_dimension)) {
      const field = record.time_dimension.field || {};
      let timeColumn = null;
      if (_is_plain_object(field)) {
        const tableKey = field.table_key;
        const columnName = field.column_name;
        if (tableKey && columnName) timeColumn = `${tableKey}.${columnName}`;
      }
      if (!timeColumn) timeColumn = record.time_dimension.column;
      const extractType = record.time_dimension.extract_type;
      if (timeColumn || extractType) {
        parts.push(`time ${[timeColumn, extractType].filter((item) => item).map(String).join(' ')}`);
      }
    }

    if (record.projections) {
      const projectionTokens = [];
      for (const projection of record.projections.slice(0, 3)) {
        if (_is_plain_object(projection)) {
          const alias = projection.alias;
          const kind = projection.kind;
          if (alias) projectionTokens.push(String(alias));
          else if (kind) projectionTokens.push(String(kind));
        } else {
          projectionTokens.push(String(projection));
        }
      }
      if (projectionTokens.length) parts.push(`projections ${projectionTokens.join(' ')}`);
    }

    return parts.filter((part) => part).join(' ');
  }

  /**
   * 序列化一条记录（排除 embedding），并做一次 upgrade 归一化（失败降级原始 payload）。
   * @param {object} record
   * @returns {object}
   */
  static _serialize_record(record) {
    const payload = {};
    for (const column of METRIC_VIEW_COLUMNS) {
      if (column === 'embedding') continue;
      payload[column] = record[column] !== undefined ? record[column] : null;
    }
    try {
      return upgrade_metric_view_payload(normalizeMetricViewRow(payload));
    } catch (exc) {
      // 草稿允许字段不全, upgrade 失败时降级为原始 dict
      console.warn(
        `_serialize_record: upgrade 失败 id=${payload.id} status=${payload.status} err=${exc?.message ?? exc}，降级返回原始 payload`,
      );
      return payload;
    }
  }

  /**
   * 批量构建数据源摘要（business_source_id → 物理源信息）。
   * @param {object} ctx
   * @param {string[]} source_ids
   * @returns {Promise<Object<string, object>>}
   */
  static async _build_source_summary_map(ctx, source_ids) {
    const uniqueIds = [...new Set((source_ids || []).filter((id) => id))];
    if (!uniqueIds.length) return {};

    const items = await ctx.query(
      `SELECT id, source_type, source_id
         FROM business_data_sources
        WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
      [uniqueIds],
    );

    const databaseIds = items.filter((i) => i.source_type === 'database_connection').map((i) => i.source_id);
    const structuredIds = items.filter((i) => i.source_type === 'structured_data_source').map((i) => i.source_id);
    const unstructuredIds = items.filter((i) => i.source_type === 'unstructured_data_source').map((i) => i.source_id);
    const mcpIds = items.filter((i) => i.source_type === 'mcp_data_source').map((i) => i.source_id);

    // (source_type, source_id) → physical name
    const physicalNameMap = new Map();
    const keyOf = (type, id) => `${type}::${id}`;

    const loadNames = async (ids, table, sourceType) => {
      if (!ids.length) return;
      const rows = await ctx.query(
        `SELECT id, name FROM ${table} WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
        [ids],
      );
      for (const source of rows) {
        physicalNameMap.set(keyOf(sourceType, source.id), source.name);
      }
    };

    await loadNames(databaseIds, 'database_connections', 'database_connection');
    await loadNames(structuredIds, 'structured_data_sources', 'structured_data_source');
    await loadNames(unstructuredIds, 'unstructured_data_sources', 'unstructured_data_source');
    await loadNames(mcpIds, 'mcp_data_sources', 'mcp_data_source');

    const summaryMap = {};
    for (const item of items) {
      summaryMap[item.id] = {
        source_id: item.id,
        business_source_id: item.id,
        connection_id: item.source_id,
        source_type: item.source_type,
        source_name: physicalNameMap.get(keyOf(item.source_type, item.source_id)) ?? item.source_id,
      };
    }
    return summaryMap;
  }

  static _build_definition_input_from_record(record) {
    return {
      name: record.name,
      description: record.description,
      aliases: record.aliases || [],
      source_id: record.source_id,
      tables: record.tables || [],
      fixed_predicates: record.fixed_predicates || [],
      query_dimensions: record.query_dimensions || [],
      time_dimension: record.time_dimension,
      projections: record.projections || [],
      group_by: record.group_by || [],
      sort_spec: record.sort_spec || { order_by: [], limit_default: 100 },
    };
  }

  /**
   * 把视图定义字段拍平为可落库的列值集合（create/update/draft/non-draft 共用）。
   * @returns {object} 形如 { name, description, source_id, aliases, tables, ... }
   */
  static _build_record_columns({ name, description, source_id, normalized_or_raw }) {
    return {
      name,
      description,
      source_id,
      aliases: normalized_or_raw.aliases || null,
      tables: normalized_or_raw.tables || [],
      fixed_predicates: normalized_or_raw.fixed_predicates || null,
      query_dimensions: normalized_or_raw.query_dimensions || null,
      time_dimension: normalized_or_raw.time_dimension != null ? normalized_or_raw.time_dimension : null,
      projections: normalized_or_raw.projections || [],
      group_by: normalized_or_raw.group_by || null,
      sort_spec: normalized_or_raw.sort_spec || { order_by: [], limit_default: 100 },
    };
  }

  /** 构造草稿落库用的字段字典（跳过 normalize，原样保留 LLM 输出）。 */
  static _build_draft_payload({
    aliases,
    tables,
    projections,
    fixed_predicates,
    query_dimensions,
    time_dimension,
    group_by,
    sort_spec,
  }) {
    return {
      aliases,
      tables,
      fixed_predicates,
      query_dimensions,
      time_dimension,
      projections,
      group_by,
      sort_spec,
    };
  }

  /**
   * 写库前用 ViewMetricDefinition 做一次结构校验与归一化，把默认值稳定写入 JSON 字段。
   * @returns {Promise<object>} 归一化后的字段集合
   */
  static async _normalize_definition_payload(ctx, {
    name,
    source_id,
    aliases,
    tables,
    projections,
    fixed_predicates,
    query_dimensions,
    time_dimension,
    group_by,
    sort_spec,
    strict_source_resolution = true,
  }) {
    // operator/op 大小写归一化（兜底大写 'IN'/'LIKE'）
    fixed_predicates = _normalize_op_case_in_list(fixed_predicates, 'operator');
    query_dimensions = _normalize_op_case_in_list(query_dimensions, 'op');
    if (_is_plain_object(time_dimension) && time_dimension.op) {
      time_dimension = { ...time_dimension };
      time_dimension.op = _normalize_sql_op(time_dimension.op);
    }

    let definition;
    try {
      const normalizedPayload = upgrade_metric_view_payload({
        metric_id: 'draft_metric_view',
        name,
        aliases: aliases || [],
        source_id,
        descriptions: [],
        tables,
        fixed_predicates: fixed_predicates || [],
        query_dimensions: query_dimensions || [],
        time_dimension,
        projections,
        group_by: group_by || [],
        sort_spec: sort_spec || { order_by: [], limit_default: 100 },
      });
      // 桌面版无 pydantic：直接用 upgrade 后的普通对象作为 definition，
      // 字段默认值在 canonicalize / 下面落库时补齐。
      definition = MetricViewService._coerce_definition_defaults(normalizedPayload);
      definition = await canonicalize_metric_view_definition(ctx, definition, {
        source_id,
        strict_source_resolution,
      });
    } catch (exc) {
      throw new ValidationError(`指标视图定义不合法: ${exc?.message ?? exc}`);
    }

    return {
      aliases: (definition.aliases && definition.aliases.length ? definition.aliases : null),
      tables: definition.tables || [],
      fixed_predicates: (definition.fixed_predicates && definition.fixed_predicates.length ? definition.fixed_predicates : null),
      query_dimensions: (definition.query_dimensions && definition.query_dimensions.length ? definition.query_dimensions : null),
      time_dimension: definition.time_dimension != null ? definition.time_dimension : null,
      projections: definition.projections || [],
      group_by: (definition.group_by && definition.group_by.length ? definition.group_by : null),
      sort_spec: definition.sort_spec || { order_by: [], limit_default: 100 },
    };
  }

  /**
   * 为 upgrade 后的 payload 补齐 pydantic 默认值（替代 model_validate + model_dump）。
   * 仅补本服务后续会用到的容器默认值，保持形状稳定。
   */
  static _coerce_definition_defaults(payload) {
    const def = { ...payload };
    def.aliases = def.aliases || [];
    def.tables = def.tables || [];
    def.fixed_predicates = def.fixed_predicates || [];
    def.query_dimensions = def.query_dimensions || [];
    def.time_dimension = def.time_dimension != null ? def.time_dimension : null;
    def.projections = def.projections || [];
    def.group_by = def.group_by || [];
    const sortSpec = def.sort_spec || {};
    def.sort_spec = {
      order_by: sortSpec.order_by || [],
      limit_default: sortSpec.limit_default != null ? sortSpec.limit_default : 100,
    };
    return def;
  }

  /**
   * 存储契约修复：扫描项目/视图记录，重新归一化并（非 dry_run 时）回写。
   * @param {object} ctx
   * @param {{project_id?:string, metric_view_id?:string, dry_run?:boolean}} options
   * @returns {Promise<object>} summary
   */
  static async repair_storage_contract(ctx, { project_id = null, metric_view_id = null, dry_run = true } = {}) {
    const params = [];
    let sql = `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
                 FROM metric_view_definitions
                WHERE deleted_at IS NULL`;
    if (project_id) {
      params.push(project_id);
      sql += ` AND project_id = $${params.length}`;
    }
    if (metric_view_id) {
      params.push(metric_view_id);
      sql += ` AND id = $${params.length}`;
    }
    sql += ' ORDER BY created_at ASC';

    const records = await ctx.query(sql, params);

    const summary = {
      dry_run,
      scanned: records.length,
      updated: 0,
      skipped: [],
      failed: [],
    };

    for (const record of records) {
      if (!record.source_id) {
        summary.skipped.push({ id: record.id, name: record.name, reason: 'missing_source_id' });
        continue;
      }

      try {
        const currentUpgraded = MetricViewService._coerce_definition_defaults(
          upgrade_metric_view_payload(MetricViewService._build_definition_input_from_record(record)),
        );
        const currentPayload = {
          name: record.name,
          description: record.description,
          aliases: currentUpgraded.aliases || [],
          source_id: record.source_id,
          tables: currentUpgraded.tables,
          fixed_predicates: currentUpgraded.fixed_predicates,
          query_dimensions: currentUpgraded.query_dimensions,
          time_dimension: currentUpgraded.time_dimension,
          projections: currentUpgraded.projections,
          group_by: currentUpgraded.group_by,
          sort_spec: currentUpgraded.sort_spec,
        };

        const normalized = await MetricViewService._normalize_definition_payload(ctx, {
          name: record.name,
          source_id: record.source_id,
          aliases: record.aliases,
          tables: record.tables || [],
          projections: record.projections || [],
          fixed_predicates: record.fixed_predicates,
          query_dimensions: record.query_dimensions,
          time_dimension: record.time_dimension,
          group_by: record.group_by,
          sort_spec: record.sort_spec,
          strict_source_resolution: true,
        });

        const nextPayload = {
          name: record.name,
          description: record.description,
          aliases: normalized.aliases || [],
          source_id: record.source_id,
          tables: normalized.tables,
          fixed_predicates: normalized.fixed_predicates || [],
          query_dimensions: normalized.query_dimensions || [],
          time_dimension: normalized.time_dimension,
          projections: normalized.projections,
          group_by: normalized.group_by || [],
          sort_spec: normalized.sort_spec,
        };

        if (_stable_json(currentPayload) === _stable_json(nextPayload)) {
          continue;
        }

        summary.updated += 1;
        if (dry_run) continue;

        await ctx.query(
          `UPDATE metric_view_definitions
              SET aliases = $1, tables = $2, fixed_predicates = $3, query_dimensions = $4,
                  time_dimension = $5, projections = $6, group_by = $7, sort_spec = $8,
                  updated_at = $9
            WHERE id = $10`,
          [
            _json_or_null(normalized.aliases),
            _json_or_null(normalized.tables),
            _json_or_null(normalized.fixed_predicates),
            _json_or_null(normalized.query_dimensions),
            _json_or_null(normalized.time_dimension),
            _json_or_null(normalized.projections),
            _json_or_null(normalized.group_by),
            _json_or_null(normalized.sort_spec),
            new Date(),
            record.id,
          ],
        );
      } catch (exc) {
        summary.failed.push({ id: record.id, name: record.name, reason: String(exc?.message ?? exc) });
      }
    }

    return summary;
  }

  /**
   * 创建指标视图定义。
   * @param {object} ctx
   * @returns {Promise<{success:boolean,id:string,message:string}>}
   */
  static async create(ctx, {
    project_id,
    name,
    source_id,
    tables,
    projections,
    description = null,
    aliases = null,
    fixed_predicates = null,
    query_dimensions = null,
    time_dimension = null,
    group_by = null,
    sort_spec = null,
    status = METRIC_VIEW_STATUS_ACTIVE,
  }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      if (!METRIC_VIEW_STATUSES.includes(status)) {
        throw new ValidationError(`非法的状态值: ${status}`);
      }

      const businessDataSource = await ctx.queryOne(
        `SELECT id, project_id, source_type, source_id, deleted_at
           FROM business_data_sources WHERE id = $1`,
        [source_id],
      );
      if (!businessDataSource || businessDataSource.deleted_at != null) {
        throw new ValidationError('项目数据源不存在');
      }
      if (businessDataSource.project_id !== project_id) {
        throw new ValidationError('指标视图绑定的数据源不属于当前项目');
      }
      // 注：business_data_sources 表无 is_active 列，原 Python getattr 默认 True，恒不触发停用判断。

      // 名称唯一性
      const existing = await ctx.queryOne(
        `SELECT 1 FROM metric_view_definitions
          WHERE project_id = $1 AND name = $2 AND deleted_at IS NULL LIMIT 1`,
        [project_id, name],
      );
      if (existing) {
        throw new ValidationError(`指标视图名称 '${name}' 已存在`);
      }

      let payload;
      if (status === METRIC_VIEW_STATUS_DRAFT) {
        payload = MetricViewService._build_draft_payload({
          aliases, tables, projections, fixed_predicates, query_dimensions, time_dimension, group_by, sort_spec,
        });
      } else {
        payload = await MetricViewService._normalize_definition_payload(ctx, {
          name, source_id, aliases, tables, projections, fixed_predicates,
          query_dimensions, time_dimension, group_by, sort_spec, strict_source_resolution: true,
        });
      }

      const cols = MetricViewService._build_record_columns({
        name, description, source_id, normalized_or_raw: payload,
      });

      const now = new Date();
      const inserted = await ctx.queryOne(
        `INSERT INTO metric_view_definitions
           (project_id, status, name, description, source_id, aliases, tables,
            fixed_predicates, query_dimensions, time_dimension, projections,
            group_by, sort_spec, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id`,
        [
          project_id,
          status,
          cols.name,
          cols.description,
          cols.source_id,
          _json_or_null(cols.aliases),
          _json_or_null(cols.tables),
          _json_or_null(cols.fixed_predicates),
          _json_or_null(cols.query_dimensions),
          _json_or_null(cols.time_dimension),
          _json_or_null(cols.projections),
          _json_or_null(cols.group_by),
          _json_or_null(cols.sort_spec),
          now,
          now,
        ],
      );

      await MetricViewService.invalidate_metric_view_cache(project_id);
      return { success: true, id: inserted?.id, message: `成功创建指标视图 ${name}` };
    } catch (e) {
      console.error(`创建指标视图失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 更新指标视图定义。
   * @param {object} ctx
   * @returns {Promise<{success:boolean,id:string,message:string}>}
   */
  static async update(ctx, {
    metric_view_id,
    project_id,
    name,
    source_id,
    tables,
    projections,
    description = null,
    aliases = null,
    fixed_predicates = null,
    query_dimensions = null,
    time_dimension = null,
    group_by = null,
    sort_spec = null,
    status = null,
  }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      if (status != null && !METRIC_VIEW_STATUSES.includes(status)) {
        throw new ValidationError(`非法的状态值: ${status}`);
      }

      const businessDataSource = await ctx.queryOne(
        `SELECT id, project_id, source_type, source_id, deleted_at
           FROM business_data_sources WHERE id = $1`,
        [source_id],
      );
      if (!businessDataSource || businessDataSource.deleted_at != null) {
        throw new ValidationError('项目数据源不存在');
      }
      if (businessDataSource.project_id !== project_id) {
        throw new ValidationError('指标视图绑定的数据源不属于当前项目');
      }

      const record = await ctx.queryOne(
        `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
           FROM metric_view_definitions
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_view_id, project_id],
      );
      if (!record) {
        throw new NotFoundError('指标视图不存在');
      }

      if (record.name !== name) {
        const dup = await ctx.queryOne(
          `SELECT 1 FROM metric_view_definitions
            WHERE project_id = $1 AND name = $2 AND id <> $3 AND deleted_at IS NULL LIMIT 1`,
          [project_id, name, metric_view_id],
        );
        if (dup) {
          throw new ValidationError(`指标视图名称 '${name}' 已存在`);
        }
      }

      const targetStatus = status != null ? status : record.status;
      let payload;
      if (targetStatus === METRIC_VIEW_STATUS_DRAFT) {
        payload = MetricViewService._build_draft_payload({
          aliases, tables, projections, fixed_predicates, query_dimensions, time_dimension, group_by, sort_spec,
        });
      } else {
        payload = await MetricViewService._normalize_definition_payload(ctx, {
          name, source_id, aliases, tables, projections, fixed_predicates,
          query_dimensions, time_dimension, group_by, sort_spec, strict_source_resolution: true,
        });
      }

      const cols = MetricViewService._build_record_columns({
        name, description, source_id, normalized_or_raw: payload,
      });

      const nextStatus = status != null ? status : record.status;
      // 状态变更为非 active 时清空 embedding（向量召回仅服务 active 视图）
      const clearEmbedding = nextStatus !== METRIC_VIEW_STATUS_ACTIVE && record.embedding != null;

      await ctx.query(
        `UPDATE metric_view_definitions
            SET name = $1, description = $2, source_id = $3, aliases = $4, tables = $5,
                fixed_predicates = $6, query_dimensions = $7, time_dimension = $8,
                projections = $9, group_by = $10, sort_spec = $11, status = $12,
                embedding = CASE WHEN $13 THEN NULL ELSE embedding END,
                embedding_model = CASE WHEN $13 THEN NULL ELSE embedding_model END,
                updated_at = $14
          WHERE id = $15`,
        [
          cols.name,
          cols.description,
          cols.source_id,
          _json_or_null(cols.aliases),
          _json_or_null(cols.tables),
          _json_or_null(cols.fixed_predicates),
          _json_or_null(cols.query_dimensions),
          _json_or_null(cols.time_dimension),
          _json_or_null(cols.projections),
          _json_or_null(cols.group_by),
          _json_or_null(cols.sort_spec),
          nextStatus,
          clearEmbedding,
          new Date(),
          metric_view_id,
        ],
      );

      await MetricViewService.invalidate_metric_view_cache(project_id);
      return { success: true, id: metric_view_id, message: `成功更新指标视图 ${name}` };
    } catch (e) {
      console.error(`更新指标视图失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 获取指标视图列表（分页）。
   * @param {object} ctx
   * @returns {Promise<[object[], number]>} [items, total]
   */
  static async get_list(ctx, {
    project_id,
    source_id = null,
    active_only = false,
    status_filter = null,
    page = 1,
    page_size = 20,
  }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      const params = [project_id];
      let where = 'project_id = $1 AND deleted_at IS NULL';
      if (source_id) {
        params.push(source_id);
        where += ` AND source_id = $${params.length}`;
      }
      if (status_filter) {
        if (!METRIC_VIEW_STATUSES.includes(status_filter)) {
          throw new ValidationError(`非法的状态过滤值: ${status_filter}`);
        }
        params.push(status_filter);
        where += ` AND status = $${params.length}`;
      } else if (active_only) {
        params.push(METRIC_VIEW_STATUS_ACTIVE);
        where += ` AND status = $${params.length}`;
      }

      const countRow = await ctx.queryOne(
        `SELECT COUNT(*) AS cnt FROM metric_view_definitions WHERE ${where}`,
        params,
      );
      const total = countRow ? Number(countRow.cnt) || 0 : 0;

      let listSql = `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
                       FROM metric_view_definitions
                      WHERE ${where}
                   ORDER BY created_at DESC`;
      const listParams = [...params];
      if (page_size > 0) {
        listParams.push(page_size);
        listSql += ` LIMIT $${listParams.length}`;
        listParams.push((page - 1) * page_size);
        listSql += ` OFFSET $${listParams.length}`;
      }

      const records = await ctx.query(listSql, listParams);

      const sourceSummaryMap = await MetricViewService._build_source_summary_map(
        ctx,
        records.map((record) => record.source_id),
      );

      const items = [];
      for (const record of records) {
        const payload = MetricViewService._serialize_record(record);
        Object.assign(payload, sourceSummaryMap[record.source_id] || {});
        items.push(payload);
      }
      return [items, total];
    } catch (e) {
      console.error(`获取指标视图列表失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 获取指标视图详情。
   * @param {object} ctx
   * @returns {Promise<object>}
   */
  static async get_detail(ctx, { metric_view_id, project_id }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      const record = await ctx.queryOne(
        `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
           FROM metric_view_definitions
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_view_id, project_id],
      );
      if (!record) {
        throw new NotFoundError('指标视图不存在');
      }

      const payload = MetricViewService._serialize_record(record);
      const sourceSummaryMap = await MetricViewService._build_source_summary_map(ctx, [record.source_id]);
      Object.assign(payload, sourceSummaryMap[record.source_id] || {});
      return payload;
    } catch (e) {
      console.error(`获取指标视图详情失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 软删除指标视图。
   * @param {object} ctx
   * @returns {Promise<void>}
   */
  static async delete(ctx, { metric_view_id, project_id }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      const record = await ctx.queryOne(
        `SELECT id FROM metric_view_definitions
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_view_id, project_id],
      );
      if (!record) {
        throw new NotFoundError('指标视图不存在');
      }

      await ctx.query(
        `UPDATE metric_view_definitions SET deleted_at = $1, updated_at = $1 WHERE id = $2`,
        [new Date(), metric_view_id],
      );

      await MetricViewService.invalidate_metric_view_cache(project_id);
    } catch (e) {
      console.error(`删除指标视图失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 切换指标视图状态: draft / active / inactive。
   * 草稿 -> 启用前会触发严格 schema 解析校验，失败抛 ValidationError。
   * @param {object} ctx
   * @returns {Promise<{success:boolean,id:string,status:string,message:string}>}
   */
  static async update_status(ctx, { metric_view_id, project_id, status }) {
    try {
      if (!METRIC_VIEW_STATUSES.includes(status)) {
        throw new ValidationError(`非法的状态值: ${status}`);
      }

      await MetricViewService._validate_business(ctx, project_id);

      const record = await ctx.queryOne(
        `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
           FROM metric_view_definitions
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_view_id, project_id],
      );
      if (!record) {
        throw new NotFoundError('指标视图不存在');
      }

      // 任何状态切到 active 都必须能通过严格 schema 解析
      const willBecomeActive =
        status === METRIC_VIEW_STATUS_ACTIVE && record.status !== METRIC_VIEW_STATUS_ACTIVE;
      if (willBecomeActive) {
        await MetricViewService._normalize_definition_payload(ctx, {
          name: record.name,
          source_id: record.source_id,
          aliases: record.aliases,
          tables: record.tables || [],
          projections: record.projections || [],
          fixed_predicates: record.fixed_predicates,
          query_dimensions: record.query_dimensions,
          time_dimension: record.time_dimension,
          group_by: record.group_by,
          sort_spec: record.sort_spec,
          strict_source_resolution: true,
        });
      }

      const clearEmbedding = status !== METRIC_VIEW_STATUS_ACTIVE && record.embedding != null;

      await ctx.query(
        `UPDATE metric_view_definitions
            SET status = $1,
                embedding = CASE WHEN $2 THEN NULL ELSE embedding END,
                embedding_model = CASE WHEN $2 THEN NULL ELSE embedding_model END,
                updated_at = $3
          WHERE id = $4`,
        [status, clearEmbedding, new Date(), metric_view_id],
      );

      return {
        success: true,
        id: metric_view_id,
        status,
        message: `状态已更新为 ${status}`,
      };
    } catch (e) {
      if (e instanceof NotFoundError || e instanceof ValidationError) throw e;
      console.error(`更新指标视图状态失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 批量生成指标视图向量（真·向量：embed(name+aliases+description+结构文本)→写 embedding 列）。
   *
   * 仅对 active 视图中 embedding IS NULL 的行批量生成（每批 ≤16）。无 EMBEDDING 模型/
   * 向量扩展未就绪/embed 失败时降级：不抛异常，processed=0，保留对外接口与返回形状。
   *
   * @param {object} ctx
   * @returns {Promise<{success:boolean,total:number,processed:number,message:string}>}
   */
  static async generate_embeddings(ctx, { project_id, metric_view_id = null }) {
    try {
      await MetricViewService._validate_business(ctx, project_id);

      // 清理非 active 视图的 embedding 残留（历史脏数据兜底）
      await ctx.query(
        `UPDATE metric_view_definitions
            SET embedding = NULL, embedding_model = NULL
          WHERE project_id = $1
            AND deleted_at IS NULL
            AND status <> $2
            AND embedding IS NOT NULL`,
        [project_id, METRIC_VIEW_STATUS_ACTIVE],
      );

      // 只取尚未生成向量(embedding IS NULL)的启用视图
      const params = [project_id, METRIC_VIEW_STATUS_ACTIVE];
      let sql = `SELECT id, name, aliases, description, tables, query_dimensions,
                        time_dimension, projections
                   FROM metric_view_definitions
                  WHERE project_id = $1 AND deleted_at IS NULL AND status = $2
                    AND embedding IS NULL`;
      if (metric_view_id) {
        params.push(metric_view_id);
        sql += ` AND id = $${params.length}`;
      }
      const records = await ctx.query(sql, params);

      if (!records.length) {
        return {
          success: true,
          total: 0,
          processed: 0,
          message: '没有找到需要生成向量的启用视图(草稿/停用视图不参与向量生成)',
        };
      }

      let processed = 0;
      // 批量(每批 ≤16)embed → 逐行 UPDATE embedding 列。embed 失败/无模型降级 processed=0。
      try {
        for (let i = 0; i < records.length; i += METRIC_VIEW_EMBEDDING_BATCH) {
          const batch = records.slice(i, i + METRIC_VIEW_EMBEDDING_BATCH);
          const texts = batch.map((r) => MetricViewService._build_embedding_text(r) || r.name || '');
          // eslint-disable-next-line no-await-in-loop
          const vectors = await embed(texts, { project_id });
          if (!Array.isArray(vectors) || !vectors.length) break;
          for (let j = 0; j < batch.length; j += 1) {
            const vec = vectors[j];
            if (!Array.isArray(vec) || !vec.length) continue;
            // eslint-disable-next-line no-await-in-loop
            await ctx.query(
              // embedding 统一存 JSON 文本(与 schema_retrieval/metric/entity 一致);
              // 召回侧 vexdb_cosine_distance(embedding, vexdb_f32($q)) 接受 JSON 文本列
              `UPDATE metric_view_definitions
                  SET embedding = $1, embedding_model = $2, updated_at = $3
                WHERE id = $4`,
              [JSON.stringify(vec), METRIC_VIEW_EMBEDDING_MODEL, new Date(), batch[j].id],
            );
            processed += 1;
          }
        }
      } catch (embedErr) {
        // 无 EMBEDDING 模型/向量扩展未就绪/embed 失败 → 降级，不抛异常
        console.warn(`[MetricView] 向量生成降级(无向量服务或 embed 失败): ${embedErr?.message ?? embedErr}`);
      }

      await MetricViewService.invalidate_metric_view_cache(project_id);
      const message = processed > 0
        ? `成功为 ${processed}/${records.length} 个启用视图生成向量`
        : `无向量服务或 embed 失败，已识别 ${records.length} 个启用视图但未生成向量`;
      return {
        success: true,
        total: records.length,
        processed,
        message,
      };
    } catch (e) {
      console.error(`生成指标视图向量失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * vexdb_cosine_distance 向量召回 active 视图：对有 embedding 的视图按余弦距离升序取 top-N。
   * similarity = max(0, 1 - distance)。返回与关键词路径一致的 { model, similarity } 列表。
   * SQL/向量扩展失败 → 返回空，调用方回退关键词。
   * @returns {Promise<Array<{model:object, similarity:number}>>}
   */
  static async _vectorScoreViews(ctx, project_id, queryVec, limit) {
    const rows = await ctx.query(
      `SELECT ${METRIC_VIEW_COLUMNS.map((c) => (c === 'embedding' ? null : c)).filter((c) => c).join(', ')},
              vexdb_cosine_distance(embedding, vexdb_f32($1)) AS distance
         FROM metric_view_definitions
        WHERE project_id = $2
          AND status = $3
          AND embedding IS NOT NULL
          AND deleted_at IS NULL
        ORDER BY distance ASC, id ASC
        LIMIT $4`,
      [JSON.stringify(queryVec), project_id, METRIC_VIEW_STATUS_ACTIVE, limit],
    ).catch((e) => {
      console.warn(`[MetricView] 向量召回 SQL 失败: ${e?.message ?? e}`);
      return [];
    });
    return rows.map((model) => ({
      model: normalizeMetricViewRow(model),
      similarity: Math.max(0, 1.0 - Number(model.distance ?? 1)),
    }));
  }

  /**
   * 搜索 metric view definitions（向量优先 vexdb_cosine_distance，向量空回退关键词召回）。
   *
   * @param {object} ctx
   * @returns {Promise<object[]>}
   */
  static async search(ctx, {
    query_text,
    project_id,
    limit = 3,
    offset = 0,
    query_embedding = null,
  }) {
    try {
      const safeLimit = Math.max(0, Number.parseInt(limit, 10) || 0);
      const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
      if (safeLimit === 0) return [];
      const rawRows = await ctx.query(
        `SELECT ${METRIC_VIEW_COLUMNS.join(', ')}
           FROM metric_view_definitions
          WHERE project_id = $1
            AND deleted_at IS NULL
            AND status = $2`,
        [project_id, METRIC_VIEW_STATUS_ACTIVE],
      );
      if (!rawRows.length) return [];
      const rows = rawRows.map(normalizeMetricViewRow);

      const keywordScored = rows.map((model) => {
        const candidateText = [
          model.name || '',
          ...(model.aliases || []),
          model.description || '',
        ].join(' ');
        return { model, similarity: _keyword_similarity(query_text, candidateText) };
      });
      keywordScored.sort((a, b) => b.similarity - a.similarity
        || String(a.model.name || '').localeCompare(String(b.model.name || ''))
        || String(a.model.id || '').localeCompare(String(b.model.id || '')));

      let scored = keywordScored;
      const qvec = await embedQuestion(query_text, project_id, query_embedding);
      if (qvec) {
        const vectorScored = await MetricViewService._vectorScoreViews(ctx, project_id, qvec, rows.length);
        if (vectorScored.length) {
          const fused = new Map();
          const addRanking = (hits) => {
            hits.forEach((hit) => {
              const id = String(hit.model?.id || '');
              if (!id) return;
              const score = Number(hit.similarity || 0);
              const current = fused.get(id) || { hit, score: Number.NEGATIVE_INFINITY };
              if (score > current.score) {
                current.hit = hit;
                current.score = score;
              }
              fused.set(id, current);
            });
          };
          addRanking(vectorScored);
          addRanking(keywordScored);
          scored = [...fused.values()].sort((a, b) => b.score - a.score
            || String(a.hit.model?.name || '').localeCompare(String(b.hit.model?.name || ''))
            || String(a.hit.model?.id || '').localeCompare(String(b.hit.model?.id || '')))
            .map((item) => item.hit);
          console.log(`[MetricView] 混合召回: vector=${vectorScored.length} keyword=${keywordScored.length}`);
        }
      }

      const top = scored.slice(safeOffset, safeOffset + safeLimit);

      const sourceSummaryMap = await MetricViewService._build_source_summary_map(
        ctx,
        top.map(({ model }) => model.source_id),
      );

      const matches = [];
      for (const { model, similarity } of top) {
        const sourceSummary = sourceSummaryMap[model.source_id] || {};
        matches.push({
          definition: to_metric_view_definition(model),
          similarity,
          name: model.name,
          aliases: model.aliases || [],
          description: model.description || '',
          source_id: model.source_id,
          business_source_id: sourceSummary.business_source_id ?? model.source_id,
          connection_id: sourceSummary.connection_id ?? null,
          source_name: sourceSummary.source_name ?? null,
        });
      }
      return prioritize_metric_view_matches(query_text, matches);
    } catch (e) {
      console.error(`搜索指标视图失败: ${e?.message ?? e}`);
      throw e;
    }
  }
}

export default MetricViewService;
