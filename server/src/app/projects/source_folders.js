import { randomUUID } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import { ApiError } from "../../errors.js";
import { loadProjectSourceFolders } from "../../engine/agents/project_source_folders.js";

function cleanPath(value, { allowUnavailable = false } = {}) {
  const input = String(value || "").trim();
  if (!input) throw new ApiError("文件夹路径不能为空", 400);
  if (!isAbsolute(input)) throw new ApiError("请选择本机绝对路径", 400);
  const path = resolve(input);
  let available = false;
  try { available = existsSync(path) && statSync(path).isDirectory(); } catch { available = false; }
  if (!available) {
    if (allowUnavailable) return path;
    throw new ApiError(`文件夹不存在或无法访问：${path}`, 400);
  }
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function displayName(value, path) {
  return String(value || "").trim().slice(0, 160) || basename(path) || path;
}

export async function listProjectSourceFolders(db, projectId) {
  return loadProjectSourceFolders(db, projectId);
}

function isNestedPath(parent, child) {
  const rel = relative(parent, child);
  return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith("/") && !rel.startsWith("\\");
}

export function normalizeProjectSourceFolders(folders = [], { allowedUnavailablePaths = new Set() } = {}) {
  if (!Array.isArray(folders)) throw new ApiError("Source folders 必须是数组", 400);
  if (folders.length > 20) throw new ApiError("一个项目最多关联 20 个本地文件夹", 400);

  const normalized = [];
  const seen = new Set();
  let writeTargetCount = 0;
  for (const item of folders) {
    const inputPath = typeof item === "string" ? item : item?.path || item?.local_path;
    const resolvedInput = resolve(String(inputPath || ""));
    const path = cleanPath(inputPath, { allowUnavailable: allowedUnavailablePaths.has(resolvedInput) });
    if (seen.has(path)) {
      throw new ApiError(`文件夹重复：${path}`, 409, "PROJECT_SOURCE_FOLDER_DUPLICATE");
    }
    const overlap = normalized.find((existing) => isNestedPath(existing.path, path) || isNestedPath(path, existing.path));
    if (overlap) {
      throw new ApiError(
        `文件夹范围重叠：${overlap.path} 与 ${path}，请只保留其中一个`,
        409,
        "PROJECT_SOURCE_FOLDER_OVERLAP",
      );
    }
    seen.add(path);
    const requestedMode = typeof item === "string"
      ? ""
      : String(item?.access_mode || (item?.write_target === true || item?.is_write_target === true ? "write" : "")).trim();
    if (requestedMode && requestedMode !== "read" && requestedMode !== "write") {
      throw new ApiError(`不支持的文件夹权限：${requestedMode}`, 400, "PROJECT_SOURCE_FOLDER_ACCESS_INVALID");
    }
    const accessMode = requestedMode === "write" ? "write" : "read";
    if (accessMode === "write") writeTargetCount += 1;
    normalized.push({
      path,
      name: displayName(typeof item === "string" ? "" : item?.name || item?.display_name, path),
      access_mode: accessMode,
      write_target: accessMode === "write",
    });
  }
  if (writeTargetCount > 1) {
    throw new ApiError("一个项目只能选择一个写入位置", 409, "PROJECT_SOURCE_FOLDER_MULTIPLE_WRITE_TARGETS");
  }
  if (normalized.length && writeTargetCount === 0) {
    normalized[0].access_mode = "write";
    normalized[0].write_target = true;
  }
  return normalized;
}

export async function replaceProjectSourceFolders(db, projectId, folders = [], userId = null) {
  if (!db?.query || !projectId) return [];
  const current = await db.query(
    `SELECT id, local_path, access_mode, deleted_at FROM project_source_folders WHERE project_id=$1`,
    [projectId],
  );
  const allowedUnavailablePaths = new Set(current
    .filter((row) => !row.deleted_at)
    .map((row) => resolve(String(row.local_path || ""))));
  const normalized = normalizeProjectSourceFolders(folders, { allowedUnavailablePaths });
  const byPath = new Map(current.map((row) => [String(row.local_path), row]));
  await db.query(
    `UPDATE project_source_folders
        SET deleted_at=now(), deleted_by=$2, updated_at=now()
      WHERE project_id=$1 AND deleted_at IS NULL`,
    [projectId, userId || null],
  );
  for (let index = 0; index < normalized.length; index += 1) {
    const item = normalized[index];
    const existing = byPath.get(item.path);
    if (existing) {
      await db.query(
        `UPDATE project_source_folders
            SET display_name=$3, access_mode=$4, sort_order=$5, deleted_at=NULL, deleted_by=NULL, updated_at=now()
          WHERE id=$1 AND project_id=$2`,
        [existing.id, projectId, item.name, item.access_mode, index],
      );
    } else {
      await db.query(
        `INSERT INTO project_source_folders
          (id, project_id, local_path, display_name, access_mode, sort_order, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now(),now())`,
        [randomUUID(), projectId, item.path, item.name, item.access_mode, index],
      );
    }
  }

  return listProjectSourceFolders(db, projectId);
}

export default listProjectSourceFolders;
