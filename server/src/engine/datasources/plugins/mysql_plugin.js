/**
 * MySQL 插件(Node,用 mysql2/promise)。对齐 Python mysql_plugin.py。
 * 单 schema(用 DATABASE() 限定),get_schemas 返回 []。
 */
import mysql from 'mysql2/promise'
import { DatabasePlugin, PluginRegistry, toPort, extractFirstColumnValues } from './base.js'

function connConfig(config) {
  return {
    host: config.host,
    port: toPort(config.port, 3306),
    user: config.username,
    password: config.password,
    database: config.database,
    connectTimeout: 30000,
    charset: 'utf8mb4',
    // 大表 information_schema 查询可能较慢;不设 query timeout,靠 connectTimeout 兜底
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  }
}

async function withConn(config, fn) {
  const conn = await mysql.createConnection(connConfig(config))
  try {
    return await fn(conn)
  } finally {
    await conn.end().catch(() => {})
  }
}

export class MySQLPlugin extends DatabasePlugin {
  static metadata = {
    value: 'MySQL',
    label: 'MySQL',
    default_port: 3306,
    multiple_schema: false,
    description: '开源关系型数据库',
    // MySQL 线协议同族:复用 mysql2 驱动直连(各自成卡,连接走本插件;端口按各自默认)
    variants: [
      { value: 'MariaDB', label: 'MariaDB', default_port: 3306, multiple_schema: false, description: 'MySQL 兼容开源数据库' },
      { value: 'Doris', label: 'Apache Doris', default_port: 9030, multiple_schema: false, description: '高性能分布式分析型数据库(MySQL 协议)' },
      { value: 'StarRocks', label: 'StarRocks', default_port: 9030, multiple_schema: false, description: '高性能分析型数据库(MySQL 协议)' },
      { value: 'OceanBase', label: 'OceanBase', default_port: 2881, multiple_schema: false, description: '分布式 HTAP 数据库(MySQL 协议)' },
      { value: 'TiDB', label: 'TiDB', default_port: 4000, multiple_schema: false, description: '分布式 HTAP 数据库(MySQL 协议)' },
    ],
  }

  async testConnection(config) {
    try {
      const version = await withConn(config, async (c) => {
        const [rows] = await c.query('SELECT VERSION() AS v')
        return rows[0]?.v ?? null
      })
      return { success: true, message: '连接成功', connection_info: this.getConnectionInfo(config, version) }
    } catch (e) {
      return { success: false, message: '连接失败: ' + (e?.message || String(e)) }
    }
  }

  async getVersion(config) {
    try {
      return await withConn(config, async (c) => {
        const [rows] = await c.query('SELECT VERSION() AS v')
        return rows[0]?.v ?? null
      })
    } catch {
      return null
    }
  }

  async executeQuery(config, sql, opts = {}) {
    try {
      return await withConn(config, async (c) => {
        const [rows, fields] = await c.query(sql, opts?.parameters || [])
        const data = Array.isArray(rows) ? rows : []
        const columns = (fields || []).map((f) => ({
          column_name: f.name,
          data_type: 'UNKNOWN',
          is_nullable: true,
          default_value: null,
        }))
        return { success: true, message: '查询成功', data, columns, row_count: data.length, sql_executed: sql }
      })
    } catch (e) {
      const msg = e?.message || String(e)
      return { success: false, message: '查询失败: ' + msg, error: msg, data: [], columns: [], row_count: 0, sql_executed: sql }
    }
  }

  async getSchemas(_config) {
    return [] // MySQL 单 schema
  }

  async getSchemaInfo(config, _opts = {}) {
    try {
      return await withConn(config, async (c) => {
        // 表基本信息(table_rows 为估算值,快)
        const [tableRows] = await c.query(
          `SELECT table_name AS table_name, table_type AS table_type,
                  table_comment AS table_comment, table_rows AS table_rows
             FROM information_schema.tables
            WHERE table_schema = DATABASE()
            ORDER BY table_name`,
        )
        if (!tableRows.length) return { tables: [] }

        const tableNames = tableRows.map((r) => r.table_name)
        const columnsByTable = await this._getColumns(c, tableNames)

        const tables = tableRows.map((r) => {
          const tt = String(r.table_type || 'BASE TABLE').toUpperCase()
          const isView = tt === 'VIEW' || tt === 'SYSTEM VIEW'
          return {
            table_name: r.table_name,
            schema_name: 'default',
            table_type: isView ? 'VIEW' : 'TABLE',
            description: r.table_comment || '',
            row_count: r.table_rows != null ? Number(r.table_rows) : null,
            is_view: isView,
            columns: columnsByTable.get(r.table_name) || [],
          }
        })
        return { tables }
      })
    } catch (e) {
      return { tables: [], error: e?.message || String(e) }
    }
  }

