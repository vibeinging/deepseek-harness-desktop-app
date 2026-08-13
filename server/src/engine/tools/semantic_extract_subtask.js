// 迁移自 dsh_kernel/data_analyze/planner/tools/semantic_extract_subtask.py
//
// SemanticExtractTool —— 对单张中间结果表逐行做结构化抽取（不筛行）。
// 依赖 llm.chat() 逐行调 LLM，把文本字段格式化为标准结构化字段。
//
// 说明：
// - Python 侧通过 StructuredExtract 算子 + IntermediateTableScan 算子 + load_prompt
//   分层实现。Node 桌面版尚未单独迁移这些算子，这里把必要逻辑内联，保持对外
//   接口名 SemanticExtractTool 一致，行为等价（逐行抽取、不丢行、全失败抛错）。
// - DB 访问走 IntermediateDataSource.query(sql)（注入在 context.input_data 里），不直接连库。

import { BaseTool, Result } from '../core/base_tool.js';
import { chat } from '../core/llm.js';
import { t } from '../utils/i18n.js';
import { ExtractSchemaField } from './expected_format.js';
import {
  chunkSemanticRows,
  mapSettledWithConcurrency,
  resolveSemanticBatchConcurrency,
  resolveSemanticBatchSize,
  resolveSemanticMinSuccessRatio,
  semanticExecutionCoverage,
  semanticLlmRequestOptions,
} from './semantic_row_executor.js';

const logger = {
  info: (...args) => console.info('[SemanticExtractTool]', ...args),
  warn: (...args) => console.warn('[SemanticExtractTool]', ...args),
  error: (...args) => console.error('[SemanticExtractTool]', ...args),
};

// 中低温度（审核、分析），对应 Python LLMConfig.TEMPERATURE_MEDIUM
const TEMPERATURE_MEDIUM = 0.1;

// ---- 中间表名校验 ----
// LLM 工具参数会沿用该名称拼入 SQL，必须挡住注入向量（ATTACH、COPY TO、read_csv 等）。
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

export function normalizeExtractSchemaParam(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {
      return [];
    }
    return [];
  }
  if (typeof value === 'object') return [value];
  return [];
}

