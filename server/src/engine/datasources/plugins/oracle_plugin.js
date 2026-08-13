/**
 * Oracle 插件(Node,用 oracledb 驱动 THIN 模式)。对齐 Python oracle_plugin.py。
 *
 * THIN 模式是 oracledb 7 的默认模式,纯 JS 实现,无需 Oracle Instant Client。
 * 仅支持 Oracle 12.1+(thin 模式限制)。连接串默认按 service_name 组装:
 *   host:port/service_name;若 extra_config.oracle_conn_type === 'sid' 则用 host:port:SID。
 */
import oracledb from 'oracledb'
import { DatabasePlugin, PluginRegistry, toPort, extractFirstColumnValues } from './base.js'

// CLOB/NCLOB 直接取字符串,免去 Lob 流式读取(schema 内省/查询都只需文本值)
oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB]

// 系统/内置 schema:内省与 schema 列举时排除(对齐 Python 排除列表)
const SYS_OWNERS = new Set([
  'SYS', 'SYSTEM', 'SYSAUX', 'OUTLN', 'DBSNMP', 'APPQOSSYS', 'CTXSYS', 'XDB',
  'MDSYS', 'ORDSYS', 'ORDDATA', 'WMSYS', 'OLAPSYS', 'GSMADMIN_INTERNAL',
  'LBACSYS', 'DIP', 'ORACLE_OCM', 'EXFSYS', 'ANONYMOUS', 'SYSMAN',
  'FLOWS_FILES', 'APEX_PUBLIC_USER',
])
const SYS_OWNERS_SQL = [...SYS_OWNERS].map((o) => `'${o}'`).join(',')

/** 取连接类型(sid / service_name);兼容直传与 extra_config 两种方式 */
function connType(config) {
  if (config.oracle_conn_type) return config.oracle_conn_type
  const extra = config.extra_config || config.extra_config_dict || {}
  return extra.oracle_conn_type || 'service_name'
}

/** 组装 thin 模式连接串(easy connect 语法) */
function buildConnectString(config) {
  const host = config.host
  const port = toPort(config.port, 1521)
  if (connType(config) === 'sid') {
    const sid = config.sid || config.database
    return `${host}:${port}:${sid}` // host:port:SID
  }
  const service = config.service_name || config.database
  return `${host}:${port}/${service}` // host:port/service_name
}

/** 开一个连接跑回调,保证 close */
async function withConn(config, fn) {
  const conn = await oracledb.getConnection({
    user: config.username,
    password: config.password,
    connectString: buildConnectString(config),
  })
  try {
    return await fn(conn)
  } finally {
    await conn.close().catch(() => {})
  }
}

/** Oracle 不接受 SQL 末尾分号,统一去除 */
const stripTrailingSemicolon = (sql) => String(sql).replace(/;\s*$/, '').trimEnd()

export class OraclePlugin extends DatabasePlugin {
  static metadata = {
    value: 'Oracle',
    label: 'Oracle',
    default_port: 1521,
    multiple_schema: true,
    description: '企业级关系型数据库',
    aliases: [],
  }

  async testConnection(config) {
    try {
      const version = await withConn(config, async (c) => {
        const r = await c.execute(
          'SELECT banner AS v FROM v$version WHERE ROWNUM = 1',
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        )
        return r.rows?.[0]?.V ?? null
      })
      return { success: true, message: '连接成功', connection_info: this.getConnectionInfo(config, version) }
    } catch (e) {
      return { success: false, message: '连接失败: ' + (e?.message || String(e)) }
    }
  }

  async getVersion(config) {
    try {
      return await withConn(config, async (c) => {
        const r = await c.execute(
          'SELECT banner AS v FROM v$version WHERE ROWNUM = 1',
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        )
        return r.rows?.[0]?.V ?? null
      })
    } catch {
      return null
    }
  }

