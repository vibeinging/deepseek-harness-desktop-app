// 迁移自 dsh_kernel/data_sources/datasource/intermediate_data_source.py
//
// 中间数据源
// 使用 DuckDB 存储中间计算结果,支持 SQL 查询。
//
// 存储路径: <INTERMEDIATE_DIR>/{project_id}/{session_id}/intermediate.duckdb

import { Profile, Column } from './profile.js';
import { DataSource, QueryResult } from './data_source.js';
import { IntermediateStorageService } from './intermediate_storage_service.js';
import { t } from '../utils/i18n.js';

export class IntermediateDataSource extends DataSource {
  /**
   * @param {object} opts
   * @param {string} opts.session_id
   * @param {string} opts.project_id
   * @param {string} [opts.business_id]
   * @param {string} opts.intermediate_data_source_id
   * @param {string|null} [opts.run_id]
   */
  constructor({ session_id, project_id, business_id, intermediate_data_source_id, run_id = null }) {
    super(intermediate_data_source_id, business_id, project_id, 'intermediate_data_source');
    this.intermediate_data_source_id = intermediate_data_source_id;
    this.session_id = session_id;
    this.run_id = run_id;
    const scopeId = String(run_id || session_id || '').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 96);
    this.datasource_name = `intermediate_${scopeId}`;
    this.db_type = 'duckdb';
    this.database = `intermediate_${session_id}`;

    // DuckDB 路径
    this._duckdb_path = IntermediateStorageService.get_duckdb_path(project_id, session_id, run_id);

    // 与 DatabaseConnection 接口对齐(version 等信息)
    this._extra_config_dict = IntermediateDataSource._detect_duckdb_version();

