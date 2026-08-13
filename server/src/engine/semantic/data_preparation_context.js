import { getLatestDataPreparationRevision } from "./data_preparation_revision_store.js";

function clean(value) {
  return String(value ?? "").trim();
}

const CONTEXT_MODE_BY_STATUS = Object.freeze({
  running: "last_run_running",
  completed: "last_run_completed",
  partial: "last_run_partial",
  failed: "last_run_failed",
});

/**
 * Return observational context about the latest standalone data-preparation run.
 *
 * This is deliberately not a query gate. Callers read whatever data and metadata
 * are currently available, whether preparation has never run, is running, or failed.
 */
export async function resolveProjectDataPreparationContext(db, projectId, {
  getLatestRevisionFn = getLatestDataPreparationRevision,
} = {}) {
  const effectiveProjectId = clean(projectId);
  if (!effectiveProjectId) {
    const error = new Error("缺少 project_id，无法读取数据准备状态");
    error.code = "DATA_PREPARATION_PROJECT_REQUIRED";
    throw error;
  }
  const latest = await getLatestRevisionFn(db, effectiveProjectId);
  if (!latest) {
    return Object.freeze({
      mode: "no_preparation_run",
      project_id: effectiveProjectId,
      revision_id: null,
      revision: null,
      status: "not_run",
      enhancement_level: "raw",
    });
  }

  const status = clean(latest.status).toLowerCase() || "unknown";
  const enhancementLevel = status === "completed"
    ? "complete"
    : (status === "partial" ? "partial" : "raw_or_partial");
  return Object.freeze({
    mode: CONTEXT_MODE_BY_STATUS[status] || "last_run_unknown",
    project_id: effectiveProjectId,
    revision_id: latest.id,
    revision: latest.revision,
    status,
    enhancement_level: enhancementLevel,
    coverage_summary: latest.coverage_summary,
    failure_details: latest.failure_details,
  });
}

export default resolveProjectDataPreparationContext;
