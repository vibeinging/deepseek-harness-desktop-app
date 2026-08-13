// Metric-view legacy payload upgrade and stable definition conversion.

import { normalizeMetricViewRow } from './metric_view_storage.js';

const _ALLOWED_PREDICATE_OPS = new Set(
  [
    // FixedPredicateSpec.operator
    '=', '!=', '>', '>=', '<', '<=', 'like', 'in', 'between', 'is_null', 'is_not_null',
    // QueryDimensionSpec.op
    '=', '>', '>=', '<', '<=', 'in', 'between',
  ].map((op) => String(op).toLowerCase()),
);

/** 把 SQL 操作符规范为小写（LLM/历史输入可能大写，严格枚举为小写）。 */
export function _normalize_sql_op(op) {
  if (typeof op !== 'string') return op;
  const lower = op.trim().toLowerCase();
  if (_ALLOWED_PREDICATE_OPS.has(lower)) return lower;
  return op;
}

/** 对一组 dict 中指定 key（operator/op）做小写归一化，返回新数组不变更原对象。 */
export function _normalize_op_case_in_list(items, key) {
  if (!items) return items;
  const newItems = [];
  for (const item of items) {
    if (item && typeof item === 'object' && !Array.isArray(item) && item[key] != null) {
      const normalized = { ...item };
      normalized[key] = _normalize_sql_op(item[key]);
      newItems.push(normalized);
    } else {
      newItems.push(item);
    }
  }
  return newItems;
}

// ===========================================================================
//  view_metric_definition.py 的 Node 端口
// ===========================================================================

const SQL_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LEGACY_JOIN_PATTERN =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|>|>=|<|<=)\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*$/;
const LEGACY_QUALIFIED_FIELD_PATTERN =
  /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)(?![A-Za-z0-9_])/g;
const LEGACY_RAW_FIELD_PROJECTION_PATTERN =
  /^\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s+AS\s+(.+?)\s*$/i;
const LEGACY_AGG_PROJECTION_PATTERN =
  /^\s*(SUM|AVG|MAX|MIN|COUNT)\(\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\)\s+AS\s+(.+?)\s*$/i;
