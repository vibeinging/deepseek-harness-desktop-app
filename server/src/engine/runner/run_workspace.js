import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { dataPath } from "../../config/paths.js";
import { normalizeRunnerRunId, runnerRunDirectory } from "./run_paths.js";

export const AGENT_RUN_WORKSPACE_VERSION = "agent_run_workspace.v1";
export const AGENT_RUN_WORKSPACE_DIRS = Object.freeze([
  "input",
  "work",
  "intermediate",
  "artifacts",
  "logs",
  "tmp",
]);

function workspaceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

function manifestHash(manifest) {
  const { manifest_hash: _storedHash, ...identity } = manifest || {};
  return hash(identity);
}

function assertRunId(runId) {
  const raw = String(runId || "").trim();
  const normalized = normalizeRunnerRunId(raw, "");
  if (!raw || raw !== normalized) {
    throw workspaceError("AGENT_RUN_WORKSPACE_INVALID_ID", "运行工作区需要安全、稳定的 run_id");
  }
  return raw;
}

async function assertNotSymlink(path, label) {
  const entry = await lstat(path).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (entry?.isSymbolicLink()) {
    throw workspaceError("AGENT_RUN_WORKSPACE_SYMLINK", `拒绝使用符号链接${label}：${path}`);
  }
  return entry;
}

export function agentRunWorkspacePaths(runId, { runsRoot = dataPath("runs") } = {}) {
  const id = assertRunId(runId);
  const root = runnerRunDirectory(id, { runsRoot: resolve(runsRoot) });
  return {
    version: AGENT_RUN_WORKSPACE_VERSION,
    run_id: id,
    root,
    manifest: join(root, "manifest.json"),
    input: join(root, "input"),
    work: join(root, "work"),
    intermediate: join(root, "intermediate"),
    artifacts: join(root, "artifacts"),
    logs: join(root, "logs"),
    tmp: join(root, "tmp"),
  };
}

export async function ensureAgentRunWorkspace({
  runId,
  sessionId,
  projectId = null,
  userId = null,
  mode = "agent",
  skill = null,
  createdAt = new Date().toISOString(),
  runsRoot = dataPath("runs"),
} = {}) {
  const paths = agentRunWorkspacePaths(runId, { runsRoot });
  const root = resolve(runsRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await assertNotSymlink(root, "根目录");
  await assertNotSymlink(paths.root, "目录");
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  await chmod(paths.root, 0o700).catch(() => {});
  for (const name of AGENT_RUN_WORKSPACE_DIRS) {
    const path = paths[name];
    await assertNotSymlink(path, `子目录 ${name}`);
    await mkdir(path, { recursive: true, mode: 0o700 });
    await chmod(path, 0o700).catch(() => {});
  }

  const identity = {
    version: AGENT_RUN_WORKSPACE_VERSION,
    run_id: paths.run_id,
    session_id: String(sessionId || "") || null,
    project_id: String(projectId || "") || null,
    user_id: String(userId || "") || null,
    mode: String(mode || "agent"),
    skill: String(skill || "") || null,
    created_at: String(createdAt || new Date().toISOString()),
    directories: Object.fromEntries(AGENT_RUN_WORKSPACE_DIRS.map((name) => [name, name])),
  };
  const manifest = { ...identity, manifest_hash: hash(identity) };
  try {
    await writeFile(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await assertNotSymlink(paths.manifest, "清单");
    const existing = JSON.parse(await readFile(paths.manifest, "utf8"));
    if (
      existing?.version !== AGENT_RUN_WORKSPACE_VERSION ||
      existing?.run_id !== paths.run_id ||
      (existing?.session_id || null) !== identity.session_id ||
      (existing?.project_id || null) !== identity.project_id
    ) {
      throw workspaceError("AGENT_RUN_WORKSPACE_CONFLICT", "已存在的运行工作区清单与当前运行不一致");
    }
    if (existing.manifest_hash !== manifestHash(existing)) {
      throw workspaceError("AGENT_RUN_WORKSPACE_CONFLICT", "运行工作区清单指纹校验失败");
    }
    return { ...paths, manifest_data: existing, manifest_hash: existing.manifest_hash || hash(identity) };
  }
  return { ...paths, manifest_data: manifest, manifest_hash: manifest.manifest_hash };
}

export async function readAgentRunWorkspace(runId, options = {}) {
  const paths = agentRunWorkspacePaths(runId, options);
  await assertNotSymlink(paths.root, "目录");
  await assertNotSymlink(paths.manifest, "清单");
  const manifest = JSON.parse(await readFile(paths.manifest, "utf8"));
  if (manifest?.version !== AGENT_RUN_WORKSPACE_VERSION || manifest?.run_id !== paths.run_id) {
    throw workspaceError("AGENT_RUN_WORKSPACE_CONFLICT", "运行工作区清单无效");
  }
  if (manifest.manifest_hash !== manifestHash(manifest)) {
    throw workspaceError("AGENT_RUN_WORKSPACE_CONFLICT", "运行工作区清单指纹校验失败");
  }
  return { ...paths, manifest_data: manifest, manifest_hash: manifest.manifest_hash || null };
}

export default {
  AGENT_RUN_WORKSPACE_DIRS,
  AGENT_RUN_WORKSPACE_VERSION,
  agentRunWorkspacePaths,
  ensureAgentRunWorkspace,
  readAgentRunWorkspace,
};
