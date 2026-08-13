// Migrated from dsh_kernel/data_sources/tools/data_profiler_tool.py
//
// Data profiling utility.
// Provides:
// - DataProfilerTool: unified Schema exploration tool wrapper
// - ProfilingResult: data profiling result
// - GrepDataSourceTool / GrepTablesTool / GrepColumnsTool / GrepEntitiesTool: flattened helper tools
//
// Recommended usage: use DataGrep's grep_* methods directly.
//   const explorer = bds.data_grep;
//   const profiles = await explorer.grep_tables({ query: '订单' });
//   const profile  = await explorer.grep_columns({ table_name: 'orders', query: '金额' });
//   const values   = await explorer.grep_entities({ table_name: 'orders', column_name: 'status', keyword: '完成' });
//
// Data access implementation:
// - grep_db relationship info: reads PG relationship_metadata + table_metadata.
// - grep_tables/grep_columns/grep_entities: goes through DataGrep (reads PG metadata + DuckDB internally).
// - align_value memory/disambiguation: uses real implementation in semantic/disambiguation_service.js
//   _fetch_memories uses DisambiguationService.lookup_by_keyword (team-mapped memories, time-decay ranking),
//   is_session_auto_apply_memory reads session-level chip status (Redis-backed); falls back safely when memory/state is unavailable.

import { BaseTool, Result, runTool } from '../core/base_tool.js';
import { Profile } from './profile.js';
import { query, queryOne } from '../../db.js';
import {
  DisambiguationService,
  is_session_auto_apply_memory as _is_session_auto_apply_memory,
} from '../semantic/disambiguation_service.js';
import { t } from '../utils/i18n.js';

// ============================================================
// Memory/disambiguation service wiring: reuse the real implementation from semantic/disambiguation_service.js
// ============================================================

// Fetch team-mapped memories by exact key (project, table, column, normalize(keyword)), including time-decay ordering.
// Returns [{id, chosen_value, hit_count, last_used_at, created_by, ...}], or [] if no memory is found.
async function lookup_memories(project_id, table_name, column_name, keyword) {
  return DisambiguationService.lookup_by_keyword(
    { query, queryOne }, project_id, table_name, column_name, keyword,
  );
}

// Session-level "auto-apply memory" chip state (Redis-backed); safely falls back to false when state is unavailable.
async function is_session_auto_apply_memory(session_id) {
  return _is_session_auto_apply_memory(session_id);
}

// ============================================================
// ProfilingResult
// ============================================================

export class ProfilingResult {
  /**
   * @param {Array<Profile>} profiles
   * @param {object} [opts]
   * @param {object} [opts.profiles_dict={}]
   * @param {string|null} [opts.knowledge=null]
   */
  constructor(profiles, { profiles_dict = {}, knowledge = null } = {}) {
    this.profiles = profiles;
    this.profiles_dict = profiles_dict;
    this.knowledge = knowledge;
  }

  /**
   * Build full result from profile list (equivalent to from_profiles).
   * @param {Array<Profile>} profiles
   * @param {string|null} [knowledge=null]
   * @returns {ProfilingResult}
   */
  static from_profiles(profiles, knowledge = null) {
    /** @type {Object<string, Object<string, Profile>>} */
    const profilesDict = {};
    for (const profile of profiles) {
      const dbName = profile.database;
      const tableKey = (profile.schema_name && profile.schema_name !== 'default')
        ? `${profile.schema_name}.${profile.name}`
        : profile.name;
      if (!profilesDict[dbName]) profilesDict[dbName] = {};
      profilesDict[dbName][tableKey] = profile;
    }
    return new ProfilingResult(profiles, { profiles_dict: profilesDict, knowledge });
  }
}

// ============================================================
// DataProfilerTool
// ============================================================

