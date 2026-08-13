import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { ApiError } from "../../errors.js";
import { dataPath } from "../../config/paths.js";
import { createAgentRuntime } from "../../engine/agents/agent_run_runtime.js";
import { releaseRunLease, transitionAgentRun } from "../../engine/agents/run_fact_store.js";
import { requireProjectOwner } from "../projects/access.js";

function assertEvalMode() {
  if (!process.env.DSH_EVAL_MODE && process.env.NODE_ENV !== "test") {
    throw new ApiError("恢复诊断只在 Eval 环境可用", 404);
  }
}

export async function prepareRunRecoveryDiagnostic(ctx, input) {
  assertEvalMode();
  const projectId = String(input.body?.project_id || input.body?.projectId || "").trim();
  const sessionId = String(input.body?.session_id || input.body?.sessionId || "").trim();
  if (!(projectId && sessionId)) throw new ApiError("缺少 project_id 或 session_id", 400);
  await requireProjectOwner(ctx, projectId);
  const session = await ctx.queryOne(
    `SELECT id FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL
      LIMIT 1`,
    [sessionId, projectId, ctx.userId || ""],
  );
  if (!session) throw new ApiError("诊断会话不存在", 404);

  const runId = `recovery-diagnostic-${randomUUID()}`;
  const callId = `write-${randomUUID()}`;
  const marker = `recovery-${randomUUID()}`;
  const workspace = dataPath("projects", projectId);
  const artifactPath = join(workspace, `${runId}.txt`);
  await mkdir(workspace, { recursive: true });
  const runtime = createAgentRuntime({
    ctx,
    stream: null,
    runId,
    sessionId,
    projectId,
    userId: ctx.userId || "",
    mode: "diagnostic_recovery",
  });
  const created = await runtime.createRun();
  if (!created) throw new ApiError("无法创建恢复诊断运行", 500);

  try {
    await runtime.beginToolCall({
      callId,
      toolName: "write",
      accessMode: "write",
      input: { path: artifactPath, content: marker },
    });
    await writeFile(artifactPath, marker, { mode: 0o600 });
    const result = { content: [{ type: "text", text: "diagnostic artifact written" }] };
    await runtime.finishToolCall({
      callId,
      toolName: "write",
      ok: true,
      result,
      outputSummary: "diagnostic artifact written",
    });
    await runtime.recordArtifact({
      callId,
      kind: "file",
      path: artifactPath,
      metadata: { diagnostic: true },
    });
    await runtime.saveCheckpoint({
      diagnostic: true,
      call_id: callId,
      marker,
      artifact_path: artifactPath,
    }, { source: "recovery_diagnostic" });
    await transitionAgentRun(ctx, {
      runId,
      status: "recovering",
      eventType: "run_recovery_diagnostic_prepared",
      eventMetadata: { call_id: callId },
      recoverable: true,
    });
    await releaseRunLease(ctx, { runId, owner: runtime.leaseOwner });
    return {
      data: {
        run_id: runId,
        call_id: callId,
        marker,
        artifact_path: artifactPath,
      },
      message: "恢复诊断已准备",
    };
  } catch (error) {
    await runtime.completeRun("failed").catch(() => {});
    throw error;
  } finally { /* no separate runner process */ }
}

export async function prepareRunningElectronExitDiagnostic(ctx, input) {
  assertEvalMode();
  const prepared = await prepareRunRecoveryDiagnostic(ctx, input);
  const data = prepared.data || {};
  const runId = String(data.run_id || "");
  const projectId = String(input.body?.project_id || input.body?.projectId || "").trim();
  const sessionId = String(input.body?.session_id || input.body?.sessionId || "").trim();
  const callId = `exit-probe-${randomUUID()}`;
  const workspace = dataPath("projects", projectId);
  const runtime = createAgentRuntime({
    ctx,
    stream: null,
    runId,
    sessionId,
    projectId,
    userId: ctx.userId || "",
    mode: "diagnostic_recovery",
  });
  try {
    await runtime.beginToolCall({
      callId,
      toolName: "bash",
      accessMode: "read",
      input: { command: "/bin/sleep 30" },
    });
    const child = spawn("/bin/sleep", ["30"], { cwd: workspace, stdio: "ignore" });
    void new Promise((resolve, reject) => {
      child.once("exit", (code) => code === 0 ? resolve({ code }) : reject(new Error(`sleep exited ${code}`)));
      child.once("error", reject);
    }).then(
      (result) => runtime.finishToolCall({
        callId,
        toolName: "bash",
        ok: true,
        result,
        outputSummary: "electron exit probe completed",
      }),
      (error) => runtime.finishToolCall({
        callId,
        toolName: "bash",
        ok: false,
        error,
        outputSummary: error?.message || String(error),
      }),
    ).catch(() => {});
    const commandPid = Number(child.pid || 0) || null;
    const runnerPid = process.pid;
    if (!commandPid) throw new ApiError("无法启动 Electron 退出故障探针", 500);
    await runtime.recordEvent({
      eventType: "electron_exit_diagnostic_running",
      status: "recovering",
      metadata: { runner_pid: runnerPid, command_pid: commandPid, call_id: callId },
    });
    return {
      data: {
        ...data,
        probe_call_id: callId,
        runner_pid: runnerPid,
        command_pid: commandPid,
      },
      message: "Electron 退出诊断运行中",
    };
  } catch (error) {
    throw error;
  }
}

export default { prepareRunRecoveryDiagnostic, prepareRunningElectronExitDiagnostic };
