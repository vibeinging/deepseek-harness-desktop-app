// 迁移自 dsh_kernel/data_analyze/planner/tools/empty_result_diagnosis.py
//
// 空结果智能诊断器
//
// 在 Agent observation() 检测到结果为空时自动调用，
// 不注册为 LLM 可调用工具，零额外迭代。
//
// 迁移要点：
// - Python 原版纯靠数据源 SQL 探测（表是否有数据 / 知识库是否有文档），
//   并不调用 LLM；本文件保持同一行为（1:1）。
// - asyncio.wait_for(超时) → Promise.race + 定时器实现 DIAGNOSIS_TIMEOUT。
// - isinstance(IntermediateDataSource) → 鸭子判型（source_type / 类名），
//   避免与 datasources 形成硬依赖环。
// - ds.query(sql, project_id=...) → ds.query(sql, { project_id })，返回 QueryResult。

import { t } from '../utils/i18n.js';

// 轻量 logger（对应 Python logging.getLogger）
const logger = {
  warn: (...args) => console.warn('[EmptyResultDiagnoser]', ...args),
  info: (...args) => console.info('[EmptyResultDiagnoser]', ...args),
};

/** 判断一个数据源是否为「中间数据源」（对应 isinstance(ds, IntermediateDataSource)） */
function isIntermediateDataSource(ds) {
  if (!ds) return false;
  const st = ds.source_type;
  if (st === 'intermediate_data_source' || st === 'intermediate') return true;
  const cname = ds?.constructor?.name;
  return cname === 'IntermediateDataSource';
}

const EXACT_IDENTIFIER_COLUMNS = [
  'ACC_NUM',
  'PRN_ACC_NUM',
  'IVSM_ACC_NUM',
  'PRN_IVSM_ACC_NUM',
  'SCR_NUM',
];

function hasExactIdentifierPredicate(sql) {
  const where = extractWhereClause(sql);
  if (!where) return false;
  return EXACT_IDENTIFIER_COLUMNS.some((column) => {
    const quotedLiteral = new RegExp(`(?:^|[^\\w.])(?:[\\w]+\.)?["\`]?${column}["\`]?\\s*=\\s*(?:'[^']+'|"[^"]+")`, 'i');
    const inLiteral = new RegExp(`(?:^|[^\\w.])(?:[\\w]+\.)?["\`]?${column}["\`]?\\s+IN\\s*\\([^)]*(?:'[^']+'|"[^"]+")[^)]*\\)`, 'i');
    return quotedLiteral.test(where) || inLiteral.test(where);
  });
}

function extractWhereClause(sql) {
  const text = String(sql || '');
  const match = /\bWHERE\b([\s\S]*)/i.exec(text);
  if (!match) return '';
  return match[1].split(/\b(?:GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|FETCH|UNION|INTERSECT|EXCEPT)\b/i)[0] || '';
}

function quoteIdentifier(identifier) {
  return `"${String(identifier || '').replace(/"/g, '""')}"`;
}

