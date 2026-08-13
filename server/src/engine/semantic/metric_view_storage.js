// Storage conversion helpers shared by the metric-view definition and CRUD modules.

const METRIC_VIEW_JSON_FIELDS = [
  'aliases', 'tables', 'fixed_predicates', 'query_dimensions',
  'time_dimension', 'projections', 'group_by', 'sort_spec',
];

export function normalizeMetricViewRow(row = {}) {
  const normalized = { ...row };
  for (const field of METRIC_VIEW_JSON_FIELDS) {
    const value = normalized[field];
    if (typeof value !== 'string') continue;
    try { normalized[field] = JSON.parse(value); } catch { /* 草稿可能暂时不是合法 JSON，保留原值供校验报错 */ }
  }
  return normalized;
}

/** JSON 字段落库：null/undefined → null，对象/数组 → JSON 字符串（pg 驱动也接受对象，这里统一字符串化）。 */
export function _json_or_null(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** 稳定排序键的 JSON 序列化（对齐 Python json.dumps(sort_keys=True, ensure_ascii=False)）。 */
export function _stable_json(value) {
  const sortKeys = (input) => {
    if (Array.isArray(input)) return input.map(sortKeys);
    if (input && typeof input === 'object') {
      const out = {};
      for (const key of Object.keys(input).sort()) out[key] = sortKeys(input[key]);
      return out;
    }
    return input;
  };
  return JSON.stringify(sortKeys(value));
}
