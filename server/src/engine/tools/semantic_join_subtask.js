// 迁移自 dsh_kernel/data_analyze/planner/tools/semantic_join_subtask.py
//
// SemanticJoinTool —— 按行融合两个中间数据表：对两表笛卡尔积后的每行数据回答子问题。
//
// semantic_join 需要防止笛卡尔膨胀：
//   FROM left, right 是 M×N，逐行调 LLM。本文件保留两道 P0 护栏，勿简化：
//     ① 笛卡尔积行数上限 MAX_SEMANTIC_JOIN_ROWS（超过直接报错，不无脑烧 token）
//     ② 指定列与查询返回列无交集 → 直接报错止损（否则对 M×N 行全部空调用）
//
// 对外接口名 SemanticJoinTool 与 Python 保持一致，下游 import 不变。

import { BaseTool, Result } from '../core/base_tool.js';
import { chat } from '../core/llm.js';
import { t } from '../utils/i18n.js';
import {
  mapSettledWithConcurrency,
  resolveSemanticRowConcurrency,
  semanticLlmRequestOptions,
} from './semantic_row_executor.js';

const logger = {
  info: (...args) => console.info('[SemanticJoinTool]', ...args),
  warn: (...args) => console.warn('[SemanticJoinTool]', ...args),
  error: (...args) => console.error('[SemanticJoinTool]', ...args),
};

const TEMPERATURE_MEDIUM = 0.1;

// 笛卡尔积逐行调 LLM 的行数上限——超过则报错而非无脑烧 token（M×N 爆炸护栏）
export const MAX_SEMANTIC_JOIN_ROWS = 200;

const JOIN_PROMPT_TEMPLATE = `You are a semantic Q&A assistant. Based on the given statement and data evidence, determine the answer to the question.

## Statement
{question}

## Data Evidence
{row}

## Response Requirements
1. If the question contains conditions, first determine whether the conditions are met. If not, no further steps are needed
2. If there are no conditions, or the conditions are met, answer the question directly

Output format must strictly follow:
\`\`\`json
{res_format}
\`\`\`
`;

const RES_FORMAT = "{verified: True|False(whether conditions are met), result: 'fused reasoning result', res_name: 'result name based on question intent (not affected by data)'}";

// 响应模型（对应 SemanticJoinResponseModel）
class SemanticJoinResponseModel {
  constructor({ verified = false, result = '', res_name = '' } = {}) {
    this.verified = verified;
    this.result = result;
    this.res_name = res_name;
  }

  static get name() { return 'SemanticJoinResponseModel'; }
  static get schema() {
    return {
      properties: { verified: {}, result: {}, res_name: {} },
      required: ['verified', 'result', 'res_name'],
    };
  }

  static fromJSON(parsed) {
    const p = parsed || {};
    return new SemanticJoinResponseModel({
      verified: Boolean(p.verified),
      result: p.result ?? '',
      res_name: p.res_name ?? '',
    });
  }
}

/**
 * SemanticJoinTool —— 语义连接（按行融合两表）算子工具。
 */
export class SemanticJoinTool extends BaseTool {
  constructor(kwargs = {}) {
    const name = 'semantic_join_operator';
    const description = `**semantic_join_operator** - 按行融合两个中间数据表，结合两个数据表做笛卡尔积之后的每行数据回答子问题
\`\`\`json
{
  "tool": "semantic_join_operator",
  "params": {"question": "子问题描述",
  "left_table_name": "查询左表名称（一定是中间结果表）",
  "right_table_name": "查询右表名称（一定是中间结果表）",
  "left_columns": "查询左表中的列名",
  "right_columns": "查询右表中的列名"
}}
\`\`\``;
    super(name, description, kwargs);
    this.name = name;
    this.description = description;
    this.inputs = {
      question: {
        type: 'string',
        description: 'A task description on the semantic join rules.',
      },
      left_table_name: {
        type: 'string',
        description: 'Intermediate data name with the left table.',
      },
      left_columns: {
        type: 'list',
        description: 'List of column names of the left table.',
      },
      right_table_name: {
        type: 'string',
        description: 'Intermediate data name with the right table.',
      },
      right_columns: {
        type: 'list',
        description: 'List of column names of the right table.',
      },
    };
  }

  // 构建 SELECT 语句中的列选择部分（对应 _build_column_select）
  static _buildColumnSelect(tableName, columns) {
    return columns.map((col) => `${tableName}.${col}`).join(',');
  }

