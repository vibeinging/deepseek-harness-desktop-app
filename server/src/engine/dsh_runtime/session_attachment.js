/**
 * Register an App workspace in DSH and attach one Session to it.
 * A cwd-only DSH Session is intentionally "Ungrouped" in DSH Web; its blank
 * composer is disabled once the workspace baseline is ready. Using the
 * Workspace protocol here keeps the App shell and the embedded DSH client on
 * the same project instead of showing a second workspace picker.
 */
export async function ensureDshWorkspaceSession(client, { sessionId = null, cwd } = {}) {
  const path = String(cwd || "").trim();
  if (!path) {
    const error = new Error("挂接 DSH 会话需要工作目录");
    error.code = "DSH_WORKSPACE_CWD_REQUIRED";
    throw error;
  }

  const createdWorkspace = await client.request("workspace.create", { path });
  const workspace = createdWorkspace?.workspace;
  const workspaceId = String(workspace?.workspaceId || "").trim();
  if (!workspaceId) {
    const error = new Error("DSH 没有返回 workspace id");
    error.code = "DSH_WORKSPACE_ID_MISSING";
    throw error;
  }

  const requestedSessionId = String(sessionId || "").trim();
  const createdSession = await client.request("session.create", {
    workspaceId,
    ...(requestedSessionId ? { sessionId: requestedSessionId } : {}),
  });
  const resolvedSessionId = String(createdSession?.sessionId || "").trim();
  if (!resolvedSessionId) {
    const error = new Error("DSH 没有返回 session id");
    error.code = "DSH_SESSION_ID_MISSING";
    throw error;
  }
  if (requestedSessionId && resolvedSessionId !== requestedSessionId) {
    const error = new Error(`DSH 返回了不同的 session id：${resolvedSessionId}`);
    error.code = "DSH_SESSION_ID_MISMATCH";
    throw error;
  }
  return { sessionId: resolvedSessionId, workspace };
}