  async executeQuery(config, sql, opts = {}) {
    const cleanSql = stripTrailingSemicolon(sql)
    try {
      return await withConn(config, async (c) => {
        const r = await c.execute(cleanSql, opts?.parameters || [], { outFormat: oracledb.OUT_FORMAT_OBJECT })
        const data = r.rows || []
        // metaData 每项有 .name(列名,默认大写);dbTypeName 给出 Oracle 类型名
        const columns = (r.metaData || []).map((m) => ({
          column_name: m.name,
          data_type: m.dbTypeName || 'UNKNOWN',
          is_nullable: m.nullable !== false,
          default_value: null,
        }))
        return {
          success: true,
          message: '查询成功',
          data,
          columns,
          row_count: data.length,
          sql_executed: cleanSql,
        }
      })
    } catch (e) {
      const msg = e?.message || String(e)
      return {
        success: false,
        message: '查询失败: ' + msg,
        error: msg,
        data: [],
        columns: [],
        row_count: 0,
        sql_executed: cleanSql,
      }
    }
  }

  async getSchemas(config) {
    return withConn(config, async (c) => {
      try {
        const r = await c.execute(
          `SELECT DISTINCT owner FROM all_tables
            WHERE owner NOT IN (${SYS_OWNERS_SQL})
            ORDER BY owner`,
          [],
          { outFormat: oracledb.OUT_FORMAT_OBJECT },
        )
        const list = (r.rows || []).map((x) => x.OWNER).filter(Boolean)
        if (list.length) return list
      } catch {
        // 权限不足时降级到当前用户 schema
      }
      // 兜底:当前用户(通常即默认 schema)
      const u = String(config.username || '').toUpperCase()
      return u ? [u] : []
    })
  }

  async getSchemaInfo(config, opts = {}) {
    try {
      return await withConn(config, async (c) => {
        // 目标 owner 列表:优先 selectedSchemas,否则默认当前用户 schema(大写)
        let owners
        if (opts.selectedSchemas && opts.selectedSchemas.length) {
          owners = opts.selectedSchemas.map((s) => String(s).toUpperCase()).filter((s) => !SYS_OWNERS.has(s))
        } else {
          const u = String(config.username || '').toUpperCase()
          owners = u ? [u] : []
        }
        if (!owners.length) return { tables: [] }

        const tables = []
        for (const owner of owners) {
          // 表 + 视图(num_rows 为统计信息,可能为 null)
          const tr = await c.execute(
            `SELECT t.table_name AS table_name, 'TABLE' AS table_type,
                    NVL((SELECT comments FROM all_tab_comments tc
                          WHERE tc.owner = t.owner AND tc.table_name = t.table_name), '') AS table_comment,
                    t.num_rows AS row_count
               FROM all_tables t
              WHERE t.owner = :owner
              UNION ALL
             SELECT v.view_name AS table_name, 'VIEW' AS table_type, '' AS table_comment, NULL AS row_count
               FROM all_views v
              WHERE v.owner = :owner
              ORDER BY table_name`,
            { owner },
            { outFormat: oracledb.OUT_FORMAT_OBJECT },
          )
          const tableRows = tr.rows || []
          if (!tableRows.length) continue

          // 批量取该 owner 下所有表/视图的列、PK、FK
          const columnsByTable = await this._getColumns(c, owner)

          for (const row of tableRows) {
            const isView = String(row.TABLE_TYPE).toUpperCase() === 'VIEW'
            tables.push({
              table_name: row.TABLE_NAME,
              schema_name: owner,
              table_type: isView ? 'VIEW' : 'TABLE',
              description: row.TABLE_COMMENT || '',
              row_count: row.ROW_COUNT != null ? Number(row.ROW_COUNT) : null,
              is_view: isView,
              columns: columnsByTable.get(row.TABLE_NAME) || [],
            })
          }
        }
        return { tables }
      })
    } catch (e) {
      return { tables: [], error: e?.message || String(e) }
    }
  }

