// 迁移自 backend/dsh_kernel/semantic_catalogs/business/metric_service.py
//
// 业务指标管理服务（指标定义 / 解析 / 向量召回的核心）。
// 对外 class MetricService 及主要方法名与 Python 版 1:1 保留，供下游 import 不改调用方。
//
// ============================ 桌面版迁移要点 ============================
// DB 访问约定（与其它已迁文件一致）：所有需要查库的方法第一个参数由 Python 的
//   db: AsyncSession 改为【注入的 ctx/deps 对象】，形如：
//     { query(sql, params)->Promise<rows>, queryOne(sql, params)->Promise<row|null> }
//   由上层注入。本服务【不直接连库】。
//   - ORM 模型 MetricDefinition → 表 metric_definitions（参数化 SQL，占位符 $1...）。
//   - SQLAlchemy 的 select/where/func/or_ 改写为参数化 SQL；.in_() → = ANY($n)。
//   - 所有查询带 deleted_at IS NULL 软删过滤。
//   - Vastbase 把空串当 NULL：判空一律用 IS NOT NULL / IS NULL，绝不用 <> ''。
//   - 事务：桌面版无 AsyncSession 的 commit/rollback 概念，假定 ctx 内自行管理连接；
//     这里去掉显式 db.commit()/db.rollback()，由注入的 ctx 决定提交语义。
//
// embedding / 向量召回：
//   当前已接入 core/llm.js 的 embed() 和 VexDB 余弦距离查询。搜索会合并向量与关键词候选，
//   尚未生成 embedding 的新指标仍可通过名称、别名和描述命中。未配置 Embedding 模型或
//   向量扩展未就绪时，生成入口返回明确降级结果，搜索继续走关键词路径。
//   has_business_metrics 统计所有激活指标，因为关键词路径同样可以供 Agent 召回。
//
// Excel 导入 / 导出（bulk_import_metrics_from_excel / import_code_values_from_excel /
//   export_code_values_to_excel）：Node 端无 pandas / openpyxl，server 也未引入 xlsx 库。
//   - 这些方法保留对外签名，但 .xlsx 二进制解析 / 生成无法在不引依赖前提下完成。
//   - 解析逻辑（行校验 / 码值 JSON 组装）已按 Python 版 1:1 迁为可复用的纯函数
//     （_parseBulkImportDataframe / _parseBulkImportRow / ...），接收「行对象数组」即可工作；
//     只把「.xlsx bytes ↔ 行数组」这一层标 TODO，调用方可注入已解析好的 rows 绕过。
//   TODO(xlsx): 接入 exceljs / sheetjs 后，在 _readExcelRows / _writeExcelRows 内补实现即可。
// =======================================================================

import { randomUUID } from 'node:crypto';

import { invalidate_cache, service_key_builder, withCache } from '../core/cache.js';
import { NotFoundError, ValidationError } from '../core/exceptions.js';
import { t } from '../utils/i18n.js';
import { embed } from '../core/llm.js';
import { vectorReady } from '../../db.js';
import { EntityServiceBase } from './entity_service_base.js';
import {
  listMetricExecutionPlans,
  replaceMetricExecutionPlans,
  validateMetricExecutionPlan,
} from './metric_execution_service.js';

// 全量向量化时每批从 DB 读取的行数，降低内存峰值
const METRIC_EMBED_BATCH_SIZE = 256;
// 与 models.MetricDefinition.embedding / FloatVector 维度一致
const METRIC_EMBEDDING_DIMENSION = 1024;
// Excel 批量导入可选列：预计算向量，写入后可跳过「全部向量化」中对该条的 embedding 调用
const BULK_IMPORT_METRIC_EMBEDDING_COLUMN = '指标向量化内容';

// metric_definitions 表名（对应 ORM __tablename__）
const METRIC_TABLE = 'metric_definitions';

// ============================================================
// pandas 兼容小工具（迁移自 pd.isna / pd.notna / 字符串处理）
// ============================================================

/** 对应 pd.isna：None / NaN / 空（不含空字符串——pandas 空字符串 notna） */
function isNa(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'number' && Number.isNaN(v)) return true;
  return false;
}

/** 对应 pd.notna */
function notNa(v) {
  return !isNa(v);
}

/** 对应 _embedding_cell_is_empty */
function _embeddingCellIsEmpty(raw) {
  if (raw === null || raw === undefined) return true;
  if (Array.isArray(raw)) return raw.length === 0;
  if (typeof raw === 'number' && Number.isNaN(raw)) return true;
  if (isNa(raw)) return true;
  return !String(raw).trim();
}

// ============================================================
// Excel 行解析（纯函数，迁移自模块级辅助函数）
// 输入为「行对象数组」（每行是 {列名: 值} 的普通对象），与 pandas DataFrame 行等价。
// ============================================================

/**
 * 解析「指标向量化内容」列；合法则返回向量，空单元格返回 null，有误则写入 errors。
 * 对应 _parse_bulk_import_embedding_column。
 * @param {string[]} columns 全部列名
 * @param {Object} row 行对象
 * @param {number} excelRowNum
 * @param {string} metricName
 * @param {Array<Object>} errors
 * @returns {number[]|null}
 */
function _parseBulkImportEmbeddingColumn(columns, row, excelRowNum, metricName, errors) {
  if (!columns.includes(BULK_IMPORT_METRIC_EMBEDDING_COLUMN)) {
    return null;
  }

  const raw = row[BULK_IMPORT_METRIC_EMBEDDING_COLUMN];

  const dimError = (vec) => {
    const n = vec.length;
    if (n !== METRIC_EMBEDDING_DIMENSION) {
      return t('向量化内容不合法：向量维度不对（需要 {} 维，当前 {} 维）。', METRIC_EMBEDDING_DIMENSION, n);
    }
    return null;
  };

  let vec = null;
  let err = null;

  if (_embeddingCellIsEmpty(raw)) {
    // 空单元格——保持原向量
  } else if (Array.isArray(raw)) {
    const tmp = [];
    let ok = true;
    for (const x of raw) {
      const f = Number(x);
      if (Number.isNaN(f)) { ok = false; break; }
      tmp.push(f);
    }
    if (!ok) {
      err = t('向量化内容不合法：无法解析为数字列表。');
    } else {
      err = dimError(tmp);
      if (err === null) vec = tmp;
    }
  } else {
    const s = String(raw).trim();
    if (s.startsWith('[')) {
      let parsed;
      try {
        parsed = JSON.parse(s);
      } catch (_) {
        parsed = undefined;
        err = t('向量化内容格式有误：JSON 无法解析。');
      }
      if (err === null && parsed !== undefined) {
        if (!Array.isArray(parsed)) {
          err = t('向量化内容格式有误：须为数字数组 [...]。');
        } else {
          const tmp = [];
          let ok = true;
          for (const x of parsed) {
            const f = Number(x);
            if (Number.isNaN(f)) { ok = false; break; }
            tmp.push(f);
          }
          if (!ok) {
            err = t('向量化内容不合法：数组内存在非数字。');
          } else {
            err = dimError(tmp);
            if (err === null) vec = tmp;
          }
        }
      }
    } else if (s.includes(',')) {
      const parts = s.split(',').map((p) => p.trim()).filter((p) => p);
      const tmp = [];
      let ok = true;
      for (const p of parts) {
        const f = Number(p);
        if (Number.isNaN(f)) { ok = false; break; }
        tmp.push(f);
      }
      if (!ok) {
        err = t('向量化内容格式有误：逗号分隔的数字无法解析。');
      } else {
        err = dimError(tmp);
        if (err === null) vec = tmp;
      }
    } else {
      err = t('向量化内容格式有误：请使用 {} 维 JSON 数组或逗号分隔数字。', METRIC_EMBEDDING_DIMENSION);
    }
  }

  if (err) {
    errors.push({ row: excelRowNum, metric_name: metricName, error: err });
  }
  return vec;
}

/**
 * 解析单行 Excel 数据（校验 + 字段提取）。返回 [payload|null, errors]。
 * 对应 _parse_bulk_import_row。
 */
