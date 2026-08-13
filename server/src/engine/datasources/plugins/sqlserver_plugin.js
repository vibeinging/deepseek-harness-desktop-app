/**
 * SQL Server 插件(Node,用 mssql/tedious 驱动)。从零实现,走标准 T-SQL 目录视图。
 * 无 Python 参考;返回结构对齐 base.js 契约(供 table_metadata / 前端直接消费)。
 */
import sql from 'mssql'
import { DatabasePlugin, PluginRegistry, toPort, extractFirstColumnValues } from './base.js'

// SQL Server 系统/内建 schema,getSchemas / getSchemaInfo 一律排除
const SYS_SCHEMAS = new Set([
  'sys',
  'INFORMATION_SCHEMA',
  'guest',
  'db_owner',
  'db_accessadmin',
  'db_securityadmin',
  'db_ddladmin',
  'db_backupoperator',
  'db_datareader',
  'db_datawriter',
  'db_denydatareader',
  'db_denydatawriter',
])
const isSystemSchema = (s) => SYS_SCHEMAS.has(String(s))

function poolConfig(config) {
  return {
    server: config.host,
    port: toPort(config.port, 1433),
    user: config.username,
    password: config.password,
    database: config.database,
    connectionTimeout: 30000,
    requestTimeout: 45000,
    // 桌面联调:默认不加密、信任自签证书(对端常无正式 CA)
    options: { encrypt: false, trustServerCertificate: true },
  }
}

/** 开一个连接池跑回调,保证 close */
async function withPool(config, fn) {
  const pool = await new sql.ConnectionPool(poolConfig(config)).connect()
  try {
    return await fn(pool)
  } finally {
    await pool.close().catch(() => {})
  }
}

/** mssql 默认模式下 recordset.columns 是以列名为 key 的对象;转成统一 columns 数组 */
function mapColumns(recordset) {
  const meta = recordset?.columns || {}
  return Object.keys(meta).map((name) => {
    const c = meta[name] || {}
    return {
      column_name: c.name ?? name,
      data_type: c.type?.declaration || c.type?.name || 'UNKNOWN',
      is_nullable: c.nullable !== false,
      default_value: null,
    }
  })
}

export class SqlServerPlugin extends DatabasePlugin {
  static metadata = {
    value: 'SQLServer',
    label: 'SQL Server',
    default_port: 1433,
    multiple_schema: true,
    description: '企业级关系型数据库',
    aliases: ['mssql', 'sqlserver'],
  }

  async testConnection(config) {
    try {
      const version = await withPool(config, async (pool) => {
        const r = await pool.request().query('SELECT @@VERSION AS v')
        return r.recordset?.[0]?.v ?? null
      })
      return { success: true, message: '连接成功', connection_info: this.getConnectionInfo(config, version) }
    } catch (e) {
      return { success: false, message: '连接失败: ' + (e?.message || String(e)) }
    }
  }

  async getVersion(config) {
    try {
      return await withPool(config, async (pool) => {
        const r = await pool.request().query('SELECT @@VERSION AS v')
        return r.recordset?.[0]?.v ?? null
      })
    } catch {
      return null
    }
  }

  async executeQuery(config, sqlText, _opts = {}) {
    try {
      return await withPool(config, async (pool) => {
        const r = await pool.request().query(sqlText)
        const data = r.recordset || []
        const columns = mapColumns(r.recordset)
        return { success: true, message: '查询成功', data, columns, row_count: data.length, sql_executed: sqlText }
      })
    } catch (e) {
      const msg = e?.message || String(e)
      return { success: false, message: '查询失败: ' + msg, error: msg, data: [], columns: [], row_count: 0, sql_executed: sqlText }
    }
  }

  async getSchemas(config) {
    return withPool(config, async (pool) => {
      const r = await pool.request().query(`
        SELECT name FROM sys.schemas
         WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin',
                            'db_securityadmin','db_ddladmin','db_backupoperator','db_datareader',
                            'db_datawriter','db_denydatareader','db_denydatawriter')
         ORDER BY name`)
      return (r.recordset || []).map((x) => x.name)
    })
  }

