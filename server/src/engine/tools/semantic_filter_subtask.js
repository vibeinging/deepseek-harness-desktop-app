// 迁移自 dsh_kernel/data_analyze/planner/tools/semantic_filter_subtask.py
//
// SemanticFilterTool —— 对中间结果表做逐行语义过滤：逐行调 LLM 分析每行内容
// （尤其文本/非结构化内容列），再据自然语言条件判断该行是否保留。
//
// 对外接口名 SemanticFilterTool 与 Python 保持一致，下游 import 不变。
// Python 通过 SemanticFilter 算子 + IntermediateTableScan + load_prompt 分层实现，
// Node 桌面版尚未单独迁移这些算子，这里把必要逻辑内联，行为等价。

import { BaseTool, Result } from '../core/base_tool.js';
import { chat } from '../core/llm.js';
import { t } from '../utils/i18n.js';
import { ExtractSchemaField } from './expected_format.js';
import {
  normalizeExtractSchemaParam,
} from './semantic_extract_subtask.js';
import {
  mapSettledWithConcurrency,
  resolveSemanticRowConcurrency,
  semanticLlmRequestOptions,
} from './semantic_row_executor.js';

const logger = {
  info: (...args) => console.info('[SemanticFilterTool]', ...args),
  warn: (...args) => console.warn('[SemanticFilterTool]', ...args),
  error: (...args) => console.error('[SemanticFilterTool]', ...args),
};

const TEMPERATURE_MEDIUM = 0.1;

// ---- 中间表名校验 ----
const VALID_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function assertValidTableName(tableName) {
  if (typeof tableName !== 'string' || !VALID_TABLE_NAME.test(tableName)) {
    throw new Error(
      `Invalid intermediate table name: ${JSON.stringify(tableName)} ` +
      '(must match [A-Za-z_][A-Za-z0-9_]{0,127})'
    );
  }
  return tableName;
}

function normalizeTableName(tableName) {
  const normalized = String(tableName || '').trim().split('.').pop();
  if (normalized) assertValidTableName(normalized);
  return normalized;
}

function resolveIntermediateTableName({
  table_name = null,
  dependency_tables = null,
  preferred_intermediate_tables = null,
} = {}) {
  if (table_name) return normalizeTableName(table_name);

  const preferredTables = (preferred_intermediate_tables || [])
    .filter((item) => item && typeof item === 'object' && item.intermediate_table)
    .map((item) => normalizeTableName(item.intermediate_table))
    .filter(Boolean);
  const uniquePreferred = [...new Set(preferredTables)];
  if (uniquePreferred.length === 1) return uniquePreferred[0];

  const rawDeps = (dependency_tables || [])
    .filter(Boolean)
    .map((item) => normalizeTableName(item));
  const uniqueDeps = [...new Set(rawDeps)];
  if (uniqueDeps.length === 1) return uniqueDeps[0];

  return null;
}

// ---- 占位符引用列（对应 string.get_referenced_cols / get_place_holder_form_col） ----
function getReferencedCols(naturalIns) {
  const cols = new Set();
  const re = /\$\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(String(naturalIns || ''))) !== null) cols.add(m[1]);
  return cols;
}

function getPlaceholderFormCol(colName) {
  return `\${${colName}}`;
}

// ---- 行内容/字段序列化（对应 semantic_row_utils） ----
const TEXT_PRIORITY_COLUMNS = [
  'embedding_content', 'content', 'text', 'chunk_content',
  'meta_info', 'metadata', 'title', 'name', 'description',
];

function truncateSemanticValue(value, maxLen = 1500) {
  const text = String(value);
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...[truncated]';
}

function extractSemanticRowContent(row) {
  const chunks = [];
  for (const key of TEXT_PRIORITY_COLUMNS) {
    const value = row[key];
    if (value === null || value === undefined || value === '') continue;
    chunks.push(`${key}: ${truncateSemanticValue(value)}`);
  }
  if (chunks.length) return chunks.join('\n');

  const fallback = [];
  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined || typeof value === 'object') continue;
    if (typeof value === 'string' && !value.trim()) continue;
    fallback.push(`${key}: ${truncateSemanticValue(value, 500)}`);
  }
  return fallback.join('\n');
}

function serializeSemanticRowFields(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    if (value !== null && typeof value === 'object') {
      normalized[key] = truncateSemanticValue(JSON.stringify(value), 1200);
    } else {
      normalized[key] = truncateSemanticValue(value, 1200);
    }
  }
  return JSON.stringify(normalized, null, 2);
}

