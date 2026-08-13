import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { query, queryOne } from "../../server/src/db.js";
import {
  createAgentAutomation,
  deleteAgentAutomation,
  listAgentAutomations,
  publishAgentAutomationEvent,
  setAgentAutomationStatus,
  updateAgentAutomation,
  resolveAutomationSkillSnapshot,
} from "../../server/src/app/agents/automations.js";
import {
  missedOccurrenceDecision,
  nextAutomationRunAt,
  normalizeAutomationSchedule,
  zonedDateParts,
} from "../../server/src/app/agents/automation_schedule.js";
import {
  executeAgentAutomation,
  listAgentAutomationRuns,
  markAllAgentAutomationRunsRead,
  syncAgentAutomationRun,
} from "../../server/src/app/agents/automation_executor.js";
import { createAgentAutomationScheduler } from "../../server/src/app/agents/automation_scheduler.js";
import {
  ensureAutomationRuntimeStore,
  listPendingAutomationEvents,
} from "../../server/src/app/agents/automation_runtime_store.js";
import { listAgentSessions } from "../../server/src/app/chat/agent_misc.js";
import { createProductTools } from "../../server/src/engine/agents/product_tools.js";
import { automationRoutes } from "../../server/src/transport/registry.automations.js";

const ctx = { query, queryOne, userId: "automation-user" };

async function createProject(prefix = "automation-project") {
  const id = `${prefix}-${randomUUID()}`;
  await query("INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,$2,'active',now(),now())", [id, prefix]);
  await query(
    "INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at) VALUES ($1,$2,$3,1,now(),now())",
    [`${id}:owner`, id, ctx.userId],
  );
  return id;
}

async function cleanupProject(projectId) {
  await ensureAutomationRuntimeStore(ctx);
  const automationRows = await query("SELECT id FROM agent_automations WHERE project_id=$1", [projectId]);
  const runs = await query("SELECT id,run_id,session_id FROM agent_automation_runs WHERE project_id=$1", [projectId]);
  for (const run of runs) {
    if (run.run_id) {
      await query("DELETE FROM agent_evidence_bundles WHERE run_id=$1", [run.run_id]);
      await query("DELETE FROM agent_pending_inputs WHERE run_id=$1", [run.run_id]);
      await query("DELETE FROM agent_run_events WHERE run_id=$1", [run.run_id]);
      await query("DELETE FROM agent_runs WHERE id=$1", [run.run_id]);
    }
    if (run.session_id) {
      await query("DELETE FROM session_messages WHERE session_id=$1", [run.session_id]);
      await query("DELETE FROM sessions WHERE id=$1", [run.session_id]);
    }
    await query("DELETE FROM agent_automation_run_contexts WHERE automation_run_id=$1", [run.id]);
  }
  for (const automation of automationRows) {
    await query("DELETE FROM agent_automation_events WHERE automation_id=$1", [automation.id]);
    await query("DELETE FROM agent_automation_state WHERE automation_id=$1", [automation.id]);
  }
  await query("DELETE FROM agent_automation_runs WHERE project_id=$1", [projectId]);
  await query("DELETE FROM agent_automations WHERE project_id=$1", [projectId]);
  await query("DELETE FROM session_messages WHERE session_id IN (SELECT id FROM sessions WHERE project_id=$1)", [projectId]);
  await query("DELETE FROM sessions WHERE project_id=$1", [projectId]);
  await query("DELETE FROM project_members WHERE project_id=$1", [projectId]);
  await query("DELETE FROM projects WHERE id=$1", [projectId]);
}

function completedAgent(summary = "本次结果") {
  return async (chatCtx, input) => {
    await query(
      `INSERT INTO agent_runs (id,session_id,project_id,user_id,status,mode,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'completed','automation',now(),now())`,
      [input.agentRunId, input.params.sid, input.params.pid, chatCtx.userId],
    );
    const sequence = Number((await queryOne(
      "SELECT MAX(sequence_number) AS n FROM session_messages WHERE session_id=$1",
      [input.params.sid],
    ))?.n || 0) + 1;
    await query(
      `INSERT INTO session_messages (id,session_id,role,content_items,sequence_number,created_at,updated_at)
       VALUES ($1,$2,'assistant',$3,$4,now(),now())`,
      [randomUUID(), input.params.sid, JSON.stringify([{ type: "markdown", content: summary }]), sequence],
    );
  };
}