  async getSchemaInfo(config, opts = {}) {
    try {
      return await withPool(config, async (pool) => {
        // 1) 目标 schema 列表
        let targetSchemas
        if (opts.selectedSchemas && opts.selectedSchemas.length) {
          targetSchemas = opts.selectedSchemas.filter((s) => !isSystemSchema(s))
        } else {
          const sr = await pool.request().query(`
            SELECT name FROM sys.schemas
             WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest','db_owner','db_accessadmin',
                                'db_securityadmin','db_ddladmin','db_backupoperator','db_datareader',
                                'db_datawriter','db_denydatareader','db_denydatawriter')
             ORDER BY name`)
          targetSchemas = (sr.recordset || []).map((x) => x.name).filter((s) => !isSystemSchema(s))
        }
        if (!targetSchemas.length) return { tables: [] }
        const schemaSet = new Set(targetSchemas)

        // 2) 表 / 视图(INFORMATION_SCHEMA.TABLES)
        const tr = await pool.request().query(`
          SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
            FROM INFORMATION_SCHEMA.TABLES
           WHERE TABLE_TYPE IN ('BASE TABLE','VIEW')
           ORDER BY TABLE_SCHEMA, TABLE_NAME`)
        const tableRows = (tr.recordset || []).filter((r) => schemaSet.has(r.TABLE_SCHEMA))
        if (!tableRows.length) return { tables: [] }

        // 3) 列(INFORMATION_SCHEMA.COLUMNS)— 按 schema.table 归并
        const cr = await pool.request().query(`
          SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, ORDINAL_POSITION, DATA_TYPE,
                 IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_MAXIMUM_LENGTH,
                 NUMERIC_PRECISION, NUMERIC_SCALE
            FROM INFORMATION_SCHEMA.COLUMNS
           ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`)

        // 4) PK / FK(TABLE_CONSTRAINTS + KEY_COLUMN_USAGE)
        const kr = await pool.request().query(`
          SELECT kcu.TABLE_SCHEMA, kcu.TABLE_NAME, kcu.COLUMN_NAME, tc.CONSTRAINT_TYPE
            FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
              ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
             AND tc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
           WHERE tc.CONSTRAINT_TYPE IN ('PRIMARY KEY','FOREIGN KEY')`)
        const pkSet = new Set()
        const fkSet = new Set()
        for (const r of kr.recordset || []) {
          const key = `${r.TABLE_SCHEMA}.${r.TABLE_NAME}.${r.COLUMN_NAME}`
          if (r.CONSTRAINT_TYPE === 'PRIMARY KEY') pkSet.add(key)
          else if (r.CONSTRAINT_TYPE === 'FOREIGN KEY') fkSet.add(key)
        }

        // 5) 表 / 列描述(sys.extended_properties 'MS_Description')— best-effort,失败置空
        const tableDesc = new Map() // "schema.table" -> desc
        const colDesc = new Map() // "schema.table.col" -> desc
        try {
          const dr = await pool.request().query(`
            SELECT s.name AS schema_name, t.name AS table_name,
                   CAST(ep.value AS NVARCHAR(MAX)) AS description
              FROM sys.extended_properties ep
              JOIN sys.tables t ON ep.major_id = t.object_id
              JOIN sys.schemas s ON t.schema_id = s.schema_id
             WHERE ep.name = 'MS_Description' AND ep.minor_id = 0`)
          for (const r of dr.recordset || []) {
            tableDesc.set(`${r.schema_name}.${r.table_name}`, r.description || '')
          }
          const cdr = await pool.request().query(`
            SELECT s.name AS schema_name, t.name AS table_name, c.name AS column_name,
                   CAST(ep.value AS NVARCHAR(MAX)) AS description
              FROM sys.extended_properties ep
              JOIN sys.columns c ON ep.major_id = c.object_id AND ep.minor_id = c.column_id
              JOIN sys.tables t ON c.object_id = t.object_id
              JOIN sys.schemas s ON t.schema_id = s.schema_id
             WHERE ep.name = 'MS_Description' AND ep.minor_id > 0`)
          for (const r of cdr.recordset || []) {
            colDesc.set(`${r.schema_name}.${r.table_name}.${r.column_name}`, r.description || '')
          }
        } catch {
          // 描述非必需,忽略权限/视图缺失
        }

        // 6) 行数(sys.dm_db_partition_stats)— best-effort,失败留 null
        const rowCounts = new Map() // "schema.table" -> number
        try {
          const rr = await pool.request().query(`
            SELECT s.name AS schema_name, t.name AS table_name,
                   SUM(p.row_count) AS row_count
              FROM sys.dm_db_partition_stats p
              JOIN sys.tables t ON p.object_id = t.object_id
              JOIN sys.schemas s ON t.schema_id = s.schema_id
             WHERE p.index_id IN (0, 1)
             GROUP BY s.name, t.name`)
          for (const r of rr.recordset || []) {
            const n = r.row_count != null ? Number(r.row_count) : null
            rowCounts.set(`${r.schema_name}.${r.table_name}`, Number.isFinite(n) ? n : null)
          }
        } catch {
          // 行数非必需
        }

        // 7) 列信息归并到 schema.table
        const colsByTable = new Map() // "schema.table" -> columns[]
        for (const row of cr.recordset || []) {
          if (!schemaSet.has(row.TABLE_SCHEMA)) continue
          const tkey = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`
          const ckey = `${tkey}.${row.COLUMN_NAME}`
          const list = colsByTable.get(tkey) || []
          const isPk = pkSet.has(ckey)
          list.push({
            column_name: row.COLUMN_NAME,
            data_type: row.DATA_TYPE,
            is_nullable: String(row.IS_NULLABLE).toUpperCase() === 'YES',
            default_value: row.COLUMN_DEFAULT ?? null,
            is_primary_key: isPk,
            is_foreign_key: fkSet.has(ckey),
            is_unique: false,
            is_indexed: isPk,
            description: colDesc.get(ckey) || '',
            max_length: row.CHARACTER_MAXIMUM_LENGTH ?? null,
            numeric_precision: row.NUMERIC_PRECISION ?? null,
            numeric_scale: row.NUMERIC_SCALE ?? null,
          })
          colsByTable.set(tkey, list)
        }

        // 8) 组装 tables
        const tables = []
        for (const t of tableRows) {
          const tkey = `${t.TABLE_SCHEMA}.${t.TABLE_NAME}`
          const isView = String(t.TABLE_TYPE).toUpperCase() === 'VIEW'
          tables.push({
            table_name: t.TABLE_NAME,
            schema_name: t.TABLE_SCHEMA,
            table_type: isView ? 'VIEW' : 'TABLE',
            description: tableDesc.get(tkey) || '',
            row_count: rowCounts.has(tkey) ? rowCounts.get(tkey) : null,
            is_view: isView,
            columns: colsByTable.get(tkey) || [],
          })
        }
        return { tables }
      })
    } catch (e) {
      return { tables: [], error: e?.message || String(e) }
    }
  }

  // ── 列样例值 / EXPLAIN(SQL Server 专用覆写)──

  /**
   * SQL EXPLAIN 校验 — SQL Server 无 EXPLAIN,改用 SET SHOWPLAN_ALL ON
   * 只产计划不真执行,避免副作用。经 executeQuery 跑(整批一条语句)。
   * @returns {Promise<{success:boolean, message:string, data:any[], error?:string}>}
   */
  async explain(config, sqlText, _opts = {}) {
    const result = await this.executeQuery(config, `SET SHOWPLAN_ALL ON; ${sqlText}; SET SHOWPLAN_ALL OFF;`)
    if (!result?.success) {
      const err = result?.error ?? result?.message ?? '未知错误'
      return { success: false, message: 'EXPLAIN 执行失败: ' + err, data: [], error: err }
    }
    return { success: true, message: 'EXPLAIN 执行成功', data: result.data || [] }
  }

  /**
   * 取表中各列的示例值 — 先查 INFORMATION_SCHEMA.COLUMNS 拿列名(默认 schema dbo),
   * 逐列执行 `SELECT DISTINCT TOP n <col> FROM <table> WHERE <col> IS NOT NULL`。
   * 单列失败置空数组,不抛。SQL Server 用 TOP 而非 LIMIT。
   * @param {object} config
   * @param {string} tableName plain 表名
   * @param {{schemaName?:string, limit?:number}} [opts]
   * @returns {Promise<Record<string, any[]>>}
   */
  async getExampleValues(config, tableName, { schemaName = 'dbo', limit = 3 } = {}) {
    const safe = (s) => String(s).replace(/'/g, "''")
    const colSql =
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS` +
      ` WHERE TABLE_SCHEMA = '${safe(schemaName)}' AND TABLE_NAME = '${safe(tableName)}'` +
      ` ORDER BY ORDINAL_POSITION`
    const colRes = await this.executeQuery(config, colSql)
    const result = {}
    if (!colRes?.success) return result

    const quotedTable = this.quoteTableWithSchema(tableName, schemaName)
    const top = Number.parseInt(String(limit), 10) || 3
    for (const row of colRes.data || []) {
      const columnName = row.COLUMN_NAME
      if (!columnName) continue
      const quotedColumn = this.quoteIdentifier(columnName)
      const querySql =
        `SELECT DISTINCT TOP ${top} ${quotedColumn} FROM ${quotedTable}` +
        ` WHERE ${quotedColumn} IS NOT NULL`
      try {
        const res = await this.executeQuery(config, querySql)
        result[columnName] = res?.success ? extractFirstColumnValues(res.data) : []
      } catch {
        result[columnName] = []
      }
    }
    return result
  }

  /**
   * 构建获取列唯一值的 SQL(覆写 base:SQL Server 用 TOP/OFFSET-FETCH,无 LIMIT)。
   * keyword 非空时附加 LIKE 过滤(单引号转义防注入)。
   * @returns {string}
   */
  buildDistinctColumnSql(tableName, columnName, opts = {}) {
    const { limit = 20, offset = 0, keyword = null, schemaName = null } = opts
    const quotedTable = this.quoteTableWithSchema(tableName, schemaName)
    const quotedColumn = this.quoteIdentifier(columnName)
    let where = `WHERE ${quotedColumn} IS NOT NULL`
    if (keyword) {
      const safeKeyword = String(keyword).replace(/'/g, "''")
      const likeCondition = this.buildLikeCondition(quotedColumn, `'%${safeKeyword}%'`)
      where = `${where} AND ${likeCondition}`
    }
    const off = Number.parseInt(String(offset), 10) || 0
    const lim = Number.parseInt(String(limit), 10) || 20
    // ORDER BY 必须有(OFFSET-FETCH 要求);用列本身排序即可
    return (
      `SELECT DISTINCT ${quotedColumn} FROM ${quotedTable} ${where}` +
      ` ORDER BY ${quotedColumn} OFFSET ${off} ROWS FETCH NEXT ${lim} ROWS ONLY`
    )
  }

  // ── 方言 ──
  quoteIdentifier(identifier) {
    return `[${String(identifier).replace(/]/g, ']]')}]`
  }

  quoteTableWithSchema(tableName, schemaName = null) {
    const t = this.quoteIdentifier(tableName)
    if (schemaName && schemaName !== 'default') {
      return `${this.quoteIdentifier(schemaName)}.${t}`
    }
    return t
  }

  // SQL Server 默认排序规则大小写不敏感,LIKE 直接用即可
  buildLikeCondition(column, pattern, _caseInsensitive = true) {
    return `${column} LIKE ${pattern}`
  }
}

PluginRegistry.register(new SqlServerPlugin())

export default SqlServerPlugin