const LEGACY_COUNT_DISTINCT_PROJECTION_PATTERN =
  /^\s*COUNT\s*\(\s*DISTINCT\s+([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\)\s+AS\s+(.+?)\s*$/i;
const LEGACY_ROUND_PROJECTION_PATTERN =
  /^\s*ROUND\(\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*,\s*(\d+)\s*\)\s+AS\s+(.+?)\s*$/i;

function _sanitize_identifier(text, fallback) {
  let normalized = String(text || '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  if (!normalized) normalized = fallback;
  const first = normalized[0];
  if (!/[A-Za-z]/.test(first) && first !== '_') {
    normalized = `t_${normalized}`;
  }
  return normalized;
}

function _generate_table_key(table_ref, existing_keys, preferred = null, index = 0) {
  let candidate;
  if (preferred) {
    candidate = _sanitize_identifier(preferred, `t_${index}`);
  } else if (index === 0) {
    candidate = 'main';
  } else {
    const tableName = String(table_ref || '').split('.').pop();
    candidate = _sanitize_identifier(tableName, `join_${index}`);
  }

  const base = candidate;
  let suffix = 1;
  while (existing_keys.has(candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  existing_keys.add(candidate);
  return candidate;
}

function _build_legacy_reference_map(tables) {
  const referenceMap = {};
  for (const table of tables) {
    const tableKey = table.table_key;
    referenceMap[tableKey] = tableKey;
    referenceMap[String(table.table_ref || '')] = tableKey;
    const alias = table.alias;
    if (alias) referenceMap[String(alias)] = tableKey;
  }
  return referenceMap;
}

function _parse_legacy_field_string(fieldValue, referenceMap) {
  if (!fieldValue) return null;
  const text = String(fieldValue).trim();
  if (!text) return null;
  const dotIndex = text.indexOf('.');
  if (dotIndex <= 0) return null;
  const prefix = text.slice(0, dotIndex);
  const columnName = text.slice(dotIndex + 1);
  const tableKey = referenceMap[prefix];
  if (!tableKey || !columnName) return null;
  return { table_key: tableKey, column_name: columnName };
}

function _convert_legacy_expression_to_template(expression, referenceMap) {
  return String(expression || '').replace(
    LEGACY_QUALIFIED_FIELD_PATTERN,
    (whole, prefix, columnName) => {
      const tableKey = referenceMap[prefix];
      if (!tableKey) return whole;
      return `{{${tableKey}.${columnName}}}`;
    },
  );
}

function _upgrade_legacy_tables(legacyTables) {
  const existingKeys = new Set();
  const normalizedTables = [];

  legacyTables.forEach((table, index) => {
    const tableRef = String((table && table.table_ref) || '').trim();
    const preferred = (table && (table.table_key || table.key || table.alias)) || null;
    const tableKey = _generate_table_key(tableRef, existingKeys, preferred, index);
    normalizedTables.push({
      table_key: tableKey,
      table_ref: tableRef,
      join_type: table && table.join_type != null ? table.join_type : null,
      alias: table && table.alias != null ? table.alias : null,
      join_condition: table && table.join_condition != null ? table.join_condition : null,
    });
  });

  const referenceMap = _build_legacy_reference_map(normalizedTables);

  const upgradedTables = [];
  normalizedTables.forEach((table, index) => {
    const joinConditions = [];
    if (index > 0) {
      const rawJoinCondition = String(table.join_condition || '').trim();
      if (rawJoinCondition) {
        const matched = LEGACY_JOIN_PATTERN.exec(rawJoinCondition);
        if (matched) {
          const [, leftPrefix, leftColumn, operator, rightPrefix, rightColumn] = matched;
          const leftTableKey = referenceMap[leftPrefix];
          const rightTableKey = referenceMap[rightPrefix];
          if (leftTableKey && rightTableKey) {
            joinConditions.push({
              kind: 'field_compare',
              left: { table_key: leftTableKey, column_name: leftColumn },
              operator,
              right: { table_key: rightTableKey, column_name: rightColumn },
            });
          } else {
            joinConditions.push({
              kind: 'template',
              expression_template: _convert_legacy_expression_to_template(rawJoinCondition, referenceMap),
            });
          }
        } else {
          joinConditions.push({
            kind: 'template',
            expression_template: _convert_legacy_expression_to_template(rawJoinCondition, referenceMap),
          });
        }
      }
    }

    upgradedTables.push({
      table_key: table.table_key,
      table_ref: table.table_ref,
      join_type: table.join_type != null ? table.join_type : null,
      join_conditions: joinConditions,
    });
  });

  return upgradedTables;
}

function _upgrade_legacy_query_dimension(dim, referenceMap) {
  const field = _parse_legacy_field_string(dim.column, referenceMap);
  if (!field) {
    throw new Error(`cannot upgrade query dimension field: ${dim.column}`);
  }
  return {
    name: dim.name,
    field,
    op: dim.op,
    param_type: dim.param_type,
    required: dim.required != null ? dim.required : true,
    allowed_values: dim.allowed_values || [],
  };
}

function _upgrade_legacy_time_dimension(timeDimension, referenceMap) {
  if (!timeDimension) return null;
  const field = _parse_legacy_field_string(timeDimension.column, referenceMap);
  if (!field) {
    throw new Error(`cannot upgrade time dimension field: ${timeDimension.column}`);
  }
  return {
    field,
    op: timeDimension.op || 'between',
    extract_type: timeDimension.extract_type || 'day',
    required: timeDimension.required != null ? timeDimension.required : true,
    output_format: timeDimension.output_format || 'YYYY-MM-DD',
  };
}

function _upgrade_legacy_fixed_predicate(predicate, referenceMap) {
  const text = String(predicate || '').trim();
  if (!text) return { kind: 'template', expression_template: '' };

  let m = /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s+(IS NULL|IS NOT NULL)$/i.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(m[1], referenceMap);
    if (field) {
      return {
        kind: 'null_check',
        field,
        operator: m[2].toUpperCase() === 'IS NULL' ? 'is_null' : 'is_not_null',
      };
    }
  }

  m = /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s+BETWEEN\s+(.+?)\s+AND\s+(.+)$/i.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(m[1], referenceMap);
    if (field) {
      return {
        kind: 'range',
        field,
        operator: 'between',
        start: m[2].trim().replace(/^'|'$/g, ''),
        end: m[3].trim().replace(/^'|'$/g, ''),
      };
    }
  }

  m = /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s+IN\s*\((.+)\)$/i.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(m[1], referenceMap);
    if (field) {
      const values = m[2]
        .split(',')
        .map((item) => item.trim().replace(/^'|'$/g, ''))
        .filter((item) => item);
      return { kind: 'set', field, operator: 'in', values };
    }
  }

  m = /^([A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*)\s*(=|!=|>|>=|<|<=|LIKE)\s*(.+)$/i.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(m[1], referenceMap);
    if (field) {
      return {
        kind: 'comparison',
        field,
        operator: m[2].toLowerCase(),
        value: m[3].trim().replace(/^'|'$/g, ''),
      };
    }
  }

  return {
    kind: 'template',
    expression_template: _convert_legacy_expression_to_template(text, referenceMap),
  };
}

function _upgrade_legacy_projection(projection, referenceMap, index) {
  const text = String(projection || '').trim();

  let m = LEGACY_RAW_FIELD_PROJECTION_PATTERN.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(`${m[1]}.${m[2]}`, referenceMap);
    if (field) {
      return { projection_key: `projection_${index}`, kind: 'field', field, alias: m[3].trim() };
    }
  }

  m = LEGACY_ROUND_PROJECTION_PATTERN.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(`${m[1]}.${m[2]}`, referenceMap);
    if (field) {
      return {
        projection_key: `projection_${index}`,
        kind: 'aggregate',
        field,
        function: 'round',
        precision: parseInt(m[3], 10),
        alias: m[4].trim(),
      };
    }
  }

  m = LEGACY_COUNT_DISTINCT_PROJECTION_PATTERN.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(`${m[1]}.${m[2]}`, referenceMap);
    if (field) {
      return {
        projection_key: `projection_${index}`,
        kind: 'aggregate',
        field,
        function: 'count_distinct',
        alias: m[3].trim(),
      };
    }
  }

  m = LEGACY_AGG_PROJECTION_PATTERN.exec(text);
  if (m) {
    const field = _parse_legacy_field_string(`${m[2]}.${m[3]}`, referenceMap);
    if (field) {
      return {
        projection_key: `projection_${index}`,
        kind: 'aggregate',
        field,
        function: m[1].toLowerCase(),
        alias: m[4].trim(),
      };
    }
  }

  return {
    projection_key: `projection_${index}`,
    kind: 'expression',
    expression_template: _convert_legacy_expression_to_template(text, referenceMap),
  };
}

