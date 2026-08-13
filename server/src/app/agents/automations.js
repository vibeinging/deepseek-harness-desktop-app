import { randomUUID } from "node:crypto";

import { ApiError } from "../../errors.js";
import { requireProjectMember } from "../projects/access.js";
import { listEnabledSkills } from "../../engine/agents/skill_registry.js";
import { skillQualifiedName, skillSelectionKey } from "../../engine/skills/skill_identity.js";
import {
  AUTOMATION_SCHEDULE_TYPES,
  nextAutomationRunAt,
  normalizeAutomationSchedule,
  normalizeMissedPolicy,
} from "./automation_schedule.js";
import {
  automationFingerprint,
  ensureAutomationRuntimeStore,
  publishAutomationEvent,
} from "./automation_runtime_store.js";

export const AUTOMATION_VERSION = "agent_automation.v2";
export { AUTOMATION_SCHEDULE_TYPES, nextAutomationRunAt, normalizeAutomationSchedule };

const AUTOMATION_STATUSES = new Set(["enabled", "paused", "completed"]);
const SAFE_TOOL_NAME = /^[a-zA-Z0-9_.:-]{1,160}$/;

function parseJson(value, fallback) {
  if (value == null || value === "") return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function clean(value, max = 10_000) {
  return String(value || "").trim().slice(0, max);
}

function editableValue(body, key, existing) {
  return Object.prototype.hasOwnProperty.call(body, key) ? body[key] : existing?.[key];
}

function uniqueTools(value) {
  const tools = [...new Set((Array.isArray(value) ? value : []).map((item) => clean(item, 160)).filter(Boolean))];
  if (tools.some((name) => !SAFE_TOOL_NAME.test(name))) throw new ApiError("工具范围包含无效名称", 400);
  return tools.slice(0, 200);
}

function uniqueSkillNames(value) {
  return [...new Set(
    (Array.isArray(value) ? value : []).map((item) => clean(item, 180)).filter(Boolean),
  )];
}

function skillIdentity(skill) {
  return {
    selection_key: skillSelectionKey(skill),
    name: skill.name,
    qualified_name: skillQualifiedName(skill),
    version: skill.version || null,
    digest: skill.digest || null,
    source: skill.source || null,
    scope: skill.scope || null,
    plugin_name: skill.plugin_name || null,
    plugin_version: skill.plugin_version || null,
    required_tools: [...new Set(skill.required_tools || skill.tool_dependencies || [])].sort(),
  };
}

async function effectiveProjectSkills(ctx, projectId) {
  return listEnabledSkills(ctx, projectId);
}

export function resolveAutomationSkillSnapshot(skills = [], selected = []) {
  const names = uniqueSkillNames(selected);
  if (!names.length) return [];
  const byExactName = new Map();
  const byShortName = new Map();
  for (const skill of skills) {
    for (const name of [skillSelectionKey(skill), skillQualifiedName(skill)]) {
      if (!name) continue;
      const matches = byExactName.get(name) || [];
      if (!matches.includes(skill)) matches.push(skill);
      byExactName.set(name, matches);
    }
    const shortMatches = byShortName.get(skill.name) || [];
    shortMatches.push(skill);
    byShortName.set(skill.name, shortMatches);
  }
  const snapshot = [];
  const selectedKeys = new Set();
  for (const name of names) {
    const exact = byExactName.get(name) || [];
    const matches = exact.length ? exact : (byShortName.get(name) || []);
    if (matches.length > 1) {
      throw new ApiError(`Skill「${name}」存在重名，请重新选择`, 400);
    }
    const skill = matches[0];
    if (!skill || skill.effective_enabled === false || skill.availability !== "enabled") {
      throw new ApiError(`Skill「${name}」不存在、未启用或当前不可用`, 400);
    }
    const identity = skillIdentity(skill);
    if (!selectedKeys.has(identity.selection_key)) {
      selectedKeys.add(identity.selection_key);
      snapshot.push(identity);
    }
  }
  return snapshot;
}

export async function captureAutomationSkillSnapshot(ctx, projectId, selected = []) {
  const names = uniqueSkillNames(selected);
  if (!names.length) return [];
  const skills = await effectiveProjectSkills(ctx, projectId);
  return resolveAutomationSkillSnapshot(skills, names);
}

export async function verifyAutomationSkillSnapshot(ctx, automation) {
  const expected = Array.isArray(automation?.skill_snapshot) ? automation.skill_snapshot : [];
  if (!expected.length) return { ok: true, expected, current: [] };
  let current;
  try {
    current = await captureAutomationSkillSnapshot(
      ctx,
      automation.project_id,
      expected.map((item) => item.selection_key || item.qualified_name || item.name),
    );
  } catch (error) {
    return { ok: false, expected, current: [], reason: error?.message || String(error) };
  }
  const comparable = (items) => items.map((item) => ({
    selection_key: item.selection_key || null,
    qualified_name: item.qualified_name,
    version: item.version,
    digest: item.digest,
    plugin_version: item.plugin_version,
    required_tools: item.required_tools,
  }));
  const ok = automationFingerprint(comparable(expected)) === automationFingerprint(comparable(current));
  return {
    ok,
    expected,
    current,
    reason: ok ? null : "任务使用的 Skill 已更新、停用或更换版本",
  };
}

function normalizeDestination(value) {
  const source = value && typeof value === "object" ? value : {};
  const type = clean(source.type || "standalone", 30).toLowerCase();
  if (!new Set(["standalone", "conversation"]).has(type)) throw new ApiError("任务对话方式无效", 400);
  const sessionId = type === "conversation" ? clean(source.session_id, 120) : null;
  if (type === "conversation" && !sessionId) throw new ApiError("回到原对话的任务必须选择对话", 400);
  return { type, session_id: sessionId };
}

function normalizeMonitorPolicy(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const mode = clean(source.mode || "always", 30).toLowerCase();
  if (!new Set(["always", "change_only"]).has(mode)) throw new ApiError("结果通知方式无效", 400);
  return { mode };
}

function normalizeToolPolicy(body, existing = null) {
  const existingSandbox = parseJson(existing?.sandbox_policy_json, {});
  if (Object.hasOwn(body, "tool_scope") || Object.hasOwn(body, "allowed_tools")) {
    throw new ApiError("DSH 定时任务不接受工具白名单字段", 400);
  }
  const storedAllowedTools = uniqueTools(parseJson(existing?.allowed_tools_json, []));
  if (existingSandbox.tool_scope === "allowlist" || storedAllowedTools.length) {
    throw new ApiError("这个旧任务使用了已停用的工具白名单，请删除后重新创建", 409);
  }
}

function normalizePolicies(body = {}, existing = null, skillSnapshot = []) {
  const existingSchedule = parseJson(existing?.schedule_json, {});
  const existingSnapshot = parseJson(existing?.snapshot_policy_json, {});
  const existingNotification = parseJson(existing?.notification_policy_json, {});
  const existingPermission = parseJson(existing?.permission_policy_json, {});
  const missed = normalizeMissedPolicy(body.missed_policy ?? existingSchedule.missed_policy ?? {});
  const destination = normalizeDestination(
    body.destination ?? existingSnapshot.destination ?? existingPermission.destination,
  );
  const monitor = normalizeMonitorPolicy(body.monitor_policy ?? existingNotification.monitor ?? {});
  normalizeToolPolicy(body, existing);
  return {
    missed,
    destination,
    monitor,
    sandbox: {
      mode: "workspace-write",
      source: "dsh",
      network: "managed",
      write_scope: "project",
    },
    snapshot: {
      version: AUTOMATION_VERSION,
      strategy: "run_start",
      skill_mode: "pinned",
      skills: skillSnapshot,
      destination,
    },
    notification: {
      inbox: true,
      on_success: body.notification_policy?.on_success ?? existingNotification.on_success ?? true,
      on_failure: body.notification_policy?.on_failure ?? existingNotification.on_failure ?? true,
      on_attention: true,
      monitor,
    },
    permission: {
      approval_mode: "unattended",
      approval_policy: "never",
      approvals_reviewer: "auto_review",
      unattended: true,
      unmet_requirement: "needs_attention",
      destination,
    },
  };
}

function publicAutomation(row) {
  if (!row) return null;
  const schedule = parseJson(row.schedule_json, { type: "manual" });
  const snapshot = parseJson(row.snapshot_policy_json, {});
  const sandbox = parseJson(row.sandbox_policy_json, {});
  const notification = parseJson(row.notification_policy_json, {});
  const permission = parseJson(row.permission_policy_json, {});
  const destination = snapshot.destination || permission.destination || normalizeDestination({ type: "standalone" });
  const skillSnapshot = Array.isArray(snapshot.skills) ? snapshot.skills : [];
  return {
    id: row.id,
    version: AUTOMATION_VERSION,
    project_id: row.project_id,
    user_id: row.user_id || null,
    destination,
    name: row.name,
    prompt: row.prompt,
    skills: skillSnapshot.map((item) => item.selection_key || item.qualified_name || item.name).filter(Boolean),
    skill_snapshot: skillSnapshot,
    model_id: row.model_id || null,
    model_name: row.model_name || null,
    reasoning_effort: row.reasoning_effort || null,
    schedule,
    missed_policy: normalizeMissedPolicy(schedule.missed_policy || {}),
    monitor_policy: notification.monitor || { mode: "always" },
    sandbox_policy: sandbox,
    snapshot_policy: snapshot,
    notification_policy: notification,
    permission_policy: permission,
    status: row.status,
    next_run_at: row.next_run_at || null,
    last_run_at: row.last_run_at || null,
    last_status: row.last_status || null,
    consecutive_failures: Number(row.consecutive_failures || 0),
    max_consecutive_failures: Number(row.max_consecutive_failures || 3),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function internalAutomationExecutionShape(row) {
  const automation = publicAutomation(row);
  const sandbox = parseJson(row?.sandbox_policy_json, {});
  const storedAllowedTools = uniqueTools(parseJson(row?.allowed_tools_json, []));
  return {
    ...automation,
    legacy_tool_allowlist: sandbox.tool_scope === "allowlist" || storedAllowedTools.length > 0,
  };
}

async function ownedAutomation(ctx, id) {
  const row = await ctx.queryOne(
    `SELECT * FROM agent_automations WHERE id=$1 AND deleted_at IS NULL
      AND user_id=$2 LIMIT 1`,
    [id, ctx.userId || ""],
  );
  if (!row) throw new ApiError("定时任务不存在", 404);
  return row;
}

export async function listAgentAutomations(ctx, input) {
  const projectId = clean(input.params?.pid, 100);
  await requireProjectMember(ctx, projectId);
  const rows = await ctx.query(
    `SELECT * FROM agent_automations WHERE project_id=$1 AND deleted_at IS NULL
      AND user_id=$2
      ORDER BY created_at DESC`,
    [projectId, ctx.userId || ""],
  );
  return { data: { items: rows.map(publicAutomation) }, message: "ok" };
}

export async function getAgentAutomation(ctx, input) {
  return { data: publicAutomation(await ownedAutomation(ctx, input.params.automationId)), message: "ok" };
}

async function normalizedDefinition(ctx, projectId, body, existing = null) {
  const name = clean(body.name ?? existing?.name, 120);
  const prompt = clean(body.prompt ?? existing?.prompt, 60_000);
  if (!name) throw new ApiError("定时任务名称不能为空", 400);
  if (!prompt) throw new ApiError("定时任务指令不能为空", 400);
  const existingSnapshot = parseJson(existing?.snapshot_policy_json, {});
  const selectedSkills = uniqueSkillNames(
    body.skills ?? existingSnapshot.skills?.map((item) => item.selection_key || item.qualified_name || item.name),
  );
  const skillSnapshot = await captureAutomationSkillSnapshot(ctx, projectId, selectedSkills);
  const rawSchedule = body.schedule ?? parseJson(existing?.schedule_json, { type: "manual" });
  const schedule = normalizeAutomationSchedule(rawSchedule, { defaultStart: new Date() });
  const status = clean(body.status ?? existing?.status ?? "enabled", 20);
  if (!AUTOMATION_STATUSES.has(status)) throw new ApiError("定时任务状态无效", 400);
  const maxFailures = Math.max(1, Math.min(20, Math.floor(Number(body.max_consecutive_failures ?? existing?.max_consecutive_failures ?? 3))));
  const policies = normalizePolicies(body, existing, skillSnapshot);
  return {
    name,
    prompt,
    skills: selectedSkills,
    skill_snapshot: skillSnapshot,
    model_id: clean(editableValue(body, "model_id", existing), 120) || null,
    model_name: clean(editableValue(body, "model_name", existing), 240) || null,
    reasoning_effort: clean(editableValue(body, "reasoning_effort", existing), 40) || null,
    schedule: { ...schedule, missed_policy: policies.missed },
    status,
    max_consecutive_failures: maxFailures,
    ...policies,
  };
}

async function validateDestinationSession(ctx, projectId, destination) {
  if (destination.type !== "conversation") return;
  const session = await ctx.queryOne(
    "SELECT id FROM sessions WHERE id=$1 AND project_id=$2 AND deleted_at IS NULL LIMIT 1",
    [destination.session_id, projectId],
  );
  if (!session) throw new ApiError("任务绑定的原对话不存在或不属于当前项目", 400);
}

function initialNextRunAt(def, now = new Date()) {
  if (def.status !== "enabled") return null;
  if (def.schedule.type === "once") return def.schedule.run_at;
  return nextAutomationRunAt(def.schedule, now);
}

export async function createAgentAutomation(ctx, input) {
  const projectId = clean(input.params?.pid, 100);
  await requireProjectMember(ctx, projectId);
  const def = await normalizedDefinition(ctx, projectId, input.body || {});
  await validateDestinationSession(ctx, projectId, def.destination);
  const id = randomUUID();
  const nextRunAt = initialNextRunAt(def);
  await ctx.query(
    `INSERT INTO agent_automations (
      id, project_id, user_id, name, prompt, model_id, model_name,
      reasoning_effort, allowed_tools_json,
      schedule_json, sandbox_policy_json, snapshot_policy_json, notification_policy_json,
      permission_policy_json, status, next_run_at, consecutive_failures,
      max_consecutive_failures, created_at, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,0,$17,now(),now())`,
    [
      id, projectId, ctx.userId || null, def.name, def.prompt,
      def.model_id, def.model_name, def.reasoning_effort,
      "[]", JSON.stringify(def.schedule),
      JSON.stringify(def.sandbox), JSON.stringify(def.snapshot), JSON.stringify(def.notification),
      JSON.stringify(def.permission), def.status, nextRunAt, def.max_consecutive_failures,
    ],
  );
  return { data: publicAutomation(await ownedAutomation(ctx, id)), message: "定时任务已创建" };
}

export async function updateAgentAutomation(ctx, input) {
  const existing = await ownedAutomation(ctx, input.params.automationId);
  const def = await normalizedDefinition(ctx, existing.project_id, input.body || {}, existing);
  await validateDestinationSession(ctx, existing.project_id, def.destination);
  const nextRunAt = initialNextRunAt(def);
  await ctx.query(
    `UPDATE agent_automations SET session_id=NULL, skill_name=NULL, name=$2, prompt=$3, model_id=$4,
      model_name=$5, reasoning_effort=$6, allowed_tools_json=$7,
      schedule_json=$8, sandbox_policy_json=$9, snapshot_policy_json=$10,
      notification_policy_json=$11, permission_policy_json=$12, status=$13,
      next_run_at=$14, max_consecutive_failures=$15, updated_at=now() WHERE id=$1`,
    [
      existing.id, def.name, def.prompt, def.model_id, def.model_name,
      def.reasoning_effort, "[]",
      JSON.stringify(def.schedule), JSON.stringify(def.sandbox), JSON.stringify(def.snapshot),
      JSON.stringify(def.notification), JSON.stringify(def.permission), def.status, nextRunAt,
      def.max_consecutive_failures,
    ],
  );
  await ctx.query(
    `UPDATE agent_automation_runs SET status='failed', requires_attention=0,
       inbox_status='read', summary='任务已更新，旧的 Skill 变更提醒已关闭',
       finished_at=COALESCE(finished_at,now()), updated_at=now()
      WHERE automation_id=$1 AND status='needs_attention'
        AND error_code='AUTOMATION_SKILL_SNAPSHOT_CHANGED'`,
    [existing.id],
  );
  return { data: publicAutomation(await ownedAutomation(ctx, existing.id)), message: "定时任务已更新" };
}

export async function setAgentAutomationStatus(ctx, input) {
  const existing = await ownedAutomation(ctx, input.params.automationId);
  const status = clean(input.body?.status, 20);
  if (!new Set(["enabled", "paused"]).has(status)) throw new ApiError("状态只支持 enabled 或 paused", 400);
  const schedule = parseJson(existing.schedule_json, { type: "manual" });
  const definition = { status, schedule };
  const nextRunAt = initialNextRunAt(definition);
  await ctx.query("UPDATE agent_automations SET status=$2, next_run_at=$3, updated_at=now() WHERE id=$1", [existing.id, status, nextRunAt]);
  if (status === "paused") {
    await ensureAutomationRuntimeStore(ctx);
    await ctx.query(
      "UPDATE agent_automation_events SET status='ignored', processed_at=now(), updated_at=now() WHERE automation_id=$1 AND status='pending'",
      [existing.id],
    );
  }
  return { data: publicAutomation(await ownedAutomation(ctx, existing.id)), message: status === "enabled" ? "定时任务已启用" : "定时任务已暂停" };
}

export async function deleteAgentAutomation(ctx, input) {
  const existing = await ownedAutomation(ctx, input.params.automationId);
  await ctx.query(
    "UPDATE agent_automations SET deleted_at=now(), deleted_by=$2, status='paused', next_run_at=NULL, updated_at=now() WHERE id=$1",
    [existing.id, ctx.userId || "user"],
  );
  await ensureAutomationRuntimeStore(ctx);
  await ctx.query(
    "UPDATE agent_automation_events SET status='ignored', processed_at=now(), updated_at=now() WHERE automation_id=$1 AND status='pending'",
    [existing.id],
  );
  return { data: { id: existing.id, deleted: true }, message: "定时任务已删除" };
}

export async function listDueAutomations(ctx, { now = new Date().toISOString(), limit = 20 } = {}) {
  const rows = await ctx.query(
    `SELECT * FROM agent_automations WHERE deleted_at IS NULL AND status='enabled'
      AND next_run_at IS NOT NULL AND next_run_at <= $1
      AND (lease_expires_at IS NULL OR lease_expires_at <= $1)
      AND NOT EXISTS (
        SELECT 1 FROM agent_automation_runs r
         WHERE r.automation_id=agent_automations.id AND r.deleted_at IS NULL
           AND r.status='running'
      )
      ORDER BY next_run_at ASC LIMIT $2`,
    [now, Math.max(1, Math.min(100, Number(limit || 20)))],
  );
  return rows.map(publicAutomation);
}

export async function publishAgentAutomationEvent(ctx, input) {
  const projectId = clean(input.params?.pid || input.body?.project_id, 100);
  if (projectId) await requireProjectMember(ctx, projectId);
  const eventName = clean(input.body?.event_name, 160);
  if (!/^[a-z][a-z0-9_.:-]{1,159}$/i.test(eventName)) throw new ApiError("事件名称无效", 400);
  const occurredAt = input.body?.occurred_at ? new Date(input.body.occurred_at) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new ApiError("事件时间无效", 400);
  const data = await publishAutomationEvent(ctx, {
    projectId: projectId || null,
    eventName,
    eventKey: clean(input.body?.event_key, 240) || null,
    payload: input.body?.payload && typeof input.body.payload === "object" ? input.body.payload : {},
    occurredAt: occurredAt.toISOString(),
    ownerUserId: ctx.userId,
  });
  return { data, message: data.queued.length ? "事件任务已进入本地队列" : "没有匹配的新事件任务" };
}

export default {
  createAgentAutomation,
  deleteAgentAutomation,
  getAgentAutomation,
  listAgentAutomations,
  listDueAutomations,
  publishAgentAutomationEvent,
  setAgentAutomationStatus,
  updateAgentAutomation,
};