test("v2 schedules use explicit anchors, IANA timezones, DST, one-time runs and RFC 5545 rules", () => {
  assert.deepEqual(
    normalizeAutomationSchedule(
      { type: "interval", interval_minutes: 15 },
      { defaultStart: new Date("2026-08-01T00:00:00.000Z") },
    ),
    { type: "interval", interval_minutes: 15, anchor_at: "2026-08-01T00:00:00.000Z" },
  );
  assert.equal(
    nextAutomationRunAt(
      { type: "interval", interval_minutes: 15, anchor_at: "2026-08-01T00:00:00.000Z" },
      new Date("2026-08-01T00:07:00.000Z"),
    ),
    "2026-08-01T00:15:00.000Z",
  );
  assert.equal(
    nextAutomationRunAt(
      { type: "daily", time: "09:00", timezone: "Asia/Shanghai" },
      new Date("2026-08-01T00:30:00.000Z"),
    ),
    "2026-08-01T01:00:00.000Z",
  );
  assert.equal(
    nextAutomationRunAt(
      { type: "daily", time: "02:30", timezone: "America/New_York" },
      new Date("2026-03-08T06:00:00.000Z"),
    ),
    "2026-03-08T07:00:00.000Z",
    "DST 缺失时刻移动到当天第一个有效分钟",
  );
  assert.deepEqual(
    zonedDateParts("2026-03-08T07:00:00.000Z", "America/New_York"),
    { year: 2026, month: 3, day: 8, hour: 3, minute: 0, second: 0, weekday: 0 },
  );
  const once = normalizeAutomationSchedule({
    type: "once",
    local_at: "2026-08-02T09:30",
    timezone: "Asia/Shanghai",
  });
  assert.equal(once.run_at, "2026-08-02T01:30:00.000Z");
  assert.equal(nextAutomationRunAt(once, new Date("2026-08-02T01:29:00.000Z")), once.run_at);
  assert.equal(nextAutomationRunAt(once, new Date(once.run_at)), null);
  assert.equal(
    nextAutomationRunAt({
      type: "rrule",
      rrule: "FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0;COUNT=3",
      timezone: "Asia/Shanghai",
      dtstart: "2026-08-01T00:00:00.000Z",
    }, new Date("2026-08-01T00:00:00.000Z")),
    "2026-08-03T01:00:00.000Z",
  );
  assert.deepEqual(
    normalizeAutomationSchedule({ type: "event", event_name: "app.started", debounce_seconds: 45 }),
    { type: "event", event_name: "app.started", debounce_seconds: 45, match: {} },
  );
  assert.deepEqual(
    missedOccurrenceDecision("2026-08-01T00:00:00.000Z", "2026-08-01T02:00:00.000Z", { mode: "within_grace", grace_minutes: 60 }).action,
    "skip",
  );
  assert.throws(() => normalizeAutomationSchedule({ type: "daily", time: "09:00", timezone: "Mars/Olympus" }));
});

test("automation transport exposes event ingress and bulk inbox actions", () => {
  assert.ok(automationRoutes.some((route) => route.m === "POST" && route.p === "/api/agents/projects/:pid/automation-events"));
  assert.ok(automationRoutes.some((route) => route.m === "POST" && route.p === "/api/agents/projects/:pid/automation-runs/read-all"));
});

test("automation Skill snapshots keep every selected Skill and deduplicate aliases", () => {
  const skills = Array.from({ length: 9 }, (_, index) => ({
    name: `skill-${index + 1}`,
    qualified_name: `plugin-one:skill-${index + 1}`,
    selection_key: `plugin-one:skill-${index + 1}`,
    plugin_name: "plugin-one",
    effective_enabled: true,
    availability: "enabled",
  }));
  const captured = resolveAutomationSkillSnapshot(
    skills,
    skills.map((skill) => skill.selection_key),
  );
  assert.equal(captured.length, 9, "automation must not silently discard the ninth Skill");

  const first = skills[0];
  const aliases = resolveAutomationSkillSnapshot(skills, [
    first.selection_key,
    first.qualified_name,
    first.name,
  ]);
  assert.equal(aliases.length, 1, "aliases resolving to one Skill must persist once");
  assert.equal(aliases[0].selection_key, first.selection_key);
});