function _upgrade_legacy_group_by_item(item, referenceMap) {
  const field = _parse_legacy_field_string(item, referenceMap);
  if (field) return { kind: 'field', field };
  return {
    kind: 'expression',
    expression_template: _convert_legacy_expression_to_template(String(item), referenceMap),
  };
}

function _upgrade_legacy_sort_item(item, referenceMap) {
  const text = String(item || '').trim();
  const matched = /^(.*?)\s+(ASC|DESC)$/i.exec(text);
  let direction = 'ASC';
  let target = text;
  if (matched) {
    target = matched[1].trim();
    direction = matched[2].toUpperCase();
  }
  const field = _parse_legacy_field_string(target, referenceMap);
  if (field) return { kind: 'field', field, direction };
  return {
    kind: 'expression',
    direction,
    expression_template: _convert_legacy_expression_to_template(target, referenceMap),
  };
}

function _is_plain_object(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function is_legacy_metric_view_payload(payload) {
  const tables = (payload && payload.tables) || [];
  if (!tables.length) return false;
  if (tables.some((table) => _is_plain_object(table) && !('table_key' in table))) return true;
  if (((payload.fixed_predicates) || []).some((item) => typeof item === 'string')) return true;
  if (((payload.projections) || []).some((item) => typeof item === 'string')) return true;
  if (((payload.group_by) || []).some((item) => typeof item === 'string')) return true;
  const sortSpec = payload.sort_spec || {};
  if (((sortSpec.order_by) || []).some((item) => typeof item === 'string')) return true;
  const queryDimensions = payload.query_dimensions || [];
  if (queryDimensions.some((item) => _is_plain_object(item) && !('field' in item))) return true;
  const timeDimension = payload.time_dimension;
  if (_is_plain_object(timeDimension) && !('field' in timeDimension) && 'column' in timeDimension) return true;
  return false;
}

/**
 * upgrade_metric_view_payload —— 把旧形态（alias/字符串投影等）升级为新 8 元组结构。
 * 与 view_metric_definition.py 同名同行为。
 */
export function upgrade_metric_view_payload(payload) {
  if (!payload || !is_legacy_metric_view_payload(payload)) return payload;

  const legacyTables = payload.tables || [];
  const upgradedTables = _upgrade_legacy_tables(legacyTables);
  const referenceMap = {};
  for (const table of upgradedTables) referenceMap[table.table_key] = table.table_key;
  for (const legacyTable of legacyTables) {
    if (_is_plain_object(legacyTable)) {
      const tableRef = String(legacyTable.table_ref || '').trim();
      const alias = String(legacyTable.alias || '').trim();
      const upgradedTable = upgradedTables.find((item) => item.table_ref === tableRef);
      if (upgradedTable) {
        referenceMap[tableRef] = upgradedTable.table_key;
        if (alias) referenceMap[alias] = upgradedTable.table_key;
      }
    }
  }

  const upgradedQueryDimensions = (payload.query_dimensions || []).map((item) =>
    _upgrade_legacy_query_dimension(item, referenceMap),
  );
  const upgradedTimeDimension = _upgrade_legacy_time_dimension(payload.time_dimension, referenceMap);
  const upgradedFixedPredicates = (payload.fixed_predicates || []).map((item) =>
    _upgrade_legacy_fixed_predicate(item, referenceMap),
  );
  const upgradedProjections = (payload.projections || []).map((item, idx) =>
    _upgrade_legacy_projection(item, referenceMap, idx + 1),
  );
  const upgradedGroupBy = (payload.group_by || []).map((item) =>
    _upgrade_legacy_group_by_item(item, referenceMap),
  );

  const sortSpec = payload.sort_spec || {};
  const upgradedSortSpec = {
    order_by: (sortSpec.order_by || []).map((item) => _upgrade_legacy_sort_item(item, referenceMap)),
    limit_default: sortSpec.limit_default != null ? sortSpec.limit_default : 100,
  };

  return {
    ...payload,
    tables: upgradedTables,
    fixed_predicates: upgradedFixedPredicates,
    query_dimensions: upgradedQueryDimensions,
    time_dimension: upgradedTimeDimension,
    projections: upgradedProjections,
    group_by: upgradedGroupBy,
    sort_spec: upgradedSortSpec,
  };
}

/**
 * to_metric_view_definition —— 把一行 metric_view_definition 记录归一化为可用的定义对象。
 * 桌面版无 pydantic 校验：直接返回 upgrade 后的普通对象（形状与 Python model_dump 等价）。
 * 与 view_metric_definition.py 同名。
 */
export function to_metric_view_definition(row) {
  const normalizedRow = normalizeMetricViewRow(row);
  const businessSourceId = normalizedRow.business_source_id || normalizedRow.source_id;
  const payload = upgrade_metric_view_payload({
    metric_id: normalizedRow.id,
    name: normalizedRow.name,
    descriptions: normalizedRow.description ? [normalizedRow.description] : [],
    aliases: normalizedRow.aliases || [],
    source_id: businessSourceId,
    business_source_id: businessSourceId,
    connection_id: normalizedRow.connection_id != null ? normalizedRow.connection_id : null,
    tables: normalizedRow.tables,
    fixed_predicates: normalizedRow.fixed_predicates || [],
    query_dimensions: normalizedRow.query_dimensions || [],
    time_dimension: normalizedRow.time_dimension,
    projections: normalizedRow.projections,
    group_by: normalizedRow.group_by || [],
    sort_spec: normalizedRow.sort_spec || { order_by: [], limit_default: 100 },
  });
  return payload;
}