function _parseBulkImportRow(row, columns, excelRowNum, normalizedSourceId, normalizedSourceType) {
  const errors = [];

  const metricName = notNa(row['指标名称']) ? String(row['指标名称']).trim() : '';
  if (!metricName) {
    errors.push({ row: excelRowNum, error: '指标名称不能为空' });
    return [null, errors];
  }

  let relatedTables = [];
  const relatedColumns = {};

  if (normalizedSourceId && normalizedSourceType) {
    if ('关联表' in row && notNa(row['关联表'])) {
      relatedTables = String(row['关联表']).split(',').map((tbl) => tbl.trim()).filter((tbl) => tbl);
    }

    if ('关联列' in row && notNa(row['关联列'])) {
      const relatedColumnsStr = String(row['关联列']);
      if (relatedColumnsStr.startsWith('{')) {
        try {
          const parsed = JSON.parse(relatedColumnsStr);
          Object.assign(relatedColumns, parsed);
        } catch (_) {
          errors.push({
            row: excelRowNum,
            metric_name: metricName,
            error: '关联列格式有误：JSON 无法解析',
          });
        }
      } else {
        for (const item of relatedColumnsStr.split(',')) {
          if (item.includes('.')) {
            const trimmed = item.trim();
            const dotIdx = trimmed.indexOf('.');
            const table = trimmed.slice(0, dotIdx);
            const col = trimmed.slice(dotIdx + 1);
            if (!(table in relatedColumns)) relatedColumns[table] = [];
            relatedColumns[table].push(col);
          }
        }
      }
    }
  }

  let aliases = null;
  if ('别名' in row && notNa(row['别名'])) {
    aliases = String(row['别名']).split(',').map((a) => a.trim()).filter((a) => a);
  }

  const description = ('描述' in row && notNa(row['描述'])) ? String(row['描述']) : null;
  const parseJsonColumn = (names, fallback = null) => {
    const name = names.find((candidate) => candidate in row && notNa(row[candidate]) && String(row[candidate]).trim());
    if (!name) return fallback;
    const raw = row[name];
    if (raw && typeof raw === 'object') return raw;
    try { return JSON.parse(String(raw)); } catch {
      errors.push({ row: excelRowNum, metric_name: metricName, error: `${name}不是有效 JSON` });
      return fallback;
    }
  };
  const rawPlans = parseJsonColumn(['执行计划JSON'], null);
  let executionPlans = null;
  if (!Array.isArray(rawPlans) || !rawPlans.length) {
    errors.push({ row: excelRowNum, metric_name: metricName, error: '执行计划JSON必须是非空数组' });
  } else {
    try {
      executionPlans = rawPlans.map((plan) => validateMetricExecutionPlan({
        ...plan,
        source_id: plan?.source_id || normalizedSourceId || null,
        source_type: plan?.source_type || normalizedSourceType || null,
      }));
    } catch (error) {
      errors.push({ row: excelRowNum, metric_name: metricName, error: error.message });
    }
  }
  const embedding = _parseBulkImportEmbeddingColumn(columns, row, excelRowNum, metricName, errors);

  if (errors.length > 0) {
    return [null, errors];
  }

  return [{
    excel_row_num: excelRowNum,
    metric_name: metricName,
    description,
    aliases,
    execution_plans: executionPlans,
    related_tables_json: JSON.stringify(relatedTables),
    related_columns_json: JSON.stringify(relatedColumns),
    embedding,
  }, []];
}

/**
 * 扫描全文件：解析每一行。返回 [通过校验的行 payload 列表, 全部错误]。
 * 对应 _parse_bulk_import_dataframe。
 * @param {Array<Object>} rows 行对象数组（pandas DataFrame 的行集合）
 * @param {string[]} columns 列名
 */
function _parseBulkImportDataframe(rows, columns, normalizedSourceId, normalizedSourceType) {
  const parsedRows = [];
  const allErrors = [];
  rows.forEach((row, idx) => {
    const [payload, rowErrors] = _parseBulkImportRow(
      row, columns, idx + 2, normalizedSourceId, normalizedSourceType,
    );
    allErrors.push(...rowErrors);
    if (payload !== null) parsedRows.push(payload);
  });
  return [parsedRows, allErrors];
}

/** 对应 _bulk_import_validation_failed_response */
function _bulkImportValidationFailedResponse(totalRows, errors) {
  return {
    success: true,
    total: totalRows,
    success_count: 0,
    created: 0,
    skipped: 0,
    updated: 0,
    failed: errors.length,
    error_count: errors.length,
    errors,
    message: t('导入校验失败，未导入任何指标（共 {} 处错误）', errors.length),
  };
}

// ============================================================
// EmbedServiceUnavailable —— 保留对外异常类型（供 GrepMetricsTool 精确捕获）
// ============================================================

/**
 * embedding 服务不可用（区别于"无匹配"业务结论）。
 * 调用方（如 GrepMetricsTool）应捕获此精确异常，转成对 LLM 友好的 error。
 * 桌面版关键词召回路径正常不抛此异常，但保留类型以兼容下游 import / instanceof。
 */
export class EmbedServiceUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmbedServiceUnavailable';
  }
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 获取指标的码值配置，处理所有空值类型。
 * 对应 _get_clean_code_knowledge。
 * 处理：null/undefined、空字符串、字符串 "null"、空对象 {}、空列表 []。
 * @param {Object} metric 指标行对象（含 code_knowledge）
 * @returns {Object|Array|null}
 */
function _getCleanCodeKnowledge(metric) {
  let ck = metric.code_knowledge;

  // PG JSONB 可能以字符串形式回来——先尝试解析
  if (typeof ck === 'string') {
    const trimmed = ck.trim();
    if (['null', '', '{}', '[]'].includes(trimmed)) return null;
    try {
      ck = JSON.parse(ck);
    } catch (_) {
      // 非 JSON 字符串，保持原值（下方 falsy 判定兜底）
    }
  }

  // 处理所有空值类型（None/""/[]/0/false）
  if (!ck) return null;

  if (typeof ck === 'object') {
    if (Array.isArray(ck)) {
      if (ck.length === 0) return null;
    } else if (Object.keys(ck).length === 0) {
      return null;
    }
  }

  return ck;
}

/**
 * 解析关联表 / 关联列等以 JSON 文本存储的列。
 * @param {*} raw
 * @param {*} fallback 解析失败 / 空时的兜底值
 */
function _parseJsonText(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

/** aliases 列（JSON）规整为数组 */
function _normalizeAliases(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }
  return [];
}

/** code_knowledge 列规整（PG JSONB 可能回字符串） */
function _normalizeCodeKnowledge(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }
  return raw;
}

/** created_at → ISO 字符串 */
function _toIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  try {
    return new Date(v).toISOString();
  } catch (_) {
    return String(v);
  }
}

// ============================================================
// 关键词召回打分（embedding 退化实现）
// 参照 schema_retrieval_service.js：question 切关键词 → 对候选文本子串命中数 → 伪 similarity(0~1)
// ============================================================

