import { lstatSync, realpathSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import { loadProjectSourceFolders } from "../../engine/agents/project_source_folders.js";

const HIDDEN_OR_GENERATED_DIRECTORIES = new Set([".git", "node_modules", "__pycache__"]);
const MAX_PROJECTS = 80;
const MAX_RUNS = 100;
const MAX_DIRECTORY_ITEMS = 500;

function cleanId(value) {
  return String(value || "").trim();
}

export function isInsideDirectory(basePath, candidatePath) {
  const rel = relative(resolve(basePath), resolve(candidatePath));
  return rel === "" || (!!rel && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith("/") && !rel.startsWith("\\"));
}

export function hasHiddenOrGeneratedPath(relativePath) {
  return String(relativePath || "")
    .split(/[\\/]+/)
    .filter(Boolean)
    .some((part) => part.startsWith(".") || HIDDEN_OR_GENERATED_DIRECTORIES.has(part));
}

export function canonicalDirectory(path) {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

export function resolveAuthorizedRootPath(root, relativePath = "", { type = "any" } = {}) {
  if (!root?.path || String(relativePath || "").includes("\0")) return null;
  const realRoot = canonicalDirectory(root.path);
  if (!realRoot) return null;
  const requested = resolve(realRoot, String(relativePath || ""));
  if (!isInsideDirectory(realRoot, requested)) return null;
  const requestedParts = relative(realRoot, requested).split(sep).filter(Boolean);
  let requestedCursor = realRoot;
  try {
    for (const part of requestedParts) {
      requestedCursor = join(requestedCursor, part);
      if (lstatSync(requestedCursor).isSymbolicLink()) return null;
    }
  } catch {
    return null;
  }
  let realTarget;
  let stat;
  try {
    realTarget = realpathSync(requested);
    if (!isInsideDirectory(realRoot, realTarget)) return null;
    stat = statSync(realTarget);
  } catch {
    return null;
  }
  if (type === "file" && !stat.isFile()) return null;
  if (type === "directory" && !stat.isDirectory()) return null;
  return {
    rootPath: realRoot,
    fullPath: realTarget,
    relativePath: relative(realRoot, realTarget).split(sep).join("/"),
    stat,
  };
}

async function authorizedSession(ctx, projectId, sessionId) {
  if (!sessionId || !ctx?.queryOne) return null;
  return ctx.queryOne(
    `SELECT id, project_id, title
       FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
      LIMIT 1`,
    [sessionId, projectId, ctx.userId || ""],
  ).catch(() => null);
}

async function authorizedProject(ctx, projectId) {
  if (!projectId || projectId === "__chat__" || !ctx?.queryOne) return projectId === "__chat__" ? { id: projectId } : null;
  return ctx.queryOne(
    `SELECT p.id, p.name
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id AND pm.deleted_at IS NULL
      WHERE p.id=$1 AND pm.user_id=$2 AND p.deleted_at IS NULL
      LIMIT 1`,
    [projectId, ctx.userId || ""],
  ).catch(() => null);
}

export async function listProjectFileRoots(ctx, { projectId, sessionId = "" } = {}) {
  const pid = cleanId(projectId);
  const sid = cleanId(sessionId);
  if (!pid) return [];

  if (sid) {
    if (!await authorizedSession(ctx, pid, sid)) return [];
  } else if (!await authorizedProject(ctx, pid)) {
    return [];
  }

  const roots = pid === "__chat__"
    ? []
    : (await loadProjectSourceFolders(ctx, pid))
      .filter((folder) => folder.available)
      .map((folder) => ({
        id: folder.id,
        name: folder.name || basename(folder.path),
        path: folder.path,
        kind: "source_folder",
        access_mode: folder.access_mode,
        write_target: folder.write_target,
        project_id: pid,
      }));

  if (!sid) return roots;
  const run = await ctx.queryOne(
    `SELECT workspace_path
       FROM agent_runs
      WHERE session_id=$1 AND project_id=$2 AND deleted_at IS NULL
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT 1`,
    [sid, pid],
  ).catch(() => null);
  const runRoot = run?.workspace_path ? join(run.workspace_path, "work") : null;
  const artifactRoot = run?.workspace_path ? join(run.workspace_path, "artifacts") : null;
  if (runRoot && canonicalDirectory(runRoot)) {
    roots.push({ id: "run-work", name: "本轮文件", path: runRoot, kind: "run_work", project_id: pid, session_id: sid });
  }
  if (artifactRoot && canonicalDirectory(artifactRoot)) {
    roots.push({ id: "run-artifacts", name: "本轮产物", path: artifactRoot, kind: "run_artifacts", project_id: pid, session_id: sid });
  }
  return roots;
}

export function listDirectoryItems(root, relativePath = "", { limit = MAX_DIRECTORY_ITEMS } = {}) {
  const directory = resolveAuthorizedRootPath(root, relativePath, { type: "directory" });
  if (!directory || hasHiddenOrGeneratedPath(directory.relativePath)) return { items: [], truncated: false };
  let entries;
  try {
    entries = readdirSync(directory.fullPath, { withFileTypes: true });
  } catch {
    return { items: [], truncated: false };
  }

  const maxItems = Math.max(1, Math.min(MAX_DIRECTORY_ITEMS, Number(limit) || MAX_DIRECTORY_ITEMS));
  const items = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || HIDDEN_OR_GENERATED_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
    if (!entry.isDirectory() && !entry.isFile()) continue;
    const path = directory.relativePath ? `${directory.relativePath}/${entry.name}` : entry.name;
    let size;
    let modifiedAt = null;
    if (entry.isFile()) {
      try {
        const fileStat = statSync(join(directory.fullPath, entry.name));
        size = Number(fileStat.size || 0);
        modifiedAt = fileStat.mtime?.toISOString?.() || null;
      } catch {
        continue;
      }
    }
    items.push({
      name: entry.name,
      path,
      type: entry.isDirectory() ? "dir" : "file",
      root_id: root.id,
      ...(entry.isDirectory() ? { children: [], loaded: false } : { size, modified_at: modifiedAt }),
    });
  }
  items.sort((left, right) => (
    left.type !== right.type
      ? (left.type === "dir" ? -1 : 1)
      : left.name.localeCompare(right.name)
  ));
  return { items: items.slice(0, maxItems), truncated: items.length > maxItems };
}

export async function listSearchableFileRoots(ctx, { projectId = "", sessionId = "" } = {}) {
  if (!ctx?.query || !ctx?.userId) return [];
  const requestedProjectId = cleanId(projectId);
  const requestedSessionId = cleanId(sessionId);
  const scopedSession = requestedSessionId && ctx.queryOne
    ? await ctx.queryOne(
      `SELECT project_id
         FROM sessions
        WHERE id=$1 AND created_by=$2 AND action_type='agentic_chat' AND deleted_at IS NULL
        LIMIT 1`,
      [requestedSessionId, ctx.userId],
    ).catch(() => null)
    : null;
  if (requestedSessionId && !scopedSession) return [];
  if (requestedProjectId && scopedSession && String(scopedSession.project_id) !== requestedProjectId) return [];
  const effectiveProjectId = requestedProjectId || String(scopedSession?.project_id || "");

  const projects = await ctx.query(
    `SELECT DISTINCT p.id, p.name
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id AND pm.deleted_at IS NULL
      WHERE pm.user_id=$1 AND p.deleted_at IS NULL
      ORDER BY p.updated_at DESC
      LIMIT ${MAX_PROJECTS}`,
    [ctx.userId],
  ).catch(() => []);

  const visibleProjects = effectiveProjectId
    ? projects.filter((project) => String(project.id) === effectiveProjectId)
    : projects;
  const sourceGroups = await Promise.all(visibleProjects.map(async (project) => {
    const folders = await loadProjectSourceFolders(ctx, project.id);
    return folders.filter((folder) => folder.available).map((folder) => ({
      id: folder.id,
      name: folder.name || basename(folder.path),
      path: folder.path,
      kind: "source_folder",
      access_mode: folder.access_mode,
      write_target: folder.write_target,
      project_id: project.id,
      project_name: project.name || "项目",
      session_id: null,
      session_title: null,
    }));
  }));

  const runs = await ctx.query(
    `WITH ranked_runs AS (
       SELECT ar.workspace_path, ar.session_id,
              s.project_id, s.title AS session_title,
              CASE WHEN s.project_id='__chat__' THEN '聊天' ELSE COALESCE(p.name,'项目') END AS project_name,
              ROW_NUMBER() OVER (
                PARTITION BY ar.session_id
                ORDER BY COALESCE(ar.updated_at,ar.created_at) DESC, ar.created_at DESC
              ) AS run_rank
         FROM agent_runs ar
         JOIN sessions s ON s.id=ar.session_id AND s.deleted_at IS NULL
         LEFT JOIN projects p ON p.id=s.project_id AND p.deleted_at IS NULL
        WHERE s.created_by=$1 AND s.action_type='agentic_chat'
          AND ar.deleted_at IS NULL AND ar.workspace_path IS NOT NULL
          AND (
            s.project_id='__chat__' OR (
              p.id IS NOT NULL AND EXISTS (
                SELECT 1 FROM project_members pm
                 WHERE pm.project_id=s.project_id AND pm.user_id=$1 AND pm.deleted_at IS NULL
              )
            )
          )
     )
     SELECT workspace_path, session_id, project_id, session_title, project_name
       FROM ranked_runs
      WHERE run_rank=1
      LIMIT ${MAX_RUNS}`,
    [ctx.userId],
  ).catch(() => []);

  const runRoots = [];
  for (const run of runs) {
    if (effectiveProjectId && String(run.project_id) !== effectiveProjectId) continue;
    if (requestedSessionId && String(run.session_id) !== requestedSessionId) continue;
    const artifacts = join(run.workspace_path, "artifacts");
    const work = join(run.workspace_path, "work");
    if (canonicalDirectory(artifacts)) runRoots.push({
      id: "run-artifacts",
      name: "本轮产物",
      path: artifacts,
      kind: "run_artifacts",
      project_id: run.project_id,
      project_name: run.project_name,
      session_id: run.session_id,
      session_title: run.session_title,
    });
    if (canonicalDirectory(work)) runRoots.push({
      id: "run-work",
      name: "本轮文件",
      path: work,
      kind: "run_work",
      project_id: run.project_id,
      project_name: run.project_name,
      session_id: run.session_id,
      session_title: run.session_title,
    });
  }

  let sources = sourceGroups.flat();
  if (requestedSessionId) {
    sources = sources.filter((root) => String(root.project_id) === String(scopedSession.project_id));
  }
  return [
    ...runRoots.filter((root) => root.kind === "run_artifacts"),
    ...sources,
    ...runRoots.filter((root) => root.kind === "run_work"),
  ];
}
