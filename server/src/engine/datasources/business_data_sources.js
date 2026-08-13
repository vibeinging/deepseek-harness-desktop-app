// 迁移自 dsh_kernel/data_sources/datasource/business_data_sources.py
//
// 业务数据源容器
// 管理和封装业务的所有数据源。
//
// 职责:
// - 数据源注册与管理(加载、添加、移除、查询)
// - 中间数据源管理
// - Profile 聚合
// - 查询路由
//
// Schema 探索功能: 通过 data_grep 属性访问 DataGrep 实例。
//
// 数据访问实现:
// - load_sources(): 直接读 PG(business_data_sources JOIN 各源表),替代 Python 的
//   BusinessService.get_data_sources(SQLAlchemy)。
// - UnstructuredDataSource / TempFileDataSource / MCPDataSource 尚未在 Node 单独迁移,
//   这里提供最小 stub 类(继承 DataSource,profile/query 抛 NotImplemented),
//   保证容器接口完整;后续单独迁移时替换为正式实现。

import { randomUUID } from 'node:crypto';

import { DataSource, QueryResult } from './data_source.js';
import { DatabaseDataSource } from './database_data_source.js';
import { IntermediateDataSource } from './intermediate_data_source.js';
import { DataGrep } from './data_grep.js';
import { UnstructuredDataSource } from './unstructured_data_source.js';
import { query } from '../../db.js';
import { t } from '../utils/i18n.js';
import { buildQueryExecutionEvidence } from './query_execution_evidence.js';

// 非结构化数据源已迁为独立模块,这里 re-export 保持原 import 路径兼容
export { UnstructuredDataSource };

// ============================================================
// 最小 stub 数据源(尚未单独迁移的类型)
// ============================================================


/** MCP 数据源 stub(对应 mcp_data_source.py,待单独迁移) */
export class MCPDataSource extends DataSource {
  constructor(business_id, project_id, raw_id, { source_id = null } = {}) {
    super(source_id || raw_id, business_id, project_id, 'mcp_data_source');
    this.raw_id = raw_id;
  }

  async profile(_user_message = null) {
    const err = new Error('MCPDataSource.profile 尚未在 Node 迁移');
    err.name = 'NotImplementedError';
    throw err;
  }

  async query(_query, _kwargs = {}) {
    return QueryResult.error('MCPDataSource.query 尚未在 Node 迁移');
  }
}

/** 临时文件数据源 stub(对应 temp_file_data_source.py,待单独迁移) */
export class TempFileDataSource extends DataSource {
  constructor(business_id, project_id, generated_id, file_path, file_name, description) {
    super(generated_id, business_id, project_id, 'temp_file');
    this.file_path = file_path;
    this.datasource_name = file_name;
    this.description = description;
  }

  async profile(_user_message = null) {
    const err = new Error('TempFileDataSource.profile 尚未在 Node 迁移');
    err.name = 'NotImplementedError';
    throw err;
  }

  async query(_query, _kwargs = {}) {
    return QueryResult.error('TempFileDataSource.query 尚未在 Node 迁移');
  }
}

// ============================================================
// BusinessDataSources
// ============================================================

export class BusinessDataSources {
  /**
   * @param {string} business_id
   * @param {string} project_id
   */
  constructor(business_id, project_id) {
    this.business_id = business_id;
    this.project_id = project_id;
    // 统一存储:所有数据源都用 UUID ID
    /** @type {Map<string, DataSource>} */
    this.data_sources = new Map(); // uuid -> DataSource
    /** @type {Map<string, string>} */
    this.data_source_aliases = new Map(); // alias -> canonical uuid
    /** @type {Map<string, object>} */
    this.web_search_configs = new Map(); // name -> config
    this._loaded = false;
    /** @type {Map<string, IntermediateDataSource>} */
    this.intermediate_data_sources = new Map(); // session_id -> IntermediateDataSource
    // Schema 探索器(延迟初始化)
    this._data_grep = null;
  }

  /** 获取 Schema 探索器实例(延迟初始化,对应 @property data_grep) */
  get data_grep() {
    if (this._data_grep === null) {
      this._data_grep = new DataGrep(this);
    }
    return this._data_grep;
  }

