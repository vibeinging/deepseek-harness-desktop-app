// Metric-view structure validation and source-aware table reference canonicalization.

import { ValidationError } from '../core/exceptions.js';

const FIELD_TOKEN_PATTERN_G =
  /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PROJECTION_KINDS = new Set(['field', 'aggregate', 'expression']);

function build_canonical_table_ref(schemaName, tableName) {
  let schema = String(schemaName || '').trim();
  const name = String(tableName || '').trim();
  if (schema.toLowerCase() === 'default') schema = '';
  return schema ? `${schema}.${name}` : name;
}

function normalize_table_ref(text) {
  return String(text || '').trim().replace(/`/g, '').replace(/"/g, '');
}

function extract_bare_table_name(tableRef) {
  const normalized = normalize_table_ref(tableRef);
  return normalized ? normalized.split('.').pop() : '';
}

function canonical_ref_of(table) {
  return build_canonical_table_ref(table.schema_name, table.table_name);
}

/**
 * 读取数据源下所有表/列元数据，构建表引用解析索引。
 * 对齐 metric_view_canonicalizer.load_table_resolution_index（ctx 查库版）。
 */
async function load_table_resolution_index(ctx, source_id) {
  const businessDataSource = await ctx.queryOne(
    `SELECT id, source_type, source_id
       FROM business_data_sources
      WHERE id = $1 AND deleted_at IS NULL`,
    [source_id],
  );
  if (!businessDataSource) {
    throw new ValidationError('业务数据源不存在');
  }
  let connectionId = null;
  if (businessDataSource.source_type === 'database_connection') {
    connectionId = businessDataSource.source_id;
  } else if (businessDataSource.source_type === 'structured_data_source') {
    const structured = await ctx.queryOne(
      `SELECT database_connection_id
         FROM structured_data_sources
        WHERE id = $1 AND deleted_at IS NULL`,
      [businessDataSource.source_id],
    );
    connectionId = structured?.database_connection_id || null;
    if (!connectionId) {
      throw new ValidationError('结构化数据源缺少可用的数据库连接');
    }
  } else {
    throw new ValidationError('当前业务视图仅支持绑定数据库类型的数据源');
  }
  const tables = await ctx.query(
    `SELECT id, schema_name, table_name
       FROM table_metadata
      WHERE database_connection_id = $1 AND deleted_at IS NULL`,
    [connectionId],
  );

  const tableIds = tables.map((t) => t.id);
  let columnsByTable = new Map();
  if (tableIds.length) {
    const columns = await ctx.query(
      `SELECT table_id, column_name
         FROM column_metadata
        WHERE table_id::text = ANY($1::text[]) AND deleted_at IS NULL`,
      [tableIds],
    );
    for (const col of columns) {
      if (!col.column_name) continue;
      if (!columnsByTable.has(col.table_id)) columnsByTable.set(col.table_id, new Set());
      columnsByTable.get(col.table_id).add(String(col.column_name));
    }
  }

  const byCanonicalRef = new Map();
  const byBareName = new Map();
  for (const table of tables) {
    const canonical = {
      table_id: table.id,
      schema_name: table.schema_name,
      table_name: table.table_name,
      columns: columnsByTable.get(table.id) || new Set(),
    };
    byCanonicalRef.set(canonical_ref_of(canonical), canonical);
    const bareName = canonical.table_name;
    if (!byBareName.has(bareName)) byBareName.set(bareName, []);
    byBareName.get(bareName).push(canonical);
  }

  return { by_canonical_ref: byCanonicalRef, by_bare_name: byBareName };
}

function resolve_table_ref_strict(tableRef, index) {
  const normalized = normalize_table_ref(tableRef);
  if (!normalized) throw new ValidationError('查询表缺少 table_ref');

  const exact = index.by_canonical_ref.get(normalized);
  if (exact) return exact;

  const bareName = extract_bare_table_name(normalized);
  const bareMatches = index.by_bare_name.get(bareName) || [];
  if (bareMatches.length === 1) return bareMatches[0];
  if (bareMatches.length > 1) {
    const choices = bareMatches
      .map((item) => canonical_ref_of(item))
      .sort()
      .join('、');
    throw new ValidationError(
      `表引用 '${tableRef}' 不唯一，请改为 canonical table_ref。可选值：${choices}`,
    );
  }
  throw new ValidationError(`表引用 '${tableRef}' 在当前数据源中不存在或尚未同步`);
}

function validate_table_keys(metricDefinition) {
  const seen = new Set();
  (metricDefinition.tables || []).forEach((table, idx) => {
    const tableKey = String((table && table.table_key) || '').trim();
    const index = idx + 1;
    if (!tableKey) throw new ValidationError(`第 ${index} 个查询表缺少 table_key`);
    if (!SQL_IDENTIFIER_PATTERN.test(tableKey)) {
      throw new ValidationError(`table_key '${tableKey}' 不是合法标识符`);
    }
    if (seen.has(tableKey)) {
      throw new ValidationError(`table_key '${tableKey}' 重复，请保持唯一`);
    }
    seen.add(tableKey);
  });
}

function _validate_field_ref(field, tableIndex, context, requireColumn = true) {
  if (!field) return;
  const table = tableIndex[field.table_key];
  if (!table) {
    throw new ValidationError(`${context} 引用了未声明的 table_key '${field.table_key}'`);
  }
  if (requireColumn && !table.columns.has(field.column_name)) {
    throw new ValidationError(
      `${context} 引用了不存在的列 '${field.column_name}'，所属表: ${canonical_ref_of(table)}`,
    );
  }
}

function _validate_expression_template(expressionTemplate, tableIndex, context, requireColumn = true) {
  if (!expressionTemplate) return;
  let match;
  FIELD_TOKEN_PATTERN_G.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((match = FIELD_TOKEN_PATTERN_G.exec(expressionTemplate)) !== null) {
    _validate_field_ref(
      { table_key: match[1], column_name: match[2] },
      tableIndex,
      context,
      requireColumn,
    );
  }
}

function _validate_join_conditions(joinConditions, tableIndex, context, requireColumn = true) {
  for (const condition of joinConditions || []) {
    if (condition.kind === 'template') {
      _validate_expression_template(condition.expression_template, tableIndex, context, requireColumn);
      continue;
    }
    _validate_field_ref(condition.left, tableIndex, `${context} 左侧`, requireColumn);
    _validate_field_ref(condition.right, tableIndex, `${context} 右侧`, requireColumn);
  }
}

function _validate_fixed_predicates(predicates, tableIndex, requireColumn = true) {
  (predicates || []).forEach((predicate, idx) => {
    const context = `固定条件 #${idx + 1}`;
    if (predicate.kind === 'template') {
      _validate_expression_template(predicate.expression_template, tableIndex, context, requireColumn);
      return;
    }
    _validate_field_ref(predicate.field, tableIndex, context, requireColumn);
  });
}

