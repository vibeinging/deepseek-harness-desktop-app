// 迁移自 dsh_kernel/data_sources/datasource/database_data_source.py
//
// 数据库数据源实现
// 封装数据库连接,提供 schema 获取和查询功能。
//
// Node 数据访问层实现要点:
// - schema/profile: 读 PG 元数据表(table_metadata / column_metadata)经 db.js query。
//   当前 profile(user_message) 尚未接入上层 SchemaRetrievalService，收到问题时仍读取全量元数据；
//   具体缺口集中记录在 docs/analysis/2026-08-04_known-feature-gaps.md。
// - query: 仅 db_type=duckdb 走 duck.js(从 database_connections.database/host 解析文件路径);
//   其它 db_type(mysql/pg/...)需活连接驱动,Node 数据访问层暂不实现,返回错误 + TODO。
// - query_distinct_values: 内联构建 DISTINCT SQL(对齐 plugins/base.build_distinct_column_sql 的通用实现)。

import { Profile, Column } from './profile.js';
import { DataSource, QueryResult } from './data_source.js';
import { existsSync } from 'node:fs';

import { query, queryOne } from '../../db.js';
import { duckRunRecords } from './duck.js';
import { t } from '../utils/i18n.js';
import { PluginRegistry } from './plugins/index.js';

export class DatabaseDataSource extends DataSource {
  /**
   * @param {string} business_id
   * @param {string} project_id
   * @param {string} connection_id
   * @param {object} [opts]
   * @param {string|null} [opts.db_type=null]
   * @param {string|null} [opts.source_id=null]
   */
  constructor(business_id, project_id, connection_id, { db_type = null, source_id = null } = {}) {
    super(source_id || connection_id, business_id, project_id, 'database_connection');
    this.connection_id = connection_id;
    this.project_id = project_id;
    this.db_type = db_type; // mysql, postgresql, doris, duckdb, ...
    // datasource_name / description 由创建者设置(父类已置 null)
    this._duck_path_cache = undefined; // 懒解析 DuckDB 文件路径
    this._conn_cache = undefined; // 懒解析完整连接配置(非 duckdb 实连用)
  }

  /**
   * 获取数据库的 Profile 信息。
   * Python 原版在 user_message 存在时做向量召回剪枝;Node 数据访问层无 embedding,
   * 统一读全量元数据(等价于召回为空时的降级路径)。
   * @param {string|null} [user_message=null]
   * @param {Array<object>|null} [entities=null] 预留(协同召回,当前未用)
   * @param {Array<object>|null} [metrics=null] 预留
   * @returns {Promise<Array<Profile>>}
   */
  async profile(user_message = null, entities = null, metrics = null) {
    // TODO: 让 profile(user_message) 复用 SchemaRetrievalService，并合并实体/指标提示；
    //       当前数据访问层降级为读取全量 schema。
    return this._get_full_profiles();
  }

  /**
   * 读全量元数据并转 Profile(对应 _get_full_profiles + TableCrudService.get_tables_with_columns)。
   * 直接读 PG: table_metadata + column_metadata。
   * @returns {Promise<Array<Profile>>}
   */
  async _get_full_profiles() {
    try {
      const tables = await query(
        `SELECT t.id, t.schema_name, t.table_name, t.description, t.row_count
           FROM table_metadata t
           JOIN database_connections d ON d.id=t.database_connection_id AND d.deleted_at IS NULL
          WHERE t.database_connection_id = $1 AND d.project_id = $2 AND t.deleted_at IS NULL
          ORDER BY t.schema_name NULLS FIRST, t.table_name`,
        [this.connection_id, this.project_id],
      );
      if (!tables.length) return [];

      const tableIds = tables.map((tb) => tb.id);
      const cols = await query(
        `SELECT table_id, column_name, data_type, description, example_values
           FROM column_metadata
          WHERE table_id::text = ANY($1::text[]) AND deleted_at IS NULL
          ORDER BY id`,
        [tableIds],
      );

      // 按 table_id 聚合列
      const colsByTable = new Map();
      for (const c of cols) {
        if (!colsByTable.has(c.table_id)) colsByTable.set(c.table_id, []);
        colsByTable.get(c.table_id).push({
          column_name: c.column_name,
          data_type: c.data_type,
          description: c.description,
          example_values: DatabaseDataSource._parseExampleValues(c.example_values),
        });
      }

      const tablesData = tables.map((tb) => ({
        table_name: tb.table_name,
        schema_name: tb.schema_name,
        description: tb.description,
        row_count: tb.row_count,
        columns: colsByTable.get(tb.id) || [],
      }));

      return this._convert_to_profiles(tablesData);
    } catch (e) {
      console.error(`获取完整 profiles 失败: ${e?.message ?? e}`);
      return [];
    }
  }