  /**
   * 从 PG 加载该业务的所有数据源(对应 load_sources)。
   * 替代 Python BusinessService.get_data_sources(SQLAlchemy)。
   */
  async load_sources() {
    if (this._loaded) return;
    try {
      const dataSourcesInfo = await this._fetch_data_sources_info();
      await this._create_data_sources_from_info(dataSourcesInfo);
      this._loaded = true;
      console.info(
        `[BusinessDataSources] 业务 ${this.business_id} 加载了 ${this.data_sources.size} 个数据源 `
        + `和 ${this.web_search_configs.size} 个Web搜索配置`,
      );
    } catch (e) {
      console.error(`[BusinessDataSources] 加载业务数据源失败: ${e?.message ?? e}`);
      this._loaded = false;
      throw e;
    }
  }

  /** @alias load_sources */
  async loadSources() { return this.load_sources(); }

  /**
   * 直接读 PG 拉取业务绑定的各类数据源,组装成 get_data_sources 的返回结构。
   * @returns {Promise<object>}
   */
  async _fetch_data_sources_info() {
    const info = {
      database_connections: [],
      unstructured_data_sources: [],
      web_search_models: [],
      mcp_data_sources: [],
    };

    // 项目数据源绑定关系(去业务层:按 project_id 取)
    const assocs = await query(
      `SELECT id AS source_id, source_type, source_id AS raw_source_id
         FROM business_data_sources
        WHERE project_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC`,
      [this.project_id],
    );

    const grouped = {
      database_connection: [],
      structured_data_source: [],
      unstructured_data_source: [],
      web_search_model: [],
      mcp_data_source: [],
    };
    for (const a of assocs) {
      if (grouped[a.source_type]) grouped[a.source_type].push(a);
    }

    // 数据库连接
    if (grouped.database_connection.length) {
      const ids = grouped.database_connection.map((a) => a.raw_source_id);
      const rows = await query(
        `SELECT id, name, db_type, description FROM database_connections
          WHERE id::text = ANY($1::text[]) AND project_id=$2 AND deleted_at IS NULL`,
        [ids, this.project_id],
      );
      const assocByRaw = new Map(grouped.database_connection.map((a) => [a.raw_source_id, a]));
      for (const ds of rows) {
        const a = assocByRaw.get(ds.id);
        info.database_connections.push({
          id: ds.id,
          source_id: a ? a.source_id : null,
          name: ds.name,
          db_type: ds.db_type,
          description: ds.description,
        });
      }
    }

    // 结构化数据源(Excel/CSV 导入):解析到底层 DuckDB database_connection,并入 database_connections,
    // 走与数据库连接相同的 SQL 查询链路(structured_data_sources.database_connection_id)。
    if (grouped.structured_data_source.length) {
      const ids = grouped.structured_data_source.map((a) => a.raw_source_id);
      const rows = await query(
        `SELECT s.id AS sds_id, s.name, s.description, c.id AS conn_id, c.db_type
           FROM structured_data_sources s
           JOIN database_connections c ON c.id = s.database_connection_id
          WHERE s.id::text = ANY($1::text[]) AND s.project_id=$2 AND c.project_id=$2
            AND s.deleted_at IS NULL AND c.deleted_at IS NULL`,
        [ids, this.project_id],
      ).catch(() => []);
      const assocByRaw = new Map(grouped.structured_data_source.map((a) => [a.raw_source_id, a]));
      for (const ds of rows) {
        const a = assocByRaw.get(ds.sds_id);
        info.database_connections.push({
          id: ds.conn_id,
          source_id: a ? a.source_id : null,
          name: ds.name,
          db_type: ds.db_type,
          description: ds.description,
        });
      }
    }

    // 非结构化数据源
    if (grouped.unstructured_data_source.length) {
      const ids = grouped.unstructured_data_source.map((a) => a.raw_source_id);
      const rows = await query(
        `SELECT id, name, description FROM unstructured_data_sources
          WHERE id::text = ANY($1::text[]) AND project_id=$2 AND deleted_at IS NULL`,
        [ids, this.project_id],
      ).catch(() => []);
      const assocByRaw = new Map(grouped.unstructured_data_source.map((a) => [a.raw_source_id, a]));
      for (const ds of rows) {
        const a = assocByRaw.get(ds.id);
        info.unstructured_data_sources.push({
          id: ds.id, source_id: a ? a.source_id : null, name: ds.name, description: ds.description,
        });
      }
    }

    // Web 搜索配置属于项目。新写入仍保留 business_data_sources 绑定，兼容统一的数据源清单；
    // 读取时同时合并项目下的有效配置，让升级前未绑定的旧配置无需先打开设置页也能被分析链路发现。
    // 这里不补写绑定，避免在线查询产生隐式写操作；设置页读取会负责幂等修复持久绑定。
    const webAssocByRaw = new Map(grouped.web_search_model.map((a) => [a.raw_source_id, a]));
    const webRows = await query(
      `SELECT id, project_id, name, model, api, description, config_type,
              custom_config, is_default
         FROM web_search_models
        WHERE project_id=$1 AND deleted_at IS NULL
        ORDER BY is_default DESC, created_at DESC`,
      [this.project_id],
    ).catch(() => []);
    for (const ds of webRows) {
      const assoc = webAssocByRaw.get(ds.id);
      let customConfig = {};
      try {
        const parsed = typeof ds.custom_config === 'string'
          ? JSON.parse(ds.custom_config || '{}')
          : ds.custom_config;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) customConfig = parsed;
      } catch {
        customConfig = {};
      }
      info.web_search_models.push({
        id: ds.id,
        project_id: ds.project_id,
        source_id: assoc?.source_id || ds.id,
        name: ds.name,
        model: ds.model,
        api: ds.api,
        description: ds.description,
        config_type: ds.config_type,
        custom_config: customConfig,
        is_default: ds.is_default === true || Number(ds.is_default) === 1,
      });
    }

