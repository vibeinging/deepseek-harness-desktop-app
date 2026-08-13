export const DATA_PREPARATION_MODES = Object.freeze({
  NONE: "none",
  SCHEMA: "schema",
  FULL: "full",
});

/**
 * 数据导入与在线查询使用不同生命周期。
 *
 * - none: 只导入，不启动后台准备；适合 eval、批量迁移和由外部任务统一调度。
 * - schema: 采样、枚举和向量准备，不调用 LLM 生成描述；是交互式导入默认值。
 * - full: 明确的离线准备任务，才允许生成表/字段描述。
 */
export function resolveDataPreparationPolicy(input = {}) {
  const requested = String(
    input.preparation_mode ?? input.preparationMode ?? input.mode ?? "",
  ).trim().toLowerCase();
  const legacyEnrich = input.enrich;
  const mode = requested === DATA_PREPARATION_MODES.NONE
    ? DATA_PREPARATION_MODES.NONE
    : requested === DATA_PREPARATION_MODES.FULL
      ? DATA_PREPARATION_MODES.FULL
      : requested === DATA_PREPARATION_MODES.SCHEMA
        ? DATA_PREPARATION_MODES.SCHEMA
        : legacyEnrich === false
          ? DATA_PREPARATION_MODES.NONE
          : legacyEnrich === true
            ? DATA_PREPARATION_MODES.FULL
            : DATA_PREPARATION_MODES.SCHEMA;

  return Object.freeze({
    mode,
    enabled: mode !== DATA_PREPARATION_MODES.NONE,
    descriptions: mode === DATA_PREPARATION_MODES.FULL,
    phase: "offline_data_preparation",
  });
}

export default resolveDataPreparationPolicy;