  /** example_values 在 PG 里存 JSON 字符串数组(对应 ColumnMetadata.example_values_list) */
  static _parseExampleValues(raw) {
    if (raw == null) return null;
    if (Array.isArray(raw)) return raw;
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  /**
   * 将 schema 数据转换为 Profile 列表(对应 _convert_to_profiles)。
   * @param {Array<object>} tables_data
   * @returns {Array<Profile>}
   */
  _convert_to_profiles(tables_data) {
    const profiles = [];
    for (const tableData of tables_data) {
      const columns = [];
      for (const colData of tableData.columns || []) {
        const dataTypeStr = (colData.data_type || '').toLowerCase();
        const pythonType = DatabaseDataSource._map_sql_type_to_python(dataTypeStr);
        columns.push(new Column(
          colData.column_name || '',
          colData.description || '',
          new Set([pythonType]),
          {
            sample_values: colData.example_values || null,
            enumerated_values: null,
            max_min: null,
          },
        ));
      }

      const dsName = this.datasource_name ? this.datasource_name : `connection_${this.connection_id}`;
      profiles.push(new Profile(
        dsName,
        tableData.table_name || '',
        tableData.description || '',
        null, // 数据库 schema 不提供行数(不设 0,避免干扰 plan 生成)
        columns,
        [], // 数据库 schema 不提供采样行
        false,
        {
          data_source_type: 'SQLDatabase',
          schema_name: tableData.schema_name || null,
        },
      ));
    }
    return profiles;
  }

  /**
   * 将 SQL 类型映射到类型名(对应 _map_sql_type_to_python,返回类型名字符串)。
   * @param {string} sql_type
   * @returns {string}
   */
  static _map_sql_type_to_python(sql_type) {
    const s = (sql_type || '').toLowerCase();
    if (['int', 'integer', 'serial', 'bigint', 'smallint'].some((x) => s.includes(x))) return 'int';
    if (['float', 'double', 'real', 'numeric', 'decimal'].some((x) => s.includes(x))) return 'float';
    if (['bool', 'boolean'].some((x) => s.includes(x))) return 'bool';
    // date/time/timestamp 与默认均映射为 str
    return 'str';
  }

  /**
   * 解析该连接对应的 DuckDB 文件路径(从 database_connections.database/host)。
   * 懒解析 + 缓存。非 duckdb 连接返回 null。
   * @returns {Promise<string|null>}
   */
  async _resolve_duck_path() {
    if (this._duck_path_cache !== undefined) return this._duck_path_cache;
    try {
      const row = await queryOne(
        `SELECT database, host, db_type FROM database_connections
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [this.connection_id, this.project_id],
      );
      if (!row) { this._duck_path_cache = null; return null; }
      if (!this.db_type) this.db_type = row.db_type;
      const isDuck = String(row.db_type || this.db_type || '').toLowerCase() === 'duckdb';
      this._duck_path_cache = isDuck ? (row.database || row.host || null) : null;
    } catch (e) {
      console.warn(`[DatabaseDataSource] 解析 DuckDB 路径失败: ${e?.message ?? e}`);
      this._duck_path_cache = null;
    }
    return this._duck_path_cache;
  }

  /**
   * 解析该连接的完整配置(host/port/username/password/database/db_type/schema/extra),
   * 供非 duckdb 库经插件层实连查询。懒解析 + 缓存。
   * @returns {Promise<object|null>}
   */
  async _resolve_connection() {
    if (this._conn_cache !== undefined) return this._conn_cache;
    try {
      const row = await queryOne(
        `SELECT db_type, host, port, username, password, database, schema_config, extra_config
           FROM database_connections
          WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL`,
        [this.connection_id, this.project_id],
      );
      this._conn_cache = row || null;
      if (row && !this.db_type) this.db_type = row.db_type;
    } catch (e) {
      console.warn(`[DatabaseDataSource] 解析连接配置失败: ${e?.message ?? e}`);
      this._conn_cache = null;
    }
    return this._conn_cache;
  }

  /**
   * 执行 SQL 查询。
   * @param {string} sql
   * @param {object} [opts]
   * @param {string|null} [opts.project_id=null]
   * @param {string|null} [opts.session_id=null]
   * @param {object|null} [opts.business_data_sources=null]
   * @returns {Promise<QueryResult>}
   */
  async query(sql, {
    project_id = null,
    session_id = null,
    business_data_sources = null,
    parameters = [],
  } = {}) {
    const boundProjectId = String(this.project_id || '').trim();
    const requestedProjectId = String(project_id || boundProjectId).trim();
    if (!boundProjectId || !requestedProjectId || requestedProjectId !== boundProjectId) {
      return QueryResult.error(t('连接配置不存在: {}', this.connection_id), sql);
    }
    const dbType = String(this.db_type || '').toLowerCase();

    // 仅 DuckDB 走本地子进程(数据全程本地)
    if (dbType === 'duckdb') {
      const duckPath = await this._resolve_duck_path();
      if (!duckPath) {
        return QueryResult.error(t('未能解析 DuckDB 文件路径'), sql);
      }

      // 中间表 ATTACH:仅当带 session_id 且业务容器里有该 session 的中间数据源
      let sqlToExecute = sql;
      if (session_id && business_data_sources) {
        const intermediateDs = business_data_sources.intermediate_data_sources?.get?.(session_id)
          ?? business_data_sources.intermediate_data_sources?.[session_id];
        if (intermediateDs) {
          sqlToExecute = this._attach_intermediate_tables(sql, intermediateDs.duckdb_path);
        }
      }

      try {
        const data = await duckRunRecords(duckPath, sqlToExecute, 1_000_000, parameters);
        const columns = data.length ? Object.keys(data[0]) : [];
        return QueryResult.ok(data, columns, data.length, '');
      } catch (e) {
        return QueryResult.error(String(e?.message ?? e), sql);
      }
    }

    // 非 DuckDB(MySQL/PostgreSQL/Doris…):经插件层实连目标库执行
    const conn = await this._resolve_connection();
    if (!conn) {
      return QueryResult.error(t('连接配置不存在: {}', this.connection_id), sql);
    }
    const plugin = PluginRegistry.get(conn.db_type || this.db_type);
    if (!plugin) {
      return QueryResult.error(t('暂不支持的数据库类型: {}', conn.db_type || this.db_type || 'unknown'), sql);
    }
    try {
      const cfg = {
        db_type: conn.db_type,
        host: conn.host,
        port: conn.port,
        username: conn.username,
        password: conn.password,
        database: conn.database,
        schema_config: conn.schema_config,
        extra_config: conn.extra_config,
      };
      const r = await plugin.executeQuery(cfg, sql, { parameters });
      if (!r || r.success === false) {
        return QueryResult.error(String(r?.error || r?.message || '查询失败'), sql);
      }
      const data = r.data || [];
      const columns = Array.isArray(r.columns) && r.columns.length
        ? r.columns.map((c) => (typeof c === 'string' ? c : c.column_name))
        : (data.length ? Object.keys(data[0]) : []);
      return QueryResult.ok(data, columns, r.row_count ?? data.length, '');
    } catch (e) {
      return QueryResult.error(String(e?.message ?? e), sql);
    }
  }

  /**
   * 查询列的唯一值(对应 query_distinct_values)。
   * @param {string} table_name plain name(不含 schema 前缀)
   * @param {string} column_name
   * @param {object} [opts]
   * @param {string|null} [opts.keyword=null]
   * @param {number} [opts.limit=20]
   * @param {number} [opts.offset=0]
   * @param {string|null} [opts.schema_name=null]
   * @returns {Promise<Array<any>>}
   */
  async query_distinct_values(table_name, column_name, {
    keyword = null, limit = 20, offset = 0, schema_name = null,
  } = {}) {
    const sql = DatabaseDataSource._build_distinct_column_sql(
      table_name, column_name, limit, offset, keyword, schema_name,
    );
    const result = await this.query(sql, { project_id: this.project_id });
    if (result.success) {
      return result.data
        .map((row) => row[column_name])
        .filter((v) => v !== null && v !== undefined);
    }
    return [];
  }

  /**
   * 构建 DISTINCT 列值 SQL(对齐 plugins/base.build_distinct_column_sql 通用实现,双引号引用)。
   * @returns {string}
   */
  static _build_distinct_column_sql(table_name, column_name, limit = 20, offset = 0, keyword = null, schema_name = null) {
    const quote = (id) => `"${String(id).replace(/"/g, '""')}"`;
    const quotedColumn = quote(column_name);
    const quotedTable = (schema_name && schema_name !== 'default')
      ? `${quote(schema_name)}.${quote(table_name)}`
      : quote(table_name);

    let baseSql = `SELECT DISTINCT ${quotedColumn} FROM ${quotedTable}`;
    if (keyword) {
      const safeKeyword = String(keyword).replace(/'/g, "''");
      baseSql = `${baseSql} WHERE LOWER(CAST(${quotedColumn} AS VARCHAR)) LIKE LOWER('%${safeKeyword}%')`;
    }
    return `${baseSql} LIMIT ${limit} OFFSET ${offset}`;
  }

  /**
   * 生成带 ATTACH 的 SQL,使中间表可被查询(对应 _attach_intermediate_tables)。
   * @param {string} sql
   * @param {string} duckdb_path
   * @returns {string}
   */
  _attach_intermediate_tables(sql, duckdb_path) {
    // 与 Python 对齐:DuckDB 文件不存在时原样返回(不 ATTACH)
    if (!duckdb_path || !existsSync(String(duckdb_path))) return sql;

    // search_path 用 DuckDB 默认 schema 'main'(Python 原版用 'data' 是其源库 schema 命名,
    // 桌面版 DuckDB 文件表在 main schema)。main 在前保证未限定表名优先解析到源库而非中间库。
    return (
      `ATTACH '${duckdb_path}' AS intermediate_db;\n`
      + "SET search_path='main,intermediate_db';\n"
      + `${sql}`
    );
  }
}

export default DatabaseDataSource;
