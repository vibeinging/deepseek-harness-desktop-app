import { dshRuntimeEnabled } from "../dsh_runtime/source_locator.js";
import { DshWorkspaceRuntime } from "../dsh_runtime/workspace_runtime.js";
import { loadDshSessionBinding } from "../dsh_runtime/session_binding.js";
import { getTemporaryDshRuntimeLease } from "../dsh_runtime/temporary_runtime.js";
import { loadProjectSourceFolders } from "./project_source_folders.js";
import { resolveActiveWorktree } from "./git_workspace.js";
import { resolveWorkspace, workspaceAccessRoots } from "./workspace_paths.js";

/** Execute one app conversation only through the configured DSH Profile runtime. */
export class WorkspaceAgent {
  constructor({ projectId = null } = {}) {
    this.projectId = projectId;
    this.activeDshRuntime = null;
    this.activeThreadId = null;
  }

  async execute(agentContext, streamCallback) {
    if (!dshRuntimeEnabled()) {
      const error = new Error("DSH Profile 运行时未启用");
      error.code = "DSH_RUNTIME_DISABLED";
      throw error;
    }

    const projectId = agentContext?.project_id || this.projectId;
    const sessionId = agentContext?.session_id || agentContext?.input_data?.session_id;
    const sourceFolderRecords = await loadProjectSourceFolders(agentContext?.db, projectId);
    const availableSourceFolders = sourceFolderRecords.filter((folder) => folder.available);
    const activeWorktreePath = await resolveActiveWorktree(agentContext?.db, projectId);
    const effectiveSourceFolders = activeWorktreePath
      ? availableSourceFolders.map((folder) => (
          folder.write_target ? { ...folder, path: activeWorktreePath, worktree: true } : folder
        ))
      : availableSourceFolders;
    const binding = await loadDshSessionBinding(agentContext?.db, sessionId);
    const { cwd, sourceFolders } = resolveWorkspace(projectId, sessionId, {
      sourceFolders: effectiveSourceFolders,
      fixedCwd: binding?.cwd,
    });
    const access = workspaceAccessRoots({
      cwd,
      sourceFolders,
      runtimeRoot: agentContext?.runtime?.workspace?.root,
    });
    agentContext.generativeUiWorkspaceRoots = [...new Set([
      ...access.readableRoots,
      ...access.writableRoots,
    ].map((root) => String(root || "").trim()).filter(Boolean))];

    const temporary = agentContext?.temporary === true;
    const ephemeral = temporary ? getTemporaryDshRuntimeLease(sessionId) : null;
    const runtime = new DshWorkspaceRuntime({
      ...(ephemeral ? { client: ephemeral.client, ephemeral } : {}),
    });
    this.activeDshRuntime = runtime;
    agentContext?.onAgent?.(this);
    const result = await runtime.execute({ agentContext, streamCallback, cwd });
    this.activeThreadId = result.thread_id || runtime.sessionId;
    return result;
  }

  abort() {
    if (this.activeDshRuntime?.sessionId) void this.activeDshRuntime.cancel();
  }

  async steer(input, options = {}) {
    if (this.activeDshRuntime?.sessionId) return this.activeDshRuntime.steer(input, options);
    const error = new Error("当前 DSH Session 还不能接收补充内容");
    error.code = "AGENT_TURN_NOT_STEERABLE";
    throw error;
  }
}

export default WorkspaceAgent;
