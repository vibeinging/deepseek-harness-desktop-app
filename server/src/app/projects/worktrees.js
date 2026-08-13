/**
 * Project worktree CRUD handlers.
 *
 * Worktrees are stored in `project_worktrees` and managed via
 * `git_workspace.js` (which spawns system git). Only one worktree can be
 * "active" per project at a time; the active worktree overrides the project's
 * write target cwd for agent turns.
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { ApiError } from "../../errors.js";
import { loadProjectSourceFolders } from "../../engine/agents/project_source_folders.js";
import { requireProjectMember, requireProjectOwner } from "./access.js";
import {
  createWorktree as createGitWorktree,
  listWorktrees as listGitWorktrees,
  removeWorktree as removeGitWorktree,
  isGitRepository,
  isGitRepositoryRoot,
} from "../../engine/agents/git_workspace.js";

async function resolveWriteTarget(db, projectId) {
  const folders = await loadProjectSourceFolders(db, projectId);
  const selectedWriteTarget = folders.find((folder) => folder.write_target);
  if (selectedWriteTarget && !selectedWriteTarget.available) {
    throw new ApiError("项目写入目录当前不可用，无法管理 worktree", 409, "PROJECT_WRITE_TARGET_UNAVAILABLE");
  }
  const writeTarget = selectedWriteTarget || folders.find((folder) => folder.available);
  if (!writeTarget) throw new ApiError("项目没有可用的写入目录，无法管理 worktree", 409);
  return writeTarget;
}

function serializeWorktree(row, { available = true } = {}) {
  return {
    id: row.id,
    project_id: row.project_id,
    source_folder_path: row.source_folder_path,
    branch: row.branch,
    path: row.path,
    base_commit: row.base_commit || null,
    active: row.active === true || Number(row.active) === 1,
    available: Boolean(available),
    created_at: row.created_at || null,
  };
}

function samePath(left, right) {
  return String(left || "").trim() === String(right || "").trim();
}

async function pathIsDirectory(value) {
  const info = await stat(String(value || "")).catch(() => null);
  return Boolean(info?.isDirectory());
}

export async function listProjectWorktrees(ctx, input) {
  const projectId = input.params?.id || input.params?.pid;
  if (!projectId) throw new ApiError("缺少项目 ID", 400);
  await requireProjectMember(ctx, projectId);
  const writeTarget = await resolveWriteTarget(ctx, projectId);
  const rows = await ctx.query(
    `SELECT id, project_id, source_folder_path, branch, path, base_commit, active, created_at, archived_at
       FROM project_worktrees
      WHERE project_id=$1 AND archived_at IS NULL
      ORDER BY created_at DESC`,
    [projectId],
  );
  const gitRepository = await isGitRepositoryRoot(writeTarget.path);
  const onDisk = new Set(gitRepository
    ? (await listGitWorktrees(writeTarget.path)).map((entry) => entry.path)
    : []);
  return {
    data: {
      items: rows.map((row) => serializeWorktree(row, {
        available: samePath(row.source_folder_path, writeTarget.path) && onDisk.has(row.path),
      })),
      write_target_path: writeTarget.path,
      git_repository: gitRepository,
    },
    message: rows.length ? undefined : "当前项目还没有 worktree",
  };
}

export async function createProjectWorktree(ctx, input) {
  const projectId = input.params?.id || input.params?.pid;
  if (!projectId) throw new ApiError("缺少项目 ID", 400);
  await requireProjectOwner(ctx, projectId);
  const writeTarget = await resolveWriteTarget(ctx, projectId);
  if (!(await isGitRepository(writeTarget.path))) {
    throw new ApiError("写入目录不是 Git 仓库，无法创建 worktree", 409);
  }
  if (!(await isGitRepositoryRoot(writeTarget.path))) {
    throw new ApiError("写入目录必须是 Git 仓库根目录，不能使用仓库内的子文件夹", 409, "WORKTREE_REPOSITORY_ROOT_REQUIRED");
  }
  const body = input.body || {};
  const branchName = String(body.branchName || "").trim();
  const worktreeId = randomUUID().replace(/-/g, "").slice(0, 16);
  const created = await createGitWorktree(writeTarget.path, {
    branchName,
    baseBranch: body.baseBranch || null,
    id: worktreeId,
  });
  const id = randomUUID();
  let stored;
  try {
    stored = await ctx.queryOne(
      `INSERT INTO project_worktrees
        (id, project_id, source_folder_path, branch, path, base_commit, active, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,now())
       RETURNING id, project_id, source_folder_path, branch, path, base_commit, active, created_at`,
      [id, projectId, writeTarget.path, created.branch, created.path, created.baseCommit, ctx.userId || ""],
    );
  } catch (error) {
    try {
      await removeGitWorktree(writeTarget.path, created.path, { deleteBranch: true });
    } catch (cleanupError) {
      console.error("[worktree] 数据库存储失败且 Git 补偿清理失败", cleanupError?.message || cleanupError);
    }
    console.error("[worktree] 无法保存新建 worktree", error?.message || error);
    throw new ApiError("worktree 已创建但无法保存，系统已尝试清理，请重试", 500, "WORKTREE_PERSIST_FAILED");
  }
  if (!stored) {
    await removeGitWorktree(writeTarget.path, created.path, { deleteBranch: true }).catch(() => {});
    throw new ApiError("worktree 保存失败，请重试", 500, "WORKTREE_PERSIST_FAILED");
  }
  return {
    data: serializeWorktree(stored, { available: true }),
    message: `已创建 worktree（分支 ${created.branch}）`,
  };
}

export async function activateProjectWorktree(ctx, input) {
  const projectId = input.params?.id || input.params?.pid;
  const worktreeId = input.params?.worktreeId;
  if (!projectId || !worktreeId) throw new ApiError("缺少项目 ID 或 worktree ID", 400);
  await requireProjectOwner(ctx, projectId);
  const row = await ctx.queryOne(
    `SELECT id, project_id, source_folder_path, branch, path, base_commit, active, created_at
       FROM project_worktrees
      WHERE id=$1 AND project_id=$2 AND archived_at IS NULL LIMIT 1`,
    [worktreeId, projectId],
  );
  if (!row) throw new ApiError("找不到这个 worktree", 404);
  const writeTarget = await resolveWriteTarget(ctx, projectId);
  if (!samePath(row.source_folder_path, writeTarget.path)) {
    throw new ApiError("这个 worktree 不属于当前写入目录，不能切换", 409, "WORKTREE_SOURCE_CHANGED");
  }
  const managed = await listGitWorktrees(writeTarget.path);
  if (!managed.some((entry) => samePath(entry.path, row.path))) {
    throw new ApiError("worktree 目录已不存在或不再受 Git 管理", 409, "WORKTREE_UNAVAILABLE");
  }
  // One statement is atomic in SQLite and repairs any old duplicate-active state.
  const updated = await ctx.query(
    `UPDATE project_worktrees
        SET active=CASE WHEN id=$2 THEN 1 ELSE 0 END
      WHERE project_id=$1 AND archived_at IS NULL
      RETURNING id, active`,
    [projectId, worktreeId],
  );
  const activeRows = updated.filter((item) => item.active === true || Number(item.active) === 1);
  if (activeRows.length !== 1 || activeRows[0].id !== worktreeId) {
    throw new ApiError("worktree 切换未完成，请重试", 409, "WORKTREE_ACTIVATION_CONFLICT");
  }
  return { data: { id: worktreeId, active: true, path: row.path }, message: "已切换到这个 worktree" };
}

export async function deactivateProjectWorktrees(ctx, input) {
  const projectId = input.params?.id || input.params?.pid;
  if (!projectId) throw new ApiError("缺少项目 ID", 400);
  await requireProjectOwner(ctx, projectId);
  const writeTarget = await resolveWriteTarget(ctx, projectId);
  await ctx.query(
    "UPDATE project_worktrees SET active=0 WHERE project_id=$1 AND archived_at IS NULL",
    [projectId],
  );
  return { data: { active: false, path: writeTarget.path }, message: "已切回主检出" };
}

export async function removeProjectWorktree(ctx, input) {
  const projectId = input.params?.id || input.params?.pid;
  const worktreeId = input.params?.worktreeId;
  if (!projectId || !worktreeId) throw new ApiError("缺少项目 ID 或 worktree ID", 400);
  await requireProjectOwner(ctx, projectId);
  const row = await ctx.queryOne(
    `SELECT id, source_folder_path, branch, path, active
       FROM project_worktrees
      WHERE id=$1 AND project_id=$2 AND archived_at IS NULL LIMIT 1`,
    [worktreeId, projectId],
  );
  if (!row) throw new ApiError("找不到这个 worktree", 404);
  if (row.active === true || Number(row.active) === 1) {
    throw new ApiError("请先切回主检出，再删除这个 worktree", 409, "WORKTREE_ACTIVE");
  }
  const directoryAvailable = await pathIsDirectory(row.path);
  const sourceAvailable = await pathIsDirectory(row.source_folder_path);
  if (sourceAvailable) {
    await removeGitWorktree(row.source_folder_path, row.path);
  } else if (directoryAvailable) {
    throw new ApiError("原 Git 仓库当前不可用，不能安全删除 worktree", 409, "WORKTREE_SOURCE_UNAVAILABLE");
  }
  await ctx.query(
    "UPDATE project_worktrees SET archived_at=now(), active=0 WHERE id=$1 AND project_id=$2",
    [worktreeId, projectId],
  );
  return { data: { id: worktreeId, removed: true }, message: "已删除 worktree" };
}

export default {
  listProjectWorktrees,
  createProjectWorktree,
  activateProjectWorktree,
  deactivateProjectWorktrees,
  removeProjectWorktree,
};
