import { lstat, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import { dataPath } from "../../config/paths.js";
import { cleanupExpiredRunFacts } from "./run_fact_store.js";
import { agentRunWorkspacePaths } from "../runner/run_workspace.js";

const DEFAULT_MAX_RUN_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024 * 1024;

function positiveBytes(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

export function runStoragePolicy(overrides = {}) {
  return {
    max_run_bytes: positiveBytes(overrides.max_run_bytes ?? process.env.DSH_AGENT_RUN_MAX_BYTES, DEFAULT_MAX_RUN_BYTES),
    max_total_bytes: positiveBytes(overrides.max_total_bytes ?? process.env.DSH_AGENT_RUNS_MAX_BYTES, DEFAULT_MAX_TOTAL_BYTES),
  };
}

export async function measureDirectoryBytes(path) {
  const root = resolve(path);
  let bytes = 0;
  let files = 0;
  let directories = 0;
  let symlinks = 0;
  const visit = async (entryPath) => {
    const info = await lstat(entryPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return;
    if (info.isSymbolicLink()) {
      symlinks += 1;
      return;
    }
    if (info.isDirectory()) {
      directories += 1;
      for (const name of await readdir(entryPath)) await visit(resolve(entryPath, name));
      return;
    }
    if (info.isFile()) {
      files += 1;
      bytes += Number(info.size || 0);
    }
  };
  await visit(root);
  return { path: root, bytes, files, directories, symlinks };
}

export async function cleanupFailedRunTemporaryFiles(runId, { runsRoot = dataPath("runs") } = {}) {
  const paths = agentRunWorkspacePaths(runId, { runsRoot });
  const runRoot = paths.root;
  const tmp = paths.tmp;
  if (!tmp.startsWith(`${runRoot}/`)) throw new Error("运行临时目录不安全");
  const before = await measureDirectoryBytes(tmp);
  const names = await readdir(tmp).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  for (const name of names) await rm(resolve(tmp, name), { recursive: true, force: true });
  return { run_id: runId, removed_bytes: before.bytes, removed_entries: names.length, path: tmp };
}

export async function enforceRunStoragePolicy(ctx, {
  now = new Date().toISOString(),
  limits = {},
  cleanup = cleanupExpiredRunFacts,
  runIds = null,
} = {}) {
  const policy = runStoragePolicy(limits);
  const scopedRunIds = [...new Set((Array.isArray(runIds) ? runIds : []).map(String).filter(Boolean))];
  const scope = scopedRunIds.length
    ? `AND r.id IN (${scopedRunIds.map((_, index) => `$${index + 1}`).join(",")})`
    : "";
  const rows = await ctx.query(
    `SELECT r.id, r.status, r.workspace_path, r.created_at, r.archived_at,
            (SELECT COUNT(*) FROM agent_evidence_bundles e
              WHERE e.run_id=r.id AND e.deleted_at IS NULL) AS evidence_count
      FROM agent_runs r
      WHERE r.deleted_at IS NULL
        ${scope}
      ORDER BY COALESCE(r.created_at, r.updated_at) ASC`,
    scopedRunIds,
  );
  const tempCleanup = [];
  const usage = [];
  for (const row of rows) {
    if (String(row.status) === "failed") {
      const cleared = await cleanupFailedRunTemporaryFiles(row.id).catch((error) => ({
        run_id: row.id,
        error: error?.code || error?.message,
        removed_bytes: 0,
      }));
      tempCleanup.push(cleared);
    }
    const root = row.workspace_path || resolve(dataPath("runs"), row.id);
    const measured = await measureDirectoryBytes(root).catch(() => ({ path: root, bytes: 0, files: 0, directories: 0, symlinks: 0 }));
    usage.push({
      ...row,
      ...measured,
      evidence_count: Number(row.evidence_count || 0),
      protected: Boolean(row.archived_at) || Number(row.evidence_count || 0) > 0,
    });
  }
  let totalBytes = usage.reduce((sum, item) => sum + item.bytes, 0);
  const scheduled = [];
  const terminal = new Set(["completed", "failed", "expired"]);
  const candidates = usage.filter((item) => terminal.has(String(item.status)) && !item.protected);
  for (const item of candidates) {
    const overRun = item.bytes > policy.max_run_bytes;
    const overTotal = totalBytes > policy.max_total_bytes;
    if (!(overRun || overTotal)) continue;
    await ctx.query("UPDATE agent_runs SET retention_until=$2, updated_at=$2 WHERE id=$1", [item.id, now]);
    scheduled.push({ run_id: item.id, bytes: item.bytes, reason: overRun ? "run_limit" : "total_limit" });
    totalBytes -= item.bytes;
  }
  const retention = scheduled.length ? await cleanup(ctx, { now, runIds: scheduled.map((item) => item.run_id) }) : null;
  return {
    version: "agent_run_storage_policy.v1",
    policy,
    measured_total_bytes: usage.reduce((sum, item) => sum + item.bytes, 0),
    remaining_total_bytes: Math.max(0, totalBytes),
    usage,
    temporary_cleanup: tempCleanup,
    scheduled_cleanup: scheduled,
    retention,
  };
}

export default {
  cleanupFailedRunTemporaryFiles,
  enforceRunStoragePolicy,
  measureDirectoryBytes,
  runStoragePolicy,
};