function readCountValue(row) {
  if (!row || typeof row !== 'object') return null;
  const direct = row.__row_count ?? row.row_count ?? row.count ?? row.COUNT;
  if (direct !== undefined && direct !== null && direct !== '') {
    const n = Number(direct);
    return Number.isFinite(n) ? n : null;
  }
  for (const value of Object.values(row)) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 空结果智能诊断器（对应 Python class EmptyResultDiagnoser）
 */
export class EmptyResultDiagnoser {
  constructor() {
    // 整体超时(秒)，对应类常量 DIAGNOSIS_TIMEOUT
    this.DIAGNOSIS_TIMEOUT = 5.0;
  }

  /**
   * 入口：根据工具类型分派诊断逻辑。
   *
   * @param {string} tool_name
   * @param {any} operator   产生空结果的算子（带 sql/source_name/table_name 等属性）
   * @param {any} data_sources 数据源注册表（需 get_data_source_by_name(name)）
   * @param {string} project_id
   * @param {string} [session_id]
   * @returns {Promise<{diagnosis_type: string, message: string, details: object}>}
   *   diagnosis_type: "no_data" | "condition_too_strict" | "semantic_no_match" | "unknown"
   */
  async diagnose(tool_name, operator, data_sources, project_id, session_id) {
    try {
      return await this._withTimeout(
        this._do_diagnose(tool_name, operator, data_sources, project_id),
        this.DIAGNOSIS_TIMEOUT,
      );
    } catch (e) {
      if (e && e.__isTimeout) {
        logger.warn('诊断超时');
        return this._unknown(t('诊断超时'));
      }
      logger.warn(`诊断异常: ${e?.message ?? e}`);
      return this._unknown(String(e?.message ?? e));
    }
  }

  /**
   * 给一个 Promise 套上超时（对应 asyncio.wait_for）。
   * 超时时抛出带 __isTimeout 标记的错误。
   * @param {Promise<any>} promise
   * @param {number} timeoutSec
   * @returns {Promise<any>}
   */
  _withTimeout(promise, timeoutSec) {
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error('diagnosis timeout');
        err.__isTimeout = true;
        reject(err);
      }, Math.max(0, timeoutSec * 1000));
      // 不阻止进程退出
      if (typeof timer?.unref === 'function') timer.unref();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  async _do_diagnose(tool_name, operator, data_sources, project_id) {
    if (tool_name === 'execute_readonly_sql') {
      return await this._diagnose_sql_empty(operator, data_sources, project_id);
    }
    if (tool_name === 'rag_operator') {
      return await this._diagnose_semantic_empty(operator, data_sources);
    }
    if (tool_name === 'semantic_filter_operator' || tool_name === 'semantic_extract_operator') {
      return this._diagnose_semantic_filter_empty(tool_name, operator);
    }
    // 兜底：本工具暂无专门的空结果诊断。**绝不能**说"未知工具类型"——LLM 会把它误读成
    // "该工具不存在/不可用"，进而放弃一个明明已注册的有效工具、另起一套平行计划（task_415
    // 实测：semantic_filter 空结果被报成"未知工具类型"→ LLM 误判工具不可用 → 追加 5 步 SQL
    // 路线 → 计划里出现两套重复分解）。这里只说"无匹配/无专门诊断"，把判断交还给 LLM。
    return {
      diagnosis_type: 'no_data',
      message: t(
        "工具 '{}' 返回空结果（无专门诊断）。该工具可用，请结合上下文判断是放宽条件、换数据源还是改用其它工具。",
        tool_name,
      ),
      details: { tool_name },
    };
  }

  // ------------------------------------------------------------------ //
  //  SQL 诊断                                                           //
  // ------------------------------------------------------------------ //

  /**
   * @param {any} operator
   * @param {any} data_sources
   * @param {string} project_id
   * @returns {Promise<object>}
   */
  async _diagnose_sql_empty(operator, data_sources, project_id) {
    const sql = operator?.sql ?? null;
    const source_name = operator?.source_name ?? '';

    if (!sql || !source_name) {
      return this._unknown(t('无法获取 SQL 或数据源名称'));
    }

    let ds;
    try {
      ds = data_sources.get_data_source_by_name(source_name);
    } catch (_) {
      return this._unknown(t('无法访问数据源 {}', source_name));
    }

    if (isIntermediateDataSource(ds)) {
      return await this._diagnose_intermediate_sql_empty(ds, source_name, sql, project_id);
    }

    // 提取主表名，检查表是否有数据
    const table_name = this._extract_main_table(sql);
    if (!table_name) {
      return this._unknown(t('无法从 SQL 中提取主表名'));
    }

    const db_type = ds?.source_type || ds?.database_type || '';
    let exists_sql;
    if (String(db_type).toUpperCase() === 'ORACLE') {
      exists_sql = `SELECT 1 AS _exists FROM ${table_name} FETCH FIRST 1 ROWS ONLY`;
    } else {
      exists_sql = `SELECT 1 AS _exists FROM ${table_name} LIMIT 1`;
    }

    const exist_result = await ds.query(exists_sql, { project_id });
    const table_has_data = Boolean(exist_result?.success)
      && Boolean(exist_result?.data)
      && (!Array.isArray(exist_result.data) || exist_result.data.length > 0);

    if (!table_has_data) {
      return {
        diagnosis_type: 'no_data',
        message: t('表 {} 中没有任何数据。', table_name),
        details: { table_name, datasource_name: source_name },
      };
    }

    if (hasExactIdentifierPredicate(sql)) {
      return {
        diagnosis_type: 'no_data',
        message: t(
          '表 {} 中有数据，但当前精确编号条件未匹配到记录。该编号在当前表/口径下可视为无数据；不要改用名称 LIKE、父级账户或模糊包含来扩展口径，除非用户明确要求。',
          table_name,
        ),
        details: { table_name, datasource_name: source_name, exact_identifier_filter: true },
      };
    }

    return {
      diagnosis_type: 'condition_too_strict',
      message: t(
        '表 {} 中有数据，当前查询条件（尤其是日期/时间筛选）可能过严，请尝试放宽后重新查询。',
        table_name,
      ),
      details: { table_name, datasource_name: source_name },
    };
  }

  async _diagnose_intermediate_sql_empty(ds, source_name, sql, project_id) {
    const table_name = this._extract_main_table(sql);
    if (!table_name) {
      return {
        diagnosis_type: 'condition_too_strict',
        message: t(
          '中间数据源 {} 的当前 SQL 未返回结果，但无法提取主表名。不要认为中间源为空；请检查 JOIN/过滤条件，必要时先查看可用中间表和样例行。',
          source_name,
        ),
        details: { is_intermediate: true, source_name },
      };
    }

    let row_count = null;
    try {
      const exist_result = await ds.query(`SELECT COUNT(*) AS __row_count FROM ${quoteIdentifier(table_name)}`, { project_id });
      if (exist_result?.success && Array.isArray(exist_result.data) && exist_result.data.length) {
        row_count = readCountValue(exist_result.data[0]);
      }
    } catch (e) {
      logger.warn(`中间表 ${table_name} 行数诊断失败: ${e?.message ?? e}`);
    }

    if (row_count === 0) {
      return {
        diagnosis_type: 'no_data',
        message: t('中间表 {} 确实为空，请回到前置步骤补充数据。', table_name),
        details: { is_intermediate: true, source_name, table_name, row_count },
      };
    }

    if (Number.isFinite(row_count) && row_count > 0) {
      return {
        diagnosis_type: 'condition_too_strict',
        message: t(
          '中间表 {} 有 {} 行，但当前 SQL 条件没有匹配结果。不要认为中间源为空；请检查 JOIN/过滤条件。若文档事实分散在多行/切片，先按稳定实体键（如 *_id/code）聚合并 coalesce 非空字段，再做过滤、JOIN 或计算。',
          table_name, row_count,
        ),
        details: { is_intermediate: true, source_name, table_name, row_count },
      };
    }

    return {
      diagnosis_type: 'condition_too_strict',
      message: t(
        '中间表 {} 的当前 SQL 未返回结果。不要认为中间源为空；请检查 JOIN/过滤条件，必要时先按稳定实体键合并分散字段。',
        table_name,
      ),
      details: { is_intermediate: true, source_name, table_name },
    };
  }

  // ------------------------------------------------------------------ //
  //  语义检索诊断                                                        //
  // ------------------------------------------------------------------ //

  /**
   * @param {any} operator
   * @param {any} data_sources
   * @returns {Promise<object>}
   */
  async _diagnose_semantic_empty(operator, data_sources) {
    const source_name = operator?.source_name ?? '';

    let has_docs;
    try {
      const ds = data_sources.get_data_source_by_name(source_name);
      const profiles = await ds.profile();
      has_docs = Boolean(profiles) && (!Array.isArray(profiles) || profiles.length > 0);
    } catch (_) {
      has_docs = null;
    }

    if (!has_docs) {
      return {
        diagnosis_type: 'semantic_no_match',
        message: t("知识库 '{}' 中没有文档内容。", source_name),
        details: { source_name, has_documents: false },
      };
    }

    return {
      diagnosis_type: 'semantic_no_match',
      message: t("在知识库 '{}' 中未找到与问题匹配的内容，但知识库中有文档。", source_name),
      details: { source_name, has_documents: true },
    };
  }

  /**
   * semantic_filter / semantic_extract 在中间表上逐行 LLM 判断后未命中任何行。
   * 明确告诉 LLM 是「无匹配行」而非「工具不可用」，避免它放弃这条有效路线。
   * @param {string} tool_name
   * @param {any} operator
   * @returns {object}
   */
  _diagnose_semantic_filter_empty(tool_name, operator) {
    const table_name = operator?.table_name || operator?.database_name || '';
    return {
      diagnosis_type: 'semantic_no_match',
      message: t(
        "语义过滤/抽取在表 '{}' 中未匹配到任何行。该工具可用——可能是判定条件过严或"
        + '目标值的表述与表内文本不一致，可放宽条件或调整问题措辞后重试。',
        table_name,
      ),
      details: { tool_name, table_name },
    };
  }

  // ------------------------------------------------------------------ //
  //  工具                                                               //
  // ------------------------------------------------------------------ //

  /**
   * 从 SQL 提取 FROM 后的主表名（对应 _extract_main_table）
   * @param {string} sql
   * @returns {string|null}
   */
  _extract_main_table(sql) {
    const match = /\bFROM\s+([\w`."[\]]+)/i.exec(sql);
    if (match) {
      return match[1].replace(/^[`"[\]]+|[`"[\]]+$/g, '');
    }
    return null;
  }

  /**
   * @param {string} message
   * @returns {{diagnosis_type: 'unknown', message: string, details: object}}
   */
  _unknown(message) {
    return { diagnosis_type: 'unknown', message, details: {} };
  }
}

export default EmptyResultDiagnoser;
