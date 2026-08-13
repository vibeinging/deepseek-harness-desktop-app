import { randomUUID } from "node:crypto";

import { ApiError } from "../../errors.js";
import { requireProjectMember } from "../projects/access.js";
import { agentChat } from "../chat/agent_chat.js";
import {
  internalAutomationExecutionShape,
  nextAutomationRunAt,
  verifyAutomationSkillSnapshot,
} from "./automations.js";
import {
  automationFingerprint,
  getAutomationRunContext,
  readAutomationState,
  saveAutomationRunContext,
  updateAutomationRunChange,
  writeAutomationState,
} from "./automation_runtime_store.js";

const LEASE_MS = 10 * 60 * 1000;

function parseJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function clean(value, max = 4_000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function addMs(value, ms) {
  return new Date(new Date(value).getTime() + ms).toISOString();
}

function automationRunShape(row, context = null) {
  if (!row) return null;
  return {
    id: row.id,
    automation_id: row.automation_id,
    run_id: row.run_id || null,
    project_id: row.project_id,
    session_id: row.session_id || null,
    status: row.status,
    inbox_status: row.inbox_status,
    requires_attention: Boolean(row.requires_attention),
    summary: row.summary || null,
    error_code: row.error_code || null,
    error_message: row.error_message || null,
    evidence_bundle_id: row.evidence_bundle_id || null,
    trigger_type: context?.trigger_type || "manual",
    scheduled_for: context?.scheduled_for || null,
    trigger: context?.trigger || {},
    event_id: context?.event_id || null,
    change_status: context?.change_status || null,
    output_fingerprint: context?.output_fingerprint || null,
    skill_snapshot: context?.skill_snapshot || [],
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function automationRunWithPending(ctx, row) {
  const context = row?.id ? await getAutomationRunContext(ctx, row.id).catch(() => null) : null;
  const shaped = automationRunShape(row, context);
  if (!shaped?.run_id) return { ...shaped, pending_action: null };
  const pending = await ctx.queryOne(
    `SELECT request_id, input_type, payload_json, resume_handle_json, resume_expires_at, created_at
       FROM agent_pending_inputs
      WHERE run_id=$1 AND status='pending' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [shaped.run_id],
  );
  return {
    ...shaped,
    pending_action: pending
      ? {
          request_id: pending.request_id,
          action_type: pending.input_type,
          payload: parseJson(pending.payload_json, {}),
          resume_handle: parseJson(pending.resume_handle_json, null),
          resume_expires_at: pending.resume_expires_at || null,
          created_at: pending.created_at,
        }
      : null,
  };
}

async function acquireAutomation(ctx, automationId, { owner, now, trustedScheduler = false }) {
  return ctx.queryOne(
    `UPDATE agent_automations SET lease_owner=$2, lease_expires_at=$3, updated_at=now()
      WHERE id=$1 AND deleted_at IS NULL
        AND (lease_expires_at IS NULL OR lease_expires_at <= $4 OR lease_owner=$2)
        AND ($6=true OR user_id=$5)
      RETURNING *`,
    [automationId, owner, addMs(now, LEASE_MS), now, ctx.userId || "", trustedScheduler === true],
  );
}

async function releaseAutomation(ctx, automationId, owner) {
  await ctx.query(
    "UPDATE agent_automations SET lease_owner=NULL, lease_expires_at=NULL, updated_at=now() WHERE id=$1 AND lease_owner=$2",
    [automationId, owner],
  );
}

async function heartbeatAutomation(ctx, automationId, owner) {
  await ctx.query(
    `UPDATE agent_automations SET lease_expires_at=$3, updated_at=now()
      WHERE id=$1 AND lease_owner=$2 AND deleted_at IS NULL`,
    [automationId, owner, addMs(new Date().toISOString(), LEASE_MS)],
  );
}

async function createStandaloneSession(ctx, automation) {
  const sessionId = randomUUID();
  const time = new Date().toLocaleString("zh-CN", { hour12: false });
  await ctx.query(
    `INSERT INTO sessions (
       id, project_id, created_by, source_type, source_id, action_type, title,
       description, status, message_count, session_config, created_at, updated_at
     ) VALUES ($1,$2,$3,'project',$4,'automation',$5,$6,'active',0,$7,now(),now())`,
    [
      sessionId,
      automation.project_id,
      automation.user_id || ctx.userId || null,
      automation.id,
      `${automation.name} · ${time}`,
      "本地定时任务独立运行对话",
      JSON.stringify({
        automation_id: automation.id,
        automation_version: automation.version,
        automation_destination: "standalone",
      }),
    ],
  );
  return sessionId;
}

async function ensureAutomationSession(ctx, automation) {
  if (automation.destination?.type !== "conversation") return createStandaloneSession(ctx, automation);
  const sessionId = automation.destination.session_id;
  const existing = await ctx.queryOne(
    "SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL LIMIT 1",
    [sessionId, automation.project_id],
  );
  if (!existing) throw new ApiError("任务绑定的原对话已经不存在", 409);
  return existing.id;
}

function assistantSummary(contentItems) {
  const items = parseJson(contentItems, []);
  if (!Array.isArray(items)) return null;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!["markdown", "text", "error"].includes(item?.type)) continue;
    const text = clean(item?.content, 2_000);
    if (text) return text;
  }
  return null;
}

async function monitorResult(ctx, {
  automation,
  automationRunId,
  triggerType,
  status,
  summary,
}) {
  if (status !== "completed") return { inboxStatus: "unread", changeStatus: null, fingerprint: null };
  const fingerprint = automationFingerprint({ status, summary });
  const monitor = automation.monitor_policy || { mode: "always" };
  if (triggerType === "manual" || monitor.mode !== "change_only") {
    await updateAutomationRunChange(ctx, automationRunId, { outputFingerprint: fingerprint, changeStatus: "reported" });
    return { inboxStatus: "unread", changeStatus: "reported", fingerprint };
  }
  const previous = await readAutomationState(ctx, automation.id, "monitor_output", null);
  const unchanged = previous?.fingerprint === fingerprint;
  const changeStatus = unchanged ? "unchanged" : previous ? "changed" : "first_result";
  if (!unchanged) {
    await writeAutomationState(ctx, automation.id, "monitor_output", {
      fingerprint,
      summary,
      updated_at: new Date().toISOString(),
    });
  }
  await updateAutomationRunChange(ctx, automationRunId, { outputFingerprint: fingerprint, changeStatus });
  return { inboxStatus: unchanged ? "read" : "unread", changeStatus, fingerprint };
}

function shouldNotify(automation, status) {
  const policy = automation.notification_policy || {};
  if (status === "completed") return policy.on_success !== false;
  if (status === "needs_attention") return policy.on_attention !== false;
  return policy.on_failure !== false;
}

async function finishAutomationRun(ctx, {
  automation,
  automationRunId,
  runId,
  sessionId,
  triggerType = "manual",
  finishedAt,
  thrownError = null,
}) {
  const run = runId
    ? await ctx.queryOne("SELECT * FROM agent_runs WHERE id=$1 AND deleted_at IS NULL LIMIT 1", [runId])
    : null;
  const exactMessage = sessionId && runId
    ? await ctx.queryOne(
        `SELECT content_items FROM session_messages
          WHERE id=$1 AND session_id=$2 AND role='assistant' AND deleted_at IS NULL LIMIT 1`,
        [`assistant:${runId}`, sessionId],
      )
    : null;
  const message = exactMessage || (sessionId
    ? await ctx.queryOne(
        `SELECT content_items FROM session_messages
          WHERE session_id=$1 AND role='assistant' AND deleted_at IS NULL
          ORDER BY sequence_number DESC LIMIT 1`,
        [sessionId],
      )
    : null);
  const evidence = runId
    ? await ctx.queryOne(
        "SELECT id FROM agent_evidence_bundles WHERE run_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1",
        [runId],
      )
    : null;
  const runStatus = String(run?.status || "failed");
  const needsAttention = runStatus === "waiting_approval" || runStatus === "waiting_user_input";
  const completed = runStatus === "completed";
  const status = needsAttention ? "needs_attention" : completed ? "completed" : "failed";
  const summary = assistantSummary(message?.content_items)
    || (needsAttention ? "任务需要你处理后才能继续" : completed ? "任务运行完成" : "任务运行失败");
  const errorMessage = thrownError ? clean(thrownError?.message || thrownError) : completed || needsAttention ? null : summary;
  const nextFailures = completed ? 0 : needsAttention
    ? Number(automation.consecutive_failures || 0)
    : Number(automation.consecutive_failures || 0) + 1;
  const shouldPause = !needsAttention && !completed && nextFailures >= Number(automation.max_consecutive_failures || 3);
  const consumesOnce = triggerType === "scheduled" && automation.schedule?.type === "once";
  let nextStatus = shouldPause ? "paused" : automation.status;
  let nextRunAt = automation.next_run_at || null;
  if (triggerType === "scheduled") {
    if (consumesOnce) {
      nextStatus = "completed";
      nextRunAt = null;
    } else if (nextStatus === "enabled") {
      nextRunAt = nextAutomationRunAt(automation.schedule, new Date(finishedAt));
      if (!nextRunAt && automation.schedule?.type !== "manual" && automation.schedule?.type !== "event") {
        nextStatus = "completed";
      }
    } else nextRunAt = null;
  }

  const monitored = await monitorResult(ctx, {
    automation,
    automationRunId,
    triggerType,
    status,
    summary,
  });
  const inboxStatus = shouldNotify(automation, status) ? monitored.inboxStatus : "read";
  await ctx.query(
    `UPDATE agent_automation_runs SET status=$2, inbox_status=$3, requires_attention=$4,
       summary=$5, error_code=$6, error_message=$7, evidence_bundle_id=$8,
       finished_at=$9, updated_at=now() WHERE id=$1`,
    [
      automationRunId,
      status,
      inboxStatus,
      needsAttention ? 1 : 0,
      summary,
      thrownError?.code || (!completed && !needsAttention ? "AGENT_AUTOMATION_RUN_FAILED" : null),
      errorMessage,
      evidence?.id || null,
      finishedAt,
    ],
  );
  await ctx.query(
    `UPDATE agent_automations SET last_run_at=$2, last_status=$3, consecutive_failures=$4,
       status=$5, next_run_at=$6, updated_at=now() WHERE id=$1`,
    [automation.id, finishedAt, status, nextFailures, nextStatus, nextRunAt],
  );
  return ctx.queryOne("SELECT * FROM agent_automation_runs WHERE id=$1", [automationRunId]);
}

async function recordSkillSnapshotAttention(ctx, automation, verification, {
  triggerType,
  scheduledFor,
  triggerContext,
}) {
  const automationRunId = randomUUID();
  const now = new Date().toISOString();
  const summary = `${verification.reason || "任务使用的 Skill 已变化"}。请编辑并保存任务，确认新的 Skill 快照。`;
  await ctx.query(
    `INSERT INTO agent_automation_runs (
       id, automation_id, run_id, project_id, session_id, status, inbox_status,
       requires_attention, summary, error_code, error_message, started_at, finished_at,
       created_at, updated_at
     ) VALUES ($1,$2,NULL,$3,NULL,'needs_attention','unread',1,$4,
       'AUTOMATION_SKILL_SNAPSHOT_CHANGED',$5,$6,$6,now(),now())`,
    [automationRunId, automation.id, automation.project_id, summary, verification.reason || null, now],
  );
  await saveAutomationRunContext(ctx, {
    automationRunId,
    triggerType,
    scheduledFor,
    eventId: triggerContext?.event_id || null,
    trigger: triggerContext || {},
    skillSnapshot: verification.current || [],
  });
  await ctx.query(
    `UPDATE agent_automations SET status='paused', next_run_at=NULL, last_run_at=$2,
       last_status='needs_attention', updated_at=now() WHERE id=$1`,
    [automation.id, now],
  );
  return automationRunWithPending(ctx, await ctx.queryOne("SELECT * FROM agent_automation_runs WHERE id=$1", [automationRunId]));
}

export async function syncAgentAutomationRun(ctx, runId, { error = null } = {}) {
  const link = await ctx.queryOne(
    `SELECT r.id AS automation_run_id, r.session_id AS automation_session_id,
            r.status AS automation_run_status, a.*
       FROM agent_automation_runs r
       JOIN agent_automations a ON a.id=r.automation_id
      WHERE r.run_id=$1 AND r.deleted_at IS NULL AND a.deleted_at IS NULL LIMIT 1`,
    [runId],
  );
  if (!link) return null;
  if (["completed", "failed", "skipped"].includes(String(link.automation_run_status || ""))) {
    return automationRunWithPending(ctx, await ctx.queryOne("SELECT * FROM agent_automation_runs WHERE id=$1", [link.automation_run_id]));
  }
  const automation = internalAutomationExecutionShape(link);
  const context = await getAutomationRunContext(ctx, link.automation_run_id).catch(() => null);
  return automationRunWithPending(ctx, await finishAutomationRun(ctx, {
    automation,
    automationRunId: link.automation_run_id,
    runId,
    sessionId: link.automation_session_id,
    triggerType: context?.trigger_type || "manual",
    finishedAt: new Date().toISOString(),
    thrownError: error,
  }));
}

export async function reconcileAgentAutomationRuns(ctx) {
  const rows = await ctx.query(
    `SELECT r.run_id, ar.status AS agent_run_status
       FROM agent_automation_runs r
       LEFT JOIN agent_runs ar ON ar.id=r.run_id AND ar.deleted_at IS NULL
      WHERE r.deleted_at IS NULL AND r.status='running'`,
  );
  const reconciled = [];
  for (const row of rows) {
    const status = String(row.agent_run_status || "missing");
    if (!["missing", "completed", "failed", "expired", "waiting_approval", "waiting_user_input"].includes(status)) continue;
    const result = await syncAgentAutomationRun(ctx, row.run_id, {
      error: status === "missing"
        ? Object.assign(new Error("任务运行未创建普通 Agent Run"), { code: "AGENT_AUTOMATION_RUN_MISSING" })
        : null,
    }).catch(() => null);
    if (result) reconciled.push(result);
  }
  return reconciled;
}

export async function executeAgentAutomation(ctx, automationId, {
  trigger = "manual",
  scheduledFor = null,
  triggerContext = {},
  now = new Date().toISOString(),
  runAgentChat = agentChat,
  emit = () => {},
  leaseOwner = `automation:${process.pid}:${randomUUID()}`,
  trustedScheduler = false,
} = {}) {
  const row = await acquireAutomation(ctx, automationId, { owner: leaseOwner, now, trustedScheduler });
  if (!row) throw new ApiError("定时任务正在运行或不存在", 409);
  const heartbeat = setInterval(() => { void heartbeatAutomation(ctx, automationId, leaseOwner); }, 30_000);
  heartbeat.unref?.();
  try {
    const automation = internalAutomationExecutionShape(row);
    await requireProjectMember(ctx, automation.project_id, { userId: automation.user_id });
    if (automation.legacy_tool_allowlist) {
      throw new ApiError("这个旧任务使用了已停用的工具白名单，请删除后重新创建", 409);
    }
    if ((trigger === "scheduled" || trigger === "event") && automation.status !== "enabled") {
      throw new ApiError("定时任务未启用", 409);
    }
    const unfinished = await ctx.queryOne(
      `SELECT id FROM agent_automation_runs
        WHERE automation_id=$1 AND deleted_at IS NULL AND status IN ('running','needs_attention')
        ORDER BY created_at DESC LIMIT 1`,
      [automation.id],
    );
    if (unfinished) throw new ApiError("定时任务已有未结束或待处理运行", 409);

    const skillVerification = await verifyAutomationSkillSnapshot(ctx, automation);
    if (!skillVerification.ok) {
      return recordSkillSnapshotAttention(ctx, automation, skillVerification, {
        triggerType: trigger,
        scheduledFor,
        triggerContext,
      });
    }

    const sessionId = await ensureAutomationSession(ctx, automation);
    const automationRunId = randomUUID();
    const runId = randomUUID();
    await ctx.query(
      `INSERT INTO agent_automation_runs (
         id, automation_id, run_id, project_id, session_id, status, inbox_status,
         requires_attention, summary, started_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,'running','unread',0,$6,$7,now(),now())`,
      [automationRunId, automation.id, runId, automation.project_id, sessionId, `由 ${trigger} 触发`, now],
    );
    await saveAutomationRunContext(ctx, {
      automationRunId,
      triggerType: trigger,
      scheduledFor,
      eventId: triggerContext?.event_id || null,
      trigger: triggerContext || {},
      skillSnapshot: skillVerification.current,
    });
    await ctx.query(
      "UPDATE agent_automations SET last_run_at=$2, last_status='running', updated_at=now() WHERE id=$1",
      [automation.id, now],
    );

    let thrownError = null;
    try {
      await runAgentChat(
        { ...ctx, userId: automation.user_id || ctx.userId || "", signal: ctx.signal || null },
        {
          params: { pid: automation.project_id, sid: sessionId },
          body: {
            message: automation.prompt,
            display_message: `[定时任务] ${automation.name}`,
            skills: automation.skill_snapshot.map((item) => item.selection_key || item.qualified_name || item.name).filter(Boolean),
            plugins: [...new Set(automation.skill_snapshot.map((item) => item.plugin_name).filter(Boolean))],
            approval: "unattended",
            settings: {
              ...(automation.model_id ? { modelId: automation.model_id } : {}),
              ...(automation.reasoning_effort ? { reasoningEffort: automation.reasoning_effort } : {}),
            },
          },
          agentRunId: runId,
          automationContext: {
            ...automation,
            automation_run_id: automationRunId,
            trigger,
            scheduled_for: scheduledFor,
            trigger_context: triggerContext,
            host_scheduler: "dsh-local",
          },
        },
        emit,
      );
    } catch (error) {
      thrownError = error;
    }
    return automationRunWithPending(ctx, await finishAutomationRun(ctx, {
      automation,
      automationRunId,
      runId,
      sessionId,
      triggerType: trigger,
      finishedAt: new Date().toISOString(),
      thrownError,
    }));
  } finally {
    clearInterval(heartbeat);
    await releaseAutomation(ctx, automationId, leaseOwner);
  }
}

export async function recordSkippedAutomationOccurrence(ctx, automation, {
  scheduledFor,
  now = new Date().toISOString(),
  reason = "错过排期，已按任务设置跳过",
} = {}) {
  const automationRunId = randomUUID();
  const nextRunAt = automation.schedule?.type === "once"
    ? null
    : nextAutomationRunAt(automation.schedule, new Date(now));
  const status = nextRunAt || ["manual", "event"].includes(automation.schedule?.type) ? automation.status : "completed";
  await ctx.query(
    `INSERT INTO agent_automation_runs (
      id, automation_id, run_id, project_id, session_id, status, inbox_status,
      requires_attention, summary, started_at, finished_at, created_at, updated_at
    ) VALUES ($1,$2,NULL,$3,NULL,'skipped','read',0,$4,$5,$5,now(),now())`,
    [automationRunId, automation.id, automation.project_id, reason, now],
  );
  await saveAutomationRunContext(ctx, {
    automationRunId,
    triggerType: "scheduled",
    scheduledFor,
    trigger: { missed: true, reason },
    skillSnapshot: automation.skill_snapshot || [],
  });
  await ctx.query(
    `UPDATE agent_automations SET last_run_at=$2, last_status='skipped',
       status=$3, next_run_at=$4, updated_at=now() WHERE id=$1`,
    [automation.id, now, status, nextRunAt],
  );
  return automationRunWithPending(ctx, await ctx.queryOne("SELECT * FROM agent_automation_runs WHERE id=$1", [automationRunId]));
}

export async function runAgentAutomation(ctx, input) {
  const data = await executeAgentAutomation(ctx, input.params.automationId, { trigger: "manual" });
  return { data, message: data.requires_attention ? "定时任务需要处理" : "定时任务运行结束" };
}

export async function listAgentAutomationRuns(ctx, input) {
  const projectId = clean(input.params?.pid, 100);
  await requireProjectMember(ctx, projectId);
  const rows = await ctx.query(
    `SELECT r.* FROM agent_automation_runs r
      JOIN agent_automations a ON a.id=r.automation_id
      WHERE r.project_id=$1 AND r.deleted_at IS NULL AND a.deleted_at IS NULL
        AND a.user_id=$2
      ORDER BY r.created_at DESC LIMIT 200`,
    [projectId, ctx.userId || ""],
  );
  return { data: { items: await Promise.all(rows.map((row) => automationRunWithPending(ctx, row))) }, message: "ok" };
}

export async function markAgentAutomationRunRead(ctx, input) {
  const row = await ctx.queryOne(
    `SELECT r.id FROM agent_automation_runs r
      JOIN agent_automations a ON a.id=r.automation_id
      WHERE r.id=$1 AND r.deleted_at IS NULL AND a.deleted_at IS NULL
        AND a.user_id=$2 LIMIT 1`,
    [input.params.runId, ctx.userId || ""],
  );
  if (!row) throw new ApiError("定时任务运行不存在", 404);
  await ctx.query("UPDATE agent_automation_runs SET inbox_status='read', updated_at=now() WHERE id=$1", [row.id]);
  return {
    data: await automationRunWithPending(ctx, await ctx.queryOne("SELECT * FROM agent_automation_runs WHERE id=$1", [row.id])),
    message: "已读",
  };
}

export async function markAllAgentAutomationRunsRead(ctx, input) {
  const projectId = clean(input.params?.pid, 100);
  await requireProjectMember(ctx, projectId);
  await ctx.query(
    `UPDATE agent_automation_runs SET inbox_status='read', updated_at=now()
      WHERE project_id=$1 AND deleted_at IS NULL AND automation_id IN (
        SELECT id FROM agent_automations WHERE project_id=$1 AND deleted_at IS NULL
          AND user_id=$2
      )`,
    [projectId, ctx.userId || ""],
  );
  return { data: { project_id: projectId, read: true }, message: "运行结果已全部标为已读" };
}

export default {
  executeAgentAutomation,
  listAgentAutomationRuns,
  markAgentAutomationRunRead,
  markAllAgentAutomationRunsRead,
  reconcileAgentAutomationRuns,
  recordSkippedAutomationOccurrence,
  runAgentAutomation,
  syncAgentAutomationRun,
};