// Model-facing prompts use one English contract for every input language.
function buildFilterPrompt({ instruction, rowContent, rowFields, extractSchema }) {
  return `You are a **Row-wise Semantic Filtering Expert**.
Your task is to decide whether the current row should be kept based on the given filter condition.

**Filter Condition**:
${instruction}

**Current Row Main Content**:
${rowContent}

**Current Row Structured Fields**:
${rowFields}

**Structured Extraction Schema To Return**:
${extractSchema}

---
### Instructions
1. Your judgment target is only the current row, not the whole table and not the whole knowledge base.
2. You must use the current row's content and field values to decide whether the row satisfies the filter condition.
3. If the filter condition requires extracting information from the row's unstructured text before judging, do that extraction first, then decide keep/remove.
4. \`data\` must follow the provided \`extract_schema\` exactly. The keys must match the schema \`name\` values exactly. Do not add, rename, or omit keys.
5. If a field cannot be determined from the current row, set that field value to \`null\`.
6. Assign every extracted value only by the field name, type and description in the provided schema. Do not create hidden helper fields or infer a domain mapping outside the schema.
7. If facts for the same entity are scattered across multiple rows/chunks, judge only the current row. A later step may merge rows only when the schema or source data provides an explicit stable key.
8. Return \`flag=true\` if the row should be kept; otherwise return \`flag=false\`.
9. When \`flag=false\`, \`data\` may be an empty object \`{}\` or \`null\`.
10. Do not output extra fields, do not answer beyond the row, and do not turn this into a general summary.

---
### Output Format
Please output a valid JSON object in the following structure: (wrapped with \`\`\`json and \`\`\`)
\`\`\`json
{
  "flag": boolean,
  "data": {
    "field_name": "value or null"
  },
  "reasoning": "string"
}
\`\`\``;
}

// FilterAnswer 响应模型（对应 prompts.expected_format.FilterAnswer）
class FilterAnswer {
  constructor({ flag = false, data = null, reasoning = '' } = {}) {
    this.flag = flag;
    this.data = data;
    this.reasoning = reasoning;
  }

  static get name() { return 'FilterAnswer'; }
  static get schema() {
    return { properties: { flag: {}, data: {}, reasoning: {} }, required: ['flag', 'reasoning'] };
  }

  static fromJSON(parsed) {
    return new FilterAnswer(parsed || {});
  }
}

// 逐行语义判定一行是否保留（对应 judge_filter_cond + SemanticFilter.judge_row）
async function judgeRow(usedPrompt, row, extractSchema, context) {
  const promptText = buildFilterPrompt({
    instruction: usedPrompt,
    rowContent: extractSemanticRowContent(row),
    rowFields: serializeSemanticRowFields(row),
    extractSchema: JSON.stringify(extractSchema, null, 2),
  });
  const judgeRes = await chat(
    [{ role: 'user', content: promptText }],
    {
      response_model: FilterAnswer,
      user_id: context.user_id,
      project_id: context.project_id,
      temperature: TEMPERATURE_MEDIUM,
      call_site: 'semantic_operator_filter',
      ...semanticLlmRequestOptions(context, { maxTokens: 2048 }),
    },
  );

  const flag = Boolean(judgeRes && judgeRes.flag);
  const rawData = (judgeRes && typeof judgeRes.data === 'object' && judgeRes.data) || {};
  // 规范化抽取字段：只保留 schema 中定义的字段
  const extracted = {};
  for (const field of extractSchema) {
    const fieldName = field && field.name;
    if (!fieldName) continue;
    extracted[fieldName] = rawData[fieldName] === undefined ? null : rawData[fieldName];
  }
  return { flag, row, extracted };
}

/**
 * SemanticFilterTool —— 语义逐行过滤算子工具。
 */
export class SemanticFilterTool extends BaseTool {
  constructor(kwargs = {}) {
    const name = 'semantic_filter_operator';
    const description = `**semantic_filter_operator** - 对中间结果表做逐行语义过滤，会逐行调用大模型分析每一行内容（尤其适用于文本/非结构化内容列），再根据自然语言条件判断该行是否保留
\`\`\`json
{"tool": "semantic_filter_operator", "params": {"question": "明确说明要从每一行非结构化文本中抽取/判断什么信息，再据此决定是否保留该行", "table_name": "中间结果表名", "extract_schema": [{"name": "结构化字段名", "type": "string|number|boolean", "description": "从每一行里抽取什么"}]}}
\`\`\`
- 适用于：数据已经在中间结果表中，需要基于自然语言条件对单张中间表继续筛选，特别适合每一行包含 \`embedding_content\`、文档片段、说明文本、备注等非结构化文本内容的场景
- \`question\` 不能只写模糊目标，必须写清楚"逐行看什么内容、抽取什么信息、按什么条件保留/剔除"
- 如果后续步骤需要使用从每一行文本中抽取出的结构化字段，必须在 \`extract_schema\` 中一次性定义所有字段名和类型，禁止让每一行各自决定字段名
- 它的职责是"逐行判断这行内容是否满足条件并保留/剔除该行"，不是直接做整库检索
- 同一实体的事实分散在多个切片时，本工具只判断当前行；只有 schema 或源数据提供明确稳定键时，后续才能按该键 group/coalesce
- 工具不会在 \`extract_schema\` 之外自动添加、猜测或改写字段
- 它的职责是"语义筛选"，不是"格式化回答整个问题"；如果问题是在已有中间结果上继续筛行，优先用它
- 只要当前子问题本质上是在**一张已存在的中间结果表上继续做自然语言筛选**，就**必须优先使用 \`semantic_filter_operator\`**，不要重新回原始数据源`;
    super(name, description, kwargs);
    this.name = name;
    this.description = description;
    this.output_type = 'string';
    this.inputs = {
      question: {
        type: 'string',
        description: 'A row-wise filtering instruction in natural language. It must clearly describe '
          + 'what information to extract or judge from each row, especially from unstructured '
          + 'text fields such as embedding_content, content, notes, or descriptions.',
      },
      table_name: {
        type: 'string',
        description: 'The intermediate table name to be filtered.',
      },
      extract_schema: {
        type: 'list',
        description: 'A unified schema for structured fields to extract from each kept row. '
          + 'Every item must include name/type, and optional description.',
      },
      depends_on: {
        type: 'list',
        description: 'Dependency task ids for the current subtask.',
      },
    };
  }

