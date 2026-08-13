/**
 * PostgreSQL 插件(Node,用 pg 驱动)。对齐 Python postgresql_plugin.py。
 * Vastbase / OpenGauss / GaussDB 等 PG 系可走别名复用。
 */
import pg from 'pg'
import { DatabasePlugin, PluginRegistry, toPort, extractFirstColumnValues } from './base.js'

const { Client } = pg

// pg 默认把 numeric/bigint 当字符串返回——保持与 Python 一致即可,这里不强转。

function clientConfig(config) {
  return {
    host: config.host,
    port: toPort(config.port, 5432),
    user: config.username,
    password: config.password,
    database: config.database,
    connectionTimeoutMillis: 30000,
    statement_timeout: 45000,
    application_name: 'dsh',
    // 桌面联调:允许自签名 SSL(若对端要求);默认不开 SSL
    ssl: config.ssl || false,
  }
}

/** 开一个连接跑回调,保证 end */
async function withClient(config, fn) {
  const client = new Client(clientConfig(config))
  await client.connect()
  try {
    return await fn(client)
  } finally {
    await client.end().catch(() => {})
  }
}

const SYS_SCHEMAS = new Set(['pg_catalog', 'information_schema'])
const isSystemSchema = (s) => SYS_SCHEMAS.has(s) || String(s).startsWith('pg_')

export class PostgreSQLPlugin extends DatabasePlugin {
  static metadata = {
    value: 'PostgreSQL',
    label: 'PostgreSQL',
    default_port: 5432,
    multiple_schema: true,
    description: '开源关系型数据库',
    aliases: ['postgres', 'pg'],
    // PG 线协议同族:复用 node-postgres 驱动直连(选择类型页各自成卡,连接走本插件)
    variants: [
      { value: 'Vastbase', label: 'Vastbase', default_port: 5432, multiple_schema: true, description: '海量 Vastbase(PostgreSQL 兼容)' },
      { value: 'OpenGauss', label: 'openGauss', default_port: 5432, multiple_schema: true, description: '开源企业级关系型数据库(PostgreSQL 兼容)' },
      { value: 'GaussDB', label: 'GaussDB', default_port: 8000, multiple_schema: true, description: '华为云企业级分布式数据库(PostgreSQL 兼容)' },
      { value: 'VexDB', label: 'VexDB', default_port: 5432, multiple_schema: true, description: '为 AI 时代而生的高性能向量数据库(PostgreSQL 兼容)' },
    ],
  }

  async testConnection(config) {
    try {
      const version = await withClient(config, async (c) => {
        const r = await c.query('SELECT version() AS v')
        return r.rows[0]?.v ?? null
      })
      return { success: true, message: '连接成功', connection_info: this.getConnectionInfo(config, version) }
    } catch (e) {
      return { success: false, message: '连接失败: ' + (e?.message || String(e)) }
    }
  }

  async getVersion(config) {
    try {
      return await withClient(config, async (c) => {
        const r = await c.query('SELECT version() AS v')
        return r.rows[0]?.v ?? null
      })
    } catch {
      return null
    }
  }