test("automation CRUD stores the native-host v2 contract without legacy provider rules", async (t) => {
  const projectId = await createProject("automation-v2-crud");
  t.after(() => cleanupProject(projectId));
  const created = await createAgentAutomation(ctx, {
    params: { pid: projectId },
    body: {
      name: "一次本地检查",
      prompt: "检查项目并给出摘要",
      destination: { type: "standalone" },
      schedule: { type: "once", local_at: "2099-08-02T09:30", timezone: "Asia/Shanghai" },
      missed_policy: { mode: "within_grace", grace_minutes: 120 },
      monitor_policy: { mode: "change_only" },
      model_id: "model-scheduled-test",
      model_name: "gpt-scheduled-test",
      reasoning_effort: "high",
      max_consecutive_failures: 4,
    },
  });
  const id = created.data.id;
  assert.equal(created.data.version, "agent_automation.v2");
  assert.equal(created.data.destination.type, "standalone");
  assert.equal(Object.hasOwn(created.data, "session_id"), false, "v2 任务不再暴露旧的定义级会话字段");
  assert.equal((await queryOne("SELECT session_id,skill_name FROM agent_automations WHERE id=$1", [id])).session_id, null);
  assert.equal(Object.hasOwn(created.data, "tool_scope"), false);
  assert.equal(Object.hasOwn(created.data, "allowed_tools"), false);
  assert.equal(created.data.schedule.type, "once");
  assert.equal(created.data.schedule.timezone, "Asia/Shanghai");
  assert.equal(created.data.missed_policy.mode, "within_grace");
  assert.equal(created.data.monitor_policy.mode, "change_only");
  assert.equal(created.data.permission_policy.approval_mode, "unattended");
  assert.equal(created.data.permission_policy.approval_policy, "never");
  assert.equal(created.data.permission_policy.approvals_reviewer, "auto_review");
  assert.equal(created.data.sandbox_policy.source, "dsh");
  assert.equal(created.data.sandbox_policy.network, "managed");
  assert.equal(created.data.snapshot_policy.strategy, "run_start");
  assert.ok(created.data.next_run_at);

  const paused = await setAgentAutomationStatus(ctx, { params: { automationId: id }, body: { status: "paused" } });
  assert.equal(paused.data.next_run_at, null);
  await assert.rejects(() => updateAgentAutomation(ctx, {
    params: { automationId: id },
    body: { tool_scope: "allowlist", allowed_tools: ["mcp__example__read", "read"] },
  }), (error) => error.status === 400 && /DSH/.test(error.message));
  const updated = await updateAgentAutomation(ctx, {
    params: { automationId: id },
    body: {
      name: "启动时检查",
      status: "enabled",
      schedule: { type: "event", event_name: "app.started", debounce_seconds: 30 },
    },
  });
  assert.equal(updated.data.name, "启动时检查");
  assert.equal(updated.data.schedule.type, "event");
  assert.equal(updated.data.next_run_at, null);
  assert.equal(Object.hasOwn(updated.data, "allowed_tools"), false);
  assert.equal((await listAgentAutomations(ctx, { params: { pid: projectId } })).data.items.length, 1);
  await assert.rejects(() => updateAgentAutomation(ctx, {
    params: { automationId: id }, body: { tool_scope: "allowlist", allowed_tools: ["../../shell"] },
  }), (error) => error.status === 400);
  assert.equal((await deleteAgentAutomation(ctx, { params: { automationId: id }, body: {} })).data.deleted, true);
});

test("scheduled_task_create is not exposed after the management surface is removed", () => {
  const tool = createProductTools({
    db: { query, queryOne }, project_id: randomUUID(), session_id: randomUUID(), user_id: ctx.userId,
  }).find((item) => item.name === "scheduled_task_create");
  assert.equal(tool, undefined);
});

test("standalone tasks create a fresh conversation per run and execute through the native agent path", async (t) => {
  const projectId = await createProject("automation-standalone");
  t.after(() => cleanupProject(projectId));
  const created = await createAgentAutomation(ctx, {
    params: { pid: projectId },
    body: {
      name: "独立运行", prompt: "生成摘要", destination: { type: "standalone" },
      schedule: { type: "manual" }, model_id: "model-test", reasoning_effort: "high",
    },
  });
  let captured = null;
  const fakeAgent = async (chatCtx, input) => {
    captured = { chatCtx, input };
    return completedAgent("独立摘要")(chatCtx, input);
  };
  const first = await executeAgentAutomation(ctx, created.data.id, { runAgentChat: fakeAgent });
  const second = await executeAgentAutomation(ctx, created.data.id, { runAgentChat: fakeAgent });
  assert.notEqual(first.session_id, second.session_id);
  assert.equal(captured.input.body.approval, "unattended");
  assert.equal(captured.input.body.settings.modelId, "model-test");
  assert.equal(captured.input.body.settings.reasoningEffort, "high");
  assert.equal(captured.input.automationContext.host_scheduler, "dsh-local");
  assert.equal(first.status, "completed");
  assert.equal(first.summary, "独立摘要");
  assert.equal((await queryOne("SELECT mode FROM agent_runs WHERE id=$1", [first.run_id])).mode, "automation");
  const history = await listAgentSessions(ctx, { params: { pid: projectId }, query: {} });
  assert.ok(history.data.items.some((session) => session.id === first.session_id));
  assert.ok(history.data.items.some((session) => session.id === second.session_id));
  await query("UPDATE agent_automation_runs SET inbox_status='read' WHERE id=$1", [first.id]);
  assert.equal((await syncAgentAutomationRun(ctx, first.run_id)).inbox_status, "read");
});

