// 迁移自 dsh_kernel/data_sources/datasource/profile.py
//
// 数据源 Profile 模型定义
// 提供:
// - Column: 列元数据
// - Profile: 表/数据源元数据
// - dump_profiles_desc: Profile 列表转描述文本
//
// 说明: Python 用 set[type] 表示列类型(如 {int}),Node 无 type 对象,
// 这里用类型名字符串集合(Set<string>,如 new Set(['int']))表示,
// 下游 data_profiler_tool 取 [...types][0] 当 data_type。

/**
 * 列元数据
 */
export class Column {
  /**
   * @param {string} name 列名
   * @param {string} description 列描述
   * @param {Set<string>|Array<string>} types 类型名集合(如 new Set(['int']))
   * @param {object} [opts]
   * @param {Set|Array|null} [opts.enumerated_values=null] 枚举值
   * @param {Array|null} [opts.sample_values=null] 样本值
   * @param {[any,any]|null} [opts.max_min=null] 最大/最小值
   */
  constructor(name, description, types, {
    enumerated_values = null,
    sample_values = null,
    max_min = null,
  } = {}) {
    this.name = name;
    this.description = description;
    this.types = types instanceof Set ? types : new Set(types || []);
    this.enumerated_values = enumerated_values;
    this.sample_values = sample_values;
    this.max_min = max_min;
  }

  /** 取一个代表性的值(优先枚举,其次样本)。都没有则抛错。 */
  sample_a_value() {
    if (this.enumerated_values && [...this.enumerated_values].length) {
      return [...this.enumerated_values][0];
    }
    if (this.sample_values && this.sample_values.length) {
      return this.sample_values[0];
    }
    throw new Error('Incomplete column information. Please provide enumerated_values or sample_values.  ');
  }

  /** 列的文本摘要(与 Python to_str 对齐) */
  to_str() {
    const typesStr = `{${[...this.types].join(', ')}}`;
    let summary = `Column \`${this.name}\`. All possible types: ${typesStr}`;
    if (this.enumerated_values && [...this.enumerated_values].length) {
      summary += `, All possible Values: {${[...this.enumerated_values].join(', ')}}`;
    } else if (this.sample_values && this.sample_values.length) {
      summary += `, Some Sampled Values: [${this.sample_values.join(', ')}]`;
    }
    if (this.max_min) {
      summary += `, Max value and Min value: (${this.max_min[0]}, ${this.max_min[1]})`;
    }
    if (this.description) {
      summary += `, Description: ${this.description}`;
    }
    return summary;
  }

  /** @alias to_str */
  toStr() { return this.to_str(); }
}

/**
 * 表/数据源元数据
 */
export class Profile {
  /**
   * @param {string} database 数据源名称
   * @param {string} name 表名
   * @param {string} description 描述
   * @param {[number,number]|null} size [行数, 列数]
   * @param {Array<Column>} columns 列列表
   * @param {Array<object>} [sample_rows=[]] 样本行
   * @param {boolean} [listable=false] 是否可整表列出
   * @param {object} [opts]
   * @param {'StructuredFile'|'UnstructuredFile'|'SQLDatabase'|'IntermediateData'} [opts.data_source_type='StructuredFile']
   * @param {string|null} [opts.schema_name=null]
   */
  constructor(database, name, description, size, columns, sample_rows = [], listable = false, {
    data_source_type = 'StructuredFile',
    schema_name = null,
  } = {}) {
    this.database = database;
    this.datasource_type = data_source_type;
    this.name = name;
    this.schema_name = schema_name;
    this.description = description;
    this.size = size;
    // column_map: name -> Column(保持插入顺序,Map 等价于 Python dict)
    this.column_map = new Map();
    for (const col of columns || []) {
      this.column_map.set(col.name, col);
    }
    this.sample_rows = sample_rows || [];
    this.listable = listable;
    // 向量召回时附加的相似度分数(可选)
    this.similarity = null;
  }

  /** 列列表(对应 @property columns) */
  get columns() {
    return [...this.column_map.values()];
  }

  /** 表的文本摘要(与 Python to_str 对齐) */
  to_str() {
    // 非结构化:简洁格式
    if (this.datasource_type === 'UnstructuredFile') {
      let summary = `  - 文档：\`${this.name}\``;
      if (this.size) summary += `，共 ${this.size[0]} 个片段`;
      if (this.description) summary += `，描述：${this.description}`;
      return summary;
    }

    // 结构化:详细格式
    const displayName = (this.schema_name && this.schema_name !== 'default')
      ? `${this.schema_name}.${this.name}`
      : this.name;
    let summary = `#### 表：\`${displayName}\``;
    if (this.size) summary += `，${this.size[0]} 行，${this.size[1]} 列`;
    if (this.description) summary += `，描述：${this.description}`;

    if (Array.isArray(this.size) && this.size[0] === 0) {
      const fields = this.columns.map((c) => c.name);
      summary += `（空表，字段：[${fields.join(', ')}]）`;
      return summary;
    }
    if (this.listable) {
      const lines = this.sample_rows.map((row, i) => `  - 行 ${i}: ${JSON.stringify(row)}`);
      summary += `\n所有值：\n${lines.join('\n')}`;
      return summary;
    }

    if (this.sample_rows && this.sample_rows.length) {
      summary += `\n示例数据：${JSON.stringify(this.sample_rows)}\n`;
    }

    summary += '\n字段：';
    for (const column of this.column_map.values()) {
      summary += `\n  -${column.to_str()}`;
    }
    return summary;
  }

  /** @alias to_str */
  toStr() { return this.to_str(); }

  edit_description(description) {
    this.description = description;
  }

  edit_column_description(column_name, description) {
    const col = this.column_map.get(column_name);
    if (col) col.description = description;
  }
}

/**
 * 将 Profile 列表转换为描述文本(与 Python dump_profiles_desc 对齐)。
 * @param {Array<Profile>} profiles
 * @returns {string}
 */
export function dump_profiles_desc(profiles) {
  let res = '';
  /** @type {Map<string, Map<string, Profile>>} */
  const profilesDict = new Map();

  for (const profile of profiles) {
    const dbName = profile.database;
    const tableKey = (profile.schema_name && profile.schema_name !== 'default')
      ? `${profile.schema_name}.${profile.name}`
      : profile.name;
    if (!profilesDict.has(dbName)) profilesDict.set(dbName, new Map());
    profilesDict.get(dbName).set(tableKey, profile);
  }

  for (const [db, tables] of profilesDict) {
    if (!tables.size) continue;
    const dbType = [...tables.values()][0].datasource_type;

    if (dbType === 'UnstructuredFile') {
      res += `### 数据源名称：\`${db}\`，类型：知识库\n`;
      res += '包含以下文档：\n';
    } else {
      res += `### 数据源名称：\`${db}\`，类型：${dbType}\n`;
      res += '包含以下表：\n';
    }

    for (const profile of tables.values()) {
      res += `${profile.to_str()}\n`;
    }
  }

  return res;
}

// camelCase 别名
export const dumpProfilesDesc = dump_profiles_desc;

export default { Column, Profile, dump_profiles_desc };