    // MCP 数据源
    if (grouped.mcp_data_source.length) {
      const ids = grouped.mcp_data_source.map((a) => a.raw_source_id);
      const rows = await query(
        `SELECT id, name, description FROM mcp_data_sources
          WHERE id::text = ANY($1::text[]) AND deleted_at IS NULL`,
        [ids],
      ).catch(() => []);
      const assocByRaw = new Map(grouped.mcp_data_source.map((a) => [a.raw_source_id, a]));
      for (const ds of rows) {
        const a = assocByRaw.get(ds.id);
        info.mcp_data_sources.push({
          id: ds.id, source_id: a ? a.source_id : null, name: ds.name, description: ds.description,
        });
      }
    }

    return info;
  }

  /**
   * 根据 _fetch_data_sources_info 返回的信息创建 DataSource 实例
   * (对应 _create_data_sources_from_info)。
   * @param {object} data_sources_info
   */
  async _create_data_sources_from_info(data_sources_info) {
    // 数据库连接
    for (const dbInfo of data_sources_info.database_connections || []) {
      const dataSource = new DatabaseDataSource(
        this.business_id, this.project_id, dbInfo.id,
        { db_type: dbInfo.db_type, source_id: dbInfo.source_id || dbInfo.id },
      );
      dataSource.datasource_name = dbInfo.name;
      dataSource.description = dbInfo.description ?? null;
      const sourceId = dataSource.id;
      this.data_sources.set(sourceId, dataSource);
      this._register_source_aliases(sourceId, dbInfo.id, dbInfo.source_id);
    }

    // 非结构化数据源
    for (const usInfo of data_sources_info.unstructured_data_sources || []) {
      const dataSource = new UnstructuredDataSource(
        this.business_id, this.project_id, usInfo.id,
        { source_id: usInfo.source_id || usInfo.id },
      );
      dataSource.datasource_name = usInfo.name;
      dataSource.description = usInfo.description ?? null;
      const sourceId = dataSource.id;
      this.data_sources.set(sourceId, dataSource);
      this._register_source_aliases(sourceId, usInfo.id, usInfo.source_id);
    }

    // Web 搜索配置(不创建 DataSource 实例,仅缓存)
    for (const webConfig of data_sources_info.web_search_models || []) {
      this.web_search_configs.set(webConfig.name, webConfig);
    }

    // MCP 数据源
    for (const mcpInfo of data_sources_info.mcp_data_sources || []) {
      const dataSource = new MCPDataSource(
        this.business_id, this.project_id, mcpInfo.id,
        { source_id: mcpInfo.source_id || mcpInfo.id },
      );
      dataSource.datasource_name = mcpInfo.name;
      dataSource.description = mcpInfo.description ?? null;
      const sourceId = dataSource.id;
      this.data_sources.set(sourceId, dataSource);
      this._register_source_aliases(sourceId, mcpInfo.id, mcpInfo.source_id);
    }
  }

  /** 根据 UUID 获取数据源(对应 get_data_source) */
  get_data_source(source_id) {
    const canonical = this._resolve_source_id(source_id);
    if (!canonical) return null;
    return this.data_sources.get(canonical) || null;
  }

  /** 获取所有数据源(对应 get_all_sources) */
  get_all_sources() {
    return [...this.data_sources.values()];
  }

  /** 根据类型获取数据源(对应 get_sources_by_type) */
  get_sources_by_type(source_type) {
    return [...this.data_sources.values()].filter((s) => s.source_type === source_type);
  }

  get_database_sources() { return this.get_sources_by_type('database_connection'); }

  get_unstructured_sources() { return this.get_sources_by_type('unstructured_data_source'); }

  get_mcp_sources() { return this.get_sources_by_type('mcp_data_source'); }

  get_temp_file_sources() { return this.get_sources_by_type('temp_file'); }

  /** 获取 Web 搜索配置(对应 get_web_search_config) */
  get_web_search_config(name) {
    return this.web_search_configs.get(name) || null;
  }

  // ==================== 中间数据源管理 ====================

  /**
   * 注册并获取指定 session 的中间数据源(对应 register_intermediate_data_source)。
   * @param {string} session_id
   * @returns {IntermediateDataSource}
   */
  register_intermediate_data_source(session_id, { run_id = null } = {}) {
    if (!this.intermediate_data_sources.has(session_id)) {
      const sourceKey = `intermediate_${run_id || session_id}`;
      const intermediateDs = new IntermediateDataSource({
        session_id,
        project_id: this.project_id,
        business_id: this.business_id,
        intermediate_data_source_id: sourceKey,
        run_id,
      });
      this.data_sources.set(sourceKey, intermediateDs);
      this._register_source_aliases(sourceKey, sourceKey);
      this.intermediate_data_sources.set(session_id, intermediateDs);
      console.info(`[BusinessDataSources] 为 session ${session_id} 注册中间数据源到业务 ${this.business_id}`);
    }
    return this.intermediate_data_sources.get(session_id);
  }

  // ==================== 动态数据源管理 ====================

  /**
   * 添加数据源到当前容器(仅内存操作,对应 add_data_source)。
   * @param {string} source_type
   * @param {string|null} [source_id=null]
   * @param {object} [kwargs={}]
   * @returns {DataSource|null}
   */
  add_data_source(source_type, source_id = null, kwargs = {}) {
    const validTypes = ['database_connection', 'unstructured_data_source', 'temp_file', 'intermediate', 'mcp_data_source'];
    if (!validTypes.includes(source_type)) {
      throw new Error(t('无效的数据源类型: {}. 允许的类型: {}', source_type, validTypes.join(',')));
    }

    let sid = source_id;
    if (source_type === 'temp_file') {
      if (!('file_path' in kwargs)) throw new Error(t('临时文件必须提供file_path参数'));
      sid = randomUUID();
      kwargs.generated_id = sid;
    } else if (source_type === 'intermediate') {
      if (!('session_id' in kwargs)) throw new Error(t('中间数据源必须提供session_id参数'));
      sid = randomUUID();
      kwargs.generated_id = sid;
    } else if (sid == null) {
      throw new Error(t('{} 必须提供UUID格式的source_id', source_type));
    }

    const existing = this._resolve_source_id(sid);
    if (existing && this.data_sources.has(existing)) {
      console.warn(`数据源已存在：${source_type}:${sid}`);
      return this.data_sources.get(existing);
    }

    try {
      let dataSource;
      if (source_type === 'database_connection') {
        dataSource = new DatabaseDataSource(this.business_id, this.project_id, sid);
      } else if (source_type === 'unstructured_data_source') {
        dataSource = new UnstructuredDataSource(this.business_id, this.project_id, sid);
      } else if (source_type === 'mcp_data_source') {
        dataSource = new MCPDataSource(this.business_id, this.project_id, sid);
      } else if (source_type === 'temp_file') {
        dataSource = new TempFileDataSource(
          this.business_id, this.project_id, kwargs.generated_id,
          kwargs.file_path, kwargs.file_name ?? `temp_file_${sid}`, kwargs.description ?? '临时文件',
        );
      } else if (source_type === 'intermediate') {
        dataSource = new IntermediateDataSource({
          session_id: kwargs.session_id,
          project_id: this.project_id,
          business_id: this.business_id,
          intermediate_data_source_id: kwargs.generated_id,
        });
      } else {
        return null;
      }

      this.data_sources.set(sid, dataSource);
      this._register_source_aliases(sid, sid);
      console.info(`添加数据源：${source_type}:${sid}`);
      return dataSource;
    } catch (e) {
      console.error(`创建DataSource实例失败 ${source_type}:${sid}: ${e?.message ?? e}`);
      return null;
    }
  }

  /** 从容器中移除数据源(对应 remove_data_source) */
  remove_data_source(source_id) {
    const canonical = this._resolve_source_id(source_id);
    if (!canonical || !this.data_sources.has(canonical)) return false;
    this.data_sources.delete(canonical);
    for (const [alias, target] of [...this.data_source_aliases]) {
      if (target === canonical) this.data_source_aliases.delete(alias);
    }
    return true;
  }

  /** 检查是否包含指定数据源(对应 has_data_source) */
  has_data_source(source_id) {
    const canonical = this._resolve_source_id(source_id);
    return canonical != null && this.data_sources.has(canonical);
  }

  /** 清空所有数据源(对应 clear_data_sources) */
  clear_data_sources() {
    const count = this.data_sources.size;
    this.data_sources.clear();
    this.data_source_aliases.clear();
    return count;
  }

  /** 按类型统计数据源数量(对应 get_data_source_count_by_type) */
  get_data_source_count_by_type() {
    const countByType = {
      database_connection: 0,
      unstructured_data_source: 0,
      mcp_data_source: 0,
      temp_file: 0,
    };
    for (const ds of this.data_sources.values()) {
      if (ds.source_type in countByType) countByType[ds.source_type] += 1;
    }
    return countByType;
  }

  /**
   * 获取所有数据源的 Profile 信息(对应 get_all_profiles)。
   * @param {string|null} [user_message=null]
   * @param {Array<object>|null} [entities=null]
   * @param {Array<object>|null} [metrics=null]
   * @returns {Promise<Array<import('./profile.js').Profile>>}
   */
  async get_all_profiles(user_message = null, entities = null, metrics = null) {
    const allProfiles = [];
    console.info(`[BusinessDataSources] get_all_profiles: ${this.data_sources.size} 个数据源`);
    for (const source of this.data_sources.values()) {
      try {
        let profiles;
        if (source.source_type === 'database_connection') {
          profiles = await source.profile(user_message, entities, metrics);
        } else {
          profiles = await source.profile(user_message);
        }
        allProfiles.push(...profiles);
      } catch (e) {
        if (e?.name === 'NotImplementedError') {
          // 非结构化数据源等不支持 Profile,忽略
          console.debug(`数据源 ${source.id} (${source.source_type}) 暂不支持 Profile: ${e.message}`);
        } else {
          console.warn(`获取数据源 profile 失败 ${source.id}: ${e?.message ?? e}`);
        }
      }
    }
    return allProfiles;
  }

  /**
   * 知识库搜索(非结构化数据源向量搜索,对应 kb_search)。
   * @param {string} queryStr
   * @param {number} [top_k=5]
   * @returns {Promise<string>}
   */
  async kb_search(queryStr, top_k = 5) {
    let allResults = [];
    const unstructuredSources = this.get_unstructured_sources();
    for (const us of unstructuredSources) {
      try {
        const queryResult = await us.query(queryStr, { top_k });
        const rows = queryResult?.data ?? queryResult?.results;
        if ((queryResult.success ?? true) && Array.isArray(rows)) {
          allResults.push(...rows.map((row) => ({
            ...row,
            metadata: {
              ...(row.metadata || {}),
              source_name: us.datasource_name || us.id,
              document_name: row.document_name || null,
              content_index: row.content_index ?? null,
            },
            similarity: row.retrieval_score ?? row.vector_similarity ?? row.similarity ?? 0,
          })));
        }
      } catch (e) {
        console.warn(`[kb_search] 数据源 ${us.id} 查询失败: ${e?.message ?? e}`);
      }
    }
    allResults = allResults.sort((a, b) => (b.similarity || 0) - (a.similarity || 0));
    const topResults = allResults.slice(0, top_k);
    return topResults
      .map((res) => `meta: ${JSON.stringify(res.metadata || {})}\ncontent: ${res.content || ''}`)
      .join('\n');
  }

  /**
   * 按名称获取数据源(对应 get_data_source_by_name)。未找到抛错。
   * @param {string} name
   * @returns {DataSource}
   */
  get_data_source_by_name(name) {
    for (const ds of this.data_sources.values()) {
      if (ds.datasource_name === name) return ds;
    }
    for (const ds of this.intermediate_data_sources.values()) {
      if (ds.datasource_name === name) return ds;
    }
    throw new Error(t('未找到名称为 {} 的数据源', name));
  }

  /** 数据源数量(对应 __len__,仅传统数据源) */
  get length() {
    return this.data_sources.size;
  }

  /** 是否有任何数据源配置(对应 __bool__) */
  get isEmpty() {
    return !(this.data_sources.size > 0
      || this.web_search_configs.size > 0
      || this.intermediate_data_sources.size > 0);
  }

  /** 是否包含指定数据源(对应 __contains__) */
  has(source_id) {
    return this.has_data_source(source_id);
  }

  toString() {
    return (
      `<BusinessDataSources business_id=${this.business_id} `
      + `project_id=${this.project_id} `
      + `sources=${this.data_sources.size} `
      + `web_configs=${this.web_search_configs.size}>`
    );
  }

  _register_source_aliases(canonical_source_id, ...aliases) {
    for (const alias of aliases) {
      const aliasText = String(alias ?? '').trim();
      if (aliasText) this.data_source_aliases.set(aliasText, canonical_source_id);
    }
  }

  _resolve_source_id(source_id) {
    const sourceText = String(source_id ?? '').trim();
    if (!sourceText) return null;
    return this.data_source_aliases.get(sourceText) || sourceText;
  }

  // ==================== 查询方法 ====================

  /**
   * 执行查询(对应 query)。
   * @param {string} datasource_name
   * @param {any} queryArg SQL 字符串或条件
   * @param {object} [opts]
   * @param {string|null} [opts.session_id=null]
   * @param {string|null} [opts.project_id=null]
   * @returns {Promise<QueryResult>}
   */
  async query(datasource_name, queryArg, { session_id = null, project_id = null, ...rest } = {}) {
    const startedAt = new Date();
    let ds = null;
    try {
      ds = this.get_data_source_by_name(datasource_name);
      const result = await ds.query(queryArg, {
        project_id, session_id, business_data_sources: this, ...rest,
      });
      result.evidence = await buildQueryExecutionEvidence({
        datasource: ds,
        statement: queryArg,
        parameters: rest.parameters || [],
        result,
        startedAt,
        finishedAt: new Date(),
      });
      return result;
    } catch (e) {
      console.error(`[BusinessDataSources] query 失败: ${e?.message ?? e}`);
      const result = QueryResult.error(`查询失败: ${e?.message ?? e}`, typeof queryArg === 'string' ? queryArg : null);
      result.evidence = await buildQueryExecutionEvidence({
        datasource: ds,
        statement: queryArg,
        parameters: rest.parameters || [],
        result,
        startedAt,
        finishedAt: new Date(),
      }).catch(() => null);
      return result;
    }
  }

  /**
   * 生成用于 LLM 的数据源描述字符串(对应 to_prompt_string)。
   * @returns {string}
   */
  to_prompt_string() {
    if (!this.data_sources.size) return '无可用数据源';

    const lines = ['可用数据源：'];

    const dbSources = this.get_database_sources();
    if (dbSources.length) {
      lines.push('【数据库】');
      for (const ds of dbSources) {
        const desc = ds.description ? `，描述：${ds.description}` : '';
        lines.push(`  - 数据源名称：\`${ds.datasource_name}\`${desc}`);
      }
    }

    const unstructuredSources = this.get_unstructured_sources();
    if (unstructuredSources.length) {
      lines.push('【知识库】');
      for (const ds of unstructuredSources) {
        const desc = ds.description ? `，描述：${ds.description}` : '';
        lines.push(`  - 数据源名称：\`${ds.datasource_name}\`${desc}`);
      }
    }

    const mcpSources = this.get_mcp_sources();
    if (mcpSources.length) {
      lines.push('【MCP工具】');
      for (const ds of mcpSources) {
        const desc = ds.description ? `，描述：${ds.description}` : '';
        lines.push(`  - 数据源名称：\`${ds.datasource_name}\`${desc}`);
      }
    }

    if (lines.length === 1) return '无可用数据源';
    return lines.join('\n');
  }

  /** @alias to_prompt_string */
  toPromptString() { return this.to_prompt_string(); }
}

export default BusinessDataSources;
