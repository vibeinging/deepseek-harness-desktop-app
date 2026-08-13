// 迁移自 dsh_kernel/data_sources/datasource/intermediate_storage_service.py
//
// 中间数据存储服务
// 负责将中间计算结果写入 Session 级别的 DuckDB 进行持久化存储。
//
// 存储路径: <INTERMEDIATE_DIR>/{project_id}/{session_id}/intermediate.duckdb
//   默认 INTERMEDIATE_DIR = <python backend>/sources/intermediate
//   可通过 env INTERMEDIATE_DIR 覆盖。
//
// 数据访问经 duck.js(原生 @duckdb/node-api,自包含,无需 python)。读/写方法均为 async。

import path from 'node:path';
import { existsSync } from 'node:fs';
import { dataPath } from '../../config/paths.js';
import { agentRunWorkspacePaths } from '../runner/run_workspace.js';

import {
  duckRunRecords,
  duckWriteRecords,
  duckListTables,
  duckTableSchema,
  duckSampleRows,
  duckTableExists,
  sanitizeTableName,
  sanitizeColumnName,
  METADATA_TABLE,
} from './duck.js';

const DEFAULT_INTERMEDIATE_DIR = dataPath('intermediate');
const INTERMEDIATE_DIR = process.env.INTERMEDIATE_DIR || DEFAULT_INTERMEDIATE_DIR;

export class IntermediateStorageService {
  static DUCKDB_FILE = 'intermediate.duckdb';
  static METADATA_TABLE = METADATA_TABLE;

  /**
   * 获取 DuckDB 文件绝对路径(对应 get_duckdb_path)。
   * @param {string} project_id
   * @param {string} session_id
   * @returns {string}
   */
  static get_duckdb_path(project_id, session_id, run_id = null) {
    if (run_id) return path.join(agentRunWorkspacePaths(run_id).intermediate, this.DUCKDB_FILE);
    return path.join(INTERMEDIATE_DIR, String(project_id), String(session_id), this.DUCKDB_FILE);
  }

  /** @alias get_duckdb_path */
  static getDuckdbPath(project_id, session_id, run_id = null) {
    return this.get_duckdb_path(project_id, session_id, run_id);
  }

  /** 清理表名(对齐 Python sanitize_table_name) */
  static sanitize_table_name(name) { return sanitizeTableName(name); }

  /** 清理列名(对齐 Python sanitize_column_name) */
  static sanitize_column_name(name) { return sanitizeColumnName(name); }

  /**
   * 执行 SQL 查询(对应 execute_sql)。
   * Python 返回 (success, df, error);Node 返回 {success, data, columns, error}。
   * @param {string} duckdb_path
   * @param {string} sql
   * @returns {Promise<{success: boolean, data: Array<object>, columns: string[], error: string|null}>}
   */
  static async execute_sql(duckdb_path, sql) {
    try {
      if (!existsSync(String(duckdb_path))) {
        return { success: false, data: [], columns: [], error: '数据库文件不存在' };
      }
      const data = await duckRunRecords(duckdb_path, sql, 1_000_000);
      const columns = data.length ? Object.keys(data[0]) : [];
      return { success: true, data, columns, error: null };
    } catch (e) {
      const error_msg = `SQL 执行失败: ${e?.message ?? e}`;
      console.error('[IntermediateStorage]', error_msg);
      return { success: false, data: [], columns: [], error: error_msg };
    }
  }

  /**
   * 列出所有中间表(排除元数据表本身,对应 list_tables)。
   * @param {string} duckdb_path
   * @returns {Promise<Array<object>>}
   */
  static async list_tables(duckdb_path) {
    return duckListTables(duckdb_path);
  }

  /** @alias list_tables */
  static listTables(duckdb_path) { return this.list_tables(duckdb_path); }

  /**
   * 获取表的列信息(对应 get_table_schema)。返回 [{name, type}]。
   * @param {string} duckdb_path
   * @param {string} table_name
   * @returns {Promise<Array<{name:string,type:string}>>}
   */
  static async get_table_schema(duckdb_path, table_name) {
    return duckTableSchema(duckdb_path, sanitizeTableName(table_name));
  }

