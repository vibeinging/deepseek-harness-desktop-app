/**
 * 数据库操作插件基础抽象类(Node 端口,对齐 Python core/database/plugins/base.py)。
 *
 * 设计:按 db_type 注册到 PluginRegistry;每个插件实现统一接口(连接外部库做
 * 测试连接 / 版本 / schema 内省 / 查询)。连接信息统一用一个 config 对象传入:
 *   { host, port, username, password, database, db_type, ...extra }
 *
 * 返回结构与 Python 版完全一致(便于前端 / table_metadata 直接消费)。
 */

export class PluginRegistry {
  /** @type {Map<string, DatabasePlugin>} db_type.lower() -> 实例 */
  static _plugins = new Map()
  /** @type {Map<string, string>} alias.lower() -> canonical db_type.lower() */
  static _aliases = new Map()

  /** 注册插件实例 */
  static register(plugin) {
    const meta = plugin.metadata
    const dbType = String(meta.value || '').toLowerCase()
    if (!dbType) return
    this._plugins.set(dbType, plugin)
    for (const alias of meta.aliases || []) {
      this._aliases.set(String(alias).toLowerCase(), dbType)
    }
    // 同族变体(PG 兼容 / MySQL 兼容)的 value 也注册成别名,使 get(variant) 复用本插件驱动
    for (const v of meta.variants || []) {
      const vv = String(v.value || '').toLowerCase()
      if (vv) this._aliases.set(vv, dbType)
    }
  }

  /**
   * 选择类型页要展示的全部「可选数据库类型」= 每个插件的基础类型 + 其线协议同族变体。
   * 变体经别名路由回基础插件,连接 / 查询复用同一驱动(如 Vastbase→pg、Doris→mysql)。
   * @returns {Array<{value,label,default_port,multiple_schema,description}>}
   */
  static selectableTypes() {
    const norm = (ms) => (ms === true || ms === 'True' ? 'True' : 'False')
    const out = []
    for (const plugin of this._plugins.values()) {
      const m = plugin.metadata
      out.push({
        value: m.value,
        label: m.label || m.value,
        default_port: m.default_port ?? null,
        multiple_schema: norm(m.multiple_schema),
        description: m.description || '',
      })
      for (const v of m.variants || []) {
        out.push({
          value: v.value,
          label: v.label || v.value,
          default_port: v.default_port ?? m.default_port ?? null,
          multiple_schema: norm(v.multiple_schema ?? m.multiple_schema),
          description: v.description || '',
        })
      }
    }
    return out
  }

  /** 按 db_type 取插件(支持别名);找不到返回 null */
  static get(dbType) {
    let key = String(dbType || '').toLowerCase()
    if (this._aliases.has(key)) key = this._aliases.get(key)
    return this._plugins.get(key) || null
  }

  static allTypes() {
    return [...this._plugins.values()].map((p) => p.metadata.value)
  }

  static allMetadata() {
    return [...this._plugins.values()].map((p) => p.metadata)
  }
}

export class DatabasePlugin {
  /** 子类覆盖:{ value, label, default_port, multiple_schema, description, aliases } */
  static metadata = {
    value: '',
    label: '',
    default_port: null,
    multiple_schema: false,
    description: '',
    aliases: [],
  }

  get metadata() {
    return this.constructor.metadata
  }

  get db_type() {
    return this.metadata.value
  }

  // ── 子类必须实现 ──

  /** @returns {Promise<{success:boolean, message:string, connection_info?:object}>} */
  async testConnection(_config) {
    throw new Error('testConnection not implemented')
  }

  /** @returns {Promise<{success:boolean, message:string, data:object[], columns:object[], row_count:number, sql_executed:string, error?:string}>} */
  async executeQuery(_config, _sql, _opts = {}) {
    throw new Error('executeQuery not implemented')
  }

  /** @returns {Promise<string|null>} */
  async getVersion(_config) {
    throw new Error('getVersion not implemented')
  }