// 解析中间表名（对应 resolve_intermediate_table_name）
function resolveIntermediateTableName({
  table_name = null,
  dependency_tables = null,
  preferred_intermediate_tables = null,
} = {}) {
  if (table_name) return normalizeTableName(table_name);

  let preferredTables = (preferred_intermediate_tables || [])
    .filter((item) => item && typeof item === 'object' && item.intermediate_table)
    .map((item) => normalizeTableName(item.intermediate_table))
    .filter(Boolean);
  // 去重保序
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

// 预编译占位符替换器（对应 _build_placeholder_substitutor）。
// 单次替换避免朴素 replace 顺序耦合（A 列值含 ${B} 会被下一轮再替换）。
function buildPlaceholderSubstitutor(prompt, usedCols) {
  if (!usedCols || usedCols.size === 0) return () => prompt;
  const colForPlaceholder = new Map();
  for (const col of usedCols) colForPlaceholder.set(getPlaceholderFormCol(col), col);
  // 按长度倒序，避免 ${a} 截断 ${ab}
  const sortedPlaceholders = [...colForPlaceholder.keys()].sort((a, b) => b.length - a.length);
  const escaped = sortedPlaceholders.map((ph) => ph.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('|'), 'g');
  return (row) => prompt.replace(pattern, (matched) => String(row[colForPlaceholder.get(matched)]));
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
function buildMultiExtractPrompt({ instruction, rowContent, rowFields, extractSchema, cardinality = 'one' }) {
  const many = cardinality === 'many';
  const outputShape = many
    ? '{\n  "data": [\n    { "field_name": "value or null" }\n  ],\n  "reasoning": "string"\n}'
    : '{\n  "data": {\n    "field_name": "value or null"\n  },\n  "reasoning": "string"\n}';
  return `You are a **Row-wise Structured Extraction Expert**.
Your task is to extract all structured fields defined in the schema from the current row in a single response.

**Extraction Task**:
${instruction}

**Current Row Main Content**:
${rowContent}

**Current Row Structured Fields**:
${rowFields}

**Structured Extraction Schema To Return**:
${extractSchema}

---
### Instructions
1. Your target is only the current row, not the whole table and not the whole knowledge base.
2. You must return all fields defined in \`extract_schema\` in one response. Do not split them across multiple answers.
3. \`data\` must be ${many ? 'an array with one object per business record found in the current row' : 'one object for the current row'}. Every object must follow \`extract_schema\` exactly. Keys must match schema \`name\` values; do not add, rename, or omit keys.
4. If a field cannot be determined from the current row, set that field value to \`null\`.
5. Assign every value only by the field name, type and description in the provided schema. Never create hidden helper fields or infer a domain-specific field mapping outside that schema.
6. If facts for the same entity are scattered across multiple rows/chunks, extract only fields visible in this row. A later step may merge rows only when the schema or source data provides an explicit stable key.
7. Do not output extra fields, do not answer beyond the row, and do not turn this into a general summary.
8. ${many ? 'Extract every business record present in this row. Return [] only when the row contains no matching record.' : 'Return exactly one structured object for this row.'}

---
### Output Format
Please output a valid JSON object in the following structure: (wrapped with \`\`\`json and \`\`\`)
\`\`\`json
${outputShape}
\`\`\``;
}

// StructuredExtractAnswer 响应模型（对应 prompts.expected_format.StructuredExtractAnswer）
class StructuredExtractAnswer {
  constructor({ data = null, reasoning = '' } = {}) {
    this.data = data;
    this.reasoning = reasoning;
  }

  static get name() { return 'StructuredExtractAnswer'; }
  static get schema() {
    return { properties: { data: {}, reasoning: {} }, required: ['reasoning'] };
  }

  static fromJSON(parsed) {
    return new StructuredExtractAnswer(parsed || {});
  }
}

// 逐行结构化抽取一行（对应 extract_structured_fields + StructuredExtract._extract_row）
export function normalizeExtractedRows(llmResponse, row, extractSchema, cardinality = 'one') {
  const raw = llmResponse?.data;
  const sources = cardinality === 'many'
    ? Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : []
    : [raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}];
  return sources.map((source) => {
    const normalized = {};
    for (const field of extractSchema) {
      const fieldName = field && field.name;
      if (!fieldName) continue;
      normalized[fieldName] = source[fieldName] === undefined ? null : source[fieldName];
    }
    return normalized;
  });
}

async function extractFieldsFromRow(usedPrompt, row, extractSchema, context, cardinality) {
  const promptText = buildMultiExtractPrompt({
    instruction: usedPrompt,
    rowContent: extractSemanticRowContent(row),
    rowFields: serializeSemanticRowFields(row),
    extractSchema: JSON.stringify(extractSchema, null, 2),
    cardinality,
  });
  const llmResponse = await chat(
    [{ role: 'user', content: promptText }],
    {
      response_model: StructuredExtractAnswer,
      user_id: context.user_id,
      project_id: context.project_id,
      model_role: 'secondary',
      temperature: TEMPERATURE_MEDIUM,
      call_site: 'semantic_operator_extract',
      ...semanticLlmRequestOptions(context, { maxTokens: 2048 }),
    },
  );
  return normalizeExtractedRows(llmResponse, row, extractSchema, cardinality);
}

class StructuredBatchExtractAnswer {
  constructor({ data = [] } = {}) {
    this.data = Array.isArray(data) ? data : [];
  }

  static get name() { return 'StructuredBatchExtractAnswer'; }
  static get schema() {
    return { properties: { data: {} }, required: ['data'] };
  }

  static fromJSON(parsed) {
    return new StructuredBatchExtractAnswer(parsed || {});
  }
}

function buildBatchExtractPrompt({ items, extractSchema, cardinality }) {
  const many = cardinality === 'many';
  const payload = items.map(({ rowIndex, instruction, row }) => ({
    row_index: rowIndex,
    instruction,
    content: extractSemanticRowContent(row),
    fields: JSON.parse(serializeSemanticRowFields(row)),
  }));
  const schemaText = JSON.stringify(extractSchema, null, 2);
  const inputText = JSON.stringify(payload, null, 2);
  return `You are a batch structured extraction engine. Process each input row independently.

Extraction schema:
${schemaText}

Input rows:
${inputText}

Rules:
1. Values must come only from the corresponding input row and its instruction.
2. Every values object must contain exactly the schema fields; use null when unknown.
3. Do not create hidden fields or infer domain mappings outside the schema.
4. Keep row_index exactly as provided.
5. ${many ? 'Return zero or more data items for each input row, one item per record found.' : 'Return exactly one data item for every input row.'}
6. Return JSON only. Do not include reasoning.

Output: {"data":[{"row_index":0,"values":{"field_name":"value or null"}}]}`;
}

export function normalizeBatchExtractedRows(llmResponse, items, extractSchema, cardinality = 'one') {
  const allowedIndexes = new Set(items.map((item) => item.rowIndex));
  const grouped = new Map();
  for (const entry of Array.isArray(llmResponse?.data) ? llmResponse.data : []) {
    const rowIndex = Number(entry?.row_index);
    if (!Number.isInteger(rowIndex) || !allowedIndexes.has(rowIndex)) continue;
    const source = entry?.values && typeof entry.values === 'object' && !Array.isArray(entry.values)
      ? entry.values
      : {};
    const normalized = {};
    for (const field of extractSchema) {
      const fieldName = field?.name;
      if (!fieldName) continue;
      normalized[fieldName] = source[fieldName] === undefined ? null : source[fieldName];
    }
    const rows = grouped.get(rowIndex) || [];
    rows.push(normalized);
    grouped.set(rowIndex, rows);
  }

  return items.map((item) => {
    const extractedRows = grouped.get(item.rowIndex) || [];
    if (cardinality === 'many') return { ...item, extractedRows };
    const fallback = Object.fromEntries(extractSchema.map((field) => [field.name, null]).filter(([name]) => name));
    return { ...item, extractedRows: [extractedRows[0] || fallback] };
  });
}

async function extractFieldsFromBatch(items, extractSchema, context, cardinality) {
  const llmResponse = await chat(
    [{ role: 'user', content: buildBatchExtractPrompt({ items, extractSchema, cardinality }) }],
    {
      response_model: StructuredBatchExtractAnswer,
      user_id: context.user_id,
      project_id: context.project_id,
      model_role: 'secondary',
      temperature: TEMPERATURE_MEDIUM,
      call_site: 'semantic_operator_extract_batch',
      ...semanticLlmRequestOptions(context, { maxTokens: 4096 }),
    },
  );
  return normalizeBatchExtractedRows(llmResponse, items, extractSchema, cardinality);
}

/**
 * SemanticExtractTool —— 语义结构化抽取算子工具。
 * 对外接口名与 Python 保持一致，下游 import { SemanticExtractTool } 不变。
 */
export class SemanticExtractTool extends BaseTool {
  constructor(kwargs = {}) {
    const name = 'semantic_extract_operator';
    const description = `**semantic_extract_operator** - 对单张中间结果表逐行做结构化抽取，不筛除行，适合把文本字段格式化为标准字段供后续 SQL / 展示使用
\`\`\`json
{"tool": "semantic_extract_operator", "params": {"question": "明确说明要从每一行文本/备注/文档片段里抽取哪些结构化信息", "table_name": "中间结果表名", "cardinality": "one|many", "extract_schema": [{"name": "结构化字段名", "type": "string|number|boolean", "description": "从每一行里抽取什么"}]}}
\`\`\`
- 适用于：已经有一张中间结果表，需要对每一行补充结构化字段，但**不需要**按条件删除行
- 典型场景：从 \`embedding_content\`、备注、说明、文档片段中抽取合同编号、日期、金额、状态、责任人等字段
- \`question\` 必须写清楚逐行抽取目标，不要写成整题总结
- \`extract_schema\` 是强约束，后续步骤依赖的字段必须一次性定义完整
- 一条输入行只代表一个业务记录时用 \`cardinality=one\`（默认）；一个文档切片内包含列表、表格或多个业务记录时用 \`cardinality=many\`，输出会展开成多行
- 同一实体的事实分散在多个切片时，只抽取 schema 中定义且当前行可见的字段；只有 schema 或源数据提供明确稳定键时，后续才能按该键 group/coalesce
- 工具不会在 \`extract_schema\` 之外自动添加、猜测或改写字段
- 如果当前子问题本质上是在**一张已存在的中间结果表上继续逐行抽取结构化字段**，就**必须优先使用 \`semantic_extract_operator\`**`;
    super(name, description, kwargs);
    this.name = name;
    this.description = description;
    this.output_type = 'string';
    this.inputs = {
      question: {
        type: 'string',
        description: 'A row-wise extraction instruction in natural language. It should clearly explain '
          + 'what structured information needs to be extracted from each row.',
      },
      table_name: {
        type: 'string',
        description: 'The intermediate table name to extract from. If omitted, it can be inferred from a single dependency table.',
      },
      extract_schema: {
        type: 'list',
        description: 'A unified schema for structured fields extracted from each row. '
          + 'Every item must include name/type, and optional description.',
      },
      cardinality: {
        type: 'string',
        description: 'one (default): one output row per input row; many: expand every business record in one input row into separate output rows.',
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
    const cardinality = String(kwargs.cardinality || 'one').trim().toLowerCase() === 'many' ? 'many' : 'one';
    const dependencyTables = kwargs.dependency_tables || [];
    const preferredIntermediateTables = kwargs.preferred_intermediate_tables || [];

    if (!question) return Result.createError(t('缺少必要参数: question'));
    if (!extractSchema.length) {
      return Result.createError(t('缺少必要参数: extract_schema。请明确要抽取的字段及类型。'));
    }

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
        t('缺少必要参数: table_name。请明确指定要抽取的中间结果表，或确保当前子任务只依赖一张中间表。'),
      );
    }

    let normalizedExtractSchema;
    try {
      normalizedExtractSchema = extractSchema.map((item) => {
        const f = ExtractSchemaField.from(item);
        return { name: f.name, type: f.type, description: f.description };
      });
    } catch (e) {
      return Result.createError(t('extract_schema 参数非法: {}', e?.message ?? e));
    }

    logger.info(
      `Execute semantic extract: table=${resolvedTableName}, question=${question}, `
      + `extract_schema=${JSON.stringify(normalizedExtractSchema)}`,
    );

    let sanitizedResult;
    let extractionStats = null;
    try {
      // 1) 扫描中间表（对应 IntermediateTableScan.get_next）
      const scanSql = `SELECT * FROM "${assertValidTableName(resolvedTableName)}"`;
      const queryResult = await intermediateDs.query(scanSql);
      if (!queryResult.success) {
        throw new Error(t('查询失败: {}', queryResult.message));
      }
      const leftColumns = new Set(queryResult.columns || []);
      const leftRows = queryResult.data || [];

      // 2) 校验占位符引用列存在
      const usedCols = getReferencedCols(question);
      for (const col of usedCols) {
        if (!leftColumns.has(col)) {
          throw new Error(
            `Column ${col} not found in the schema of the left operator. `
            + `Left schema: ${[...leftColumns]}. Used columns: ${[...usedCols]}.`,
          );
        }
      }

      // 3) 批量、受控并发抽取。一个模型请求处理多行，运行时同时限制批大小和并发。
      const substitute = buildPlaceholderSubstitutor(question.trim(), usedCols);
      const extractFieldNames = normalizedExtractSchema
        .map((f) => f.name).filter(Boolean);
      const indexedRows = leftRows.map((row, rowIndex) => {
        for (const col of usedCols) {
          if (!(col in row)) {
            throw new Error(`Column ${col} not found in the row data. Row data: ${JSON.stringify(row)}.`);
          }
        }
        return { row, rowIndex, instruction: substitute(row) };
      });
      const batches = chunkSemanticRows(
        indexedRows,
        resolveSemanticBatchSize(context, kwargs.semantic_batch_size),
      );
      const settled = await mapSettledWithConcurrency(batches, async (batch) => {
        const extractedItems = await extractFieldsFromBatch(
          batch,
          normalizedExtractSchema,
          context,
          cardinality,
        );
        return extractedItems.flatMap((item) => item.extractedRows.map((extracted) => ({ ...item.row, ...extracted })));
      }, {
        concurrency: resolveSemanticBatchConcurrency(context, kwargs.semantic_batch_concurrency),
        signal: kwargs.signal,
      });

      const resRows = [];
      let failedRowCount = 0;
      const failedReasons = [];
      for (let i = 0; i < settled.length; i++) {
        const s = settled[i];
        if (s.status === 'fulfilled') {
          resRows.push(...s.value);
        } else {
          const failedBatch = batches[i] || [];
          // 不静默丢行：保留失败批次的原 row，被抽取字段填 null，避免下游行数对不上
          logger.error(`Error extracting batch ${i}: ${s.reason?.message ?? s.reason}`);
          failedRowCount += failedBatch.length;
          failedReasons.push(String(s.reason?.message ?? s.reason ?? 'unknown extraction error'));
          for (const item of failedBatch) {
            const merged = { ...item.row };
            for (const fieldName of extractFieldNames) {
              if (merged[fieldName] === undefined) merged[fieldName] = null;
            }
            resRows.push(merged);
          }
        }
      }

      const minimumSuccessRatio = resolveSemanticMinSuccessRatio(context);
      extractionStats = {
        ...semanticExecutionCoverage(leftRows.length, failedRowCount, minimumSuccessRatio),
        batch_size: resolveSemanticBatchSize(context, kwargs.semantic_batch_size),
        batch_concurrency: resolveSemanticBatchConcurrency(context, kwargs.semantic_batch_concurrency),
      };

      // 覆盖率不达标时显式失败，避免上游把批次错误当成真实 null 继续关联。
      if (leftRows.length && !extractionStats.meets_minimum) {
        throw new Error(
          `StructuredExtract coverage ${extractionStats.success_rows}/${leftRows.length} `
          + `(${(extractionStats.success_ratio * 100).toFixed(1)}%) `
          + `is below required ${(minimumSuccessRatio * 100).toFixed(1)}%. `
          + `First error: ${(failedReasons[0] || 'unknown').slice(0, 800)}`,
        );
      }

      logger.info(
        `Summary: prompt=${question}, cardinality=${cardinality}, input_rows=${leftRows.length}, output_rows=${resRows.length}, `
        + `failed_rows=${failedRowCount}, extracted_fields=${JSON.stringify(extractFieldNames)}`,
      );

      // 结果列 = 左表列 ∪ 抽取字段
      const resultColumns = new Set(leftColumns);
      for (const f of extractFieldNames) resultColumns.add(f);
      for (const row of resRows) {
        for (const key of Object.keys(row || {})) resultColumns.add(key);
      }

      // 4) 二次清洗：按 schema 类型对抽取字段做强制类型转换（对应 _sanitize_result）
      sanitizedResult = SemanticExtractTool._sanitizeResult(
        { columns: resultColumns, rows: resRows },
        normalizedExtractSchema,
      );
    } catch (e) {
      logger.error(`Execute failed: ${e?.message ?? e}`, e);
      return Result.createError(t('语义抽取失败: {}', e?.message ?? e));
    }

    // 构造与下游兼容的 operator 描述对象（保留 source_name/table_name/schema 字段）
    const extractOperator = {
      nodetag: 'StructuredExtract',
      prompt: question.trim(),
      extract_schema: normalizedExtractSchema,
      cardinality,
      source_name: intermediateDs?.datasource_name,
      table_name: resolvedTableName,
      schema: sanitizedResult.columns,
      extraction_stats: extractionStats,
    };

    return Result.create(
      {
        operator: extractOperator,
        result: sanitizedResult,
        'sub-query': question,
      },
      t('查询执行成功'),
    );
  }

  // ---- 结果清洗（对应 _sanitize_result）：按 schema 类型转换抽取字段 ----
  static _sanitizeResult(table, extractSchema) {
    const rows = [];
    const resultColumns = new Set(table.columns || []);
    for (const row of table.rows || []) {
      const cleanRow = { ...row };
      for (const field of extractSchema) {
        const fieldName = field && field.name;
        if (!fieldName) continue;
        cleanRow[fieldName] = SemanticExtractTool._coerceValue(
          cleanRow[fieldName],
          field.type || 'string',
        );
        resultColumns.add(fieldName);
      }
      rows.push(cleanRow);
    }
    return { columns: resultColumns, rows };
  }

  // ---- 值类型强制（对应 _coerce_value） ----
  static _coerceValue(value, fieldType) {
    if (value === null || value === undefined) return null;

    const normalizedType = String(fieldType || 'string').trim().toLowerCase();
    if (normalizedType === 'string') {
      return typeof value === 'string' ? value : String(value);
    }
    if (normalizedType === 'boolean') {
      if (typeof value === 'boolean') return value;
      const text = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'y', '是', '有'].includes(text)) return true;
      if (['false', '0', 'no', 'n', '否', '无'].includes(text)) return false;
      return value;
    }
    if (normalizedType === 'number') {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'number') return value;
      const text = String(value).trim().replace(/,/g, '');
      if (!text) return null;
      const exactPattern = /^[-+]?\d+(?:\.\d+)?$/;
      if (exactPattern.test(text)) {
        return text.includes('.') ? parseFloat(text) : parseInt(text, 10);
      }
      const m = text.match(/[-+]?\d+(?:\.\d+)?/);
      if (m) {
        const num = m[0];
        return num.includes('.') ? parseFloat(num) : parseInt(num, 10);
      }
    }
    return value;
  }
}

export default SemanticExtractTool;
