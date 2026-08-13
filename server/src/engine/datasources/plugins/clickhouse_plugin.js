/**
 * ClickHouse 插件(Node,用 @clickhouse/client HTTP 驱动)。对齐 Python clickhouse_plugin.py。
 * 列式 OLAP 库:无 schema 概念(以「database」为作用域),multiple_schema=false。
 */
import { createClient } from '@clickhouse/client'
import { DatabasePlugin, PluginRegistry, toPort } from './base.js'

/** 建一个 client(每次调用新建,finally 必关) */
function makeClient(config) {
  return createClient({
    url: `http://${config.host}:${toPort(config.port, 8123)}`,
    username: config.username || 'default',
    password: config.password || '',
    database: config.database || 'default',
    request_timeout: 45000,
  })
}

/** SELECT 类语句(有结果集)才走 query();DDL/INSERT 走 command()。 */
const RE_HAS_RESULT = /^\s*(select|with|show|describe|desc|explain)\b/i

/** 单引号转义(用于把字面量拼进 system.* 查询) */
const sq = (s) => String(s).replace(/'/g, "''")

export class ClickHousePlugin extends DatabasePlugin {
  static metadata = {
    value: 'ClickHouse',
    label: 'ClickHouse',
    default_port: 8123,
    multiple_schema: false,
    description: '列式分析数据库，适合高吞吐 OLAP 查询',
    aliases: ['clickhouse'],
  }

  async testConnection(config) {
    try {
      const version = await this.getVersion(config)
      if (version == null) {
        return { success: false, message: '连接失败: 无法获取版本' }
      }
      return { success: true, message: '连接成功', connection_info: this.getConnectionInfo(config, version) }
    } catch (e) {
      return { success: false, message: '连接失败: ' + (e?.message || String(e)) }
    }
  }

  async getVersion(config) {
    const client = makeClient(config)
    try {
      const rs = await client.query({ query: 'SELECT version() AS v', format: 'JSON' })
      const body = await rs.json()
      return body?.data?.[0]?.v ?? null
    } catch {
      return null
    } finally {
      await client.close().catch(() => {})
    }
  }

  async executeQuery(config, sql, _opts = {}) {
    const client = makeClient(config)
    try {
      if (RE_HAS_RESULT.test(sql)) {
        const rs = await client.query({ query: sql, format: 'JSON' })
        const body = await rs.json()
        const data = body?.data || []
        const columns = (body?.meta || []).map((m) => ({
          column_name: m.name,
          data_type: m.type,
          is_nullable: typeof m.type === 'string' && m.type.startsWith('Nullable('),
          default_value: null,
        }))
        const rowCount = body?.rows ?? data.length
        return { success: true, message: '查询成功', data, columns, row_count: rowCount, sql_executed: sql }
      }
      // DDL / INSERT 等无结果集语句
      await client.command({ query: sql })
      return { success: true, message: '查询成功', data: [], columns: [], row_count: 0, sql_executed: sql }
    } catch (e) {
      const msg = e?.message || String(e)
      return { success: false, message: '查询失败: ' + msg, error: msg, data: [], columns: [], row_count: 0, sql_executed: sql }
    } finally {
      await client.close().catch(() => {})
    }
  }

  /** ClickHouse 用「database」而非 schema;multiple_schema=false,作用域即连接的 database,返回 []。 */
  async getSchemas(_config) {
    return []
  }

  async getSchemaInfo(config, _opts = {}) {
    const client = makeClient(config)
    try {
      // 当前连接 database 作为作用域;config.database 缺省时用 currentDatabase()
      const dbName = config.database || 'default'
      const dbFilter = config.database ? `database = '${sq(dbName)}'` : `database = currentDatabase()`

      // 1) 表清单(含引擎 / 行数 / 注释)
      const tablesRs = await client.query({
        query: `
          SELECT name, engine, comment, total_rows
          FROM system.tables
          WHERE ${dbFilter} AND is_temporary = 0
          ORDER BY name`,
        format: 'JSON',
      })
      const tablesBody = await tablesRs.json()

      // 2) 列清单(主键 / 默认值 / 注释)
      const colsRs = await client.query({
        query: `
          SELECT table, name, type, default_kind, default_expression,
                 comment, is_in_primary_key, is_in_sorting_key, position
          FROM system.columns
          WHERE ${dbFilter}
          ORDER BY table, position`,
        format: 'JSON',
      })
      const colsBody = await colsRs.json()

      // 列按表归组
      const columnsByTable = new Map()
      for (const row of colsBody?.data || []) {
        const tableName = row.table
        const list = columnsByTable.get(tableName) || []
        const type = String(row.type ?? '')
        const isPk = Number(row.is_in_primary_key) === 1
        const isSorting = Number(row.is_in_sorting_key) === 1
        list.push({
          column_name: row.name,
          data_type: type,
          is_nullable: type.startsWith('Nullable('),
          // default_expression 仅在有 default_kind(DEFAULT/MATERIALIZED/ALIAS)时有意义
          default_value: row.default_kind ? row.default_expression || null : null,
          is_primary_key: isPk,
          is_foreign_key: false,
          is_unique: false,
          is_indexed: isPk || isSorting,
          description: row.comment || '',
          max_length: null,
          numeric_precision: null,
          numeric_scale: null,
        })
        columnsByTable.set(tableName, list)
      }

      const tables = []
      for (const row of tablesBody?.data || []) {
        const engine = String(row.engine ?? '')
        const isView = /view/i.test(engine) // View / MaterializedView / LiveView 等
        const total = row.total_rows
        tables.push({
          table_name: row.name,
          schema_name: dbName,
          table_type: isView ? 'VIEW' : 'TABLE',
          description: row.comment || '',
          row_count: total != null && total !== '' ? Number(total) : null,
          is_view: isView,
          columns: columnsByTable.get(row.name) || [],
        })
      }
      return { tables }
    } catch (e) {
      return { tables: [], error: e?.message || String(e) }
    } finally {
      await client.close().catch(() => {})
    }
  }

  // ── 方言 ──
  // ClickHouse 标识符用反引号;内部反引号双写转义。
  quoteIdentifier(identifier) {
    return `\`${String(identifier).replace(/`/g, '``')}\``
  }

  // ClickHouse 无 ILIKE;大小写不敏感用 lowerUTF8() 两侧降级再 LIKE。
  buildLikeCondition(column, pattern, caseInsensitive = true) {
    return caseInsensitive
      ? `lowerUTF8(toString(${column})) LIKE lowerUTF8(${pattern})`
      : `${column} LIKE ${pattern}`
  }
}

PluginRegistry.register(new ClickHousePlugin())

export default ClickHousePlugin