  /**
   * schema 内省 — 统一格式,可直接写入 table_metadata / column_metadata。
   * @returns {Promise<{tables: Array<{
   *   table_name, schema_name, table_type, description, row_count, is_view,
   *   columns: Array<{ column_name, data_type, is_nullable, default_value,
   *     is_primary_key, is_foreign_key, is_unique, is_indexed, description,
   *     max_length, numeric_precision, numeric_scale }>
   * }>}>}
   */
  async getSchemaInfo(_config, _opts = {}) {
    throw new Error('getSchemaInfo not implemented')
  }

  /** @returns {Promise<string[]>} 可用 schema 列表(单 schema 库返回 []) */
  async getSchemas(_config) {
    return []
  }

  // ── 值采样 / distinct / 搜索 / EXPLAIN(默认实现,子类可覆盖)──
  //    全部复用 executeQuery(config, sql),不另开连接。对齐 Python base.py 默认实现。

  /**
   * 取表中各列的示例值(简化采样,未用智能采样 mixin = Python IntelligentSamplingMixin)。
   *
   * 默认实现:先经 getSchemaInfo 取该表列名,再逐列执行
   *   SELECT DISTINCT <col> FROM <table> WHERE <col> IS NOT NULL LIMIT <limit>
   * 收集成 { col: [values] }。失败的列跳过(置空数组),不抛。
   * pg/mysql 子类可按需覆写(如直接查 information_schema 取列名,免整库内省)。
   * @param {object} config 连接配置
   * @param {string} tableName 表名
   * @param {{schemaName?:string|null, limit?:number}} [opts]
   * @returns {Promise<Record<string, any[]>>} { [columnName]: [值,...] }
   */
  async getExampleValues(config, tableName, opts = {}) {
    const { schemaName = null, limit = 3 } = opts
    const result = {}
    // 1) 取列名(走 schema 内省,失败则无列名,返回空对象)
    let columnNames = []
    try {
      const info = await this.getSchemaInfo(config, schemaName ? { selectedSchemas: [schemaName] } : {})
      const table = (info?.tables || []).find(
        (t) => t.table_name === tableName && (!schemaName || schemaName === 'default' || t.schema_name === schemaName),
      )
      columnNames = (table?.columns || []).map((c) => c.column_name).filter((c) => c != null)
    } catch {
      columnNames = []
    }
    // 2) 逐列 SELECT DISTINCT,失败的列置空数组
    const quotedTable = this.quoteTableWithSchema(tableName, schemaName)
    for (const col of columnNames) {
      const quotedCol = this.quoteIdentifier(col)
      const sql = `SELECT DISTINCT ${quotedCol} FROM ${quotedTable} WHERE ${quotedCol} IS NOT NULL LIMIT ${limit}`
      try {
        const r = await this.executeQuery(config, sql)
        result[col] = r?.success ? extractFirstColumnValues(r.data) : []
      } catch {
        result[col] = []
      }
    }
    return result
  }

  /**
   * 获取列唯一值(distinct)。对齐 Python get_distinct_values 默认实现。
   * @returns {Promise<{success:boolean, data:any[], row_count:number, has_more?:boolean}>}
   */
  async getDistinctValues(config, tableName, columnName, opts = {}) {
    const { schemaName = null, limit = 20, offset = 0, keyword = null } = opts
    const sql = this.buildDistinctColumnSql(tableName, columnName, { limit, offset, keyword, schemaName })
    const result = await this.executeQuery(config, sql)
    if (!result?.success) {
      return { success: false, data: [], row_count: 0, error: result?.error ?? result?.message }
    }
    const data = extractFirstColumnValues(result.data)
    return { success: true, data, row_count: data.length }
  }