  /**
   * 获取表的样本行(对应 get_sample_rows)。
   * @param {string} duckdb_path
   * @param {string} table_name
   * @param {number} [limit=5]
   * @returns {Promise<Array<object>>}
   */
  static async get_sample_rows(duckdb_path, table_name, limit = 5) {
    return duckSampleRows(duckdb_path, sanitizeTableName(table_name), limit);
  }

  /**
   * 检查表是否存在(对应 table_exists)。
   * @param {string} duckdb_path
   * @param {string} table_name
   * @returns {Promise<boolean>}
   */
  static async table_exists(duckdb_path, table_name) {
    return duckTableExists(duckdb_path, table_name);
  }

  /**
   * 获取表信息(对应 get_table_info)。
   * @param {string} duckdb_path
   * @param {string} table_name
   * @returns {Promise<object|null>}
   */
  static async get_table_info(duckdb_path, table_name) {
    const sanitized = sanitizeTableName(table_name);
    const found = (await duckListTables(duckdb_path)).find((t) => t.table_name === sanitized);
    return found || null;
  }

  // ==================== 写路径(中间结果落地)====================

  /**
   * 确保数据库目录存在(对应 ensure_database)。duckWriteRecords 内部会 makedirs,这里幂等占位。
   */
  static ensure_database(_duckdb_path) {
    return { success: true };
  }

  /**
   * 把查询结果写入中间 DuckDB 表(对应 write_dataframe)。
   * df 为 _resultToDf 产出的 df-like({columns, toRecords()}),或记录数组。
   * @param {string} duckdb_path
   * @param {object|Array} df
   * @param {string} name
   * @param {string} [description]
   * @param {{sub_query?:string, sql_query?:string}} [opts]
   * @returns {Promise<{success:boolean, table_name:string, row_count:number, column_count:number}>}
   */
  static async write_dataframe(duckdb_path, df, name, description = '', opts = {}) {
    const safeName = sanitizeTableName(name);
    let columns = [];
    let records = [];
    if (Array.isArray(df)) {
      records = df;
      columns = records.length ? Object.keys(records[0]) : [];
    } else if (df && typeof df === 'object') {
      columns = df.columns ? [...df.columns] : [];
      records = typeof df.toRecords === 'function' ? df.toRecords()
        : (Array.isArray(df._data) ? df._data : []);
      if (!columns.length && records.length) columns = Object.keys(records[0]);
    }
    const res = await duckWriteRecords(duckdb_path, safeName, records, columns, {
      description,
      sub_query: opts?.sub_query ?? '',
      sql_query: opts?.sql_query ?? '',
    });
    if (res && res.success === false) throw new Error(res.error || '写入中间表失败');
    return { success: true, table_name: safeName, row_count: res?.row_count ?? records.length, column_count: columns.length };
  }

  /**
   * 读取整表为记录数组(对应 read_dataframe,返回 List<Object> 而非 DataFrame)。
   * @param {string} duckdb_path
   * @param {string} table_name
   * @returns {Promise<Array<object>|null>}
   */
  static async read_dataframe(duckdb_path, table_name) {
    try {
      if (!existsSync(String(duckdb_path))) return null;
      const sanitized = sanitizeTableName(table_name);
      return await duckRunRecords(duckdb_path, `SELECT * FROM "${sanitized}"`, 1_000_000);
    } catch (e) {
      console.error('[IntermediateStorage] 读取表失败:', e?.message ?? e);
      return null;
    }
  }

  /**
   * 删除表(对应 delete_table)。
   * TODO: 写路径(DROP)由 Python 计算层负责;Node 数据访问层为只读,返回 false。
   */
  static delete_table(_duckdb_path, _table_name) {
    console.warn('[IntermediateStorageService] delete_table 在 Node 数据访问层未实现(只读)');
    return false;
  }
}

export { INTERMEDIATE_DIR };
export default IntermediateStorageService;