function _tokenizeQuery(question) {
  if (!question) return [];
  const lower = String(question).toLowerCase();
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

function _countHits(text, tokens) {
  if (!text || !tokens.length) return 0;
  const hay = String(text).toLowerCase();
  let hits = 0;
  for (const tk of tokens) {
    if (hay.includes(tk)) hits += 1;
  }
  return hits;
}

function _phraseMatchRank(question, metricRow) {
  const normalize = (value) => String(value || '').toLowerCase().replace(/[\s\-_.,，。；;:：/\\()（）\[\]{}]+/g, '');
  const query = normalize(question);
  if (!query) return 0;
  const candidates = [metricRow?.name, ..._normalizeAliases(metricRow?.aliases)].map(normalize).filter(Boolean);
  if (candidates.some((candidate) => candidate === query)) return 3;
  if (candidates.some((candidate) => candidate.startsWith(query) || query.startsWith(candidate))) return 2;
  if (candidates.some((candidate) => candidate.includes(query) || query.includes(candidate))) return 1;
  return 0;
}

function withMatchRank(hit, question) {
  Object.defineProperty(hit, '_matchRank', {
    value: _phraseMatchRank(question, hit), enumerable: false, configurable: true,
  });
  return hit;
}

/**
 * 对一条指标行计算关键词命中得分（name + aliases + description）。
 * 返回 0~1 的伪 similarity；distance = 2*(1-similarity) 以兼容原 cosine_distance 语义。
 */
function _keywordScoreMetric(metricRow, tokens) {
  if (!tokens.length) return { similarity: 0, distance: 2 };
  const aliases = _normalizeAliases(metricRow.aliases);
  const nameHits = _countHits(metricRow.name, tokens);
  const aliasHits = _countHits(aliases.join(' '), tokens);
  const descHits = _countHits(metricRow.description, tokens);
  // name / alias 权重高于 description
  const weighted = nameHits * 2 + aliasHits * 2 + descHits;
  const maxWeighted = tokens.length * 2; // 以 name 全命中为满分基准
  const similarity = maxWeighted > 0 ? Math.min(1, weighted / maxWeighted) : 0;
  const distance = 2 * (1 - similarity);
  return { similarity, distance };
}

/**
 * 把查询文本向量化（供 vexdb_cosine_distance 召回）。query_embedding 已给则直接用；
 * 否则调 embed()。任何失败（无 EMBEDDING 模型 / 扩展未加载）返回 null → 调用方回退关键词。
 * 参照 schema_retrieval_service.js 的 embedQuestion 写法。
 * @param {string} question
 * @param {string|null} project_id
 * @param {number[]|null} query_embedding
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
    console.warn(`[MetricService] embed 失败，回退关键词召回: ${e?.message ?? e}`);
    return null;
  }
}

// ============================================================
// MetricService
// ============================================================

export class MetricService extends EntityServiceBase {
  // ==================== 缓存失效 ====================

  /**
   * 清除指标缓存（去业务层：scope 恒为 project_id）。
   * @param {string} project_id
   */
  static async invalidate_metric_cache(project_id) {
    await invalidate_cache('get_metrics', { project_id });
    // 同步失效 Agent 工具门控判定的 has_business_metrics 缓存
    await invalidate_cache('has_business_metrics', { project_id });
  }

  // ==================== 创建 / 更新 ====================

  /**
   * 创建指标。
   * @param {{query:Function, queryOne:Function}} ctx 注入的 DB 访问对象
   * @param {Object} params 具名参数
   * @returns {Promise<{success:boolean, id:string, message:string}>}
   */
  static async create_metric(ctx, {
    name,
    project_id,
    description = null,
    related_tables = null,
    related_columns = null,
    aliases = null,
    code_knowledge = null,
    execution_plans,
  } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      // 检查名称唯一性（同一项目下，未软删）
      const existing = await ctx.queryOne(
        `SELECT 1 FROM ${METRIC_TABLE}
          WHERE project_id = $1 AND name = $2 AND deleted_at IS NULL
          LIMIT 1`,
        [project_id, name],
      );
      if (existing) {
        throw new ValidationError(t("指标名称 '{}' 已存在", name));
      }

      const relatedTablesJson = JSON.stringify(related_tables || []);
      const relatedColumnsJson = JSON.stringify(related_columns || {});
      const codeKnowledgeToSave = code_knowledge !== null ? JSON.stringify(code_knowledge) : null;
      const aliasesJson = aliases !== null ? JSON.stringify(aliases) : null;
      if (!Array.isArray(execution_plans) || !execution_plans.length) {
        throw new ValidationError('execution_plans 必须是至少包含一项的数组');
      }
      execution_plans.forEach((plan) => validateMetricExecutionPlan(plan));

      const id = randomUUID();
      const now = new Date();
      await ctx.query(
        `INSERT INTO ${METRIC_TABLE}
           (id, project_id, name, description, aliases, related_tables,
            related_columns, code_knowledge, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9, $9)`,
        [
          id, project_id, name, description, aliasesJson,
          relatedTablesJson, relatedColumnsJson, codeKnowledgeToSave, now,
        ],
      );
      try {
        await replaceMetricExecutionPlans(ctx, {
          project_id,
          metric_id: id,
          execution_plans,
        });
      } catch (error) {
        await ctx.query(`DELETE FROM metric_execution_plans WHERE project_id=$1 AND metric_id=$2`, [project_id, id]);
        await ctx.query(`DELETE FROM ${METRIC_TABLE} WHERE project_id=$1 AND id=$2`, [project_id, id]);
        throw error;
      }

      await MetricService.invalidate_metric_cache(project_id);

      console.info(`成功创建指标: ${name}`);
      return { success: true, id, message: t('成功创建指标 {}', name) };
    } catch (e) {
      console.error(`创建指标失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 更新指标。
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {Object} params 具名参数
   */
  static async update_metric(ctx, {
    metric_id,
    name,
    project_id,
    description = null,
    related_tables = null,
    related_columns = null,
    is_active = null,
    aliases = null,
    code_knowledge = null,
    execution_plans = undefined,
  } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      const metric = await ctx.queryOne(
        `SELECT id, name, aliases FROM ${METRIC_TABLE}
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_id, project_id],
      );
      if (!metric) {
        throw new NotFoundError(t('指标不存在'));
      }

      // 名称改变时检查新名称是否已存在
      if (metric.name !== name) {
        const exists = await ctx.queryOne(
          `SELECT 1 FROM ${METRIC_TABLE}
            WHERE project_id = $1 AND name = $2 AND id <> $3 AND deleted_at IS NULL
            LIMIT 1`,
          [project_id, name, metric_id],
        );
        if (exists) {
          throw new ValidationError(t("指标名称 '{}' 已存在", name));
        }
      }

      const relatedTablesJson = JSON.stringify(related_tables || []);
      const relatedColumnsJson = JSON.stringify(related_columns || {});
      const codeKnowledgeToSave = code_knowledge !== null ? JSON.stringify(code_knowledge) : null;
      const aliasesJson = aliases !== null ? JSON.stringify(aliases) : null;
      if (execution_plans !== undefined) {
        if (!Array.isArray(execution_plans) || !execution_plans.length) {
          throw new ValidationError('execution_plans 必须是至少包含一项的数组');
        }
        execution_plans.forEach((plan) => validateMetricExecutionPlan(plan));
      }

      // is_active 为 null 时保持原值
      const setActive = is_active !== null;
      const params = [
        name, description, aliasesJson, relatedTablesJson,
        relatedColumnsJson, codeKnowledgeToSave, new Date(),
      ];
      let activeClause = '';
      if (setActive) {
        params.push(is_active);
        activeClause = `, is_active = $${params.length}`;
      }
      params.push(metric_id);
      const idIdx = params.length;

      if (execution_plans !== undefined) {
        await replaceMetricExecutionPlans(ctx, {
          project_id,
          metric_id,
          execution_plans,
        });
      }
      await ctx.query(
        `UPDATE ${METRIC_TABLE}
            SET name = $1, description = $2, aliases = $3,
                related_tables = $4, related_columns = $5, code_knowledge = $6,
                updated_at = $7${activeClause}
          WHERE id = $${idIdx}`,
        params,
      );

      await MetricService.invalidate_metric_cache(project_id);

      console.info(`成功更新指标: ${name}`);
      return { success: true, id: metric_id, message: t('成功更新指标 {}', name) };
    } catch (e) {
      console.error(`更新指标失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  // ==================== 查询 ====================

  /**
   * 获取指标列表（支持分页）。
   * @param {{query:Function}} ctx
   * @param {Object} params
   * @returns {Promise<[Array<Object>, number]>} [指标列表, 总数]
   */
  static async get_metrics(ctx, {
    project_id,
    active_only = false,
    page = 1,
    page_size = 0,
  } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      const conds = ['project_id = $1', 'deleted_at IS NULL'];
      const params = [project_id];
      if (active_only) {
        conds.push('(is_active = true OR is_active IS NULL)');
      }
      const where = conds.join(' AND ');

      const countRow = await ctx.queryOne(
        `SELECT COUNT(*) AS cnt FROM ${METRIC_TABLE} WHERE ${where}`,
        params,
      );
      const total = Number(countRow?.cnt || 0);

      let sql = `SELECT * FROM ${METRIC_TABLE} WHERE ${where}
                  ORDER BY created_at DESC, id DESC`;
      const dataParams = [...params];
      if (page_size > 0) {
        dataParams.push(page_size);
        dataParams.push((page - 1) * page_size);
        sql += ` LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`;
      }

      const metrics = await ctx.query(sql, dataParams);
      const plans = await listMetricExecutionPlans(ctx, {
        project_id,
        metric_ids: metrics.map((metric) => metric.id),
      });
      const plansByMetric = new Map();
      for (const plan of plans) {
        const items = plansByMetric.get(plan.metric_id) || [];
        items.push(plan);
        plansByMetric.set(plan.metric_id, items);
      }

      return [
        metrics.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          aliases: _normalizeAliases(m.aliases),
          execution_plans: plansByMetric.get(m.id) || [],
          related_tables: _parseJsonText(m.related_tables, []),
          related_columns: _parseJsonText(m.related_columns, {}),
          code_knowledge: _normalizeCodeKnowledge(m.code_knowledge),
          has_embedding: m.embedding !== null && m.embedding !== undefined,
          embedding_model: m.embedding_model,
          is_active: m.is_active !== null && m.is_active !== undefined ? m.is_active : true,
          created_at: _toIso(m.created_at),
        })),
        total,
      ];
    } catch (e) {
      console.error(`获取指标列表失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  // ==================== 删除 ====================

  /**
   * 删除指标（软删）。
   * @param {{query:Function, queryOne:Function}} ctx
   */
  static async delete_metric(ctx, { metric_id, project_id } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      const metric = await ctx.queryOne(
        `SELECT id, name FROM ${METRIC_TABLE}
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_id, project_id],
      );
      if (!metric) {
        throw new NotFoundError(t('指标不存在'));
      }

      // 软删（对齐项目软删约定；Python 版用 db.delete 物理删，桌面版统一软删）
      await ctx.query(
        `UPDATE ${METRIC_TABLE} SET deleted_at = $1 WHERE id = $2`,
        [new Date(), metric_id],
      );
      await ctx.query(
        `UPDATE metric_execution_plans
            SET deleted_at = $1, is_active = false, updated_at = $1
          WHERE metric_id = $2 AND project_id = $3 AND deleted_at IS NULL`,
        [new Date(), metric_id, project_id],
      );

      await MetricService.invalidate_metric_cache(project_id);

      console.info(`成功删除指标: ${metric.name}`);
      return true;
    } catch (e) {
      console.error(`删除指标失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 批量删除指标（忽略不存在的 ID，返回实际删除数量）。
   * @param {{query:Function}} ctx
   */
  static async delete_metrics(ctx, { metric_ids, project_id } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      if (!metric_ids || metric_ids.length === 0) {
        throw new ValidationError(t('metric_ids 不能为空'));
      }
      const uniqueIds = [...new Set(metric_ids.filter((mid) => mid))];
      if (uniqueIds.length === 0) {
        throw new ValidationError(t('metric_ids 不能为空'));
      }

      const rows = await ctx.query(
        `UPDATE ${METRIC_TABLE} SET deleted_at = $1
          WHERE project_id = $2 AND id::text = ANY($3::text[]) AND deleted_at IS NULL
          RETURNING id`,
        [new Date(), project_id, uniqueIds],
      );
      const deletedCount = Array.isArray(rows) ? rows.length : 0;
      if (deletedCount > 0) {
        await ctx.query(
          `UPDATE metric_execution_plans
              SET deleted_at = $1, is_active = false, updated_at = $1
            WHERE project_id = $2 AND metric_id::text = ANY($3::text[]) AND deleted_at IS NULL`,
          [new Date(), project_id, uniqueIds],
        );
      }

      await MetricService.invalidate_metric_cache(project_id);

      console.info(`成功批量删除指标: project_id=${project_id}, deleted_count=${deletedCount}`);
      return deletedCount;
    } catch (e) {
      console.error(`批量删除指标失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 删除项目下全部未删除的指标（软删）。
   * @param {{query:Function}} ctx
   */
  static async delete_all_metrics(ctx, { project_id } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      const rows = await ctx.query(
        `UPDATE ${METRIC_TABLE} SET deleted_at = $1
          WHERE project_id = $2 AND deleted_at IS NULL
          RETURNING id`,
        [new Date(), project_id],
      );
      const deletedCount = Array.isArray(rows) ? rows.length : 0;
      if (deletedCount > 0) {
        await ctx.query(
          `UPDATE metric_execution_plans
              SET deleted_at = $1, is_active = false, updated_at = $1
            WHERE project_id = $2 AND deleted_at IS NULL`,
          [new Date(), project_id],
        );
      }

      await MetricService.invalidate_metric_cache(project_id);

      console.info(`成功删除项目全部指标: project_id=${project_id}, deleted_count=${deletedCount}`);
      return deletedCount;
    } catch (e) {
      console.error(`删除项目全部指标失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  // ==================== 启用 / 禁用 ====================

  /**
   * 更新单个指标的启用 / 禁用状态。
   * @param {{query:Function, queryOne:Function}} ctx
   */
  static async update_metric_status(ctx, { metric_id, is_active, project_id } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      const metric = await ctx.queryOne(
        `SELECT id, name FROM ${METRIC_TABLE}
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [metric_id, project_id],
      );
      if (!metric) {
        throw new NotFoundError(t('指标不存在'));
      }

      await ctx.query(
        `UPDATE ${METRIC_TABLE} SET is_active = $1, updated_at = $2 WHERE id = $3`,
        [is_active, new Date(), metric_id],
      );

      await MetricService.invalidate_metric_cache(project_id);

      console.info(`成功更新指标状态: ${metric.name} -> is_active=${is_active}`);
      return true;
    } catch (e) {
      console.error(`更新指标状态失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 批量更新指标的启用 / 禁用状态。
   * @param {{query:Function}} ctx
   */
  static async batch_update_metrics_status(ctx, { metric_ids, is_active, project_id } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      if (!metric_ids || metric_ids.length === 0) {
        throw new ValidationError(t('metric_ids 不能为空'));
      }
      const uniqueIds = [...new Set(metric_ids.filter((mid) => mid))];
      if (uniqueIds.length === 0) {
        throw new ValidationError(t('metric_ids 不能为空'));
      }

      const rows = await ctx.query(
        `UPDATE ${METRIC_TABLE} SET is_active = $1, updated_at = $2
          WHERE project_id = $3 AND id::text = ANY($4::text[]) AND deleted_at IS NULL
          RETURNING id`,
        [is_active, new Date(), project_id, uniqueIds],
      );
      const updatedCount = Array.isArray(rows) ? rows.length : 0;

      await MetricService.invalidate_metric_cache(project_id);

      console.info(
        `成功批量更新指标状态: project_id=${project_id}, is_active=${is_active}, updated_count=${updatedCount}`,
      );
      return updatedCount;
    } catch (e) {
      console.error(`批量更新指标状态失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  // ==================== 向量化文本 ====================

  /**
   * 拼接指标向量化文本：name + 别名。对应 _metric_embedding_text。
   * @param {Object} m 指标行对象
   * @returns {string}
   */
  static _metric_embedding_text(m) {
    const aliases = _normalizeAliases(m.aliases);
    let text = m.name;
    if (aliases.length > 0) {
      const aliasStr = aliases.join(', ');
      text = `${m.name} (别名: ${aliasStr})`;
    }
    return text;
  }

  /**
   * 一批指标在同一连接上批量更新向量。对应 _bulk_apply_metric_embeddings。
   * 用于写入上层显式提供的向量，例如 Excel 中的预计算向量。
   * @param {{query:Function}} ctx
   * @param {string[]} ids
   * @param {Array<*>} embeddings
   */
  static async _bulk_apply_metric_embeddings(ctx, ids, embeddings) {
    if (!ids || ids.length === 0) return;
    for (let i = 0; i < ids.length; i += 1) {
      const emb = embeddings[i];
      const embText = Array.isArray(emb) ? JSON.stringify(emb) : emb;
      await ctx.query(
        `UPDATE ${METRIC_TABLE} SET embedding = $1, embedding_model = $2 WHERE id = $3`,
        [embText, 'default', ids[i]],
      );
    }
  }

  // ==================== 向量计数 / 生成 ====================

  /**
   * 统计尚未写入向量的指标数量（embedding IS NULL）。
   * @param {{queryOne:Function}} ctx
   */
  static async count_metrics_pending_embedding(ctx, { project_id } = {}) {
    await MetricService._validate_business(ctx, project_id);
    const row = await ctx.queryOne(
      `SELECT COUNT(*) AS cnt FROM ${METRIC_TABLE}
        WHERE project_id = $1 AND deleted_at IS NULL AND embedding IS NULL`,
      [project_id],
    );
    return Number(row?.cnt || 0);
  }

  /**
   * 分批对「尚未写入向量」的指标生成 embedding。
   * 对应 batch_generate_all_metric_embeddings。
   *
   * 对该项目下 embedding IS NULL 的指标，按批（每批 ≤ 16 条）组合文本→embed()→写回 embedding。
   * embed 失败 / 无 EMBEDDING 模型时 catch 后返回 processed=0（保留降级，不抛）。
   * @param {{query:Function, queryOne:Function}} ctx
   */
  static async batch_generate_all_metric_embeddings(ctx, { project_id } = {}) {
    await MetricService._validate_business(ctx, project_id);

    const row = await ctx.queryOne(
      `SELECT COUNT(*) AS cnt FROM ${METRIC_TABLE}
        WHERE project_id = $1 AND deleted_at IS NULL AND embedding IS NULL`,
      [project_id],
    );
    const pending = Number(row?.cnt || 0);

    // 向量服务不可用：保留降级（no-op，processed=0），不抛异常
    if (!vectorReady) {
      console.warn(
        '[metric_service] 向量扩展未就绪：batch_generate_all_metric_embeddings 退化为 no-op '
        + `project_id=${project_id} pending=${pending}`,
      );
      return {
        completed: false,
        success: false,
        total: pending,
        pending,
        processed: 0,
        batches: 0,
        message: t('当前环境未启用向量服务，已跳过指标向量生成（关键词召回不依赖向量）'),
      };
    }

    let processed = 0;
    let batches = 0;
    const EMBED_BATCH = 16;

    try {
      // 分页从 DB 读取待向量化指标（按 id 稳定排序，写回后下一页自然跳过已处理项）
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const metrics = await ctx.query(
          `SELECT id, name, aliases, description FROM ${METRIC_TABLE}
            WHERE project_id = $1 AND deleted_at IS NULL AND embedding IS NULL
            ORDER BY id
            LIMIT $2`,
          [project_id, METRIC_EMBED_BATCH_SIZE],
        );
        if (!metrics || !metrics.length) break;

        for (let i = 0; i < metrics.length; i += EMBED_BATCH) {
          const slice = metrics.slice(i, i + EMBED_BATCH);
          const texts = slice.map((m) => MetricService._metric_embedding_text_for_recall(m));
          let vecs;
          try {
            vecs = await embed(texts, { project_id });
          } catch (e) {
            console.warn(`[MetricService] 指标向量生成失败，停止（保留降级）: ${e?.message ?? e}`);
            return {
              completed: false,
              success: false,
              total: pending,
              pending,
              processed,
              batches,
              message: t('当前环境未启用向量服务，已跳过指标向量生成（关键词召回不依赖向量）'),
            };
          }
          if (!Array.isArray(vecs) || !vecs.length) {
            console.warn('[MetricService] 指标向量生成返回空，停止（保留降级）');
            return {
              completed: false, success: false, total: pending, pending, processed, batches,
              message: t('当前环境未启用向量服务，已跳过指标向量生成（关键词召回不依赖向量）'),
            };
          }
          const now = new Date();
          for (let j = 0; j < slice.length; j += 1) {
            const vec = vecs[j];
            if (!Array.isArray(vec) || !vec.length) continue;
            await ctx.query(
              `UPDATE ${METRIC_TABLE}
                  SET embedding = $1, embedding_model = $2, updated_at = $3 WHERE id = $4`,
              [JSON.stringify(vec), 'text-embedding-v3', now, slice[j].id],
            );
            processed += 1;
          }
          batches += 1;
        }

        // 本页全部 embed 失败（一条都没写回）→ 避免死循环，退出
        if (processed === 0) break;
        // 若本页行数不足一整页，说明已无更多待处理项
        if (metrics.length < METRIC_EMBED_BATCH_SIZE) break;
      }

      await MetricService.invalidate_metric_cache(project_id);

      console.info(
        `[metric_service] 指标向量生成完成: project_id=${project_id} `
        + `total=${pending} processed=${processed} batches=${batches}`,
      );
      return {
        completed: true,
        success: true,
        total: pending,
        pending: Math.max(0, pending - processed),
        processed,
        batches,
        message: t('指标向量生成完成：共处理 {} 条', processed),
      };
    } catch (e) {
      console.error(`[metric_service] 指标向量生成异常（保留降级）: ${e?.message ?? e}`);
      return {
        completed: false, success: false, total: pending, pending, processed, batches,
        message: t('当前环境未启用向量服务，已跳过指标向量生成（关键词召回不依赖向量）'),
      };
    }
  }

  /**
   * 召回用向量化文本：name + aliases + description（aliases 拼成空格分隔）。
   * 与 search_metrics 的关键词字段（name/aliases/description）对齐，保证召回语义一致。
   * @param {Object} m 指标行对象
   * @returns {string}
   */
  static _metric_embedding_text_for_recall(m) {
    const aliases = _normalizeAliases(m.aliases);
    const parts = [m.name];
    if (aliases.length) parts.push(aliases.join(' '));
    if (m.description) parts.push(String(m.description));
    return parts.filter((p) => p && String(p).trim()).join(' ');
  }

  /**
   * 生成指标向量（含别名语义）。未指定 metric_id 时走 batch_generate_all_metric_embeddings。
   * 对应 generate_metric_embeddings。
   *
   * 指定 metric_id 时：组合 name + aliases + description → embed() → 写回 embedding。
   * embed 失败 / 无 EMBEDDING 模型时 catch 后返回 processed=0（保留降级，不抛）。
   * @param {{query:Function, queryOne:Function}} ctx
   */
  static async generate_metric_embeddings(ctx, { project_id, metric_id = null } = {}) {
    if (!metric_id) {
      return MetricService.batch_generate_all_metric_embeddings(ctx, { project_id });
    }

    await MetricService._validate_business(ctx, project_id);

    const metric = await ctx.queryOne(
      `SELECT id, name, aliases, description FROM ${METRIC_TABLE}
        WHERE project_id = $1 AND deleted_at IS NULL AND id = $2`,
      [project_id, metric_id],
    );

    if (!metric) {
      return {
        success: false,
        completed: false,
        total: 0,
        processed: 0,
        message: t('没有找到需要生成向量的指标'),
      };
    }

    if (!vectorReady) {
      console.warn(
        '[metric_service] 向量扩展未就绪：generate_metric_embeddings 退化为 no-op '
        + `project_id=${project_id} metric_id=${metric_id}`,
      );
      return {
        success: true,
        completed: true,
        total: 1,
        processed: 0,
        message: t('当前环境未启用向量服务，已跳过指标向量生成（关键词召回不依赖向量）'),
      };
    }

    try {
      const text = MetricService._metric_embedding_text_for_recall(metric);
      const vec = await embed(text, { project_id });
      if (Array.isArray(vec) && vec.length) {
        await ctx.query(
          `UPDATE ${METRIC_TABLE}
              SET embedding = $1, embedding_model = $2, updated_at = $3 WHERE id = $4`,
          [JSON.stringify(vec), 'text-embedding-v3', new Date(), metric.id],
        );
        await MetricService.invalidate_metric_cache(project_id);
        return {
          success: true,
          completed: true,
          total: 1,
          processed: 1,
          message: t('指标向量生成完成：共处理 {} 条', 1),
        };
      }
    } catch (e) {
      console.warn(`[MetricService] 单指标向量生成失败（保留降级）: ${e?.message ?? e}`);
    }

    return {
      success: false,
      completed: false,
      total: 1,
      processed: 0,
      message: t('当前环境未启用向量服务，已跳过指标向量生成（关键词召回不依赖向量）'),
    };
  }

  // ==================== 召回（向量 + 关键词混合） ====================

  /**
   * 召回指标（向量相似度 + 关键词/名称/别名/描述子串打分混合召回，取较高分融合；无向量时退化为关键词路径）。
   * 对应 search_metrics。只召回激活的指标（NULL 视为激活）。
   *
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {Object} params
   * @param {string} params.query_text 查询文本
   * @param {string} params.project_id
   * @param {number} [params.limit=5]
   * @returns {Promise<Array<Object>>}
   * @throws {EmbedServiceUnavailable} 保留类型兼容；关键词路径正常不抛
   */
  static async search_metrics(ctx, {
    query_text, project_id, limit = 5, offset = 0, query_embedding = null,
  } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);
      const safeLimit = Math.max(0, Number.parseInt(limit, 10) || 0);
      const safeOffset = Math.max(0, Number.parseInt(offset, 10) || 0);
      if (safeLimit === 0) return [];

      // 始终生成关键词排序。这样部分指标尚未生成 embedding 时，也不会被向量路径永久隐藏。
      const tokens = _tokenizeQuery(query_text);
      const rows = await ctx.query(
        `SELECT id, name, description, aliases,
                related_tables, related_columns, code_knowledge
           FROM ${METRIC_TABLE}
          WHERE project_id = $1
            AND deleted_at IS NULL
            AND (is_active = true OR is_active IS NULL)`,
        [project_id],
      );

      const keywordHits = [];
      for (const m of rows) {
        const { similarity, distance } = _keywordScoreMetric(m, tokens);
        keywordHits.push(withMatchRank(MetricService._formatMetricHit(m, similarity, distance), query_text));
      }

      keywordHits.sort((a, b) => b._matchRank - a._matchRank
        || b.similarity - a.similarity
        || String(a.name || '').localeCompare(String(b.name || ''))
        || String(a.id || '').localeCompare(String(b.id || '')));

      const qvec = await embedQuestion(query_text, project_id, query_embedding);
      if (!qvec || !rows.length) {
        return keywordHits.slice(safeOffset, safeOffset + safeLimit);
      }

      const vectorHits = await MetricService._vectorScoreMetrics(ctx, project_id, qvec, rows.length);
      if (!vectorHits.length) {
        return keywordHits.slice(safeOffset, safeOffset + safeLimit);
      }

      // 合并两个候选集并取较高召回分，不设置阈值。未生成 embedding 的新指标仍可凭关键词进入前页。
      const fused = new Map();
      const addRanking = (hits) => {
        hits.forEach((hit) => {
          const id = String(hit.id || '');
          if (!id) return;
          const score = Number(hit.similarity || 0);
          const current = fused.get(id) || { hit, score: Number.NEGATIVE_INFINITY, matchRank: 0 };
          current.matchRank = Math.max(current.matchRank, _phraseMatchRank(query_text, hit));
          if (score > current.score) {
            current.hit = hit;
            current.score = score;
          }
          fused.set(id, current);
        });
      };
      addRanking(vectorHits);
      addRanking(keywordHits);
      const ranked = [...fused.values()].sort((a, b) => b.matchRank - a.matchRank
        || b.score - a.score
        || String(a.hit.name || '').localeCompare(String(b.hit.name || ''))
        || String(a.hit.id || '').localeCompare(String(b.hit.id || '')));

      console.log(`[MetricService] 混合召回指标: vector=${vectorHits.length} keyword=${keywordHits.length}`);
      return ranked.slice(safeOffset, safeOffset + safeLimit).map((item) => item.hit);
    } catch (e) {
      if (e instanceof EmbedServiceUnavailable) {
        // 透传给调用方，由其转成对 LLM 友好的 error
        throw e;
      }
      console.error(`搜索指标失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * vexdb_cosine_distance 向量召回指标：对该项目下有 embedding 的激活指标（NULL 视为激活）
   * 按余弦距离升序取 top-N。similarity = max(0, 1 - distance)，与关键词路径返回结构完全一致。
   * @param {{query:Function}} ctx
   * @param {string} project_id
   * @param {number[]} queryVec
   * @param {number} limit
   * @returns {Promise<Array<Object>>}
   */
  static async _vectorScoreMetrics(ctx, project_id, queryVec, limit) {
    const rows = await ctx.query(
      `SELECT id, name, description, aliases,
              related_tables, related_columns, code_knowledge,
              vexdb_cosine_distance(embedding, vexdb_f32($1)) AS distance
         FROM ${METRIC_TABLE}
        WHERE project_id = $2
          AND embedding IS NOT NULL
          AND deleted_at IS NULL
          AND (is_active = true OR is_active IS NULL)
        ORDER BY distance ASC, id ASC
        LIMIT $3`,
      [JSON.stringify(queryVec), project_id, Math.max(0, limit)],
    ).catch((e) => {
      console.warn(`[MetricService] 向量召回指标 SQL 失败: ${e?.message ?? e}`);
      return [];
    });
    return rows.map((m) => {
      const distance = Number(m.distance ?? 1);
      const similarity = Math.max(0, 1 - distance);
      return MetricService._formatMetricHit(m, similarity, distance);
    });
  }

  /**
   * 统一格式化召回命中（向量 / 关键词两条路共用，保证返回结构 100% 一致）。
   * @param {Object} m 指标行对象
   * @param {number} similarity
   * @param {number} distance
   * @returns {Object}
   */
  static _formatMetricHit(m, similarity, distance) {
    return {
      id: m.id,
      name: m.name,
      description: m.description,
      aliases: _normalizeAliases(m.aliases),
      related_tables: _parseJsonText(m.related_tables, []),
      related_columns: _parseJsonText(m.related_columns, {}),
      code_knowledge: _normalizeCodeKnowledge(m.code_knowledge),
      similarity,
      distance,
      rule: m.description,
    };
  }

  // ==================== Excel 批量导入 ====================

  /**
   * 读取 .xlsx bytes → 行对象数组 + 列名。
   *
   * TODO(xlsx): server 端未引入 xlsx / exceljs 库，无法解析 .xlsx 二进制。
   * 若 input 已是「{ rows, columns }」结构（上层预解析），直接透传；
   * 否则抛 ValidationError 提示需注入已解析的行数据。
   * @param {{rows?:Array<Object>, columns?:string[]}|Uint8Array|Buffer} fileBytes
   * @returns {{rows:Array<Object>, columns:string[]}}
   */
  static _readExcelRows(fileBytes) {
    if (fileBytes && typeof fileBytes === 'object' && Array.isArray(fileBytes.rows)) {
      const rows = fileBytes.rows;
      const columns = Array.isArray(fileBytes.columns) && fileBytes.columns.length
        ? fileBytes.columns.map((c) => String(c).trim())
        : [...new Set(rows.flatMap((r) => Object.keys(r)))];
      return { rows, columns };
    }
    throw new ValidationError(
      t('当前环境未启用 Excel 解析，请改用预解析的行数据（{ rows, columns }）导入指标'),
    );
  }

  /**
   * 从 Excel 批量导入指标。对应 bulk_import_metrics_from_excel。
   *
   * 行校验 / 写库逻辑 1:1 保留；仅「.xlsx bytes → 行数组」依赖 _readExcelRows（见其 TODO）。
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {Object} params
   */
  static async bulk_import_metrics_from_excel(ctx, {
    source_id = null,
    source_type = null,
    file_bytes,
    project_id,
    overwrite = false,
  } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      const normalizedSourceId = source_id && String(source_id).trim() ? String(source_id).trim() : null;
      const normalizedSourceType = source_type && String(source_type).trim() ? String(source_type).trim() : null;

      const { rows, columns } = MetricService._readExcelRows(file_bytes);

      // 校验必需列
      const requiredCols = ['指标名称', '执行计划JSON'];
      const missingCols = requiredCols.filter((col) => !columns.includes(col));
      if (missingCols.length > 0) {
        throw new ValidationError(t('Excel缺少必需列: {}', JSON.stringify(missingCols)));
      }

      // 文件内部重复指标名称检测
      const metricNamesInFile = rows.map((r) => (notNa(r['指标名称']) ? String(r['指标名称']).trim() : ''));
      const nameCounts = new Map();
      for (const nm of metricNamesInFile) nameCounts.set(nm, (nameCounts.get(nm) || 0) + 1);
      const duplicatesInFile = [...nameCounts.entries()]
        .filter(([nm, cnt]) => nm && cnt > 1)
        .map(([nm]) => nm);
      if (duplicatesInFile.length > 0) {
        throw new ValidationError(t('Excel文件中存在重复的指标名称: {}', duplicatesInFile.join(', ')));
      }

      const validMetricNames = metricNamesInFile.filter((nm) => nm);
      if (validMetricNames.length === 0) {
        throw new ValidationError(t('Excel文件中没有有效的指标名称'));
      }

      // Phase 1：全文件解析 + 校验
      const [parsedRows, validationErrors] = _parseBulkImportDataframe(
        rows, columns, normalizedSourceId, normalizedSourceType,
      );
      if (validationErrors.length > 0) {
        return _bulkImportValidationFailedResponse(rows.length, validationErrors);
      }

      // 查询已存在指标
      const uniqueNamesToCheck = [...new Set(validMetricNames)];
      const existingMetricsRows = await ctx.query(
        `SELECT name, id FROM ${METRIC_TABLE}
          WHERE project_id = $1 AND name::text = ANY($2::text[]) AND deleted_at IS NULL`,
        [project_id, uniqueNamesToCheck],
      );
      const existingNames = new Map(existingMetricsRows.map((row) => [row.name, row]));

      // Phase 2：写入
      let successCount = 0;
      let skippedCount = 0;
      let updatedCount = 0;
      let createdWithoutEmbedding = 0;
      const hasEmbeddingColumn = columns.includes(BULK_IMPORT_METRIC_EMBEDDING_COLUMN);

      for (const payload of parsedRows) {
        const metricName = payload.metric_name;
        const aliases = payload.aliases;
        const importedEmbedding = payload.embedding;
        const aliasesJson = aliases !== null ? JSON.stringify(aliases) : null;
        const embText = importedEmbedding !== null && importedEmbedding !== undefined
          ? JSON.stringify(importedEmbedding) : null;

        if (existingNames.has(metricName)) {
          if (!overwrite) {
            skippedCount += 1;
            continue;
          }

          const existingMetric = existingNames.get(metricName);
          const params = [
            payload.related_tables_json, payload.related_columns_json,
            payload.description, aliasesJson, new Date(),
          ];
          let embClause = '';
          if (importedEmbedding !== null && importedEmbedding !== undefined) {
            params.push(embText);
            embClause += `, embedding = $${params.length}`;
            params.push('imported');
            embClause += `, embedding_model = $${params.length}`;
          }
          params.push(existingMetric.id);
          const idIdx = params.length;

          await replaceMetricExecutionPlans(ctx, {
            project_id,
            metric_id: existingMetric.id,
            execution_plans: payload.execution_plans,
          });
          await ctx.query(
            `UPDATE ${METRIC_TABLE}
                SET related_tables = $1, related_columns = $2,
                    description = $3, aliases = $4, updated_at = $5${embClause}
              WHERE id = $${idIdx}`,
            params,
          );
          updatedCount += 1;
          continue;
        }

        const id = randomUUID();
        const now = new Date();
        await ctx.query(
          `INSERT INTO ${METRIC_TABLE}
             (id, project_id, name, description, aliases,
              related_tables, related_columns, is_active,
              embedding, embedding_model, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9, $10, $10)`,
          [
            id, project_id, metricName, payload.description, aliasesJson,
            payload.related_tables_json, payload.related_columns_json,
            embText, embText !== null ? 'imported' : null, now,
          ],
        );
        try {
          await replaceMetricExecutionPlans(ctx, {
            project_id,
            metric_id: id,
            execution_plans: payload.execution_plans,
          });
        } catch (error) {
          await ctx.query(`DELETE FROM metric_execution_plans WHERE project_id=$1 AND metric_id=$2`, [project_id, id]);
          await ctx.query(`DELETE FROM ${METRIC_TABLE} WHERE project_id=$1 AND id=$2`, [project_id, id]);
          throw error;
        }
        successCount += 1;
        if (importedEmbedding === null || importedEmbedding === undefined) {
          createdWithoutEmbedding += 1;
        }
      }

      await MetricService.invalidate_metric_cache(project_id);

      const createdCount = successCount;
      const needsEmbeddingPrompt = createdWithoutEmbedding > 0;
      return {
        success: true,
        total: rows.length,
        success_count: successCount,
        created: createdCount,
        skipped: skippedCount,
        updated: updatedCount,
        failed: 0,
        error_count: 0,
        errors: [],
        has_embedding_column: hasEmbeddingColumn,
        needs_embedding_prompt: needsEmbeddingPrompt,
        pending_embedding_count: createdWithoutEmbedding,
        message: t('导入完成: 新增{}个, 跳过{}个, 覆盖{}个, 失败{}个', createdCount, skippedCount, updatedCount, 0),
      };
    } catch (e) {
      console.error(`批量导入失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  // ==================== 码值 Excel 导入 / 导出 ====================

  /**
   * 解析关键词字符串，返回列表。对应 _parse_keywords。
   * @param {*} keywordsStr
   * @returns {string[]}
   */
  static _parse_keywords(keywordsStr) {
    if (isNa(keywordsStr) || !keywordsStr) return [];
    const str = String(keywordsStr).trim();
    for (const sep of [',', ';', '、', '\n', '|']) {
      if (str.includes(sep)) {
        return str.split(sep).map((k) => k.trim()).filter((k) => k);
      }
    }
    return str ? [str] : [];
  }

  /**
   * 从 Excel 导入码值配置到指标。对应 import_code_values_from_excel。
   *
   * 码值组装逻辑 1:1 保留；.xlsx 解析依赖 _readExcelRows（见其 TODO）。
   * @param {{query:Function, queryOne:Function}} ctx
   * @param {Object} params
   */
  static async import_code_values_from_excel(ctx, {
    source_id,
    source_type,
    file_bytes,
    project_id,
    import_format = 'by-metric',
  } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);
      const { rows, columns } = MetricService._readExcelRows(file_bytes);

      let successCount = 0;
      const errorRows = [];

      // 待写回的 code_knowledge（metric_id -> 对象），末尾统一 UPDATE
      const pendingUpdates = new Map();

      const groupBy = (key) => {
        const groups = new Map();
        for (const r of rows) {
          const gk = r[key];
          const gkStr = isNa(gk) ? '' : String(gk);
          if (!groups.has(gkStr)) groups.set(gkStr, []);
          groups.get(gkStr).push(r);
        }
        return groups;
      };

      let groupedSize = 0;

      if (import_format === 'by-metric') {
        const requiredCols = ['指标名称'];
        const missingCols = requiredCols.filter((col) => !columns.includes(col));
        if (missingCols.length > 0) {
          throw new ValidationError(t('Excel缺少必需列: {}', JSON.stringify(missingCols)));
        }

        const grouped = groupBy('指标名称');
        groupedSize = grouped.size;
        const metricNames = [...grouped.keys()];
        console.info(`准备导入 ${metricNames.length} 个指标的码值`);

        const metricsResult = await ctx.query(
          `SELECT * FROM ${METRIC_TABLE}
            WHERE project_id = $1 AND name::text = ANY($2::text[]) AND deleted_at IS NULL`,
          [project_id, metricNames],
        );
        const metricsDict = new Map(metricsResult.map((m) => [m.name, m]));
        console.info(`找到 ${metricsDict.size} 个已存在的指标`);

        for (const [metricName, group] of grouped.entries()) {
          try {
            const metric = metricsDict.get(metricName);
            if (!metric) {
              console.warn(`指标不存在: ${metricName}`);
              errorRows.push({ metric: metricName, error: '指标不存在' });
              continue;
            }

            const existingCk = _getCleanCodeKnowledge(metric);
            const codeKnowledge = existingCk || { fields: [], common_filters: [] };
            const fieldsMap = new Map((codeKnowledge.fields || []).map((f) => [f.field_name, f]));
            const filtersMap = new Map((codeKnowledge.common_filters || []).map((f) => [f.description, f]));

            for (const row of group) {
              const fieldName = row['字段名'];
              if (isNa(fieldName) || !fieldName) {
                // 处理过滤条件
                const filterDesc = row['过滤条件说明'];
                const filterCondition = row['SQL条件'];
                if (notNa(filterDesc) && notNa(filterCondition)) {
                  if (!filtersMap.has(filterDesc)) {
                    filtersMap.set(filterDesc, {
                      description: String(filterDesc),
                      condition: String(filterCondition),
                      user_keywords: MetricService._parse_keywords(row['用户关键词'] ?? ''),
                    });
                  }
                }
                continue;
              }

              if (!fieldsMap.has(fieldName)) {
                fieldsMap.set(fieldName, {
                  field_name: fieldName,
                  field_display_name: row['字段显示名'] ?? fieldName,
                  description: row['字段描述'] ?? '',
                  code_values: [],
                });
              }
              const fieldConfig = fieldsMap.get(fieldName);

              const code = row['码值编码'];
              const label = row['码值标签'];
              if (notNa(code) && notNa(label)) {
                const codeValues = fieldConfig.code_values || [];
                const existing = codeValues.some((cv) => cv.code === String(code));
                if (!existing) {
                  codeValues.push({
                    code: String(code),
                    label: String(label),
                    aliases: MetricService._parse_keywords(row['码值别名'] ?? ''),
                    description: row['码值描述'] ?? '',
                  });
                }
                fieldConfig.code_values = codeValues;
              }

              const filterDesc = row['过滤条件说明'];
              const filterCondition = row['SQL条件'];
              if (notNa(filterDesc) && notNa(filterCondition)) {
                if (!filtersMap.has(filterDesc)) {
                  filtersMap.set(filterDesc, {
                    description: String(filterDesc),
                    condition: String(filterCondition),
                    user_keywords: MetricService._parse_keywords(row['用户关键词'] ?? ''),
                  });
                }
              }
            }

            codeKnowledge.fields = [...fieldsMap.values()];
            codeKnowledge.common_filters = [...filtersMap.values()];
            pendingUpdates.set(metric.id, codeKnowledge);
            successCount += 1;
          } catch (e) {
            errorRows.push({ metric: metricName, error: String(e?.message ?? e) });
            console.warn(`导入指标 ${metricName} 码值失败: ${e?.message ?? e}`);
          }
        }
      } else {
        // by-field
        const requiredCols = ['字段名', '关联指标'];
        const missingCols = requiredCols.filter((col) => !columns.includes(col));
        if (missingCols.length > 0) {
          throw new ValidationError(t('Excel缺少必需列: {}', JSON.stringify(missingCols)));
        }

        const grouped = groupBy('字段名');
        groupedSize = grouped.size;

        const allRelatedMetrics = new Set();
        for (const group of grouped.values()) {
          const firstRow = group[0];
          const relatedMetricsStr = firstRow['关联指标'] ?? '';
          for (const m of String(relatedMetricsStr).split(',').map((s) => s.trim()).filter((s) => s)) {
            allRelatedMetrics.add(m);
          }
        }

        let metricsDict = new Map();
        if (allRelatedMetrics.size > 0) {
          console.info(`准备更新 ${allRelatedMetrics.size} 个关联指标的码值`);
          const metricsResult = await ctx.query(
            `SELECT * FROM ${METRIC_TABLE}
              WHERE project_id = $1 AND name::text = ANY($2::text[]) AND deleted_at IS NULL`,
            [project_id, [...allRelatedMetrics]],
          );
          metricsDict = new Map(metricsResult.map((m) => [m.name, m]));
          console.info(`找到 ${metricsDict.size} 个已存在的指标`);
        }

        for (const [fieldName, group] of grouped.entries()) {
          try {
            const firstRow = group[0];
            const fieldDisplayName = firstRow['字段显示名'] ?? fieldName;
            const fieldDescription = firstRow['字段描述'] ?? '';

            const relatedMetricsStr = firstRow['关联指标'] ?? '';
            const relatedMetrics = String(relatedMetricsStr).split(',').map((s) => s.trim()).filter((s) => s);

            if (relatedMetrics.length === 0) {
              errorRows.push({ field: fieldName, error: '未指定关联指标' });
              continue;
            }

            const codeValues = [];
            for (const row of group) {
              const code = row['码值编码'];
              const label = row['码值标签'];
              if (notNa(code) && notNa(label)) {
                codeValues.push({
                  code: String(code),
                  label: String(label),
                  aliases: MetricService._parse_keywords(row['码值别名'] ?? ''),
                  description: row['码值描述'] ?? '',
                });
              }
            }

            if (codeValues.length === 0) {
              errorRows.push({ field: fieldName, error: '没有有效的码值数据' });
              continue;
            }

            for (const metricName of relatedMetrics) {
              const metric = metricsDict.get(metricName);
              if (!metric) {
                errorRows.push({ metric: metricName, error: '指标不存在' });
                continue;
              }

              // 复用 pendingUpdates 中已累积的 code_knowledge（同一指标被多字段引用）
              const existingCk = pendingUpdates.get(metric.id) || _getCleanCodeKnowledge(metric)
                || { fields: [], common_filters: [] };
              const fieldsMap = new Map((existingCk.fields || []).map((f) => [f.field_name, f]));

              fieldsMap.set(fieldName, {
                field_name: fieldName,
                field_display_name: fieldDisplayName,
                description: fieldDescription,
                code_values: codeValues,
              });

              existingCk.fields = [...fieldsMap.values()];
              if (!existingCk.common_filters) existingCk.common_filters = [];
              pendingUpdates.set(metric.id, existingCk);
              successCount += 1;
            }
          } catch (e) {
            errorRows.push({ field: fieldName, error: String(e?.message ?? e) });
            console.warn(`导入字段 ${fieldName} 码值失败: ${e?.message ?? e}`);
          }
        }
      }

      // 统一写回 code_knowledge
      for (const [metricId, ck] of pendingUpdates.entries()) {
        await ctx.query(
          `UPDATE ${METRIC_TABLE} SET code_knowledge = $1, updated_at = $2 WHERE id = $3`,
          [JSON.stringify(ck), new Date(), metricId],
        );
      }

      await MetricService.invalidate_metric_cache(project_id);

      return {
        success: true,
        total: import_format === 'by-metric' ? rows.length : groupedSize,
        success_count: successCount,
        error_count: errorRows.length,
        errors: errorRows,
        message: t('成功导入 {} 条码值配置', successCount),
      };
    } catch (e) {
      console.error(`导入码值失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 导出指标码值配置为「行对象数组」。对应 export_code_values_to_excel。
   *
   * TODO(xlsx): server 未引入 xlsx 库，无法生成 .xlsx 二进制。
   * 本实现返回结构化行数组 { rows, columns, sheet_name }，由上层自行落盘 / 转 xlsx。
   * 对外签名与返回「可写入 Excel 的内容」语义保持一致。
   * @param {{query:Function}} ctx
   * @param {Object} params
   */
  static async export_code_values_to_excel(ctx, {
    project_id,
    source_id = null,
    source_type = null,
    export_format = 'by-metric',
  } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      const normalizedSourceId = source_id && String(source_id).trim() ? String(source_id).trim() : null;
      const normalizedSourceType = source_type && String(source_type).trim() ? String(source_type).trim() : null;

      const conds = ['m.project_id = $1', 'm.deleted_at IS NULL'];
      const params = [project_id];
      const planConds = ['p.project_id=m.project_id', 'p.metric_id=m.id', 'p.deleted_at IS NULL'];
      if (normalizedSourceId) {
        params.push(normalizedSourceId);
        planConds.push(`p.source_id = $${params.length}`);
      }
      if (normalizedSourceType) {
        params.push(normalizedSourceType);
        planConds.push(`p.source_type = $${params.length}`);
      }
      if (normalizedSourceId || normalizedSourceType) {
        conds.push(`EXISTS (SELECT 1 FROM metric_execution_plans p WHERE ${planConds.join(' AND ')})`);
      }

      const metrics = await ctx.query(
        `SELECT m.* FROM ${METRIC_TABLE} m WHERE ${conds.join(' AND ')}`,
        params,
      );

      if (!metrics || metrics.length === 0) {
        throw new ValidationError(t('没有找到可导出的指标'));
      }

      const rows = [];

      if (export_format === 'by-metric') {
        for (const metric of metrics) {
          const existingCk = _getCleanCodeKnowledge(metric);
          const codeKnowledge = existingCk || { fields: [], common_filters: [] };

          for (const field of (codeKnowledge.fields || [])) {
            for (const codeValue of (field.code_values || [])) {
              rows.push({
                指标名称: metric.name,
                字段名: field.field_name || '',
                字段显示名: field.field_display_name || '',
                字段描述: field.description || '',
                码值编码: codeValue.code || '',
                码值标签: codeValue.label || '',
                码值别名: (codeValue.aliases || []).join(','),
                码值描述: codeValue.description || '',
                过滤条件说明: '',
                SQL条件: '',
                用户关键词: '',
              });
            }

            if (!field.code_values || field.code_values.length === 0) {
              rows.push({
                指标名称: metric.name,
                字段名: field.field_name || '',
                字段显示名: field.field_display_name || '',
                字段描述: field.description || '',
                码值编码: '',
                码值标签: '',
                码值别名: '',
                码值描述: '',
                过滤条件说明: '',
                SQL条件: '',
                用户关键词: '',
              });
            }
          }

          for (const filterItem of (codeKnowledge.common_filters || [])) {
            rows.push({
              指标名称: metric.name,
              字段名: '',
              字段显示名: '',
              字段描述: '',
              码值编码: '',
              码值标签: '',
              码值别名: '',
              码值描述: '',
              过滤条件说明: filterItem.description || '',
              SQL条件: filterItem.condition || '',
              用户关键词: (filterItem.user_keywords || []).join(','),
            });
          }
        }
      } else {
        // by-field
        const fieldData = new Map();

        for (const metric of metrics) {
          const existingCk = _getCleanCodeKnowledge(metric);
          const codeKnowledge = existingCk || { fields: [], common_filters: [] };

          for (const field of (codeKnowledge.fields || [])) {
            const fieldName = field.field_name || '';

            if (!fieldData.has(fieldName)) {
              fieldData.set(fieldName, {
                field_name: fieldName,
                field_display_name: field.field_display_name || '',
                description: field.description || '',
                code_values: [],
                related_metrics: [],
              });
            }
            const data = fieldData.get(fieldName);
            data.related_metrics.push(metric.name);

            for (const codeValue of (field.code_values || [])) {
              data.code_values.push({
                code: codeValue.code || '',
                label: codeValue.label || '',
                aliases: codeValue.aliases || [],
                description: codeValue.description || '',
              });
            }
          }
        }

        for (const [fieldName, data] of fieldData.entries()) {
          for (const codeValue of data.code_values) {
            rows.push({
              字段名: fieldName,
              字段显示名: data.field_display_name,
              字段描述: data.description,
              码值编码: codeValue.code,
              码值标签: codeValue.label,
              码值别名: (codeValue.aliases || []).join(','),
              码值描述: codeValue.description,
              关联指标: data.related_metrics.join(','),
            });
          }
        }
      }

      const columns = rows.length > 0
        ? [...new Set(rows.flatMap((r) => Object.keys(r)))]
        : [];
      // 返回结构化内容（TODO(xlsx): 上层接入 xlsx 库后可转为二进制）
      return { rows, columns, sheet_name: 'export' };
    } catch (e) {
      console.error(`导出码值失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  /**
   * 导出指标码值配置为 JSON 字符串。对应 export_code_values_to_json。
   * @param {{query:Function}} ctx
   * @param {Object} params
   * @returns {Promise<string>}
   */
  static async export_code_values_to_json(ctx, {
    project_id,
    source_id = null,
    source_type = null,
  } = {}) {
    try {
      await MetricService._validate_business(ctx, project_id);

      const normalizedSourceId = source_id && String(source_id).trim() ? String(source_id).trim() : null;
      const normalizedSourceType = source_type && String(source_type).trim() ? String(source_type).trim() : null;

      const conds = ['m.project_id = $1', 'm.deleted_at IS NULL'];
      const params = [project_id];
      const planConds = ['p.project_id=m.project_id', 'p.metric_id=m.id', 'p.deleted_at IS NULL'];
      if (normalizedSourceId) {
        params.push(normalizedSourceId);
        planConds.push(`p.source_id = $${params.length}`);
      }
      if (normalizedSourceType) {
        params.push(normalizedSourceType);
        planConds.push(`p.source_type = $${params.length}`);
      }
      if (normalizedSourceId || normalizedSourceType) {
        conds.push(`EXISTS (SELECT 1 FROM metric_execution_plans p WHERE ${planConds.join(' AND ')})`);
      }

      const metrics = await ctx.query(
        `SELECT m.* FROM ${METRIC_TABLE} m WHERE ${conds.join(' AND ')}`,
        params,
      );
      const executionPlans = await listMetricExecutionPlans(ctx, {
        project_id,
        metric_ids: metrics.map((metric) => metric.id),
      });
      const plansByMetric = new Map();
      for (const plan of executionPlans) {
        const items = plansByMetric.get(plan.metric_id) || [];
        items.push(plan);
        plansByMetric.set(plan.metric_id, items);
      }

      const data = { metrics: [] };
      for (const metric of metrics) {
        data.metrics.push({
          name: metric.name,
          description: metric.description,
          aliases: _normalizeAliases(metric.aliases),
          execution_plans: plansByMetric.get(metric.id) || [],
          related_tables: _parseJsonText(metric.related_tables, []),
          related_columns: _parseJsonText(metric.related_columns, {}),
          code_knowledge: _normalizeCodeKnowledge(metric.code_knowledge) || { fields: [], common_filters: [] },
        });
      }

      return JSON.stringify(data, null, 2);
    } catch (e) {
      console.error(`导出码值JSON失败: ${e?.message ?? e}`);
      throw e;
    }
  }

  // ==================== 工具门控计数 ====================

  /**
   * 项目下是否有可供召回的激活指标（用于 Agent 工具门控判定，走内存缓存）。
   * 对应 has_business_metrics（Python 版 @cache(expire=120, key_builder=service_key_builder)）。
   *
   * 缓存：委托给 _has_business_metrics_cached（withCache 包裹，TTL=120s）。
   * 其缓存 key 形如 `has_business_metrics:project_id=<id>`，与
   * invalidate_metric_cache 调用的 invalidate_cache('has_business_metrics', {project_id})
   * 失效 needle 对齐，保证项目方加/删指标后立即生效。
   *
   * 这里统计所有激活指标：即使部分指标还没有 embedding，关键词路径仍可召回，
   * 因此不能用向量覆盖率作为 align_metric / grep_metrics 工具的门控。
   * @param {{queryOne:Function}} ctx
   * @param {Object} params
   * @returns {Promise<boolean>}
   */
  static async has_business_metrics(ctx, { project_id } = {}) {
    return _has_business_metrics_cached(project_id, ctx);
  }

  /**
   * 统计激活且可供召回的指标数量。对应 count_metrics_with_embedding。
   *
   * 只统计激活指标（NULL 视为激活）。方法名保留以兼容下游 import；这个计数表示
   * “可通过向量或关键词召回的指标数”，不是纯向量覆盖数。
   * @param {{queryOne:Function}} ctx
   * @param {Object} params
   * @returns {Promise<number>}
   */
  static async count_metrics_with_embedding(ctx, { project_id } = {}) {
    const row = await ctx.queryOne(
      `SELECT COUNT(*) AS cnt FROM ${METRIC_TABLE}
        WHERE project_id = $1
          AND deleted_at IS NULL
          AND (is_active = true OR is_active IS NULL)`,
      [project_id],
    );
    return Number(row?.cnt || 0);
  }
}

// ============================================================
// has_business_metrics 内存缓存实现
// ============================================================
//
// 对应 Python @cache(expire=120, key_builder=service_key_builder)。
// 函数签名特意把 project_id 放在【第一个位置参数】、ctx 放第二个：
//   - service_key_builder 通过 fn.__paramNames 把位置参数映射成具名 kwargs，
//     只有 project_id 有名字 → 缓存 key = `_has_business_metrics_cached:project_id=<id>`；
//   - ctx 是注入的 DB 访问对象（含函数成员），即便被当作位置参数也无对应 __paramNames，
//     不会污染缓存 key；invalidate_cache('has_business_metrics', {project_id}) 也能命中
//     （needle `project_id=<id>` 同时出现在 has_business_metrics:* 与本函数 key 中）。
function _has_business_metrics_core(project_id, ctx) {
  return MetricService.count_metrics_with_embedding(ctx, { project_id }).then((count) => count > 0);
}
// 透传函数名为 has_business_metrics，使缓存 key 前缀与失效命名空间一致
Object.defineProperty(_has_business_metrics_core, 'name', { value: 'has_business_metrics' });
_has_business_metrics_core.__paramNames = ['project_id'];

const _has_business_metrics_cached = withCache({ expire: 120, keyBuilder: service_key_builder })(
  _has_business_metrics_core,
);

export {
  service_key_builder,
  METRIC_EMBEDDING_DIMENSION,
  BULK_IMPORT_METRIC_EMBEDDING_COLUMN,
};