function _validate_query_dimensions(dimensions, tableIndex, requireColumn = true) {
  (dimensions || []).forEach((dimension, idx) => {
    _validate_field_ref(dimension.field, tableIndex, `查询维度 #${idx + 1}`, requireColumn);
  });
}

function _validate_time_dimension(timeDimension, tableIndex, requireColumn = true) {
  if (timeDimension) {
    _validate_field_ref(timeDimension.field, tableIndex, '时间维度', requireColumn);
  }
}

function _validate_projections(projections, tableIndex, requireColumn = true) {
  (projections || []).forEach((projection, idx) => {
    const context = `投影列 #${idx + 1}`;
    const kind = String(projection?.kind || '').trim();
    if (!PROJECTION_KINDS.has(kind)) {
      throw new ValidationError(`${context} kind 必须是 field、aggregate 或 expression`);
    }
    if (kind === 'expression') {
      _validate_expression_template(projection.expression_template, tableIndex, context, requireColumn);
      return;
    }
    _validate_field_ref(projection.field, tableIndex, context, requireColumn);
  });
}

function _validate_group_by(groupByItems, tableIndex, requireColumn = true) {
  (groupByItems || []).forEach((item, idx) => {
    const context = `GROUP BY #${idx + 1}`;
    if (item.kind === 'expression') {
      _validate_expression_template(item.expression_template, tableIndex, context, requireColumn);
      return;
    }
    _validate_field_ref(item.field, tableIndex, context, requireColumn);
  });
}

