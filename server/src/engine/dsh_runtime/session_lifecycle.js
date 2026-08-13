import { ApiError } from "../../errors.js";
import { getDshRuntimeClient } from "./client.js";
import { loadDshSessionBinding } from "./session_binding.js";
import { ensureDshWorkspaceSession } from "./session_attachment.js";

async function attachedBinding(db, appSessionId, client = getDshRuntimeClient()) {
  const binding = await loadDshSessionBinding(db, appSessionId);
  if (!binding) return null;
  if (!binding.cwd) throw new ApiError("DSH 会话缺少工作目录，不能安全修改", 409);
  await client.start();
  try {
    await ensureDshWorkspaceSession(client, { sessionId: binding.dshSessionId, cwd: binding.cwd });
  } catch (error) {
    if (error?.code === "session-conflict") throw new ApiError("DSH 会话工作目录冲突", 409);
    throw error;
  }
  client.registerProductHostSession({
    db,
    userId: binding.userId,
    projectId: binding.projectId,
    appSessionId: binding.appSessionId,
    dshSessionId: binding.dshSessionId,
  });
  return { binding, client };
}

export async function syncDshSessionUpdate(db, appSessionId, { title, status } = {}, client) {
  const attached = await attachedBinding(db, appSessionId, client);
  if (!attached) return false;
  const { binding, client: runtimeClient } = attached;
  if (status === "active") {
    const workspaces = await runtimeClient.request("workspace.list", {});
    if (Array.isArray(workspaces?.archivedSessionIds) && workspaces.archivedSessionIds.includes(binding.dshSessionId)) {
      throw new ApiError("当前 DSH 版本还没有取消归档协议，不能恢复这个会话", 409);
    }
  }
  if (title !== undefined) {
    await runtimeClient.request("session.rename", { sessionId: binding.dshSessionId, title: String(title) });
  }
  if (status === "archived") {
    await runtimeClient.request("workspace.archiveSession", { sessionId: binding.dshSessionId });
    runtimeClient.unregisterProductHostSession(binding.dshSessionId);
  }
  return true;
}

export async function archiveDshSessionBeforeDelete(db, appSessionId, client) {
  const attached = await attachedBinding(db, appSessionId, client);
  if (!attached) return false;
  await attached.client.request("workspace.archiveSession", { sessionId: attached.binding.dshSessionId });
  attached.client.unregisterProductHostSession(attached.binding.dshSessionId);
  return true;
}

export async function assertDshSessionCanMove(db, appSessionId) {
  const binding = await loadDshSessionBinding(db, appSessionId);
  if (!binding) return;
  throw new ApiError("DSH session 与工作目录是一一绑定的，当前底座不支持把已有对话移动到另一个项目", 409);
}
