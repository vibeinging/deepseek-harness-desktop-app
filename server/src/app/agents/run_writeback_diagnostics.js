import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { ApiError } from "../../errors.js";
import { approvalArgsFingerprint, wrapToolsWithDeferredApprovals } from "../../engine/agents/deferred_approval_tools.js";
import { createProductTools } from "../../engine/agents/product_tools.js";
import { wrapToolsWithRunFacts } from "../../engine/agents/run_fact_store.js";
import {
  createAgentRuntime,
  resolvePendingApproval,
} from "../../engine/agents/agent_run_runtime.js";
import { removeRunnerRunDirectory } from "../../engine/runner/run_paths.js";
import { requireProjectOwner } from "../projects/access.js";

function assertEvalMode() {
  if (!process.env.DSH_EVAL_MODE && process.env.NODE_ENV !== "test") {
    throw new ApiError("运行写回诊断只在 Eval 环境可用", 404);
  }
}

async function cleanupDiagnosticRuns(ctx, runIds) {
  const ids = [...new Set((Array.isArray(runIds) ? runIds : []).map(String).filter((id) => id.startsWith("writeback-diagnostic-")))];
  const removed = [];
  for (const runId of ids) {
    const run = await ctx.queryOne(
      "SELECT id FROM agent_runs WHERE id=$1 AND user_id=$2 LIMIT 1",
      [runId, ctx.userId || ""],
    );
    if (!run) continue;
    const directory = await removeRunnerRunDirectory(runId).catch((error) => ({ removed: false, error: error?.code || error?.message }));
    for (const table of ["agent_pending_inputs", "agent_run_events", "agent_tool_calls", "agent_artifacts", "agent_evidence_bundles"]) {
      await ctx.query(`DELETE FROM ${table} WHERE run_id=$1`, [runId]);
    }
    await ctx.query("DELETE FROM agent_runs WHERE id=$1", [runId]);
    removed.push({ run_id: runId, ...directory });
  }
  return removed;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function diagnoseRunWriteback(ctx, input) {
  assertEvalMode();
  if (input.body?.action === "cleanup") {
    return { data: { removed: await cleanupDiagnosticRuns(ctx, input.body?.run_ids) }, message: "运行写回诊断已清理" };
  }
  const projectId = String(input.body?.project_id || "").trim();
  const sessionId = String(input.body?.session_id || "").trim();
  const ruleType = String(input.body?.rule_type || "sql").trim();
  const content = String(input.body?.content || "").trim();
  const operation = String(input.body?.operation || "append").trim();
  if (!(projectId && sessionId && content)) throw new ApiError("缺少 project_id、session_id 或 content", 400);
  await requireProjectOwner(ctx, projectId);
  const session = await ctx.queryOne(
    `SELECT id FROM sessions
      WHERE id=$1 AND project_id=$2 AND created_by=$3 AND deleted_at IS NULL LIMIT 1`,
    [sessionId, projectId, ctx.userId || ""],
  );
  if (!session) throw new ApiError("诊断会话不存在", 404);

  const runId = `writeback-diagnostic-${randomUUID()}`;
  const callId = `writeback-rules-${randomUUID()}`;
  const runtime = createAgentRuntime({
    ctx,
    stream: null,
    runId,
    sessionId,
    projectId,
    userId: ctx.userId || "",
    skill: "project-rules-configuration",
    mode: "writeback_diagnostic",
  });
  const created = await runtime.createRun();
  if (!created) throw new ApiError("无法创建运行写回诊断", 500);

  try {
    await runtime.captureEnvironment({
      approvalPolicy: "ask",
      sandboxPolicy: {
        mode: "workspace-write",
        system_enforced: true,
        network: "blocked",
        write_scope: "run-workspace-only",
      },
    });
    const agentContext = {
      db: { query: ctx.query, queryOne: ctx.queryOne },
      user_id: ctx.userId || "",
      project_id: projectId,
      session_id: sessionId,
      task_id: runId,
      runtime,
      input_data: { user_message: "Eval 运行写回诊断", project_id: projectId, session_id: sessionId },
      data: {},
    };
    const productTools = createProductTools(agentContext);
    const readTool = productTools.find((tool) => tool.name === "project_rules_get");
    const raw = productTools.find((tool) => tool.name === "project_rules_update");
    if (!raw) throw new ApiError("项目规则写回工具不可用", 500);
    const readRules = async () => (await readTool.execute("writeback-read", {
      project_id: projectId,
      rule_type: ruleType,
    }))?.details;
    const [factTool] = wrapToolsWithRunFacts([raw], runtime, { classify: () => "write" });
    const [tool] = wrapToolsWithDeferredApprovals([factTool], {
      approvalPolicy: {
        needsConfirm: () => true,
        approvalRequest: () => ({
          action: "写回项目规则",
          risk: "project_configuration_write",
          approval_scope: "once",
        }),
      },
      runtime,
      agentContext,
      streamCallback: async () => {},
    });
    const args = { project_id: projectId, rule_type: ruleType, operation, content };
    const before = await readRules();
    const pendingResult = await tool.execute(callId, args);
    const afterStage = await readRules();
    const pending = await ctx.queryOne(
      `SELECT request_id, status, payload_json FROM agent_pending_inputs
        WHERE run_id=$1 AND request_id=$2 AND input_type='approval' LIMIT 1`,
      [runId, callId],
    );
    const resolved = await resolvePendingApproval(ctx, {
      sessionId,
      requestId: callId,
      runId,
      approved: true,
      userId: ctx.userId || "",
    });
    agentContext.approvalGrant = {
      approved: true,
      request_id: callId,
      tool_name: "project_rules_update",
      args_fingerprint: approvalArgsFingerprint(args),
      consumed: false,
    };
    const appliedResult = await tool.execute(callId, args);
    const afterApply = await readRules();
    await runtime.completeRun("completed");
    const artifacts = await ctx.query(
      `SELECT kind, path, sha256, metadata_json FROM agent_artifacts
        WHERE run_id=$1 AND kind IN ('writeback_proposal','writeback_receipt') ORDER BY created_at ASC`,
      [runId],
    );
    const proposalArtifact = artifacts.find((item) => item.kind === "writeback_proposal") || null;
    const receiptArtifact = artifacts.find((item) => item.kind === "writeback_receipt") || null;
    return {
      data: {
        version: "agent_run_writeback_diagnostic.v1",
        run_id: runId,
        call_id: callId,
        before,
        after_stage: afterStage,
        after_apply: afterApply,
        pending: pending ? { ...pending, payload: JSON.parse(pending.payload_json || "{}"), payload_json: undefined } : null,
        pending_result: pendingResult?.details || null,
        resolved: { status: resolved.status, approved: resolved.approved, recorded: resolved.recorded },
        applied_result: appliedResult?.details || null,
        artifacts,
        proposal: proposalArtifact?.path ? await readJson(proposalArtifact.path) : null,
        receipt: receiptArtifact?.path ? await readJson(receiptArtifact.path) : null,
      },
      message: "运行写回诊断通过",
    };
  } catch (error) {
    await runtime.completeRun("failed").catch(() => null);
    throw error;
  }
}

export default { diagnoseRunWriteback };
