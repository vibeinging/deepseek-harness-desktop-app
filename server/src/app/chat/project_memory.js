import { ApiError } from "../../errors.js";
import { isProjectChatMemoryEnabled } from "../../engine/agents/project_chat_memory.js";

async function requireProjectAccess(ctx, projectId) {
  if (!projectId || projectId === "__chat__") throw new ApiError("普通聊天不使用项目对话记忆", 400);
  const project = await ctx.queryOne(
    `SELECT p.id, p.name, pm.is_owner
       FROM projects p
       JOIN project_members pm ON pm.project_id=p.id AND pm.deleted_at IS NULL
      WHERE p.id=$1 AND pm.user_id=$2 AND p.deleted_at IS NULL
      LIMIT 1`,
    [projectId, ctx.userId || ""],
  ).catch(() => null);
  if (!project) throw new ApiError("项目不存在或无权限", 404);
  return project;
}

async function requireMemorySession(ctx, projectId, sessionId) {
  const session = await ctx.queryOne(
    `SELECT id, title FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3
        AND action_type='agentic_chat' AND deleted_at IS NULL
      LIMIT 1`,
    [sessionId, projectId, ctx.userId || ""],
  ).catch(() => null);
  if (!session) throw new ApiError("对话不存在或无权限", 404);
  return session;
}

// GET /api/agent/projects/:pid/chat-memory
export async function getProjectChatMemory(ctx, input) {
  const projectId = String(input.params?.pid || "").trim();
  const project = await requireProjectAccess(ctx, projectId);
  const enabled = await isProjectChatMemoryEnabled(ctx, projectId, ctx.userId || "");
  const sessions = await ctx.query(
    `SELECT s.id, s.title, COALESCE(s.status,'active') AS status,
            COALESCE(s.message_count,0) AS message_count, s.updated_at,
            CASE WHEN e.session_id IS NULL THEN 0 ELSE 1 END AS excluded
       FROM sessions s
       LEFT JOIN project_chat_memory_exclusions e
         ON e.project_id=s.project_id AND e.user_id=s.created_by AND e.session_id=s.id
      WHERE s.project_id=$1 AND s.created_by=$2
        AND s.action_type='agentic_chat' AND s.deleted_at IS NULL
      ORDER BY s.updated_at DESC
      LIMIT 100`,
    [projectId, ctx.userId || ""],
  ).catch(() => []);
  return {
    data: {
      project_id: projectId,
      project_name: project.name,
      enabled,
      source_conversations: sessions.map((session) => ({
        ...session,
        excluded: [1, true, "1", "true"].includes(session.excluded),
      })),
      eligible_count: sessions.filter((session) => ![1, true, "1", "true"].includes(session.excluded)).length,
      excluded_count: sessions.filter((session) => [1, true, "1", "true"].includes(session.excluded)).length,
    },
    message: "ok",
  };
}

// PUT /api/agent/projects/:pid/chat-memory
export async function updateProjectChatMemory(ctx, input) {
  const projectId = String(input.params?.pid || "").trim();
  await requireProjectAccess(ctx, projectId);
  if (typeof input.body?.enabled !== "boolean") throw new ApiError("enabled 必须是布尔值", 400);
  const enabled = input.body.enabled === true;
  await ctx.query(
    `INSERT INTO project_chat_memory_settings
       (project_id,user_id,enabled,created_at,updated_at)
     VALUES ($1,$2,$3,now(),now())
     ON CONFLICT(project_id,user_id) DO UPDATE SET
       enabled=excluded.enabled, updated_at=excluded.updated_at`,
    [projectId, ctx.userId || "", enabled],
  );
  return { data: { project_id: projectId, enabled }, message: enabled ? "项目对话记忆已开启" : "项目对话记忆已关闭" };
}

// POST /api/agent/projects/:pid/chat-memory/exclusions/:sid
export async function excludeProjectChatMemorySession(ctx, input) {
  const projectId = String(input.params?.pid || "").trim();
  const sessionId = String(input.params?.sid || "").trim();
  await requireProjectAccess(ctx, projectId);
  const session = await requireMemorySession(ctx, projectId, sessionId);
  await ctx.query(
    `INSERT INTO project_chat_memory_exclusions
       (project_id,user_id,session_id,created_at)
     VALUES ($1,$2,$3,now())
     ON CONFLICT(project_id,user_id,session_id) DO NOTHING`,
    [projectId, ctx.userId || "", sessionId],
  );
  return { data: { session_id: sessionId, title: session.title, excluded: true }, message: "这段对话将不再用于项目记忆" };
}

// DELETE /api/agent/projects/:pid/chat-memory/exclusions/:sid
export async function includeProjectChatMemorySession(ctx, input) {
  const projectId = String(input.params?.pid || "").trim();
  const sessionId = String(input.params?.sid || "").trim();
  await requireProjectAccess(ctx, projectId);
  const session = await requireMemorySession(ctx, projectId, sessionId);
  await ctx.query(
    `DELETE FROM project_chat_memory_exclusions
      WHERE project_id=$1 AND user_id=$2 AND session_id=$3`,
    [projectId, ctx.userId || "", sessionId],
  );
  return { data: { session_id: sessionId, title: session.title, excluded: false }, message: "这段对话可以继续用于项目记忆" };
}
