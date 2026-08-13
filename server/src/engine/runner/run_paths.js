import { randomUUID } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { dataPath } from "../../config/paths.js";

export function normalizeRunnerRunId(value, fallback = randomUUID()) {
  return String(value || fallback).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || fallback;
}

function inside(candidate, root) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export function runnerRunDirectory(runId, { runsRoot = dataPath("runs") } = {}) {
  return join(resolve(runsRoot), normalizeRunnerRunId(runId));
}

export async function removeRunnerRunDirectory(runId, { runsRoot = dataPath("runs") } = {}) {
  const rawId = String(runId || "").trim();
  if (!rawId) {
    const error = new Error("清理运行目录缺少 run_id");
    error.code = "AGENT_RUN_RETENTION_INVALID_ID";
    throw error;
  }
  const requestedRoot = resolve(runsRoot);
  const root = await realpath(requestedRoot).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!root) return { run_id: rawId, path: runnerRunDirectory(rawId, { runsRoot: requestedRoot }), removed: false, missing: true };

  const target = resolve(root, normalizeRunnerRunId(rawId));
  if (target === root || !inside(target, root)) {
    const error = new Error(`拒绝清理运行根目录之外的路径：${target}`);
    error.code = "AGENT_RUN_RETENTION_OUTSIDE_ROOT";
    throw error;
  }
  const entry = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!entry) return { run_id: rawId, path: target, removed: false, missing: true };
  if (entry.isSymbolicLink()) {
    const error = new Error(`拒绝清理符号链接运行目录：${target}`);
    error.code = "AGENT_RUN_RETENTION_SYMLINK";
    throw error;
  }
  const canonicalTarget = await realpath(target);
  if (!inside(canonicalTarget, root)) {
    const error = new Error(`运行目录真实路径越界：${canonicalTarget}`);
    error.code = "AGENT_RUN_RETENTION_OUTSIDE_ROOT";
    throw error;
  }
  await rm(canonicalTarget, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  return { run_id: rawId, path: canonicalTarget, removed: true, missing: false };
}

export default { normalizeRunnerRunId, runnerRunDirectory, removeRunnerRunDirectory };