  /**
   * 搜索列值(LIKE 模糊匹配)。对齐 Python search_column_values 默认实现。
   * 多取 1 条用于判断 has_more。
   * @returns {Promise<{success:boolean, data:any[], candidates:any[], has_more:boolean}>}
   */
  async searchColumnValues(config, tableName, columnName, keyword, opts = {}) {
    const { schemaName = null, limit = 20, offset = 0 } = opts
    const sql = this.buildDistinctColumnSql(tableName, columnName, {
      limit: limit + 1,
      offset,
      keyword,
      schemaName,
    })
    const result = await this.executeQuery(config, sql)
    if (!result?.success) {
      return { success: false, data: [], candidates: [], has_more: false, error: result?.error ?? result?.message }
    }
    const all = extractFirstColumnValues(result.data)
    const hasMore = all.length > limit
    const data = all.slice(0, limit)
    return { success: true, data, candidates: data, has_more: hasMore }
  }

  /**
   * SQL EXPLAIN 校验(默认 `EXPLAIN <sql>`,不带 ANALYZE 避免真执行产生副作用)。
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

  // ── SQL 方言(子类可覆盖)──

  /** 标识符引用(默认不加引号) */
  quoteIdentifier(identifier) {
    return identifier
  }

  /** LIKE 条件(默认标准 LIKE) */
  buildLikeCondition(column, pattern, _caseInsensitive = true) {
    return `${column} LIKE ${pattern}`
  }

  /** 表名引用(支持 schema 前缀) */
  quoteTableWithSchema(tableName, schemaName = null) {
    const t = this.quoteIdentifier(tableName)
    if (schemaName && schemaName !== 'default') {
      return `${this.quoteIdentifier(schemaName)}.${t}`
    }
    return t
  }

  /**
   * 构建获取列唯一值的 SQL。对齐 Python build_distinct_column_sql。
   * keyword 非空时附加 LIKE 过滤(单引号转义防注入)。
   * @param {string} tableName plain 表名(不含 schema 前缀)
   * @param {string} columnName 列名
   * @param {{limit?:number, offset?:number, keyword?:string|null, schemaName?:string|null}} [opts]
   * @returns {string}
   */
  buildDistinctColumnSql(tableName, columnName, opts = {}) {
    const { limit = 20, offset = 0, keyword = null, schemaName = null } = opts
    const quotedTable = this.quoteTableWithSchema(tableName, schemaName)
    const quotedColumn = this.quoteIdentifier(columnName)
    // WHERE <col> IS NOT NULL 始终带上(对齐 Python:过滤空值);keyword 非空再 AND LIKE
    let sql = `SELECT DISTINCT ${quotedColumn} FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL`
    if (keyword) {
      const safeKeyword = String(keyword).replace(/'/g, "''")
      const likeCondition = this.buildLikeCondition(quotedColumn, `'%${safeKeyword}%'`)
      sql = `${sql} AND ${likeCondition}`
    }
    return `${sql} ORDER BY ${quotedColumn} LIMIT ${limit} OFFSET ${offset}`
  }

  getConnectionInfo(config, version) {
    return {
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.username,
      version,
      db_type: this.db_type,
    }
  }
}

/** 把端口安全转成整数(前端可能传字符串/空) */
export function toPort(port, fallback) {
  const n = Number.parseInt(String(port ?? '').trim(), 10)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

/**
 * 从 executeQuery 返回的 data 行(对象数组,key 为列名)中抽取第一列的非空值。
 * 对齐 Python 默认实现:每行取首个值,跳过 null。
 * @param {Array<Record<string, any>|any[]>} rows
 * @returns {any[]}
 */
export function extractFirstColumnValues(rows) {
  const out = []
  for (const row of rows || []) {
    let value
    if (Array.isArray(row)) {
      value = row.length ? row[0] : null
    } else if (row && typeof row === 'object') {
      const vals = Object.values(row)
      value = vals.length ? vals[0] : null
    } else {
      value = row
    }
    if (value !== null && value !== undefined) out.push(value)
  }
  return out
}
