import { ApiError } from "../../errors.js";

export const CHAT_PROJECT_ID = "__chat__";

/**
 * Require an active project membership before project-scoped data or tools are used.
 */
export async function requireProjectMember(ctx, projectId, {
  userId = ctx?.userId,
  allowChat = false,
} = {}) {
  const normalizedProjectId = String(projectId || "").trim();
  const normalizedUserId = String(userId || "").trim();
  if (allowChat && normalizedProjectId === CHAT_PROJECT_ID && normalizedUserId) {
    return { id: CHAT_PROJECT_ID, user_id: normalizedUserId, is_owner: true };
  }
  if (!normalizedProjectId || !normalizedUserId) {
    throw new ApiError("项目不存在或无权限", 404);
  }
  const project = await ctx.queryOne(
    `SELECT p.id, pm.user_id, pm.is_owner, pm.role_id
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id
        AND pm.user_id=$2 AND pm.deleted_at IS NULL
      WHERE p.id=$1 AND p.deleted_at IS NULL
      LIMIT 1`,
    [normalizedProjectId, normalizedUserId],
  ).catch(() => null);
  if (!project) throw new ApiError("项目不存在或无权限", 404);
  return project;
}

export async function requireProjectOwner(ctx, projectId, options = {}) {
  const project = await requireProjectMember(ctx, projectId, options);
  if (!(project.is_owner === true || Number(project.is_owner) === 1)) {
    throw new ApiError("只有项目所有者可以执行此操作", 403);
  }
  return project;
}

export default requireProjectMember;