  /** 批量取某 owner 下所有表的列信息(含 PK/FK),返回 Map<tableName, columns[]> */
  async _getColumns(conn, owner) {
    const byTable = new Map()

    // 主键列(约束类型 'P')
    const pkSet = new Set()
    try {
      const pkRes = await conn.execute(
        `SELECT acc.table_name AS table_name, acc.column_name AS column_name
           FROM all_constraints ac
           JOIN all_cons_columns acc
             ON ac.constraint_name = acc.constraint_name AND ac.owner = acc.owner
          WHERE ac.constraint_type = 'P' AND ac.owner = :owner`,
        { owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      )
      for (const r of pkRes.rows || []) pkSet.add(`${r.TABLE_NAME}.${r.COLUMN_NAME}`)
    } catch {
      // 忽略:无权限或无约束
    }

    // 外键列(约束类型 'R')
    const fkSet = new Set()
    try {
      const fkRes = await conn.execute(
        `SELECT acc.table_name AS table_name, acc.column_name AS column_name
           FROM all_constraints ac
           JOIN all_cons_columns acc
             ON ac.constraint_name = acc.constraint_name AND ac.owner = acc.owner
          WHERE ac.constraint_type = 'R' AND ac.owner = :owner`,
        { owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      )
      for (const r of fkRes.rows || []) fkSet.add(`${r.TABLE_NAME}.${r.COLUMN_NAME}`)
    } catch {
      // 忽略
    }

    // 列信息(data_default 为 LONG 类型,thin 模式可直接取;NVL 注释)
    const colRes = await conn.execute(
      `SELECT c.table_name AS table_name, c.column_name AS column_name, c.data_type AS data_type,
              c.nullable AS nullable, c.data_default AS data_default,
              c.data_length AS data_length, c.data_precision AS data_precision, c.data_scale AS data_scale,
              NVL((SELECT comments FROM all_col_comments cc
                    WHERE cc.owner = c.owner AND cc.table_name = c.table_name
                      AND cc.column_name = c.column_name), '') AS column_comment
         FROM all_tab_columns c
        WHERE c.owner = :owner
        ORDER BY c.table_name, c.column_id`,
      { owner },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    )

    for (const row of colRes.rows || []) {
      const tableName = row.TABLE_NAME
      const colName = row.COLUMN_NAME
      const isPk = pkSet.has(`${tableName}.${colName}`)
      const list = byTable.get(tableName) || []
      list.push({
        column_name: colName,
        data_type: row.DATA_TYPE,
        is_nullable: row.NULLABLE === 'Y',
        default_value: row.DATA_DEFAULT != null ? String(row.DATA_DEFAULT).trim() : null,
        is_primary_key: isPk,
        is_foreign_key: fkSet.has(`${tableName}.${colName}`),
        is_unique: false,
        is_indexed: isPk,
        description: row.COLUMN_COMMENT || '',
        max_length: row.DATA_LENGTH ?? null,
        numeric_precision: row.DATA_PRECISION ?? null,
        numeric_scale: row.DATA_SCALE ?? null,
      })
      byTable.set(tableName, list)
    }
    return byTable
  }

  // ── 方言 ──

  /** Oracle 双引号(保留原始大小写);未加引号的标识符会被折叠为大写。内嵌 `"` 用 `""` 转义 */
  quoteIdentifier(identifier) {
    return `"${String(identifier).replace(/"/g, '""')}"`
  }

  /** 大小写不敏感用 UPPER() 包裹两侧 */
  buildLikeCondition(column, pattern, caseInsensitive = true) {
    return caseInsensitive ? `UPPER(${column}) LIKE UPPER(${pattern})` : `${column} LIKE ${pattern}`
  }

  /**
   * 覆写 base 默认实现:Oracle 不认 `LIMIT n OFFSET n`,改用 12c+ 的
   * `OFFSET n ROWS FETCH NEXT n ROWS ONLY`。getDistinctValues/searchColumnValues
   * 继承自 base 且依赖本方法,故必须覆写,否则分页查询直接报 ORA 语法错。
   */
  buildDistinctColumnSql(tableName, columnName, opts = {}) {
    const { limit = 20, offset = 0, keyword = null, schemaName = null } = opts
    const quotedTable = this.quoteTableWithSchema(tableName, schemaName)
    const quotedColumn = this.quoteIdentifier(columnName)
    let sql = `SELECT DISTINCT ${quotedColumn} FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL`
    if (keyword) {
      const safeKeyword = String(keyword).replace(/'/g, "''")
      sql += ` AND ${this.buildLikeCondition(quotedColumn, `'%${safeKeyword}%'`)}`
    }
    return `${sql} ORDER BY ${quotedColumn} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`
  }
}

PluginRegistry.register(new OraclePlugin())

export default OraclePlugin
