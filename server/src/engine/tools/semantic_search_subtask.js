import { BaseTool, Result } from '../core/base_tool.js';
import { t } from '../utils/i18n.js';
import { UnstructuredDataSource } from '../datasources/business_data_sources.js';

const DEFAULT_TOP_K = 30;
const MAX_TOP_K = 200;
const MAX_CANDIDATE_KEYS = 500;
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const SEARCH_FUSION_OFFSET = 60;

function normalizeTopK(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_TOP_K;
  return Math.min(MAX_TOP_K, Math.trunc(parsed));
}

export function buildSemanticSearchQueries(context, question) {
  const candidates = [
    question,
    context?.input_data?.root_question,
    context?.input_data?.enhanced_user_query,
  ];
  const seen = new Set();
  const queries = [];
  for (const candidate of candidates) {
    const value = String(candidate || '').normalize('NFKC').trim();
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    queries.push(value);
  }
  return queries.slice(0, 3);
}

function searchRowKey(row, sourceName) {
  return [
    sourceName,
    row?.document_id || row?.document_name || '',
    row?.content_index ?? '',
    row?.content || '',
  ].join('\u0000');
}

export function fuseSemanticSearchResults(resultSets, topK) {
  const fused = new Map();
  for (const resultSet of resultSets || []) {
    const rows = Array.isArray(resultSet?.rows) ? resultSet.rows : [];
    rows.forEach((row, rank) => {
      const key = searchRowKey(row, resultSet.sourceName);
      const current = fused.get(key) || {
        ...row,
        source_name: resultSet.sourceName,
        retrieval_score: 0,
        query_match_count: 0,
      };
      current.retrieval_score += 1 / (SEARCH_FUSION_OFFSET + rank + 1);
      current.query_match_count += 1;
      fused.set(key, current);
    });
  }
  return [...fused.values()]
    .sort((left, right) => Number(right.retrieval_score || 0) - Number(left.retrieval_score || 0))
    .slice(0, topK);
}

export class SemanticDocumentSearchTool extends BaseTool {
  constructor(kwargs = {}) {
    const name = 'semantic_search_operator';
    const description = `**semantic_search_operator** - 先从非结构化文档中召回与问题最相关的候选切片，形成中间表，再供抽取、过滤或关联使用
\`\`\`json
{"tool":"semantic_search_operator","params":{"question":"要从文档回答的具体问题","source_name":"可选的数据源名称","file_name":"可选的具体文件名","candidate_table":"可选的候选键中间表","candidate_column":"候选键列","top_k":30}}
\`\`\`
- 文档问答默认先使用本工具缩小候选范围，再对候选中间表调用 semantic_extract_operator 或 semantic_filter_operator
- source_name 为空时会检索当前业务的全部非结构化数据源；file_name 为空时检索数据源中的全部文档
- 已有上游候选键中间表时，传 candidate_table + candidate_column，工具会在运行时读取全部候选键并下推到文档检索，不需要模型把键值逐个复制进参数
- 只有需要完整盘点、逐项统计或召回完整性无法验证时，才使用 semantic_scan_operator 全量读取文件
- top_k 是候选预算，不是答案规则；范围为 1-${MAX_TOP_K}`;
    super(name, description, kwargs);
    this.name = name;
    this.description = description;
    this.output_type = 'string';
    this.inputs = {
      question: { type: 'string', description: 'The concrete question used to retrieve document chunks.' },
      source_name: { type: 'string', description: 'Optional unstructured datasource name.' },
      file_name: { type: 'string', description: 'Optional document title.' },
      candidate_table: { type: 'string', description: 'Optional intermediate table containing candidate keys.' },
      candidate_column: { type: 'string', description: 'Candidate key column in candidate_table.' },
      top_k: { type: 'number', description: 'Maximum number of candidate chunks.' },
    };
  }