export class DataProfilerTool extends BaseTool {
  constructor() {
    super(
      'grep',
      `探索数据库 Schema，支持模糊匹配和语义搜索。

### 调用格式
\`\`\`json
{"tool": "grep", "params": {"action": "动作名", ...其他参数}}
\`\`\`

### 支持的 action

| action | 用途 | 必填参数 | 可选参数 |
|--------|------|----------|----------|
| grep_db | 获取数据库概览 | 无 | 无 |
| grep_tables | 搜索/列出表 | 无 | query, datasource_name, limit, offset |
| grep_columns | 搜索/列出列 | table_name | query, datasource_name, limit, offset |
| grep_entities | 实体对齐 | table_name, column_name, keyword | datasource_name, limit |

### 实体对齐提示

用户说的名称可能与数据库实际值不同（如"北京分行" vs "北京市分行"），用 \`grep_entities\` 查找实际值后再写 SQL。`,
      { version: '2.0.0' },
    );
    /** @type {Object<string, Array<Profile>>} */
    this._static_cache = {};
  }

  // ============== Tool interface ==============

  /**
   * Unified Tool entry point, dispatch by action (maps to execute).
   * @param {import('../core/agent_context.js').AgentContext} context
   * @param {object} [kwargs]
   * @returns {Promise<Result>}
   */
  async execute(context, kwargs = {}) {
    const action = kwargs.action || 'grep_db';

    const dataSources = this._get_data_sources(context);
    if (!dataSources) {
      return Result.createError('未找到可用的数据源', t('请检查是否已正确配置数据源'));
    }

    try {
      let resultData;
      if (action === 'grep_db') {
        resultData = await this._action_grep_db(dataSources);
      } else if (action === 'grep_tables') {
        resultData = await this._action_grep_tables(dataSources, kwargs);
      } else if (action === 'grep_columns') {
        resultData = await this._action_grep_columns(dataSources, kwargs);
      } else if (action === 'grep_entities') {
        resultData = await this._action_grep_entities(dataSources, kwargs);
      } else {
        return Result.createError(
          `未知的 action: ${action}`,
          t('支持的 action: grep_db, grep_tables, grep_columns, grep_entities'),
        );
      }
      return Result.create(resultData, t('执行成功'));
    } catch (e) {
      console.error(`[DataProfilerTool] execute 失败: ${e?.message ?? e}`);
      return Result.createError(String(e?.message ?? e), t('执行失败'));
    }
  }

  /**
   * Read data sources (equivalent to _get_data_sources).
   * @param {import('../core/agent_context.js').AgentContext} context
   * @returns {import('./business_data_sources.js').BusinessDataSources|null}
   */
  _get_data_sources(context) {
    const input = context.input_data || {};
    return (
      input.business_data_sources
      || input.data_sources_info?.business_data_sources
      || null
    );
  }

  // ============== Foreign key relationship queries ==============

  /**
   * Query table-to-table foreign key relationships across all DB data sources (equivalent to _get_relationships).
   * Reads PG relationship_metadata + table_metadata (for table names) directly.
   * @param {import('./business_data_sources.js').BusinessDataSources} data_sources
   * @returns {Promise<Array<object>>}
   */
  async _get_relationships(data_sources) {
    try {
      const dbSources = data_sources.get_database_sources();
      const connIds = dbSources.map((ds) => ds.connection_id).filter(Boolean);
      if (!connIds.length) return [];

      const rels = await query(
        `SELECT r.source_column, r.target_column, r.relationship_type, r.description,
                st.table_name AS source_table, tt.table_name AS target_table
           FROM relationship_metadata r
           LEFT JOIN table_metadata st ON st.id = r.source_table_id
           LEFT JOIN table_metadata tt ON tt.id = r.target_table_id
          WHERE r.database_connection_id::text = ANY($1::text[]) AND r.deleted_at IS NULL`,
        [connIds],
      );

      return rels.map((rel) => ({
        source_table: rel.source_table || '',
        source_column: rel.source_column,
        target_table: rel.target_table || '',
        target_column: rel.target_column,
        relationship_type: rel.relationship_type || '',
        description: rel.description || '',
      }));
    } catch (e) {
      console.warn(`[DataProfilerTool] 获取外键关系失败: ${e?.message ?? e}`);
      return [];
    }
  }