  async execute(context, kwargs = {}) {
    // 参数提取
    const question = kwargs.question;
    const leftTableName = kwargs.left_table_name;
    const leftColumns = kwargs.left_columns || [];
    const rightTableName = kwargs.right_table_name;
    const rightColumns = kwargs.right_columns || [];

    // 参数校验
    if (!question) return Result.createError('缺少必要参数: question');
    if (!leftTableName || !rightTableName) return Result.createError('缺少必要参数: 表名');
    if (!leftColumns.length || !rightColumns.length) return Result.createError('缺少必要参数: 列名列表');

    const intermediateDs = context.input_data?.data_sources_info?.intermediate_ds;

    logger.info(
      `Merge ${leftTableName} and ${rightTableName} according to QUESTION ${question}.`,
    );

    // 构建 SQL 查询 - 获取两表的所有列（FROM left, right 即 M×N 笛卡尔积）
    const sql = `SELECT ${leftTableName}.*, ${rightTableName}.* FROM ${leftTableName}, ${rightTableName};`;

    let res;
    try {
      res = await intermediateDs.query(sql);
    } catch (e) {
      logger.error(`Query failed: ${e?.message ?? e}`);
      return Result.createError(`查询失败: ${e?.message ?? e}`);
    }

    const resData = (res && res.data) || [];
    if (!resData.length) {
      return Result.create({ 'sub-query': question, result: null }, t('查询结果为空'));
    }

    // P0 护栏①：笛卡尔积行数上限。FROM left, right 是 M×N，逐行调 LLM；
    // 超过上限直接报错并提示改用带连接键的查询，避免一次 subtask 烧掉成千上万次调用。
    if (resData.length > MAX_SEMANTIC_JOIN_ROWS) {
      logger.warn(
        `笛卡尔积 ${resData.length} 行超过上限 ${MAX_SEMANTIC_JOIN_ROWS}，已拒绝逐行 LLM 调用`,
      );
      return Result.createError(
        t('语义 join 的笛卡尔积结果有 {} 行，超过上限 {}，请用带连接键的查询缩小范围后重试',
          resData.length, MAX_SEMANTIC_JOIN_ROWS),
      );
    }

    // 从查询结果中获取所有列名
    const allQueryColumns = Object.keys(resData[0]);

    // 构建 LLM 需要看到的列（只包含指定的 left_columns 和 right_columns）
    const llmColumns = new Set([...leftColumns, ...rightColumns]);

    // P0 护栏②：指定列与查询返回列无交集 → 每行过滤后都是空 {}，LLM 只能凭问题瞎编，
    // 还会对 M×N 行全部空调用。直接报错止损（常见于两表同名列冲突或 .* 列名带前缀）。
    const queryColumnSet = new Set(allQueryColumns);
    const hasIntersection = [...llmColumns].some((c) => queryColumnSet.has(c));
    if (!hasIntersection) {
      const sortedLlmColumns = [...llmColumns].sort();
      logger.warn(
        `指定列 ${JSON.stringify(sortedLlmColumns)} 与查询结果列 ${JSON.stringify(allQueryColumns)} 无交集，已拒绝空数据 LLM 调用`,
      );
      return Result.createError(
        t('指定列 {} 与查询结果列 {} 无交集，无法构造数据证据（可能列名含表前缀或同名列冲突）',
          JSON.stringify(sortedLlmColumns), JSON.stringify(allQueryColumns)),
      );
    }

    // 受控并发处理所有行的 LLM 调用（只传递指定列的数据给 LLM）
    const settled = await mapSettledWithConcurrency(resData, (row) => {
      const filteredRow = {};
      for (const [k, v] of Object.entries(row)) {
        if (llmColumns.has(k)) filteredRow[k] = v;
      }
      return this._llmProcess(question, filteredRow, context);
    }, {
      concurrency: resolveSemanticRowConcurrency(context, kwargs.semantic_row_concurrency),
      signal: kwargs.signal,
    });

    // 收集验证通过的结果
    const newRes = [];
    let resName = null;
    for (let i = 0; i < settled.length; i++) {
      const s = settled[i];
      if (s.status === 'rejected') {
        logger.warn(`LLM process failed for row: ${s.reason?.message ?? s.reason}`);
        continue;
      }
      const response = s.value;
      if (response.verified) {
        // 使用第一个验证通过的 res_name 作为结果列名
        if (resName === null) resName = response.res_name;
        const row = { ...resData[i], [resName]: response.result };
        newRes.push(row);
      }
    }

    let result = null;
    if (resName !== null) {
      // 结果列包含：查询结果的所有列 + LLM 生成的 res_name
      const resultColumns = new Set([...allQueryColumns, resName]);
      result = { columns: resultColumns, rows: newRes };
    }
    return Result.create({ 'sub-query': question, result }, t('查询执行成功'));
  }

  /** 使用 LLM 处理检索结果，生成 RAG 风格回答（对应 _llm_process） */
  async _llmProcess(question, row, context) {
    // 对应 Python str.format：row 用其字典字面量表示（dict 的 str() 形态）
    const joinPrompt = JOIN_PROMPT_TEMPLATE
      .replace('{question}', question)
      .replace('{row}', pyDictRepr(row))
      .replace('{res_format}', RES_FORMAT);

    const conversation = [{ role: 'user', content: joinPrompt }];
    const llmResponse = await chat(
      conversation,
      {
        response_model: SemanticJoinResponseModel,
        user_id: context.user_id,
        project_id: context.project_id,
        model_role: 'secondary',
        temperature: TEMPERATURE_MEDIUM,
        call_site: 'semantic_join',
        ...semanticLlmRequestOptions(context, { maxTokens: 2048 }),
      },
    );
    return llmResponse;
  }
}

// 用类 Python dict 字面量呈现一行数据（对应 Python f-string 里直接插 dict）。
// 例：{'a': 1, 'b': 'x'}
function pyDictRepr(row) {
  const parts = Object.entries(row).map(([k, v]) => `${pyRepr(k)}: ${pyRepr(v)}`);
  return `{${parts.join(', ')}}`;
}

function pyRepr(value) {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  // 对象/数组退化为 JSON 字符串呈现
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

export default SemanticJoinTool;