  async execute(context, kwargs = {}) {
    const question = String(kwargs.question || '').trim();
    const sourceName = String(kwargs.source_name || '').trim();
    const fileName = String(kwargs.file_name || '').trim();
    const candidateTable = String(kwargs.candidate_table || '').trim().split('.').filter(Boolean).at(-1) || '';
    const candidateColumn = String(kwargs.candidate_column || '').trim();
    const topK = normalizeTopK(kwargs.top_k);
    const searchQueries = buildSemanticSearchQueries(context, question);
    const dataSources = context.input_data?.data_sources_info?.business_data_sources;
    if (!question) return Result.createError(t('缺少必要参数: question'));
    if (!dataSources) return Result.createError(t('当前没有可用的知识库数据源'));

    let candidateKeys = [];
    if (candidateTable || candidateColumn) {
      if (!candidateTable || !candidateColumn) {
        return Result.createError(t('candidate_table 和 candidate_column 必须同时提供'));
      }
      if (!SAFE_IDENTIFIER.test(candidateTable) || !SAFE_IDENTIFIER.test(candidateColumn)) {
        return Result.createError(t('候选表名或列名不合法'));
      }
      const intermediateDs = context.input_data?.data_sources_info?.intermediate_ds;
      if (!intermediateDs) return Result.createError(t('当前没有可读取的中间结果'));
      const candidateResult = await intermediateDs.query(
        `SELECT DISTINCT "${candidateColumn}" AS candidate_key FROM "${candidateTable}" `
        + `WHERE "${candidateColumn}" IS NOT NULL LIMIT ${MAX_CANDIDATE_KEYS}`,
      );
      if (!candidateResult?.success) {
        return Result.createError(t('候选键读取失败: {}', candidateResult?.message || 'unknown'));
      }
      candidateKeys = (candidateResult.data || [])
        .map((row) => row?.candidate_key)
        .filter((value) => value !== null && value !== undefined && String(value).trim());
    }

    let sources = [];
    if (sourceName) {
      let resolved = null;
      try {
        resolved = dataSources.get_data_source_by_name(sourceName);
      } catch {
        resolved = null;
      }
      if (!(resolved instanceof UnstructuredDataSource)) {
        return Result.createError(t('未找到非结构化数据源: {}', sourceName));
      }
      sources = [resolved];
    } else {
      sources = dataSources.get_unstructured_sources?.() || [];
    }
    if (!sources.length) return Result.createError(t('当前没有可用的知识库数据源'));

    const perSourceTopK = Math.min(MAX_TOP_K, Math.max(topK, Math.ceil(topK * 1.5)));
    const settled = await Promise.allSettled(sources.flatMap((source) => searchQueries.map(async (searchQuery) => {
      const result = await source.query(searchQuery, {
        top_k: perSourceTopK,
        ...(fileName ? { file_name: fileName } : {}),
        ...(candidateKeys.length ? { candidate_keys: candidateKeys } : {}),
      });
      if (!result?.success) throw new Error(result?.message || t('查询失败'));
      return {
        rows: result.data || [],
        sourceName: source.datasource_name || source.id,
        retrievalHealth: result.retrieval_health || null,
      };
    })));

    const rows = fuseSemanticSearchResults(
      settled.flatMap((item) => item.status === 'fulfilled' ? [item.value] : []),
      topK,
    );
    const failedSources = settled.filter((item) => item.status === 'rejected');
    const retrievalHealth = settled
      .flatMap((item) => item.status === 'fulfilled' && item.value?.retrievalHealth
        ? [{ source_name: item.value.sourceName, ...item.value.retrievalHealth }]
        : [])
      .filter((item, index, all) => all.findIndex((candidate) => candidate.source_name === item.source_name
        && candidate.mode === item.mode) === index);
    if (!rows.length && failedSources.length === settled.length) {
      return Result.createError(t('文档检索失败: {}', failedSources[0]?.reason?.message || failedSources[0]?.reason));
    }

    const columns = new Set(rows.flatMap((row) => Object.keys(row || {})));
    if (!columns.size) {
      for (const column of ['content', 'document_name', 'content_index', 'source_name', 'retrieval_score']) {
        columns.add(column);
      }
    }
    return Result.create({
      operator: {
        nodetag: 'UnstructuredSearch',
        source_name: sourceName,
        file_name: fileName,
        query: question,
        query_count: searchQueries.length,
        top_k: topK,
        candidate_table: candidateTable,
        candidate_column: candidateColumn,
        candidate_key_count: candidateKeys.length,
        retrieval_health: retrievalHealth,
      },
      result: { columns, rows },
      'sub-query': question,
    }, t('查询执行成功'));
  }
}

export default SemanticDocumentSearchTool;