  // ============== Action handlers ==============

  /** grep_db: get database overview (maps to _action_grep_db) */
  async _action_grep_db(data_sources) {
    const profiles = await data_sources.get_all_profiles();

    const datasourceDescriptions = {};
    const datasourceDbTypes = {};
    for (const ds of data_sources.get_all_sources()) {
      if (ds.datasource_name) {
        datasourceDescriptions[ds.datasource_name] = ds.description || '';
        if (ds.db_type) datasourceDbTypes[ds.datasource_name] = ds.db_type;
      }
    }

    const dbStats = {};
    for (const p of profiles) {
      const dbName = p.database || 'default';
      if (!dbStats[dbName]) dbStats[dbName] = { table_count: 0, tables: [] };
      dbStats[dbName].table_count += 1;
      dbStats[dbName].tables.push({
        table_name: p.name,
        schema_name: p.schema_name || '',
        description: p.description || '',
        column_count: p.column_map ? p.column_map.size : 0,
      });
    }

    const relationships = await this._get_relationships(data_sources);
    const sources = data_sources.get_all_sources().map((source) => ({
      datasource_name: source.datasource_name || source.id,
      source_type: source.source_type || "unknown",
      description: source.description || "",
      db_type: source.db_type || "",
    }));
    const webSearchModels = [...(data_sources.web_search_configs?.values?.() || [])].map((config) => ({
      name: config.name,
      model: config.model,
      description: config.description || "",
      is_default: config.is_default === true || Number(config.is_default) === 1,
    }));

    return {
      connections: Object.entries(dbStats).map(([dbName, stats]) => ({
        datasource_name: dbName,
        datasource_description: datasourceDescriptions[dbName] || '',
        db_type: datasourceDbTypes[dbName] || '',
        table_count: stats.table_count,
        tables_preview: stats.tables,
      })),
      total_tables: profiles.length,
      relationships,
      sources,
      web_search_models: webSearchModels,
    };
  }

  /** grep_tables: search/list tables (maps to _action_grep_tables) */
  async _action_grep_tables(data_sources, kwargs = {}) {
    const queryStr = kwargs.query ?? null;
    const databaseName = kwargs.datasource_name ?? null;
    const limit = kwargs.limit ?? 50;
    const offset = kwargs.offset ?? 0;

    const profiles = await data_sources.data_grep.grep_tables({
      query: queryStr, database_name: databaseName, limit, offset,
    });
    const tables = profiles.map((p) => DataProfilerTool._profile_to_table_dict(p));

    return { tables, total: tables.length, has_more: tables.length >= limit };
  }

  /** grep_columns: search/list columns (maps to _action_grep_columns) */
  async _action_grep_columns(data_sources, kwargs = {}) {
    const tableName = kwargs.table_name ?? null;
    const databaseName = kwargs.datasource_name ?? null;
    const queryStr = kwargs.query ?? null;
    const limit = kwargs.limit ?? 50;

    if (!tableName) {
      return { error: 'table_name 是必填参数', columns: [] };
    }

    const profile = await data_sources.data_grep.grep_columns({
      table_name: tableName, query: queryStr, database_name: databaseName, limit,
    });

    if (!profile) {
      return {
        datasource_name: databaseName, table_name: tableName,
        columns: [], total: 0, has_more: false,
      };
    }

    const columns = profile.columns.map((col) => DataProfilerTool._column_to_dict(col));
    return {
      datasource_name: profile.database,
      table_name: profile.name,
      schema_name: profile.schema_name || '',
      columns,
      total: columns.length,
      has_more: columns.length >= limit,
    };
  }

