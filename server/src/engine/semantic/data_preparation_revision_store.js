import { randomUUID } from "node:crypto";

export const DATA_PREPARATION_STATUSES = Object.freeze([
  "running",
  "completed",
  "partial",
  "failed",
]);

const STATUS_SET = new Set(DATA_PREPARATION_STATUSES);
const TERMINAL_STATUSES = new Set(["completed", "partial", "failed"]);

function storeError(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function clean(value, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function requireDatabase(db) {
  if (!(db?.query && db?.queryOne)) {
    throw storeError("数据准备版本缺少数据库上下文", "DATA_PREPARATION_DB_REQUIRED");
  }
  return db;
}

function requireProjectId(value) {
  const projectId = clean(value);
  if (!projectId) {
    throw storeError("数据准备版本缺少 project_id", "DATA_PREPARATION_PROJECT_REQUIRED");
  }
  return projectId;
}

function requireStatus(value) {
  const status = clean(value, 40).toLowerCase();
  if (!STATUS_SET.has(status)) {
    throw storeError(`数据准备状态不合法: ${status}`, "DATA_PREPARATION_STATUS_INVALID", { status });
  }
  return status;
}

function json(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function stringify(value, fallback) {
  try {
    return JSON.stringify(value == null ? fallback : value);
  } catch {
    throw storeError("数据准备版本包含无法序列化的 JSON", "DATA_PREPARATION_JSON_INVALID");
  }
}

export function dataPreparationRevisionRow(row) {
  if (!row) return null;
  const revision = Number(row.revision || 0);
  return {
    ...row,
    revision,
    version: revision,
    coverage_summary: json(row.coverage_summary_json, {}),
    failure_details: json(row.failure_details_json, null),
  };
}

export async function beginDataPreparationRevision(db, {
  projectId = null,
  project_id = null,
  coverageSummary = {},
  coverage_summary = undefined,
} = {}) {
  requireDatabase(db);
  const effectiveProjectId = requireProjectId(projectId ?? project_id);
  const id = randomUUID();
  const coverage = coverage_summary === undefined ? coverageSummary : coverage_summary;
  await db.query(
    `INSERT INTO project_data_preparation_revisions
       (id,project_id,revision,status,coverage_summary_json,failure_details_json,
        started_at,finished_at,created_at,updated_at)
     SELECT $1,$2,COALESCE(MAX(revision),0)+1,'running',$3,NULL,now(),NULL,now(),now()
       FROM project_data_preparation_revisions
      WHERE project_id=$2`,
    [id, effectiveProjectId, stringify(coverage, {})],
  );
  const stored = await db.queryOne(
    `SELECT * FROM project_data_preparation_revisions WHERE id=$1 LIMIT 1`,
    [id],
  );
  if (!stored) throw storeError("数据准备版本创建失败", "DATA_PREPARATION_CREATE_FAILED");
  return dataPreparationRevisionRow(stored);
}

function assertTransition(currentStatus, nextStatus) {
  if (currentStatus === nextStatus) return;
  if (currentStatus === "running" && TERMINAL_STATUSES.has(nextStatus)) return;
  throw storeError(
    `数据准备状态不能从 ${currentStatus} 转为 ${nextStatus}`,
    "DATA_PREPARATION_TRANSITION_INVALID",
    { current_status: currentStatus, next_status: nextStatus },
  );
}

export async function transitionDataPreparationRevision(db, revisionId, nextStatus, {
  coverageSummary = undefined,
  coverage_summary = undefined,
  failureDetails = undefined,
  failure_details = undefined,
} = {}) {
  requireDatabase(db);
  const id = clean(revisionId);
  if (!id) throw storeError("数据准备版本 id 不能为空", "DATA_PREPARATION_REVISION_REQUIRED");
  const next = requireStatus(nextStatus);
  const current = await db.queryOne(
    `SELECT * FROM project_data_preparation_revisions WHERE id=$1 LIMIT 1`,
    [id],
  );
  if (!current) throw storeError(`数据准备版本不存在: ${id}`, "DATA_PREPARATION_REVISION_NOT_FOUND");
  assertTransition(current.status, next);

  const coverage = coverage_summary === undefined ? coverageSummary : coverage_summary;
  const failures = failure_details === undefined ? failureDetails : failure_details;
  if (next === "failed" && failures == null && !current.failure_details_json) {
    throw storeError("failed 状态必须包含失败详情", "DATA_PREPARATION_FAILURE_DETAILS_REQUIRED");
  }
  await db.query(
    `UPDATE project_data_preparation_revisions
        SET status=$2,
            coverage_summary_json=CASE WHEN $3 IS NULL THEN coverage_summary_json ELSE $3 END,
            failure_details_json=CASE WHEN $4 IS NULL THEN failure_details_json ELSE $4 END,
            finished_at=CASE WHEN $5=1 THEN COALESCE(finished_at,now()) ELSE NULL END,
            updated_at=now()
      WHERE id=$1 AND status=$6`,
    [
      id,
      next,
      coverage === undefined ? null : stringify(coverage, {}),
      failures === undefined ? null : stringify(failures, null),
      TERMINAL_STATUSES.has(next) ? 1 : 0,
      current.status,
    ],
  );
  const stored = await db.queryOne(
    `SELECT * FROM project_data_preparation_revisions WHERE id=$1 LIMIT 1`,
    [id],
  );
  if (!stored || stored.status !== next) {
    throw storeError("数据准备状态已被其他任务修改", "DATA_PREPARATION_TRANSITION_CONFLICT");
  }
  return dataPreparationRevisionRow(stored);
}

export async function getDataPreparationRevision(db, revisionId) {
  requireDatabase(db);
  const id = clean(revisionId);
  if (!id) return null;
  return dataPreparationRevisionRow(await db.queryOne(
    `SELECT * FROM project_data_preparation_revisions WHERE id=$1 LIMIT 1`,
    [id],
  ));
}

export async function getLatestDataPreparationRevision(db, projectId) {
  requireDatabase(db);
  const effectiveProjectId = requireProjectId(projectId);
  return dataPreparationRevisionRow(await db.queryOne(
    `SELECT * FROM project_data_preparation_revisions
      WHERE project_id=$1
      ORDER BY revision DESC
      LIMIT 1`,
    [effectiveProjectId],
  ));
}

export async function getLatestCompletedDataPreparationRevision(db, projectId) {
  requireDatabase(db);
  const effectiveProjectId = requireProjectId(projectId);
  return dataPreparationRevisionRow(await db.queryOne(
    `SELECT * FROM project_data_preparation_revisions
      WHERE project_id=$1 AND status='completed'
      ORDER BY revision DESC
      LIMIT 1`,
    [effectiveProjectId],
  ));
}

export async function listDataPreparationRevisions(db, projectId, { limit = 50 } = {}) {
  requireDatabase(db);
  const effectiveProjectId = requireProjectId(projectId);
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 50));
  const rows = await db.query(
    `SELECT * FROM project_data_preparation_revisions
      WHERE project_id=$1
      ORDER BY revision DESC
      LIMIT $2`,
    [effectiveProjectId, safeLimit],
  );
  return rows.map(dataPreparationRevisionRow);
}

export default {
  DATA_PREPARATION_STATUSES,
  beginDataPreparationRevision,
  transitionDataPreparationRevision,
  getDataPreparationRevision,
  getLatestDataPreparationRevision,
  getLatestCompletedDataPreparationRevision,
  listDataPreparationRevisions,
};