test("chat-scoped tasks return to the original conversation", async (t) => {
  const projectId = await createProject("automation-conversation");
  const sessionId = randomUUID();
  await query(
    `INSERT INTO sessions (id,project_id,created_by,source_type,source_id,action_type,title,status,message_count,session_config,created_at,updated_at)
     VALUES ($1,$2,$3,'project',$2,'agentic_chat','原对话','active',0,'{}',now(),now())`,
    [sessionId, projectId, ctx.userId],
  );
  t.after(() => cleanupProject(projectId));
  const created = await createAgentAutomation(ctx, {
    params: { pid: projectId },
    body: { name: "回到原对话", prompt: "继续", destination: { type: "conversation", session_id: sessionId }, schedule: { type: "manual" } },
  });
  const stored = await queryOne("SELECT session_id,skill_name FROM agent_automations WHERE id=$1", [created.data.id]);
  assert.equal(stored.session_id, null, "原对话目标只保存在 v2 destination，不复用旧定义级 session_id");
  assert.equal(stored.skill_name, null, "Skill 只使用 v2 多 Skill 快照");
  assert.equal(Object.hasOwn(created.data, "session_id"), false);
  const first = await executeAgentAutomation(ctx, created.data.id, { runAgentChat: completedAgent("第一次") });
  const second = await executeAgentAutomation(ctx, created.data.id, { runAgentChat: completedAgent("第二次") });
  assert.equal(first.session_id, sessionId);
  assert.equal(second.session_id, sessionId);
});

test("change-only monitoring keeps identical results but suppresses duplicate inbox notifications", async (t) => {
  const projectId = await createProject("automation-monitor");
  t.after(() => cleanupProject(projectId));
  const created = await createAgentAutomation(ctx, {
    params: { pid: projectId },
    body: {
      name: "变化监测", prompt: "监测", schedule: { type: "event", event_name: "project.changed" },
      monitor_policy: { mode: "change_only" },
    },
  });
  const first = await executeAgentAutomation(ctx, created.data.id, {
    trigger: "event", triggerContext: { event_name: "project.changed", payload: { rev: 1 } }, runAgentChat: completedAgent("没有变化"),
  });
  const second = await executeAgentAutomation(ctx, created.data.id, {
    trigger: "event", triggerContext: { event_name: "project.changed", payload: { rev: 2 } }, runAgentChat: completedAgent("没有变化"),
  });
  assert.equal(first.change_status, "first_result");
  assert.equal(first.inbox_status, "unread");
  assert.equal(second.change_status, "unchanged");
  assert.equal(second.inbox_status, "read");
  assert.equal((await listAgentAutomationRuns(ctx, { params: { pid: projectId } })).data.items.length, 2);
});

test("pinned Skill drift pauses before the native agent starts", async (t) => {
  const projectId = await createProject("automation-skill-drift");
  t.after(() => cleanupProject(projectId));
  const created = await createAgentAutomation(ctx, {
    params: { pid: projectId },
    body: { name: "Skill 固定", prompt: "运行", schedule: { type: "manual" } },
  });
  const fakeSnapshot = [{
    name: "missing-skill", qualified_name: "missing-skill", version: "1.0.0", digest: "sha256:missing", required_tools: [],
  }];
  const snapshotPolicy = { ...created.data.snapshot_policy, skills: fakeSnapshot };
  await query(
    "UPDATE agent_automations SET snapshot_policy_json=$2 WHERE id=$1",
    [created.data.id, JSON.stringify(snapshotPolicy)],
  );
  let called = false;
  const result = await executeAgentAutomation(ctx, created.data.id, { runAgentChat: async () => { called = true; } });
  assert.equal(called, false);
  assert.equal(result.status, "needs_attention");
  assert.equal(result.error_code, "AUTOMATION_SKILL_SNAPSHOT_CHANGED");
  assert.equal((await queryOne("SELECT status FROM agent_automations WHERE id=$1", [created.data.id])).status, "paused");
});

