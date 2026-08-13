import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { dataPath } from "../../config/paths.js";
import { ApiError } from "../../errors.js";
import { cleanupExpiredRunFacts } from "../../engine/agents/run_fact_store.js";
import { createAgentRuntime } from "../../engine/agents/agent_run_runtime.js";
import { runnerRunDirectory } from "../../engine/runner/run_paths.js";
import { requireProjectOwner } from "../projects/access.js";

function assertEvalMode() {
  if (!process.env.DSH_EVAL_MODE && process.env.NODE_ENV !== "test") {
    throw new ApiError("保留期诊断只在 Eval 环境可用", 404);
  }
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function childFactCounts(ctx, runId) {
  const [events, tools, artifacts, inputs, evidenceBundles] = await Promise.all([
    ctx.queryOne(`SELECT COUNT(*) AS count FROM agent_run_events WHERE run_id=$1`, [runId]),
    ctx.queryOne(`SELECT COUNT(*) AS count FROM agent_tool_calls WHERE run_id=$1`, [runId]),
    ctx.queryOne(`SELECT COUNT(*) AS count FROM agent_artifacts WHERE run_id=$1`, [runId]),
    ctx.queryOne(`SELECT COUNT(*) AS count FROM agent_pending_inputs WHERE run_id=$1`, [runId]),
    ctx.queryOne(`SELECT COUNT(*) AS count FROM agent_evidence_bundles WHERE run_id=$1`, [runId]),
  ]);
  return {
    events: Number(events?.count || 0),
    tools: Number(tools?.count || 0),
    artifacts: Number(artifacts?.count || 0),
    pending_inputs: Number(inputs?.count || 0),
    evidence_bundles: Number(evidenceBundles?.count || 0),
  };
}

export async function prepareRunRetentionDiagnostic(ctx, input) {
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

  const runId = `retention-diagnostic-${randomUUID()}`;
  const callId = `write-${randomUUID()}`;
  const marker = `retention-${randomUUID()}`;
  const workspace = dataPath("projects", projectId);
  const artifactPath = join(workspace, `${runId}-retained.txt`);
  await mkdir(workspace, { recursive: true });
  const runtime = createAgentRuntime({
    ctx,
    stream: null,
    runId,
    sessionId,
    projectId,
    userId: ctx.userId || "",
    mode: "diagnostic_retention",
  });
  const created = await runtime.createRun();
  if (!created) throw new ApiError("无法创建保留期诊断运行", 500);

  const runRoot = runnerRunDirectory(runId);
  const runTempPath = join(runRoot, "retention-marker.txt");
  await mkdir(runRoot, { recursive: true });
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
      outputSummary: "retention diagnostic artifact written",
    });
    await runtime.recordArtifact({
      callId,
      kind: "file",
      path: artifactPath,
      metadata: { diagnostic: true, retained: true },
    });
    await writeFile(runTempPath, marker, { mode: 0o600 });
    await runtime.saveCheckpoint({
      diagnostic: true,
      marker,
      artifact_path: artifactPath,
      run_temp_path: runTempPath,
    }, { source: "retention_diagnostic" });
    await runtime.completeRun("completed");
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    await ctx.query(`UPDATE agent_runs SET retention_until=$2 WHERE id=$1`, [runId, expiredAt]);
    return {
      data: {
        run_id: runId,
        call_id: callId,
        marker,
        artifact_path: artifactPath,
        run_temp_path: runTempPath,
        retention_until: expiredAt,
      },
      message: "保留期诊断已准备",
    };
  } catch (error) {
    await runtime.completeRun("failed").catch(() => {});
    throw error;
  } finally { /* no separate runner process */ }
}

export async function cleanupRunRetentionDiagnostic(ctx, input) {
  assertEvalMode();
  const runId = String(input.body?.run_id || input.body?.runId || "").trim();
  if (!runId) throw new ApiError("缺少 run_id", 400);
  const run = await ctx.queryOne(
    `SELECT id, project_id, checkpoint_json, deleted_at
       FROM agent_runs WHERE id=$1 LIMIT 1`,
    [runId],
  );
  if (!run || run.deleted_at) throw new ApiError("诊断运行不存在", 404);
  await requireProjectOwner(ctx, run.project_id);
  let checkpoint = {};
  try { checkpoint = JSON.parse(run.checkpoint_json || "{}"); } catch { checkpoint = {}; }
  if (checkpoint?.diagnostic !== true || !String(runId).startsWith("retention-diagnostic-")) {
    throw new ApiError("只允许清理保留期诊断运行", 400);
  }
  const artifactPath = String(checkpoint.artifact_path || "");
  const runTempPath = String(checkpoint.run_temp_path || "");
  const marker = String(checkpoint.marker || "");
  const before = {
    run_temp_exists: await exists(runTempPath),
    artifact_exists: await exists(artifactPath),
    artifact_content: artifactPath ? await readFile(artifactPath, "utf8").catch(() => "") : "",
    facts: await childFactCounts(ctx, runId),
  };
  const cleanup = await cleanupExpiredRunFacts(ctx, { now: new Date().toISOString() });
  const deleted = await ctx.queryOne(
    `SELECT id, deleted_at, deleted_by, checkpoint_json FROM agent_runs WHERE id=$1 LIMIT 1`,
    [runId],
  );
  const after = {
    run_temp_exists: await exists(runTempPath),
    artifact_exists: await exists(artifactPath),
    artifact_content: artifactPath ? await readFile(artifactPath, "utf8").catch(() => "") : "",
    facts: await childFactCounts(ctx, runId),
  };
  return {
    data: {
      run_id: runId,
      marker,
      cleanup,
      before,
      after,
      run: deleted,
    },
    message: "保留期诊断清理完成",
  };
}

export default { prepareRunRetentionDiagnostic, cleanupRunRetentionDiagnostic };
