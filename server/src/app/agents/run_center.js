import { createHash } from "node:crypto";
import { ApiError } from "../../errors.js";
import { activeRunSnapshot, stopActiveRun } from "../../engine/agents/active_run_registry.js";
import { normalizeRunStatus, transitionAgentRun } from "../../engine/agents/run_fact_store.js";
import { readRunEnvironmentSnapshot } from "../../engine/agents/run_environment_snapshot.js";
import { measureDirectoryBytes } from "../../engine/agents/run_storage_policy.js";
import { removeRunnerRunDirectory } from "../../engine/runner/run_paths.js";
import { findAgentRuntimeByThread, getAgentRuntime } from "../../engine/agent_kernel/agent_runtime.js";
import { summarizeNativeCollaborationEvents } from "../../engine/agent_kernel/native_collaboration.js";
import { resumeRecoverableAgentRuns } from "./run_recovery_scheduler.js";

const CLOSED_RUN_STATUSES = new Set(["completed", "failed", "expired", "interrupted"]);

function json(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicRun(row) {
  if (!row) return null;
  return {
    ...row,
    status: normalizeRunStatus(row.status),
    checkpoint: json(row.checkpoint_json, {}),
    metadata: json(row.metadata_json, {}),
    checkpoint_json: undefined,
    metadata_json: undefined,
    live: Boolean(activeRunSnapshot(row.id)),
  };
}

async function ownedRun(ctx, runId) {
  const row = await ctx.queryOne(
    `SELECT * FROM agent_runs
      WHERE id=$1 AND deleted_at IS NULL
        AND user_id=$2
        AND (project_id='__chat__' OR EXISTS (
          SELECT 1 FROM project_members pm
           WHERE pm.project_id=agent_runs.project_id AND pm.user_id=$2 AND pm.deleted_at IS NULL
        ))
      LIMIT 1`,
    [runId, ctx.userId || ""],
  );
  if (!row) throw new ApiError("运行不存在", 404);
  return row;
}

export async function listAgentRuns(ctx, input) {
  const projectId = String(input.params?.pid || "").trim();
  const sessionId = String(input.query?.session_id || input.query?.sessionId || "").trim();
  const limit = Math.max(1, Math.min(100, Number(input.query?.limit || 30)));
  const archived = input.query?.archived === "1" || input.query?.archived === "true";
  const params = [projectId, ctx.userId || ""];
  let sessionWhere = "";
  if (sessionId) {
    params.push(sessionId);
    sessionWhere = `AND session_id=$${params.length}`;
  }
  params.push(limit);
  const rows = await ctx.query(
    `SELECT * FROM agent_runs
      WHERE project_id=$1 AND deleted_at IS NULL
        AND COALESCE(mode,'') NOT IN ('subtask','temporary')
        AND ${archived ? "archived_at IS NOT NULL" : "archived_at IS NULL"}
        AND user_id=$2
        AND (project_id='__chat__' OR EXISTS (
          SELECT 1 FROM project_members pm
           WHERE pm.project_id=agent_runs.project_id AND pm.user_id=$2 AND pm.deleted_at IS NULL
        ))
        ${sessionWhere}
      ORDER BY COALESCE(updated_at, created_at) DESC
      LIMIT $${params.length}`,
    params,
  );
  return { data: { items: rows.map(publicRun) }, message: "ok" };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function impactHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stable(value))).digest("hex")}`;
}

async function deletionImpact(ctx, run) {
  const [events, tools, artifacts, pending, evidence, subtasks] = await Promise.all([
    ctx.queryOne("SELECT COUNT(*) AS count FROM agent_run_events WHERE run_id=$1", [run.id]),
    ctx.queryOne("SELECT COUNT(*) AS count FROM agent_tool_calls WHERE run_id=$1", [run.id]),
    ctx.query("SELECT path FROM agent_artifacts WHERE run_id=$1", [run.id]),
    ctx.queryOne("SELECT COUNT(*) AS count FROM agent_pending_inputs WHERE run_id=$1", [run.id]),
    ctx.queryOne("SELECT COUNT(*) AS count FROM agent_evidence_bundles WHERE run_id=$1 AND deleted_at IS NULL", [run.id]),
    ctx.queryOne("SELECT COUNT(*) AS count FROM agent_subtask_runs WHERE parent_run_id=$1", [run.id]),
  ]);
  const workspacePath = String(run.workspace_path || "");
  const usage = workspacePath
    ? await measureDirectoryBytes(workspacePath).catch(() => ({ path: workspacePath, bytes: 0, files: 0, directories: 0, symlinks: 0 }))
    : { path: workspacePath, bytes: 0, files: 0, directories: 0, symlinks: 0 };
  const internalArtifacts = artifacts.filter((item) => workspacePath && String(item.path || "").startsWith(`${workspacePath}/`)).length;
  const comparable = {
    run_id: run.id,
    status: normalizeRunStatus(run.status),
    workspace: usage,
    facts: {
      events: Number(events?.count || 0),
      tools: Number(tools?.count || 0),
      artifacts: artifacts.length,
      pending_inputs: Number(pending?.count || 0),
      evidence_bundles: Number(evidence?.count || 0),
      subtasks: Number(subtasks?.count || 0),
    },
    internal_artifacts: internalArtifacts,
    external_artifacts_preserved: Math.max(0, artifacts.length - internalArtifacts),
    evidence_protected: Number(evidence?.count || 0) > 0,
  };
  return { ...comparable, impact_hash: impactHash(comparable) };
}

export async function getAgentRunDeletionImpact(ctx, input) {
  const run = await ownedRun(ctx, input.params.runId);
  return { data: await deletionImpact(ctx, run), message: "删除前影响已计算" };
}

export async function archiveAgentRun(ctx, input) {
  const run = await ownedRun(ctx, input.params.runId);
  const status = normalizeRunStatus(run.status);
  if (!CLOSED_RUN_STATUSES.has(status)) throw new ApiError("运行结束后才能归档", 409);
  await ctx.query(
    `UPDATE agent_runs SET archived_at=COALESCE(archived_at,now()), archived_by=COALESCE(archived_by,$2),
       retention_until=NULL, updated_at=now() WHERE id=$1`,
    [run.id, ctx.userId || null],
  );
  return { data: { run: publicRun(await ownedRun(ctx, run.id)) }, message: "运行已归档" };
}

export async function deleteAgentRun(ctx, input) {
  const run = await ownedRun(ctx, input.params.runId);
  const status = normalizeRunStatus(run.status);
  if (!CLOSED_RUN_STATUSES.has(status)) throw new ApiError("运行结束后才能删除", 409);
  const impact = await deletionImpact(ctx, run);
  const confirmedHash = String(input.body?.impact_hash || "");
  if (!confirmedHash || confirmedHash !== impact.impact_hash) throw new ApiError("删除影响已经变化，请重新确认", 409);
  if (impact.evidence_protected && input.body?.force !== true) {
    throw new ApiError("该运行绑定了证据包，必须明确选择强制删除", 409);
  }
  const directory = await removeRunnerRunDirectory(run.id);
  const childRuns = await ctx.query("SELECT run_id FROM agent_subtask_runs WHERE parent_run_id=$1", [run.id]);
  for (const child of childRuns) {
    await ctx.query("DELETE FROM agent_run_events WHERE run_id=$1", [child.run_id]);
    await ctx.query(
      "UPDATE agent_runs SET deleted_at=now(),deleted_by=$2,updated_at=now() WHERE id=$1",
      [child.run_id, ctx.userId || "user"],
    );
  }
  await ctx.query("DELETE FROM agent_subtask_runs WHERE parent_run_id=$1", [run.id]);
  const queryExecutions = await ctx.query("SELECT id FROM query_executions WHERE parent_run_id=$1", [run.id]);
  for (const execution of queryExecutions) {
    await ctx.query("DELETE FROM query_executions WHERE id=$1", [execution.id]);
  }
  for (const table of ["agent_pending_inputs", "agent_run_events", "agent_tool_calls", "agent_artifacts", "agent_evidence_bundles"]) {
    await ctx.query(`DELETE FROM ${table} WHERE run_id=$1`, [run.id]);
  }
  await ctx.query(
    `UPDATE agent_runs SET checkpoint_json=NULL, metadata_json=NULL, last_event_seq=0,
       deleted_at=now(), deleted_by=$2, updated_at=now() WHERE id=$1`,
    [run.id, ctx.userId || "user"],
  );
  return { data: { run_id: run.id, deleted: true, directory, impact }, message: "运行已删除" };
}

export async function getAgentRun(ctx, input) {
  const run = await ownedRun(ctx, input.params.runId);
  const queryExecution = await ctx.queryOne(
    `SELECT * FROM query_executions WHERE parent_run_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [run.id],
  );
  const [events, tools, artifacts, evidenceBundles, subtasks] = await Promise.all([
    ctx.query(`SELECT * FROM agent_run_events WHERE run_id=$1 ORDER BY seq ASC`, [run.id]),
    ctx.query(`SELECT * FROM agent_tool_calls WHERE run_id=$1 ORDER BY created_at ASC`, [run.id]),
    ctx.query(`SELECT * FROM agent_artifacts WHERE run_id=$1 ORDER BY created_at ASC`, [run.id]),
    ctx.query(`SELECT * FROM agent_evidence_bundles WHERE run_id=$1 AND deleted_at IS NULL ORDER BY created_at ASC`, [run.id]),
    ctx.query(`SELECT * FROM agent_subtask_runs WHERE parent_run_id=$1 ORDER BY created_at ASC`, [run.id]),
  ]);
  const publicEvents = events.map((event) => ({ ...event, metadata: json(event.metadata_json, {}), metadata_json: undefined }));
  return {
    data: {
      run: publicRun(run),
      events: publicEvents,
      subagents: summarizeNativeCollaborationEvents(publicEvents),
      tools: tools.map((tool) => ({
        ...tool,
        input: json(tool.input_json, null),
        result: json(tool.result_json, null),
        input_json: undefined,
        result_json: undefined,
      })),
      artifacts: artifacts.map((artifact) => ({
        ...artifact,
        metadata: json(artifact.metadata_json, {}),
        metadata_json: undefined,
      })),
      evidence_bundles: evidenceBundles.map((bundle) => ({
        id: bundle.id,
        final_item_id: bundle.final_item_id,
        status: bundle.status,
        snapshot_hash: bundle.snapshot_hash,
        bundle_version: bundle.bundle_version,
        created_at: bundle.created_at,
      })),
      query_execution: queryExecution || null,
      subtasks: subtasks.map((subtask) => {
        const inputSnapshot = json(subtask.input_snapshot, {});
        const resultSnapshot = json(subtask.result_snapshot, null);
        return {
          ...subtask,
          task_id: inputSnapshot.task_id || null,
          step_index: inputSnapshot.step_index ?? null,
          source_kind: inputSnapshot.source_kind || "",
          source_name: inputSnapshot.source_name || "",
          depends_on: inputSnapshot.depends_on || [],
          output_alias: inputSnapshot.output_alias || "",
          tool_allowlist: json(subtask.tool_allowlist, []),
          tool_calls: resultSnapshot?.tool_calls || [],
          input_snapshot: inputSnapshot,
          result_snapshot: resultSnapshot,
          evidence_refs: json(subtask.evidence_refs, []),
          validation_refs: json(subtask.validation_refs, []),
        };
      }),
    },
    message: "ok",
  };
}

