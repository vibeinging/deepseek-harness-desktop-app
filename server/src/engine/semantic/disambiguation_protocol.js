function toolHistory(agentContext) {
  const history = agentContext?.data?.tool_history;
  return Array.isArray(history) ? history : [];
}

/**
 * Build the latest value-disambiguation block consumed by the conversation UI.
 */
export function build_disambiguation_context(agentContext) {
  let last = null;
  const entries = toolHistory(agentContext);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] || {};
    if (entry.tool !== "align_value" || !entry.success) continue;
    const result = entry.result || {};
    if (result.table_name && result.column_name) {
      last = result;
      break;
    }
  }
  if (!last) return null;

  const candidates = [];
  const memoryValues = [];
  for (const item of last.values || []) {
    if (!item || typeof item !== "object" || Array.isArray(item) || !item.value) continue;
    if (item.source === "memory") {
      memoryValues.push({
        value: item.value,
        memory_id: item.memory_id ?? null,
        hit_count: item.memory_meta?.hit_count ?? null,
      });
    } else if (!candidates.includes(item.value)) {
      candidates.push(item.value);
    }
  }

  return {
    source_table: last.table_name,
    source_column: last.column_name,
    keyword: last.keyword || "",
    candidates,
    memory_values: memoryValues,
  };
}