  async executeQuery(config, sql, opts = {}) {
    try {
      return await withClient(config, async (c) => {
        const r = await c.query(sql, opts?.parameters || [])
        const data = r.rows || []
        const columns = (r.fields || []).map((f) => ({
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

  async getSchemas(config) {
    return withClient(config, async (c) => {
      const r = await c.query(`
        SELECT nspname
          FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog', 'information_schema')
           AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
           AND has_schema_privilege(nspname, 'USAGE')
         ORDER BY nspname
      `)
      return r.rows.map((x) => x.nspname)
    })
  }

  async getSchemaInfo(config, opts = {}) {
    try {
      return await withClient(config, async (c) => {
        // 目标 schema 列表
        let targetSchemas
        if (opts.selectedSchemas && opts.selectedSchemas.length) {
          targetSchemas = opts.selectedSchemas.filter((s) => !isSystemSchema(s))
        } else {
          const r = await c.query(`
            SELECT nspname FROM pg_namespace
             WHERE nspname NOT IN ('pg_catalog','information_schema')
               AND nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
               AND has_schema_privilege(nspname, 'USAGE')
             ORDER BY nspname
          `)
          targetSchemas = r.rows.map((x) => x.nspname).filter((s) => !isSystemSchema(s))
        }
        if (!targetSchemas.length) return { tables: [] }

        const tables = []
        for (const schema of targetSchemas) {
          const tr = await c.query(
            `SELECT t.table_name, t.table_type,
                    COALESCE(obj_description(cl.oid), '') AS table_comment,
                    COALESCE(pst.n_live_tup, 0) AS row_count
               FROM information_schema.tables t
               LEFT JOIN pg_class cl ON cl.relname = t.table_name
               LEFT JOIN pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = $1
               LEFT JOIN pg_stat_user_tables pst ON pst.schemaname = $1 AND pst.relname = t.table_name
              WHERE t.table_schema = $1
              ORDER BY t.table_name`,
            [schema],
          )
          const tableNames = tr.rows.map((x) => x.table_name)
          if (!tableNames.length) continue

          const columnsByTable = await this._getColumns(c, schema, tableNames)

          for (const row of tr.rows) {
            const tt = String(row.table_type || 'BASE TABLE').toUpperCase()
            const isView = tt === 'VIEW' || tt === 'MATERIALIZED VIEW'
            tables.push({
              table_name: row.table_name,
              schema_name: schema,
              table_type: isView ? 'VIEW' : 'TABLE',
              description: row.table_comment || '',
              row_count: row.row_count != null ? Number(row.row_count) : null,
              is_view: isView,
              columns: columnsByTable.get(row.table_name) || [],
            })
          }
        }
        return { tables }
      })
    } catch (e) {
      return { tables: [], error: e?.message || String(e) }
    }
  }

  /** 批量取某 schema 下多表的列信息(含 PK/FK) */
  async _getColumns(client, schema, tableNames) {
    const byTable = new Map()

    // FK 列(schema 级一次查)
    const fkRes = await client.query(
      `SELECT kcu.table_name, kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
          AND tc.table_name = kcu.table_name
        WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
      [schema],
    )
    const fkSet = new Set(fkRes.rows.map((r) => `${r.table_name}.${r.column_name}`))

    const colRes = await client.query(
      `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default,
              COALESCE(pgd.description, '') AS column_comment,
              c.character_maximum_length, c.numeric_precision, c.numeric_scale,
              CASE WHEN pk.column_name IS NOT NULL THEN 'PRI' ELSE '' END AS column_key
         FROM information_schema.columns c
         LEFT JOIN pg_class pgc ON pgc.relname = c.table_name
         LEFT JOIN pg_namespace pgn ON pgn.oid = pgc.relnamespace AND pgn.nspname = $1
         LEFT JOIN pg_description pgd ON pgd.objoid = pgc.oid AND pgd.objsubid = c.ordinal_position
         LEFT JOIN (
           SELECT ku.table_schema, ku.table_name, ku.column_name
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage ku
               ON tc.constraint_name = ku.constraint_name
              AND tc.table_schema = ku.table_schema
              AND tc.table_name = ku.table_name
            WHERE tc.constraint_type = 'PRIMARY KEY'
         ) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name
        WHERE c.table_schema = $1 AND c.table_name = ANY($2::text[])
        ORDER BY c.table_name, c.ordinal_position`,
      [schema, tableNames],
    )

    for (const row of colRes.rows) {
      const list = byTable.get(row.table_name) || []
      const isPk = row.column_key === 'PRI'
      list.push({
        column_name: row.column_name,
        data_type: row.data_type,
        is_nullable: row.is_nullable === 'YES',
        default_value: row.column_default,
        is_primary_key: isPk,
        is_foreign_key: fkSet.has(`${row.table_name}.${row.column_name}`),
        is_unique: false,
        is_indexed: isPk,
        description: row.column_comment || '',
        max_length: row.character_maximum_length,
        numeric_precision: row.numeric_precision,
        numeric_scale: row.numeric_scale,
      })
      byTable.set(row.table_name, list)
    }
    return byTable
  }

  // ── 列样例值 / EXPLAIN(PG 专用覆写;distinct/search 沿用 base 默认)──

  /**
   * SQL EXPLAIN 校验 — PG 用 `EXPLAIN (FORMAT JSON) <sql>`(不带 ANALYZE,
   * 避免真执行 SQL 产生副作用),经 executeQuery 跑。
   * @returns {Promise<{success:boolean, message:string, data:any[], error?:string}>}
   */
  async explain(config, sql, _opts = {}) {
    const result = await this.executeQuery(config, `EXPLAIN (FORMAT JSON) ${sql}`)
    if (!result?.success) {
      const err = result?.error ?? result?.message ?? '未知错误'
      return { success: false, message: 'EXPLAIN 执行失败: ' + err, data: [], error: err }
    }
    return { success: true, message: 'EXPLAIN 执行成功', data: result.data || [] }
  }

  /**
   * 取表中各列的示例值 — 简化采样(未用智能采样 mixin)。
   * 先查 information_schema.columns 拿列名(schema 默认 public),逐列执行
   * `SELECT DISTINCT <col> FROM <table> WHERE <col> IS NOT NULL LIMIT <limit>`。
   * 单列失败则置空数组,不抛。
   * @param {object} config
   * @param {string} tableName plain 表名
   * @param {{schemaName?:string, limit?:number}} [opts]
   * @returns {Promise<Record<string, any[]>>} { [columnName]: [值,...] }
   */
  async getExampleValues(config, tableName, { schemaName = 'public', limit = 3 } = {}) {
    const colSql =
      `SELECT column_name FROM information_schema.columns` +
      ` WHERE table_schema = '${String(schemaName).replace(/'/g, "''")}'` +
      ` AND table_name = '${String(tableName).replace(/'/g, "''")}'` +
      ` ORDER BY ordinal_position`
    const colRes = await this.executeQuery(config, colSql)
    const result = {}
    if (!colRes?.success) return result

    const quotedTable = this.quoteTableWithSchema(tableName, schemaName)
    for (const row of colRes.data || []) {
      const columnName = row.column_name
      if (!columnName) continue
      const quotedColumn = this.quoteIdentifier(columnName)
      const sql =
        `SELECT DISTINCT ${quotedColumn} FROM ${quotedTable}` +
        ` WHERE ${quotedColumn} IS NOT NULL LIMIT ${limit}`
      try {
        const res = await this.executeQuery(config, sql)
        result[columnName] = res?.success ? extractFirstColumnValues(res.data) : []
      } catch {
        result[columnName] = []
      }
    }
    return result
  }

  // ── 方言 ──
  quoteIdentifier(identifier) {
    return `"${String(identifier).replace(/"/g, '""')}"`
  }

  buildLikeCondition(column, pattern, caseInsensitive = true) {
    return caseInsensitive ? `${column}::text ILIKE ${pattern}` : `${column} LIKE ${pattern}`
  }
}

PluginRegistry.register(new PostgreSQLPlugin())

export default PostgreSQLPlugin