async function ownedNativeSubagent(ctx, runId, threadId) {
  const run = await ownedRun(ctx, runId);
  const events = await ctx.query(
    `SELECT * FROM agent_run_events
      WHERE run_id=$1 AND event_type LIKE 'native_collaboration_%'
      ORDER BY seq ASC`,
    [run.id],
  );
  const publicEvents = events.map((event) => ({ ...event, metadata: json(event.metadata_json, {}) }));
  const record = summarizeNativeCollaborationEvents(publicEvents)
    .find((item) => item.thread_id === String(threadId || ""));
  if (!record) throw new ApiError("协作子任务不存在", 404);
  return { run, record };
}

function collaborationRuntime(record) {
  return findAgentRuntimeByThread(record.thread_id)
    || findAgentRuntimeByThread(record.parent_thread_id)
    || getAgentRuntime({ runtimeKey: "collaboration-inspector" });
}

export async function getAgentSubagentThread(ctx, input) {
  const { record } = await ownedNativeSubagent(ctx, input.params.runId, input.params.threadId);
  const response = await collaborationRuntime(record).readThread(record.thread_id, { includeTurns: true });
  return {
    data: { subagent: record, thread: response?.thread || null },
    message: "ok",
  };
}

export async function stopAgentSubagentThread(ctx, input) {
  const { record } = await ownedNativeSubagent(ctx, input.params.runId, input.params.threadId);
  const runtime = findAgentRuntimeByThread(record.thread_id) || findAgentRuntimeByThread(record.parent_thread_id);
  if (!runtime) throw new ApiError("协作子任务已经结束，当前没有可停止的本地运行", 409);
  const result = await runtime.interruptThread(record.thread_id);
  if (!result.interrupted) throw new ApiError("协作子任务已经结束", 409);
  return { data: { subagent: record, ...result }, message: "已停止协作子任务" };
}

