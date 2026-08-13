import { existsSync, mkdirSync, statSync } from "node:fs";
import { dataPath } from "../../config/paths.js";

export const CHAT_PROJECT_ID = "__chat__";

function safeSegment(value) {
  return String(value || "").trim().replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_").slice(0, 160);
}

function availableFolder(item) {
  const path = String(item?.path || item?.local_path || "").trim();
  if (!path) return null;
  try { return existsSync(path) && statSync(path).isDirectory() ? path : null; } catch { return null; }
}

function isWriteTarget(item) {
  return item?.write_target === true || item?.is_write_target === true || item?.access_mode === "write";
}

export function workspaceCwd(projectId, sessionId = null, { sourceFolders = [], runtimeRoot = null } = {}) {
  const source = availableFolder(sourceFolders.find(isWriteTarget));
  if (source) return source;
  const runtime = String(runtimeRoot || "").trim();
  if (runtime) return runtime;
  const segment = safeSegment(sessionId || projectId || "draft") || "draft";
  return dataPath("runtime_workspaces", segment);
}

export function resolveWorkspace(projectId, sessionId = null, options = {}) {
  const cwd = workspaceCwd(projectId, sessionId, options);
  mkdirSync(cwd, { recursive: true });
  const sourceFolders = (options.sourceFolders || []).map(availableFolder).filter(Boolean);
  return {
    mode: String(projectId || "") === CHAT_PROJECT_ID ? "chat" : "agent",
    cwd,
    writeRoot: cwd,
    sourceFolders,
    readRoots: sourceFolders.filter((path) => path !== cwd),
  };
}

export function workspaceAccessRoots({ cwd, sourceFolders = [], runtimeRoot = null } = {}) {
  const readableRoots = [...new Set([cwd, ...sourceFolders, runtimeRoot].filter(Boolean))];
  const writableRoots = [...new Set([cwd, runtimeRoot].filter(Boolean))];
  return { readableRoots, writableRoots };
}

export default workspaceCwd;
