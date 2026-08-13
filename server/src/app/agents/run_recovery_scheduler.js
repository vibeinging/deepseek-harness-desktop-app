import { readFile } from "node:fs/promises";

import { agentChat } from "../chat/agent_chat.js";
import {
  appendRunEvent,
  beginToolCall,
  finalizeRecoveredConversationTurn,
  releaseRunLease,
  transitionAgentRun,
} from "../../engine/agents/run_fact_store.js";

const activeRecoveries = new Set();

function parseJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function recoveryInput(run) {
  const skill = String(run.skill_name || "").trim() || null;
  const body = {
    message: "继续完成中断前的任务。",
    display_message: "",
    resume_run_id: run.id,
    skill,
    invoked_by: "startup_recovery",
    skill_decision: skill
      ? {
        skill_name: skill,
        runtime: "prompt",
        reason: "startup_recovery",
        normalized_message: "继续完成中断前的任务。",
      }
      : null,
  };
  return {
    params: { pid: run.project_id, sid: run.session_id },
    body,
    resumeRunId: run.id,
  };
}

async function recoverDiagnosticRun(ctx, run) {
  const checkpoint = parseJson(run.checkpoint_json, {});
  const callId = String(checkpoint.call_id || "").trim();
  const artifactPath = String(checkpoint.artifact_path || "").trim();
  const marker = String(checkpoint.marker || "");
  if (!(callId && artifactPath && marker)) {
    const error = new Error("诊断恢复点不完整");
    error.code = "AGENT_RECOVERY_CHECKPOINT_INVALID";
    throw error;
  }
  const replay = await beginToolCall(ctx, {
    runId: run.id,
    turnId: run.turn_id || run.id,
    callId,
    toolName: "write",
    accessMode: "write",
    input: { path: artifactPath, content: marker },
  });
  if (replay.action !== "replay") {
    const error = new Error(`恢复写调用没有复用已保存结果：${replay.action}`);
    error.code = replay.code || "AGENT_RECOVERY_REPLAY_REQUIRED";
    throw error;
  }
  const content = await readFile(artifactPath, "utf8");
  if (content !== marker) {
    const error = new Error("恢复诊断文件内容不一致");
    error.code = "AGENT_RECOVERY_ARTIFACT_MISMATCH";
    throw error;
  }
  await transitionAgentRun(ctx, {
    runId: run.id,
    status: "completed",
    eventType: "run_recovery_completed",
    eventMetadata: { diagnostic: true, replayed_call_id: callId },
    finished: true,
  });
  await releaseRunLease(ctx, { runId: run.id, owner: null }).catch(() => {});
  return { run_id: run.id, status: "completed", diagnostic: true };
}

export async function executeAgentRecovery(ctx, run, { signal, emit = () => {} } = {}) {
  if (run.mode === "diagnostic_recovery") return recoverDiagnosticRun(ctx, run);
  return agentChat(
    { ...ctx, userId: run.user_id || "", signal },
    recoveryInput(run),
    emit,
  );
}

export async function resumeRecoverableAgentRuns(ctx, {
  runIds = null,
  signal = null,
  emit = () => {},
  execute = executeAgentRecovery,
  source = "server_startup",
} = {}) {
  const ids = Array.isArray(runIds) ? runIds.map(String).filter(Boolean) : [];
  const params = [];
  let idWhere = "";
  if (ids.length) {
    params.push(ids);
    idWhere = "AND id = ANY($1::text[])";
  }
  const rows = await ctx.query(
    `SELECT * FROM agent_runs
      WHERE deleted_at IS NULL
        AND status='recovering'
        AND recoverable=1
        AND session_id IS NOT NULL
        AND project_id IS NOT NULL
        ${idWhere}
      ORDER BY COALESCE(updated_at, created_at) ASC`,
    params,
  );
  const results = [];
  for (const run of rows) {
    if (signal?.aborted) break;
    if (activeRecoveries.has(run.id)) continue;
    activeRecoveries.add(run.id);
    try {
      await appendRunEvent(ctx, {
        runId: run.id,
        turnId: run.turn_id || run.id,
        eventType: "run_recovery_dispatched",
        status: "recovering",
        metadata: { mode: run.mode, source },
      });
      await execute(ctx, run, { signal, emit });
      const current = await ctx.queryOne(
        "SELECT status FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1",
        [run.id],
      );
      results.push({ run_id: run.id, status: current?.status || "unknown" });
    } catch (error) {
      const interrupted = Boolean(signal?.aborted);
      await transitionAgentRun(ctx, {
        runId: run.id,
        status: interrupted ? "interrupted" : "failed",
        eventType: interrupted ? "run_recovery_interrupted" : "run_recovery_failed",
        eventMetadata: { error: error?.message || String(error), error_code: error?.code || null },
        finished: !interrupted,
      }).catch(() => null);
      await finalizeRecoveredConversationTurn(ctx, {
        runId: run.id,
        sessionId: run.session_id,
        status: interrupted ? "interrupted" : "failed",
        reason: interrupted ? "recovery_aborted" : "recovery_failed",
      }).catch(() => null);
      results.push({
        run_id: run.id,
        status: interrupted ? "interrupted" : "failed",
        error: error?.message || String(error),
      });
    } finally {
      activeRecoveries.delete(run.id);
    }
  }
  return results;
}

export function clearActiveRecoveriesForTests() {
  activeRecoveries.clear();
}

export default { executeAgentRecovery, resumeRecoverableAgentRuns };