  /** grep_entities: entity alignment (maps to _action_grep_entities) */
  async _action_grep_entities(data_sources, kwargs = {}) {
    const tableName = kwargs.table_name ?? null;
    const columnName = kwargs.column_name ?? null;
    const databaseName = kwargs.datasource_name ?? null;
    const keyword = kwargs.keyword ?? null;
    const limit = kwargs.limit ?? 20;

    if (!tableName || !columnName) {
      return { error: 'table_name 和 column_name 是必填参数', values: [] };
    }
    if (!keyword) {
      return { error: 'keyword 是必填参数，请提供搜索关键词', values: [] };
    }

    const entities = await data_sources.data_grep.grep_entities({
      table_name: tableName, column_name: columnName, keyword, database_name: databaseName, limit,
    });

    return {
      datasource_name: databaseName,
      table_name: tableName,
      column_name: columnName,
      keyword,
      values: entities,
      total: entities.length,
      has_more: entities.length >= limit,
    };
  }

  // ============== Result shape conversion ==============

  /** Convert Profile to table dictionary (equivalent to _profile_to_table_dict) */
  static _profile_to_table_dict(profile) {
    const dsType = profile.datasource_type || 'SQLDatabase';
    const result = {
      table_name: profile.name,
      schema_name: profile.schema_name || '',
      datasource_name: profile.database,
      datasource_type: dsType,
      description: profile.description || '',
      column_count: profile.column_map ? profile.column_map.size : 0,
    };
    if (dsType === 'UnstructuredFile') {
      result['说明'] = '这是非结构化文件，需用 semantic_scan_operator 按 file_name 读取全部切片为中间表，'
        + '不能用 execute_readonly_sql / SQL 查询';
    }
    if (profile.similarity !== null && profile.similarity !== undefined) {
      result.similarity = profile.similarity;
    }
    return result;
  }

  /** Convert Column to dictionary (equivalent to _column_to_dict) */
  static _column_to_dict(column) {
    const result = {
      column_name: column.name,
      name: column.name,
      description: column.description || '',
    };
    const typeList = [...(column.types || [])];
    if (typeList.length) {
      // Types are stored as type-name strings (for example 'int'), and Python reads them from .__name__.
      result.data_type = String(typeList[0]);
    }
    if (column.sample_values && column.sample_values.length) {
      result.sample_values = column.sample_values.slice(0, 5);
    }
    return result;
  }

  // ============== Compatibility layer (supports direct invocation) ==============

  /**
   * Backward-compatible entry point (equivalent to Python __call__).
   * @param {import('../core/agent_context.js').AgentContext} agent_context
   * @param {object} [opts]
   * @param {boolean} [opts.include_dynamic=true]
   * @param {boolean} [opts.include_knowledge=false]
   * @returns {Promise<ProfilingResult>}
   */
  async call(agent_context, { include_dynamic = true, include_knowledge = false } = {}) {
    const question = agent_context.input_data?.user_message || '';
    const dataSources = this._get_data_sources(agent_context);

    if (!dataSources) {
      const contextDataKeys = agent_context.data ? Object.keys(agent_context.data) : [];
      const inputDataKeys = agent_context.input_data ? Object.keys(agent_context.input_data) : [];
      throw new Error(
        `[DataProfilerTool] Missing business_data_sources.`
        + `context.data keys=${JSON.stringify(contextDataKeys)}, `
        + `input_data keys=${JSON.stringify(inputDataKeys)}`,
      );
    }

    const sessionId = agent_context.input_data?.session_id;
    console.info(`📊 [DataProfilerTool] 生成问题画像: ${question}`);

    const allProfiles = await this.get_profiles({
      question, data_sources: dataSources, session_id: sessionId, include_dynamic,
    });

    let knowledge = null;
    if (include_knowledge) {
      knowledge = await dataSources.kb_search(question, 5);
    }

    console.info(`📊 [DataProfilerTool] 共发现 ${allProfiles.length} 个表格`);
    return ProfilingResult.from_profiles(allProfiles, knowledge);
  }

