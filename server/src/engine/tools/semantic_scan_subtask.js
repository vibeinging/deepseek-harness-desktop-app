// 迁移自 dsh_kernel/data_analyze/planner/tools/semantic_scan_subtask.py
//
// SemanticDocumentScanTool —— 对指定文件做全量切片读取，把该文件所有切片读入中间结果，
// 供后续 SQL / 过滤 / 关联使用。只能作用于非结构化文件源（UnstructuredDataSource）。
//
// 对外接口名 SemanticDocumentScanTool 与 Python 保持一致，下游 import 不变。

import { BaseTool, Result } from '../core/base_tool.js';
import { t } from '../utils/i18n.js';
import { UnstructuredDataSource } from '../datasources/business_data_sources.js';

const logger = {
  info: (...args) => console.info('[SemanticDocumentScanTool]', ...args),
  warn: (...args) => console.warn('[SemanticDocumentScanTool]', ...args),
  error: (...args) => console.error('[SemanticDocumentScanTool]', ...args),
};

/**
 * SemanticDocumentScanTool —— 非结构化文件全量切片扫描算子工具。
 */
export class SemanticDocumentScanTool extends BaseTool {
  constructor(kwargs = {}) {
    const name = 'semantic_scan_operator';
    const description = `**semantic_scan_operator** - 对指定文件做全量切片读取，将该文件的所有切片读取为中间结果，供后续 SQL / 过滤 / 关联使用
\`\`\`json
{"tool": "semantic_scan_operator", "params": {"source_name": "数据源名称（不是文档/文件名）", "file_name": "具体文件名"}}
\`\`\`
- 适用于：需要完整盘点、逐项统计或校验召回完整性，必须读取某个文件的全部切片
- 普通文档问答先用 \`semantic_search_operator\` 召回候选；不要因为知道文件名就默认全量扫描`;
    super(name, description, kwargs);
    this.name = name;
    this.description = description;
    this.output_type = 'string';
    this.inputs = {
      source_name: {
        type: 'string',
        description: 'The name of the unstructured data source.',
      },
      file_name: {
        type: 'string',
        description: 'The document title to load all chunks from.',
      },
    };
  }

  async execute(context, kwargs = {}) {
    const sourceName = kwargs.source_name;
    const fileName = kwargs.file_name;
    const dataSources = context.input_data?.data_sources_info?.business_data_sources;

    if (!sourceName) return Result.createError(t('缺少必要参数: source_name'));
    if (!fileName) return Result.createError(t('缺少必要参数: file_name'));

    logger.info(`Load all chunks from source=${sourceName} file=${fileName}`);

    let ds;
    try {
      ds = dataSources.get_data_source_by_name(sourceName);
    } catch (err) {
      // get_data_source_by_name 未找到时抛错（对应 Python 的 ValueError 分支）
      const errorMsg = t(
        '当前没有可用的知识库数据源。请前往 [数据源管理](/project/settings#unstructured) 上传非结构化文件（pdf、ofd、txt等），并在业务中关联该数据源。',
      );
      logger.warn(`${t('未找到数据源')}: '${sourceName}'`);
      return Result.createError(errorMsg);
    }

    // 类型守卫：semantic_scan_operator 只能读非结构化文件源。若解析到结构化源，
    // 下面的 "Database:xxx Table:yyy" 寻址串会被 DatabaseDataSource.query 当 SQL 执行
    // → "Parser Error near 'Database'"，agent 反复重试空转。改为明确报错并列出可用非结构化源，
    // 引导 agent 改用正确的兄弟源（常见于结构化/非结构化源同名前缀被混淆）。
    if (!(ds instanceof UnstructuredDataSource)) {
      const unstructuredNames = [...dataSources.data_sources.values()]
        .filter((d) => d instanceof UnstructuredDataSource)
        .map((d) => d.datasource_name)
        .filter(Boolean);
      const hint = unstructuredNames.length
        ? t('可用的非结构化文件源：{}', unstructuredNames.join(', '))
        : t('当前业务无非结构化文件源，结构化数据请改用 execute_readonly_sql。');
      return Result.createError(t(
        'semantic_scan_operator 仅适用于非结构化文件源，但「{}」是结构化数据源。{}',
        sourceName, hint,
      ));
    }

    const scanQuery = `Database:${sourceName} Table:${fileName}`;
    let queryResult;
    try {
      queryResult = await ds.query(scanQuery);
    } catch (e) {
      return Result.createError(`${t('查询失败')}: ${e?.message ?? e}`);
    }
    if (!queryResult.success) {
      return Result.createError(`${t('查询失败')}: ${queryResult.message}`);
    }

    // 中间结果以 Table 形态（columns 集合 + rows 列表）传给下游
    const intermediateResult = {
      columns: new Set(queryResult.columns || []),
      rows: queryResult.data || [],
    };

    // 构造与下游兼容的 operator 描述对象（对应 UnstructuredFileScan）。
    // scan_hook 在 Node 侧直接返回已读入的中间结果（query 已立即求值，无需惰性 hook）。
    const operator = {
      nodetag: 'UnstructuredFileScan',
      source_name: sourceName,
      query: scanQuery,
      file_name: fileName,
      get_next: () => intermediateResult,
    };

    const subQuery = `Read all chunks from file '${fileName}'`;

    return Result.create(
      {
        operator,
        result: intermediateResult,
        'sub-query': subQuery,
      },
      t('查询执行成功'),
    );
  }
}

export default SemanticDocumentScanTool;
