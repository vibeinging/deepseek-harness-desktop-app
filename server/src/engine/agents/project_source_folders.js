import { existsSync, statSync } from "node:fs";

export function isProjectSourceFolderAvailable(value) {
  const path = String(value || "");
  try { return existsSync(path) && statSync(path).isDirectory(); } catch { return false; }
}

export async function loadProjectSourceFolders(db, projectId) {
  if (!db?.query || !projectId || projectId === "__chat__") return [];
  const rows = await db.query(
    `SELECT id, project_id, local_path, display_name, access_mode, sort_order, created_at, updated_at
       FROM project_source_folders
      WHERE project_id=$1 AND deleted_at IS NULL
      ORDER BY sort_order ASC, created_at ASC`,
    [projectId],
  ).catch(() => []);
  return rows.map((row) => {
    const path = String(row.local_path || "");
    const accessMode = row.access_mode === "write" ? "write" : "read";
    return {
      ...row,
      access_mode: accessMode,
      write_target: accessMode === "write",
      path,
      name: row.display_name,
      available: isProjectSourceFolderAvailable(path),
    };
  });
}

export default loadProjectSourceFolders;