  async execute(context, kwargs = {}) {
    const question = kwargs.question;
    const tableName = kwargs.table_name;
    const extractSchema = normalizeExtractSchemaParam(kwargs.extract_schema);
    const dependencyTables = kwargs.dependency_tables || [];
    const preferredIntermediateTables = kwargs.preferred_intermediate_tables || [];

    if (!question) return Result.createError(t('缺少必要参数: question'));

    const intermediateDs = context.input_data?.data_sources_info?.intermediate_ds;
    let resolvedTableName;
    try {
      resolvedTableName = resolveIntermediateTableName({
        table_name: tableName,
        dependency_tables: dependencyTables,
        preferred_intermediate_tables: preferredIntermediateTables,
      });
    } catch (e) {
      return Result.createError(String(e?.message ?? e));
    }
    if (!resolvedTableName) {
      return Result.createError(
        t('缺少必要参数: table_name。请明确指定要过滤的中间结果表，或确保当前子任务只依赖一张中间表。'),
      );
    }

    logger.info(
      `Execute semantic filter: table=${resolvedTableName}, question=${question}, `
      + `extract_schema=${JSON.stringify(extractSchema)}`,
    );

    let normalizedExtractSchema;
    try {
      normalizedExtractSchema = extractSchema.map((item) => {
        const f = ExtractSchemaField.from(item);
        return { name: f.name, type: f.type, description: f.description };
      });
    } catch (e) {
      return Result.createError(t('extract_schema 参数非法: {}', e?.message ?? e));
    }

    let result;
    try {
      // 1) 扫描中间表（对应 IntermediateTableScan.get_next）
      const scanSql = `SELECT * FROM "${assertValidTableName(resolvedTableName)}"`;
      const queryResult = await intermediateDs.query(scanSql);
      if (!queryResult.success) {
        throw new Error(t('查询失败: {}', queryResult.message));
      }
      const leftColumns = new Set(queryResult.columns || []);
      const leftRows = queryResult.data || [];
      const inputRowCount = leftRows.length;

      const usedCols = getReferencedCols(question);

      // 扩展 schema：原列 ∪ 抽取字段
      const extendedSchema = new Set(leftColumns);
      for (const f of normalizedExtractSchema) {
        if (f.name) extendedSchema.add(f.name);
      }

      // 2) 逐行受控并发判定。占位符替换沿用 Python 原行为。
      const settled = await mapSettledWithConcurrency(leftRows, async (row) => {
        let usedPrompt = question;
        for (const col of usedCols) {
          usedPrompt = usedPrompt.split(getPlaceholderFormCol(col)).join(String(row[col]));
        }
        return judgeRow(usedPrompt, row, normalizedExtractSchema, context);
      }, {
        concurrency: resolveSemanticRowConcurrency(context, kwargs.semantic_row_concurrency),
        signal: kwargs.signal,
      });

      const resRows = [];
      let failedRowCount = 0;
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === 'rejected') {
          // 失败行不保留（对应 Python continue），仅计数
          logger.error(`Error filtering row ${i}: ${s.reason?.message ?? s.reason}`);
          failedRowCount += 1;
          continue;
        }
        const { flag, row, extracted } = s.value;
        if (flag) {
          resRows.push({ ...row, ...(extracted || {}) });
        }
      }

      logger.info(
        `Summary: prompt=${question}, input_rows=${inputRowCount}, kept_rows=${resRows.length}, `
        + `failed_rows=${failedRowCount}, `
        + `extracted_fields=${JSON.stringify(normalizedExtractSchema.map((f) => f.name).filter(Boolean))}`,
      );

      for (const row of resRows) {
        for (const key of Object.keys(row || {})) extendedSchema.add(key);
      }
      result = { columns: extendedSchema, rows: resRows };
    } catch (e) {
      logger.error(`Execute failed: ${e?.message ?? e}`, e);
      return Result.createError(t('语义过滤失败: {}', e?.message ?? e));
    }

    // 构造与下游兼容的 operator 描述对象（对应 SemanticFilter）
    const filterOperator = {
      nodetag: 'SemanticFilter',
      prompt: question,
      extract_schema: normalizedExtractSchema,
      source_name: intermediateDs?.datasource_name,
      table_name: resolvedTableName,
    };

    return Result.create(
      {
        operator: filterOperator,
        result,
        'sub-query': question,
      },
      t('查询执行成功'),
    );
  }
}

export default SemanticFilterTool;