export async function getAgentRunEnvironment(ctx, input) {
  const run = await ownedRun(ctx, input.params.runId);
  if (!run.environment_snapshot_path) throw new ApiError("运行环境快照不存在", 404);
  try {
    return { data: await readRunEnvironmentSnapshot(run.id), message: "ok" };
  } catch (error) {
    if (error?.code === "ENOENT") throw new ApiError("运行环境快照不存在", 404);
    throw error;
  }
}

export async function stopAgentRun(ctx, input) {
  const run = await ownedRun(ctx, input.params.runId);
  const status = normalizeRunStatus(run.status);
  if (CLOSED_RUN_STATUSES.has(status)) {
    return { data: { run: publicRun(run), stopped: false, reason: "already_finished" }, message: "运行已结束" };
  }
  const live = await stopActiveRun(run.id, "user_stop", { waitForSettlementMs: 10_000 });
  let updated = await ownedRun(ctx, run.id);
  if (!CLOSED_RUN_STATUSES.has(normalizeRunStatus(updated.status))) {
    await transitionAgentRun(ctx, {
      runId: run.id,
      status: "interrupted",
      eventType: "run_stop_requested",
      eventMetadata: { live_process_found: live.found, live_settled: live.settled === true },
    }).catch(() => null);
    updated = await ownedRun(ctx, run.id);
  }
  const durableClosed = CLOSED_RUN_STATUSES.has(normalizeRunStatus(updated.status));
  const settled = live.found ? live.settled === true : durableClosed;
  return {
    data: {
      run: publicRun(updated),
      stopped: durableClosed,
      live: live.found,
      settled,
    },
    message: settled ? "已停止运行" : "已请求停止，运行仍在收尾",
  };
}