    console.info(`[IntermediateDataSource] 初始化 DuckDB 路径: ${this._duckdb_path}`);
  }

  /** 与 DatabaseConnection 接口对齐(对应 @property extra_config_dict) */
  get extra_config_dict() {
    return this._extra_config_dict;
  }

  /**
   * 获取 DuckDB 版本(Node 数据访问层不直连 duckdb,版本由子进程托管,这里留空)。
   * @returns {object}
   */
  static _detect_duckdb_version() {
    // TODO: 如需精确版本,可经 duck.js 子进程查询 duckdb.__version__
    return {};
  }

  /** 获取 DuckDB 文件路径(对应 @property duckdb_path) */
  get duckdb_path() {
    return this._duckdb_path;
  }

  /**
   * 获取中间数据源的 Profile 信息。
   * @param {string|null} [user_message=null]
   * @returns {Promise<Array<Profile>>}
   */
  async profile(user_message = null) {
    try {
      const profiles = await this._build_profiles_from_duckdb();
      if (user_message) {
        return await this._retrieve_with_pruning(profiles, user_message);
      }
      return profiles;
    } catch (e) {
      console.error(`[IntermediateDataSource] 加载 profiles 失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /** TODO: 实现智能召回和剪枝(当前直接返回全量) */
  async _retrieve_with_pruning(profiles, _user_message) {
    return profiles;
  }

  /**
   * 执行 SQL 查询。
   * @param {string} sql
   * @param {object} [kwargs]
   * @returns {Promise<QueryResult>}
   */
  async query(sql, _kwargs = {}) {
    try {
      if (!sql || typeof sql !== 'string') {
        return QueryResult.error('必须提供 SQL 查询语句');
      }

      const { success, data, columns, error } = await IntermediateStorageService.execute_sql(this._duckdb_path, sql);

      if (!success) {
        return QueryResult.error(error || 'SQL 执行失败');
      }

      if (!data || data.length === 0) {
        return QueryResult.ok([], [], 0, t('查询结果为空'));
      }

      return QueryResult.ok(data, columns, data.length, t('查询成功'));
    } catch (e) {
      console.error(`[IntermediateDataSource] SQL 查询失败: ${e?.message ?? e}`);
      return QueryResult.error(`SQL 查询失败: ${e?.message ?? e}`);
    }
  }

  /**
   * 将查询结果作为中间数据存储到 DuckDB(对应 add)。
   * @param {object|Array} table df-like({columns,toRecords()})或记录数组
   * @param {string} name 目标表名
   */
  async add(table, name, description = '', sub_query = '', sql_query = '') {
    try {
      const result = await IntermediateStorageService.write_dataframe(
        this._duckdb_path, table, name, description, { sub_query, sql_query },
      );
      if (!result || result.success === false) throw new Error(result?.error || '未知错误');
      console.info(`[IntermediateDataSource] 表存储完成: ${name} -> ${result.table_name}，行数: ${result.row_count}，列数: ${result.column_count}`);
    } catch (e) {
      console.error(`[IntermediateDataSource] 存储中间数据表失败: ${e?.message ?? e}`);
      throw new Error(`存储中间数据表失败: ${e?.message ?? e}`);
    }
  }

  /**
   * 删除指定中间表(对应 delete_table)。
   * TODO: 写路径(DROP)由 Python 计算层负责;Node 数据访问层为只读。
   */
  async delete_table(_table_name) {
    console.warn('[IntermediateDataSource] delete_table 在 Node 数据访问层未实现(只读)');
    return false;
  }

  /**
   * 从 DuckDB 元数据构建 Profile 列表(对应 _build_profiles_from_duckdb)。
   * @returns {Promise<Array<Profile>>}
   */
  async _build_profiles_from_duckdb() {
    const profiles = [];
    const tables = await IntermediateStorageService.list_tables(this._duckdb_path);

    for (const tableInfo of tables) {
      const tableName = tableInfo.table_name;
      try {
        const profile = await this._build_single_profile(tableName, tableInfo);
        if (profile) profiles.push(profile);
      } catch (e) {
        console.warn(`[IntermediateDataSource] 构建表 ${tableName} 的 Profile 失败: ${e?.message ?? e}`);
      }
    }
    return profiles;
  }

  /**
   * 为单个表构建 Profile(对应 _build_single_profile)。
   * @param {string} table_name
   * @param {object} table_info
   * @returns {Promise<Profile|null>}
   */
  async _build_single_profile(table_name, table_info) {
    const schema = await IntermediateStorageService.get_table_schema(this._duckdb_path, table_name);
    if (!schema || !schema.length) return null;

    const sampleRows = await IntermediateStorageService.get_sample_rows(this._duckdb_path, table_name, 5);

    const columns = [];
    for (const colInfo of schema) {
      const colName = colInfo.name;
      const colType = colInfo.type;
      const pythonTypes = this._infer_python_types(colType);

      let sampleValues = [];
      if (sampleRows && sampleRows.length) {
        sampleValues = sampleRows
          .slice(0, 3)
          .map((row) => row[colName])
          .filter((v) => v !== null && v !== undefined);
      }

      columns.push(new Column(colName, '', pythonTypes, {
        enumerated_values: null,
        sample_values: sampleValues,
        max_min: null,
      }));
    }

    const rowCount = table_info.row_count || 0;
    const colCount = table_info.column_count || 0;

    return new Profile(
      this.datasource_name,
      table_name,
      table_info.description || '',
      [rowCount, colCount],
      columns,
      sampleRows,
      rowCount <= 5,
      { data_source_type: 'IntermediateData' },
    );
  }

  /**
   * 根据 DuckDB 类型推断类型名集合(对应 _infer_python_types,返回类型名字符串)。
   * @param {string} duckdb_type
   * @returns {Set<string>}
   */
  _infer_python_types(duckdb_type) {
    const typeUpper = String(duckdb_type || '').toUpperCase();
    if (typeUpper.includes('INT')) return new Set(['int']);
    if (typeUpper.includes('DOUBLE') || typeUpper.includes('FLOAT')
      || typeUpper.includes('DECIMAL') || typeUpper.includes('NUMERIC')) {
      return new Set(['float']);
    }
    if (typeUpper.includes('BOOL')) return new Set(['bool']);
    // DATE/TIME/TIMESTAMP 与其它均映射为 str
    return new Set(['str']);
  }

  /** 检查表是否存在(对应 _table_exists) */
  async _table_exists(table_name) {
    return await IntermediateStorageService.table_exists(this._duckdb_path, table_name);
  }

  /** 获取所有表名(对应 get_all_table_names) */
  async get_all_table_names() {
    const tables = await IntermediateStorageService.list_tables(this._duckdb_path);
    return tables.map((t2) => t2.table_name);
  }
}

export default IntermediateDataSource;