function _validate_sort_spec(orderItems, tableIndex, requireColumn = true) {
  (orderItems || []).forEach((item, idx) => {
    const context = `排序规则 #${idx + 1}`;
    if (item.kind === 'expression') {
      _validate_expression_template(item.expression_template, tableIndex, context, requireColumn);
      return;
    }
    if (item.kind === 'field') {
      _validate_field_ref(item.field, tableIndex, context, requireColumn);
    }
  });
}

function _build_intra_table_index(metricDefinition) {
  const tableIndex = {};
  for (const table of metricDefinition.tables || []) {
    tableIndex[table.table_key] = {
      table_id: '',
      schema_name: null,
      table_name: table.table_ref,
      columns: new Set(),
    };
  }
  return tableIndex;
}

function validate_metric_view_references(metricDefinition) {
  validate_table_keys(metricDefinition);
  const tableIndex = _build_intra_table_index(metricDefinition);

  (metricDefinition.tables || []).forEach((table, idx) => {
    _validate_join_conditions(table.join_conditions, tableIndex, `JOIN 表 #${idx + 1}`, false);
  });
  _validate_fixed_predicates(metricDefinition.fixed_predicates, tableIndex, false);
  _validate_query_dimensions(metricDefinition.query_dimensions, tableIndex, false);
  _validate_time_dimension(metricDefinition.time_dimension, tableIndex, false);
  _validate_projections(metricDefinition.projections, tableIndex, false);
  _validate_group_by(metricDefinition.group_by, tableIndex, false);
  _validate_sort_spec(
    (metricDefinition.sort_spec && metricDefinition.sort_spec.order_by) || [],
    tableIndex,
    false,
  );
}

function validate_metric_view_against_source(metricDefinition, resolvedTables) {
  (metricDefinition.tables || []).forEach((table, idx) => {
    _validate_join_conditions(table.join_conditions, resolvedTables, `JOIN 表 #${idx + 1}`);
  });
  _validate_fixed_predicates(metricDefinition.fixed_predicates, resolvedTables);
  _validate_query_dimensions(metricDefinition.query_dimensions, resolvedTables);
  _validate_time_dimension(metricDefinition.time_dimension, resolvedTables);
  _validate_projections(metricDefinition.projections, resolvedTables);
  _validate_group_by(metricDefinition.group_by, resolvedTables);
  _validate_sort_spec((metricDefinition.sort_spec && metricDefinition.sort_spec.order_by) || [], resolvedTables);
}

/**
 * canonicalize_metric_view_definition —— 严格结构 + 表引用规范化。
 * 返回带规范化 tables 的新定义对象（普通对象，形状等价 model_dump）。
 */
export async function canonicalize_metric_view_definition(ctx, metricDefinition, { source_id, strict_source_resolution = true } = {}) {
  if (!metricDefinition.tables || metricDefinition.tables.length === 0) {
    throw new ValidationError('至少需要一张表');
  }
  validate_metric_view_references(metricDefinition);

  if (!source_id) {
    if (strict_source_resolution) {
      throw new ValidationError('指标视图必须绑定数据源，才能保存稳定的表引用');
    }
    return metricDefinition;
  }

  const tableResolutionIndex = await load_table_resolution_index(ctx, source_id);
  if (tableResolutionIndex.by_canonical_ref.size === 0) {
    throw new ValidationError('当前数据源尚未同步表结构，无法校验业务视图定义');
  }

  const resolvedTables = {};
  const canonicalTables = [];
  for (const table of metricDefinition.tables) {
    const resolved = resolve_table_ref_strict(table.table_ref, tableResolutionIndex);
    resolvedTables[table.table_key] = resolved;
    canonicalTables.push({
      table_key: table.table_key,
      table_ref: canonical_ref_of(resolved),
      join_type: table.join_type != null ? table.join_type : null,
      join_conditions: table.join_conditions || [],
    });
  }

  validate_metric_view_against_source(metricDefinition, resolvedTables);

  return { ...metricDefinition, tables: canonicalTables };
}