  async _getColumns(conn, tableNames) {
    const byTable = new Map()

    // FK 列(库级一次查)
    const [fkRows] = await conn.query(
      `SELECT TABLE_NAME AS t, COLUMN_NAME AS c
         FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL`,
    )
    const fkSet = new Set(fkRows.map((r) => `${r.t}.${r.c}`))

    // 列信息(IN (?) 由 mysql2 自动展开数组)
    const [colRows] = await conn.query(
      `SELECT table_name AS table_name, column_name AS column_name, data_type AS data_type,
              is_nullable AS is_nullable, column_default AS column_default,
              column_key AS column_key, column_comment AS column_comment,
              character_maximum_length AS max_length,
              numeric_precision AS numeric_precision, numeric_scale AS numeric_scale
         FROM information_schema.columns
        WHERE table_schema = DATABASE() AND table_name IN (?)
        ORDER BY table_name, ordinal_position`,
      [tableNames],
    )

    for (const row of colRows) {
      const list = byTable.get(row.table_name) || []
      const key = row.column_key
      list.push({
        column_name: row.column_name,
        data_type: row.data_type,
        is_nullable: row.is_nullable === 'YES',
        default_value: row.column_default,
        is_primary_key: key === 'PRI',
        is_foreign_key: fkSet.has(`${row.table_name}.${row.column_name}`),
        is_unique: key === 'UNI',
        is_indexed: key === 'PRI' || key === 'MUL' || key === 'UNI',
        description: row.column_comment || '',
        max_length: row.max_length,
        numeric_precision: row.numeric_precision,
        numeric_scale: row.numeric_scale,
      })
      byTable.set(row.table_name, list)
    }
    return byTable
  }

  // ── EXPLAIN / 值采样 ──

  /**
   * SQL EXPLAIN 校验(MySQL `EXPLAIN <sql>`,不带 ANALYZE 避免真执行 SQL 产生副作用)。
   * 经 executeQuery 跑,返回 { success, message, data(执行计划行), error? }。
   * @param {object} config
   * @param {string} sql
   * @param {object} [_opts] { timeout } — 桌面版不做 per-call timeout,靠 connectTimeout 兜底
   * @returns {Promise<{success:boolean, message:string, data:any[], error?:string}>}
   */
  async explain(config, sql, _opts = {}) {
    const result = await this.executeQuery(config, `EXPLAIN ${sql}`)
    if (!result?.success) {
      const err = result?.error ?? result?.message ?? '未知错误'
      return { success: false, message: 'EXPLAIN 执行失败: ' + err, data: [], error: err }
    }
    return { success: true, message: 'EXPLAIN 执行成功', data: result.data || [] }
  }

  /**
   * 取表中各列的示例值(简化采样,未用智能采样 mixin)。
   * MySQL 单 schema(database 即 schema):列名查 information_schema.columns
   * WHERE table_schema=DATABASE() AND table_name=<table>,再逐列
   * SELECT DISTINCT <col> ... WHERE <col> IS NOT NULL LIMIT <limit>。失败的列置空数组,不抛。
   * @param {object} config
   * @param {string} tableName
   * @param {{limit?:number}} [opts]
   * @returns {Promise<Record<string, any[]>>} { [columnName]: [值,...] }
   */
  async getExampleValues(config, tableName, { limit = 3 } = {}) {
    const result = {}
    // 1) 取列名(单 schema,用 DATABASE() 限定)
    const safeTable = String(tableName).replace(/'/g, "''")
    const colSql =
      `SELECT column_name AS column_name FROM information_schema.columns ` +
      `WHERE table_schema = DATABASE() AND table_name = '${safeTable}' ` +
      `ORDER BY ordinal_position`
    const colRes = await this.executeQuery(config, colSql)
    if (!colRes?.success) return result

    const columnNames = (colRes.data || [])
      .map((r) => r.column_name ?? r.COLUMN_NAME ?? (Array.isArray(r) ? r[0] : null))
      .filter((c) => c != null)

    const quotedTable = this.quoteTableWithSchema(tableName)
    // 2) 逐列 SELECT DISTINCT,失败的列置空数组
    for (const col of columnNames) {
      const quotedCol = this.quoteIdentifier(col)
      const sql =
        `SELECT DISTINCT ${quotedCol} FROM ${quotedTable} ` +
        `WHERE ${quotedCol} IS NOT NULL LIMIT ${limit}`
      try {
        const r = await this.executeQuery(config, sql)
        result[col] = r?.success ? extractFirstColumnValues(r.data) : []
      } catch {
        result[col] = []
      }
    }
    return result
  }

  // ── 方言 ──
  quoteIdentifier(identifier) {
    return `\`${String(identifier).replace(/`/g, '``')}\``
  }
}

PluginRegistry.register(new MySQLPlugin())

export default MySQLPlugin