function scheduleRunRecovery(ctx, runId) {
  setImmediate(() => {
    void resumeRecoverableAgentRuns(
      { query: ctx.query, queryOne: ctx.queryOne },
      { runIds: [runId], source: "run_center" },
    ).catch((error) => {
      console.warn(`[run_center] 恢复调度失败 run=${runId}:`, error?.message || error);
    });
  });
}

export async function prepareAgentRunRecovery(ctx, input, { schedule = scheduleRunRecovery } = {}) {
  const run = await ownedRun(ctx, input.params.runId);
  const status = normalizeRunStatus(run.status);
  if (!["interrupted", "failed", "recovering"].includes(status) || !Number(run.recoverable || 0)) {
    throw new ApiError("这个运行没有可用恢复点", 409);
  }
  await transitionAgentRun(ctx, {
    runId: run.id,
    status: "recovering",
    eventType: "run_recovery_requested",
    eventMetadata: { requested_by: ctx.userId || null },
  });
  const updated = await ownedRun(ctx, run.id);
  const dispatched = input.body?.dispatch === true;
  if (dispatched) schedule(ctx, run.id);
  return {
    data: {
      run: publicRun(updated),
      resume: {
        run_id: run.id,
        session_id: run.session_id,
        project_id: run.project_id,
        checkpoint: json(run.checkpoint_json, {}),
        dispatched,
      },
    },
    message: dispatched ? "运行恢复已开始" : "运行已进入恢复状态",
  };
}

export default {
  archiveAgentRun,
  deleteAgentRun,
  getAgentRun,
  getAgentSubagentThread,
  getAgentRunDeletionImpact,
  listAgentRuns,
  prepareAgentRunRecovery,
  stopAgentRun,
  stopAgentSubagentThread,
};