test("event triggers are persisted, debounced and survive until the scheduler consumes them", async (t) => {
  const projectId = await createProject("automation-events");
  t.after(() => cleanupProject(projectId));
  const created = await createAgentAutomation(ctx, {
    params: { pid: projectId },
    body: {
      name: "事件任务", prompt: "处理事件",
      schedule: { type: "event", event_name: "project.file_changed", debounce_seconds: 60, match: { kind: "markdown" } },
    },
  });
  const input = {
    params: { pid: projectId },
    body: { event_name: "project.file_changed", event_key: "event-1", payload: { kind: "markdown", path: "README.md" } },
  };
  const first = await publishAgentAutomationEvent(ctx, input);
  const duplicate = await publishAgentAutomationEvent(ctx, input);
  assert.equal(first.data.queued.length, 1);
  assert.equal(duplicate.data.queued.length, 0);
  assert.equal(duplicate.data.ignored[0].reason, "duplicate");
  assert.equal((await listPendingAutomationEvents(ctx)).length, 1);
  let captured = null;
  const scheduler = createAgentAutomationScheduler({
    query, queryOne,
    execute: async (_eventCtx, automationId, options) => {
      captured = { automationId, options };
      return { automation_id: automationId, status: "completed" };
    },
  });
  await scheduler.tick();
  scheduler.stop();
  assert.equal(captured.automationId, created.data.id);
  assert.equal(captured.options.trigger, "event");
  assert.equal(captured.options.triggerContext.payload.path, "README.md");
  assert.equal((await listPendingAutomationEvents(ctx)).length, 0);
});

test("scheduler catches up once after sleep, skips by policy and never overlaps ticks", async (t) => {
  const projectId = await createProject("automation-scheduler");
  t.after(() => cleanupProject(projectId));
  const catchup = await createAgentAutomation(ctx, {
    params: { pid: projectId },
    body: { name: "补跑", prompt: "run", schedule: { type: "interval", interval_minutes: 5 }, missed_policy: { mode: "run_once" } },
  });
  const skipped = await createAgentAutomation(ctx, {
    params: { pid: projectId },
    body: { name: "跳过", prompt: "skip", schedule: { type: "interval", interval_minutes: 5 }, missed_policy: { mode: "skip" } },
  });
  await query("UPDATE agent_automations SET next_run_at='2026-08-01T00:00:00.000Z' WHERE project_id=$1", [projectId]);
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = createAgentAutomationScheduler({
    query, queryOne,
    execute: async (_runCtx, automationId, options) => {
      calls.push({ automationId, options });
      await gate;
      return { automation_id: automationId, status: "completed" };
    },
  });
  const firstTick = scheduler.tick({ now: "2026-08-01T03:00:00.000Z" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await scheduler.tick({ now: "2026-08-01T03:00:00.000Z" }), []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].automationId, catchup.data.id);
  assert.equal(calls[0].options.triggerContext.recovered_after_sleep, true);
  release();
  await firstTick;
  scheduler.stop();
  assert.equal((await queryOne("SELECT last_status FROM agent_automations WHERE id=$1", [skipped.data.id])).last_status, "skipped");
});

test("bulk inbox read and consecutive-failure pause remain deterministic", async (t) => {
  const projectId = await createProject("automation-failures");
  t.after(() => cleanupProject(projectId));
  const created = await createAgentAutomation(ctx, {
    params: { pid: projectId },
    body: { name: "连续失败", prompt: "fail", schedule: { type: "manual" }, max_consecutive_failures: 2 },
  });
  const failAgent = async (chatCtx, input) => {
    await query(
      `INSERT INTO agent_runs (id,session_id,project_id,user_id,status,mode,created_at,updated_at)
       VALUES ($1,$2,$3,$4,'failed','automation',now(),now())`,
      [input.agentRunId, input.params.sid, input.params.pid, chatCtx.userId],
    );
  };
  await executeAgentAutomation(ctx, created.data.id, { runAgentChat: failAgent });
  await executeAgentAutomation(ctx, created.data.id, { runAgentChat: failAgent });
  const definition = await queryOne("SELECT status,consecutive_failures FROM agent_automations WHERE id=$1", [created.data.id]);
  assert.equal(definition.status, "paused");
  assert.equal(Number(definition.consecutive_failures), 2);
  await markAllAgentAutomationRunsRead(ctx, { params: { pid: projectId } });
  assert.equal(Number((await queryOne(
    "SELECT COUNT(*) AS n FROM agent_automation_runs WHERE project_id=$1 AND inbox_status='unread'",
    [projectId],
  )).n), 0);
});
