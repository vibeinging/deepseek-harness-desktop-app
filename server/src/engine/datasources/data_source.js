// 迁移自 dsh_kernel/data_sources/datasource/data_source.py
//
// 统一数据源抽象接口
// 定义所有数据源的通用接口和行为。

/**
 * 统一的数据源查询结果(对应 Python @dataclass QueryResult)
 */
export class QueryResult {
  /**
   * @param {object} opts
   * @param {boolean} opts.success
   * @param {Array<object>} opts.data
   * @param {Array<string>} opts.columns
   * @param {number} opts.row_count
   * @param {number|null} [opts.total_count=null]
   * @param {string} [opts.message='']
   * @param {string|null} [opts.query=null]
   * @param {object|null} [opts.evidence=null]
   */
  constructor({
    success,
    data,
    columns,
    row_count,
    total_count = null,
    message = '',
    query = null,
    evidence = null,
  }) {
    this.success = success;
    this.data = data;
    this.columns = columns;
    this.row_count = row_count;
    this.total_count = total_count;
    this.message = message;
    this.query = query;
    this.evidence = evidence;
  }

  /**
   * 成功结果快捷构造(对应 classmethod ok)
   * @param {Array<object>} data
   * @param {Array<string>} columns
   * @param {number|null} [total_count=null]
   * @param {string} [message='']
   * @returns {QueryResult}
   */
  static ok(data, columns, total_count = null, message = '') {
    return new QueryResult({
      success: true,
      data,
      columns,
      row_count: data.length,
      total_count,
      message,
    });
  }

  /**
   * 错误结果快捷构造(对应 classmethod error)
   * @param {string} message
   * @param {string|null} [query=null]
   * @returns {QueryResult}
   */
  static error(message, query = null) {
    return new QueryResult({
      success: false,
      data: [],
      columns: [],
      row_count: 0,
      total_count: 0,
      message,
      query,
    });
  }

  /** 向后兼容:转为字典(对应 to_dict) */
  to_dict() {
    return {
      success: this.success,
      data: this.data,
      columns: this.columns,
      row_count: this.row_count,
      total_count: this.total_count,
      message: this.message,
      query: this.query,
      evidence: this.evidence,
    };
  }

  /** @alias to_dict */
  toDict() { return this.to_dict(); }
}

/**
 * 统一数据源抽象接口(对应 Python ABC DataSource)
 */
export class DataSource {
  /**
   * @param {string} id
   * @param {string} business_id
   * @param {string} project_id
   * @param {string} source_type
   */
  constructor(id, business_id, project_id, source_type) {
    this.id = id;
    this.business_id = business_id;
    this.project_id = project_id;
    this.source_type = source_type;
    this.datasource_name = null; // 数据源名称
    this.description = null; // 数据源描述
  }

  /**
   * 获取数据源的 Profile 信息(子类必须实现,对应 @abstractmethod profile)
   * @param {string|null} [user_message=null]
   * @returns {Promise<Array<import('./profile.js').Profile>>}
   */
  async profile(user_message = null) {
    throw new Error(`${this.constructor.name}.profile() 未实现`);
  }

  /**
   * 对数据源进行查询(子类必须实现,对应 @abstractmethod query)
   * @param {any} query
   * @param {object} [kwargs]
   * @returns {Promise<QueryResult>}
   */
  async query(query, kwargs = {}) {
    throw new Error(`${this.constructor.name}.query() 未实现`);
  }

  toString() {
    return `<${this.constructor.name} id=${this.id} type=${this.source_type} business=${this.business_id} project=${this.project_id}>`;
  }
}

export default { QueryResult, DataSource };