  /**
   * Get profiling list (equivalent to get_profiles).
   * @param {object} opts
   * @param {string} opts.question
   * @param {import('./business_data_sources.js').BusinessDataSources} opts.data_sources
   * @param {string|null} [opts.session_id=null]
   * @param {boolean} [opts.include_dynamic=true]
   * @returns {Promise<Array<Profile>>}
   */
  async get_profiles({ question, data_sources, session_id = null, include_dynamic = true }) {
    // 1. Static profiling (cached)
    if (!(question in this._static_cache)) {
      this._static_cache[question] = await data_sources.get_all_profiles(question);
    }
    const staticProfiles = this._static_cache[question];

    // 2. Dynamic profiling (not cached)
    let dynamicProfiles = [];
    if (include_dynamic && session_id) {
      const intermediateDs = data_sources.register_intermediate_data_source(session_id);
      dynamicProfiles = await intermediateDs.profile(question);
      if (dynamicProfiles.length) {
        console.info(
          `📊 [DataProfilerTool] 动态画像：\n`
          + dynamicProfiles.map((p) => `  -- ${p.database}.${p.name}`).join('\n'),
        );
      }
    }

    const allProfiles = [...staticProfiles, ...dynamicProfiles];
    console.info(
      `📊 [DataProfilerTool] 画像总数: ${allProfiles.length} `
      + `(静态: ${staticProfiles.length}, 动态: ${dynamicProfiles.length})`,
    );
    return allProfiles;
  }
}

// ============================================================
// Flattened tools (direct invocation)
// ============================================================

export class GrepDataSourceTool extends BaseTool {
  constructor() {
    super(
      'grep_datasource',
      `获取所有数据源和表的概览。

**用途**：了解有哪些数据源、每个数据源有多少表。多数据源时必须先调用此工具。`,
    );
    this._profiler = new DataProfilerTool();
  }

  async execute(context, kwargs = {}) {
    return runTool(this._profiler, context, { action: 'grep_db', ...kwargs });
  }
}

export class GrepTablesTool extends BaseTool {
  constructor() {
    super(
      'grep_tables',
      `搜索或列出数据库中的表。

**参数**：query(可选,语义搜索)/ datasource_name(可选)/ limit(默认50)/ offset(默认0)`,
    );
    this.inputs = {
      query: { type: 'string', description: '搜索关键词（可选，支持语义搜索）', optional: true, default: '' },
      datasource_name: { type: 'string', description: '数据源名称（可选，多数据源时指定）', optional: true, default: '' },
      limit: { type: 'integer', description: '返回数量', optional: true, default: 50 },
      offset: { type: 'integer', description: '分页偏移', optional: true, default: 0 },
    };
    this._profiler = new DataProfilerTool();
  }

  async execute(context, kwargs = {}) {
    return runTool(this._profiler, context, { action: 'grep_tables', ...kwargs });
  }
}

export class GrepColumnsTool extends BaseTool {
  constructor() {
    super(
      'grep_columns',
      `搜索或列出表中的列。

**参数**：table_name(必填)/ query(可选,语义搜索)/ datasource_name(可选)/ limit(默认50)`,
    );
    this.inputs = {
      table_name: { type: 'string', description: '表名（必填）' },
      query: { type: 'string', description: '搜索关键词（可选，支持语义搜索）', optional: true, default: '' },
      datasource_name: { type: 'string', description: '数据源名（可选）', optional: true, default: '' },
      limit: { type: 'integer', description: '返回数量', optional: true, default: 50 },
    };
    this._profiler = new DataProfilerTool();
  }

  async execute(context, kwargs = {}) {
    return runTool(this._profiler, context, { action: 'grep_columns', ...kwargs });
  }
}

export class GrepEntitiesTool extends BaseTool {
  constructor() {
    super(
      'align_value',
      `\`align_value\`：把用户口中的字符串字面量映射到库存真值，再写 SQL。

用法：将进 WHERE 的字面量先调 \`align_value\` → 单一候选直接用；多候选难分用 \`ask_user.options\`。
不要直接 \`WHERE col='用户原文'\` 或 \`LIKE '%用户原文%'\`。

返回 \`{values: [{value, source?, memory_meta?}, ...], total}\`。

参数：table_name / column_name / keyword（用户原文）/ limit。`,
    );
    this.inputs = {
      table_name: { type: 'string', description: '表名（必填）' },
      column_name: { type: 'string', description: '列名（必填）' },
      keyword: { type: 'string', description: '搜索关键词（必填）' },
      datasource_name: { type: 'string', description: '数据源名（可选）', optional: true, default: '' },
      limit: { type: 'integer', description: '返回数量', optional: true, default: 20 },
    };
    this._profiler = new DataProfilerTool();
  }

  async execute(context, kwargs = {}) {
    const projectId = context.input_data?.project_id || context.project_id || context.input_data?.business_id;
    const sessionId = context.input_data?.session_id;
    const tableName = kwargs.table_name;
    const columnName = kwargs.column_name;
    const keyword = kwargs.keyword || '';

    // 项目上下文 / keyword 不全 → 跳过记忆 lookup,直接走原召回
    if (!(projectId && tableName && columnName && keyword)) {
      const result = await runTool(this._profiler, context, { action: 'grep_entities', ...kwargs });
      return GrepEntitiesTool._strip_vector_internals(result);
    }

    const memories = await GrepEntitiesTool._fetch_memories(projectId, tableName, columnName, keyword);
    if (!memories.length) {
      const result = await runTool(this._profiler, context, { action: 'grep_entities', ...kwargs });
      return GrepEntitiesTool._strip_vector_internals(result);
    }

    const multiMemory = memories.length > 1;
    const memoryEntries = memories.map((m) => ({
      value: m.chosen_value,
      source: 'memory',
      memory_id: m.id,
      memory_meta: {
        team_mapping: multiMemory
          ? `团队此前对「${keyword}」共有 ${memories.length} 个选择，「${m.chosen_value}」被选过 ${m.hit_count} 次`
          : `团队此前已将「${keyword}」精确映射为「${m.chosen_value}」`,
        hit_count: m.hit_count,
        last_used_at: m.last_used_at,
        created_by: m.created_by,
      },
    }));

    const autoApply = sessionId ? await is_session_auto_apply_memory(sessionId) : false;
    if (autoApply) {
      const topEntry = memoryEntries[0];
      return new Result({ success: true, data: { values: [topEntry], total: 1 } });
    }

    const result = await runTool(this._profiler, context, { action: 'grep_entities', ...kwargs });
    if (result.success && result.data && typeof result.data === 'object') {
      const vectorValues = GrepEntitiesTool._strip_vector_values(result.data.values || []);
      result.data.values = [...memoryEntries, ...vectorValues];
      result.data.total = result.data.values.length;
      result.data._require_user_confirm = true;
    }
    return result;
  }

  /** Keep only value for vector/like candidates (equivalent to _strip_vector_values) */
  static _strip_vector_values(values) {
    return (values || [])
      .filter((v) => v && typeof v === 'object' && v.value)
      .map((v) => ({ value: v.value }));
  }

  /** In original recall path without memory, also strip internals (equivalent to _strip_vector_internals) */
  static _strip_vector_internals(result) {
    if (result.success && result.data && typeof result.data === 'object') {
      result.data.values = GrepEntitiesTool._strip_vector_values(result.data.values || []);
      result.data.total = result.data.values.length;
    }
    return result;
  }

  /** Lookup team-mapped memories (equivalent to _fetch_memories) */
  static async _fetch_memories(project_id, table_name, column_name, keyword) {
    try {
      return await lookup_memories(project_id, table_name, column_name, keyword);
    } catch (e) {
      console.warn(`[GrepEntitiesTool] lookup memory 失败（忽略）: ${e?.message ?? e}`);
      return [];
    }
  }
}

export default {
  DataProfilerTool,
  ProfilingResult,
  GrepDataSourceTool,
  GrepTablesTool,
  GrepColumnsTool,
  GrepEntitiesTool,
};
