import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { query, queryOne } from "../../server/src/db.js";
import {
  attachPendingDecisionPublicInteraction,
  createLivePendingInteraction,
  listAgentSessions,
  listLivePendingInteractions,
  markAgentSessionViewed,
  pendingDecisions,
  persistAgentTurnBeforeRunTerminal,
} from "../../server/src/app/chat/agent_misc.js";
import {
  CONVERSATION_STATUS_HEARTBEAT_MS,
  watchAgentSessionStatusEvents,
} from "../../server/src/app/chat/conversation_status_stream.js";
import {
  CONVERSATION_STATUS_EVENT_TYPES,
  createConversationStatusHeartbeatEvent,
  publishConversationStatusChanged,
  subscribeConversationStatusEvents,
} from "../../server/src/engine/agents/conversation_status_events.js";
import {
  recoverStaleAgentRuns,
  cleanupExpiredRunFacts,
  transitionAgentRun,
} from "../../server/src/engine/agents/run_fact_store.js";
import { chatRoutes } from "../../server/src/transport/registry.chat.js";
import { requireIsolatedTestEnvironment } from "./test-environment.mjs";

requireIsolatedTestEnvironment("conversation-sidebar-status.test.mjs");

const requireFromServer = createRequire(new URL("../../server/package.json", import.meta.url));
const Database = requireFromServer("better-sqlite3");

function context(userId) {
  return { userId, query, queryOne };
}

async function insertSession({ id, projectId, userId, title = "状态测试" }) {
  await query(
    `INSERT INTO sessions
       (id,project_id,created_by,source_type,source_id,action_type,title,status,message_count,session_config,created_at,updated_at)
     VALUES ($1,$2,$3,'project',$2,'agentic_chat',$4,'active',1,'{}',now(),now())`,
    [id, projectId, userId, title],
  );
  await query(
    `INSERT INTO session_messages
       (id,session_id,role,content_items,sequence_number,created_at,updated_at)
     VALUES ($1,$2,'user',$3,1,now(),now())`,
    [randomUUID(), id, JSON.stringify([{ type: "text", content: "开始任务" }])],
  );
}

async function insertRun({
  id,
  sessionId,
  projectId,
  userId,
  status,
  createdAt,
  updatedAt = createdAt,
  statusChangedAt = createdAt,
  viewedAt = null,
  deletedAt = null,
}) {
  await query(
    `INSERT INTO agent_runs
       (id,session_id,project_id,user_id,status,status_changed_at,viewed_at,created_at,updated_at,deleted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, sessionId, projectId, userId, status, statusChangedAt, viewedAt, createdAt, updatedAt, deletedAt],
  );
}

async function cleanup({ projectIds = [], sessionIds = [], pendingIds = [] }) {
  for (const pendingId of pendingIds) pendingDecisions.delete(pendingId);
  await query(
    "DELETE FROM agent_run_events WHERE run_id IN (SELECT id FROM agent_runs WHERE session_id = ANY($1::text[]))",
    [sessionIds],
  );
  await query("DELETE FROM agent_runs WHERE session_id = ANY($1::text[])", [sessionIds]);
  await query("DELETE FROM session_messages WHERE session_id = ANY($1::text[])", [sessionIds]);
  await query("DELETE FROM sessions WHERE id = ANY($1::text[])", [sessionIds]);
  await query("DELETE FROM projects WHERE id = ANY($1::text[])", [projectIds]);
}

test("agent_runs upgrade backfills old terminal rows but leaves new runs unseen", (t) => {
  const dataRoot = mkdtempSync(join(tmpdir(), "dsh-sidebar-upgrade-"));
  const databasePath = join(dataRoot, "legacy.db");
  t.after(() => rmSync(dataRoot, { recursive: true, force: true }));

  const legacyDb = new Database(databasePath);
  legacyDb.exec(`
    CREATE TABLE agent_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT,
      user_id TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      skill_name TEXT,
      mode TEXT,
      checkpoint_json TEXT,
      metadata_json TEXT,
      finished_at TEXT,
      created_at TEXT,
      updated_at TEXT,
      deleted_at TEXT,
      deleted_by TEXT
    );
  `);
  const insertLegacy = legacyDb.prepare(
    "INSERT INTO agent_runs (id,session_id,status,finished_at,created_at,updated_at) VALUES (?,?,?,?,?,?)",
  );
  for (const status of ["completed", "failed", "interrupted", "expired", "running"]) {
    insertLegacy.run(
      `legacy-${status}`,
      "legacy-session",
      status,
      status === "running" ? null : "2026-08-08T10:00:00.000Z",
      "2026-08-08T09:00:00.000Z",
      "2026-08-08T10:00:00.000Z",
    );
  }
  legacyDb.close();

  const dbModuleUrl = new URL("../../server/src/db.js", import.meta.url).href;
  const childSource = `
    const database = await import(${JSON.stringify(dbModuleUrl)});
    const oldRows = await database.query(
      "SELECT id,status,viewed_at,status_changed_at FROM agent_runs WHERE session_id='legacy-session' ORDER BY id"
    );
    await database.query(
      "INSERT INTO agent_runs (id,session_id,status,created_at,updated_at) VALUES ('fresh-completed','fresh-session','completed',now(),now())"
    );
    const fresh = await database.queryOne("SELECT viewed_at FROM agent_runs WHERE id='fresh-completed'");
    console.log("SIDEBAR_UPGRADE=" + JSON.stringify({ oldRows, fresh }));
    database.closeDatabase();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", childSource], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_TEST_ISOLATED: "1",
      DSH_DATA_ROOT: dataRoot,
      DB_SQLITE_PATH: databasePath,
      DSH_AGENT_RUNTIME_HOME: join(dataRoot, "agent-runtime"),
      DSH_SKILLS_ROOT: join(dataRoot, "skills"),
    },
    encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const resultLine = child.stdout.split("\n").find((line) => line.startsWith("SIDEBAR_UPGRADE="));
  assert.ok(resultLine, child.stdout);
  const result = JSON.parse(resultLine.slice("SIDEBAR_UPGRADE=".length));

  const historical = Object.fromEntries(result.oldRows.map((row) => [row.status, row.viewed_at]));
  for (const status of ["completed", "failed", "interrupted", "expired"]) {
    assert.ok(historical[status], `${status} should be backfilled as viewed`);
  }
  assert.ok(result.oldRows.every((row) => row.status_changed_at), "old runs should receive a stable status timestamp");
  assert.equal(historical.running, null);
  assert.equal(result.fresh.viewed_at, null);
});

test("conversation status stream sends ready and scoped invalidations, then unsubscribes on abort", async () => {
  const userId = `status-stream-user-${randomUUID()}`;
  const controller = new AbortController();
  const events = [];
  const watching = watchAgentSessionStatusEvents(
    { userId, signal: controller.signal },
    {},
    (event) => events.push(event),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].type, CONVERSATION_STATUS_EVENT_TYPES.READY);
  assert.equal(events[0].payload.reason, "stream_ready");
  assert.equal(typeof events[0].payload.event_id, "string");
  assert.equal(typeof events[0].payload.server_instance_id, "string");
  assert.equal(typeof events[0].payload.seq, "number");
  assert.equal(typeof events[0].payload.at, "string");

  publishConversationStatusChanged({
    userId: `other-${userId}`,
    projectId: "other-project",
    sessionId: "other-session",
    runId: "other-run",
    reason: "should_not_arrive",
  });
  assert.equal(events.length, 1);

  publishConversationStatusChanged({
    userId,
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-1",
    reason: "run_status_changed",
  });
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], {
    type: CONVERSATION_STATUS_EVENT_TYPES.CHANGED,
    payload: {
      event_id: events[1].payload.event_id,
      server_instance_id: events[0].payload.server_instance_id,
      seq: events[1].payload.seq,
      project_id: "project-1",
      session_id: "session-1",
      run_id: "run-1",
      reason: "run_status_changed",
      at: events[1].payload.at,
    },
  });
  assert.ok(events[1].payload.seq > events[0].payload.seq);

  assert.equal(CONVERSATION_STATUS_HEARTBEAT_MS, 20_000);
  const heartbeat = createConversationStatusHeartbeatEvent();
  assert.equal(heartbeat.type, CONVERSATION_STATUS_EVENT_TYPES.HEARTBEAT);
  assert.equal(heartbeat.payload.reason, "heartbeat");
  assert.equal(heartbeat.payload.project_id, null);
  assert.equal(heartbeat.payload.session_id, null);
  assert.equal(heartbeat.payload.run_id, null);

  controller.abort();
  await watching;
  publishConversationStatusChanged({
    userId,
    projectId: "project-1",
    sessionId: "session-1",
    runId: "run-1",
    reason: "after_abort",
  });
  assert.equal(events.length, 2);

  const route = chatRoutes.find((item) => (
    item.m === "GET" && item.p === "/api/agent/session-status/events"
  ));
  assert.equal(route?.fn, watchAgentSessionStatusEvents);
  assert.equal(route?.auth, true);
  assert.equal(route?.stream, true);
});

test("pending decisions publish waiting and resolved invalidations with their session scope", () => {
  const userId = `pending-events-user-${randomUUID()}`;
  const projectId = `pending-events-project-${randomUUID()}`;
  const sessionId = `pending-events-session-${randomUUID()}`;
  const runId = `pending-events-run-${randomUUID()}`;
  const requestId = `pending-events-request-${randomUUID()}`;
  const events = [];
  const unsubscribe = subscribeConversationStatusEvents((event) => events.push(event), { userId });
  try {
    pendingDecisions.set(requestId, {
      userId,
      projectId,
      sessionId,
      runId,
      kind: "user_input",
    });
    assert.equal(pendingDecisions.delete(requestId), true);
  } finally {
    pendingDecisions.delete(requestId);
    unsubscribe();
  }

  assert.equal(events.length, 2);
  assert.equal(events[0].payload.reason, "interaction_waiting_user_input");
  assert.equal(events[1].payload.reason, "interaction_resolved");
  for (const event of events) {
    assert.equal(event.payload.project_id, projectId);
    assert.equal(event.payload.session_id, sessionId);
    assert.equal(event.payload.run_id, runId);
  }
});

test("live pending interaction hydration exposes only scoped public clones", () => {
  const userId = `pending-public-user-${randomUUID()}`;
  const projectId = `pending-public-project-${randomUUID()}`;
  const sessionId = `pending-public-session-${randomUUID()}`;
  const runId = `pending-public-run-${randomUUID()}`;
  const userInputId = `pending-public-input-${randomUUID()}`;
  const approvalId = `pending-public-approval-${randomUUID()}`;
  const createdAt = "2026-08-09T10:00:00.000Z";
  const request = {
    request_id: userInputId,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: userInputId,
    questions: [
      { id: "choice", question: "请选择", options: [{ label: "A" }] },
      { id: "secret", question: "请输入密钥", isSecret: true, defaultValue: "must-not-leak", options: [] },
    ],
    autoResolutionMs: null,
    rawKernelParams: { must_not_leak: true },
  };
  const userEntry = {
    resolve: () => {},
    rawKernelParams: { must_not_leak: true },
    userId,
    projectId,
    sessionId,
    runId,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: userInputId,
    kind: "user_input",
    createdAt,
  };
  userEntry.publicInteraction = createLivePendingInteraction(userEntry, {
    requestId: userInputId,
    request,
    block: { id: `user_input:${userInputId}`, type: "user_input", title: "requested" },
    createdAt,
  });
  pendingDecisions.set(userInputId, userEntry);
  pendingDecisions.set(approvalId, {
    resolve: () => {},
    userId,
    projectId,
    sessionId,
    runId,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: approvalId,
    kind: "approval",
    createdAt,
  });
  try {
    assert.equal(attachPendingDecisionPublicInteraction(approvalId, {
      block: { id: `confirm:${approvalId}`, type: "confirm", title: "需要批准" },
    }), true);
    const listed = listLivePendingInteractions({ userId, projectId, sessionId });
    assert.equal(listed.length, 2);
    const input = listed.find((item) => item.request_id === userInputId);
    assert.equal(input.version, 1);
    assert.deepEqual(input.resolution, {
      type: "native_turn",
      thread_id: "thread-1",
      turn_id: "turn-1",
      item_id: userInputId,
    });
    assert.equal(input.request.rawKernelParams, undefined);
    assert.equal(input.request.questions.find((question) => question.id === "secret").defaultValue, undefined);
    assert.equal(JSON.parse(input.block.content).questions.find((question) => question.id === "secret").defaultValue, undefined);
    assert.equal(input.resolve, undefined);
    assert.equal(input.rawKernelParams, undefined);
    const approval = listed.find((item) => item.request_id === approvalId);
    assert.equal(approval.kind, "approval");
    assert.equal(approval.request, undefined);
    assert.equal(approval.block.type, "confirm");

    input.block.title = "mutated clone";
    const listedAgain = listLivePendingInteractions({ userId, projectId, sessionId });
    assert.equal(listedAgain.find((item) => item.request_id === userInputId).block.title, "requested");
    assert.deepEqual(listLivePendingInteractions({ userId: `other-${userId}`, projectId, sessionId }), []);
    assert.deepEqual(listLivePendingInteractions({ userId, projectId: `other-${projectId}`, sessionId }), []);
    assert.deepEqual(listLivePendingInteractions({ userId, projectId, sessionId: `other-${sessionId}` }), []);
  } finally {
    pendingDecisions.delete(userInputId);
    pendingDecisions.delete(approvalId);
  }
});

test("durable run transitions and stale-run recovery publish scoped invalidations after writes", async (t) => {
  const userId = `run-events-user-${randomUUID()}`;
  const projectId = `run-events-project-${randomUUID()}`;
  const sessionIds = [randomUUID(), randomUUID()];
  const [transitionSessionId, recoverySessionId] = sessionIds;
  const transitionRunId = randomUUID();
  const recoveryRunId = randomUUID();
  t.after(() => cleanup({ projectIds: [projectId], sessionIds }));

  await query(
    "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,'运行事件','active',now(),now())",
    [projectId],
  );
  for (const sessionId of sessionIds) await insertSession({ id: sessionId, projectId, userId });
  await insertRun({
    id: transitionRunId,
    sessionId: transitionSessionId,
    projectId: null,
    userId: null,
    status: "running",
    createdAt: "2026-08-09T09:00:00.000Z",
  });
  await insertRun({
    id: recoveryRunId,
    sessionId: recoverySessionId,
    projectId: null,
    userId: null,
    status: "running",
    createdAt: "2026-08-09T09:00:00.000Z",
  });
  await query(
    "UPDATE agent_runs SET lease_expires_at='2000-01-01T00:00:00.000Z', recoverable=0 WHERE id=$1",
    [recoveryRunId],
  );

  const events = [];
  const unsubscribe = subscribeConversationStatusEvents((event) => events.push(event), { userId });
  const unsubscribeThrowing = subscribeConversationStatusEvents(() => {
    throw new Error("stale listener");
  }, { userId });
  t.after(() => {
    unsubscribe();
    unsubscribeThrowing();
  });

  await transitionAgentRun(context(userId), {
    runId: transitionRunId,
    status: "completed",
    finished: true,
  });
  assert.equal((await queryOne("SELECT status FROM agent_runs WHERE id=$1", [transitionRunId])).status, "completed");
  const transitionEvent = events.find((event) => event.payload.run_id === transitionRunId);
  assert.equal(transitionEvent?.payload.reason, "run_status_changed");
  assert.equal(transitionEvent?.payload.project_id, projectId);
  assert.equal(transitionEvent?.payload.session_id, transitionSessionId);

  const recovered = await recoverStaleAgentRuns(context(userId), { now: "2026-08-09T12:00:00.000Z" });
  assert.ok(recovered.some((item) => item.run_id === recoveryRunId && item.status === "interrupted"));
  assert.equal((await queryOne("SELECT status FROM agent_runs WHERE id=$1", [recoveryRunId])).status, "interrupted");
  const recoveryEvent = events.find((event) => event.payload.run_id === recoveryRunId);
  assert.equal(recoveryEvent?.payload.reason, "run_recovery_interrupted");
  assert.equal(recoveryEvent?.payload.project_id, projectId);
  assert.equal(recoveryEvent?.payload.session_id, recoverySessionId);
});

test("session list selects one newest run and gives live interactions their own priority field", async (t) => {
  const userId = `sidebar-user-${randomUUID()}`;
  const projectId = `sidebar-project-${randomUUID()}`;
  const projectIds = [projectId];
  const sessionIds = [randomUUID(), randomUUID(), randomUUID()];
  const [latestSessionId, approvalSessionId, inputSessionId] = sessionIds;
  const approvalId = `approval-${randomUUID()}`;
  const inputId = `input-${randomUUID()}`;
  const pendingIds = [approvalId, inputId];
  t.after(() => cleanup({ projectIds, sessionIds, pendingIds }));

  await query(
    "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,'侧边栏状态','active',now(),now())",
    [projectId],
  );
  for (const sessionId of sessionIds) await insertSession({ id: sessionId, projectId, userId });

  const oldRunId = randomUUID();
  const newestRunId = randomUUID();
  await insertRun({
    id: oldRunId,
    sessionId: latestSessionId,
    projectId,
    userId,
    status: "completed",
    createdAt: "2026-08-09T09:00:00.000Z",
    viewedAt: "2026-08-09T09:30:00.000Z",
  });
  await insertRun({
    id: newestRunId,
    sessionId: latestSessionId,
    projectId,
    userId,
    status: "running",
    createdAt: "2026-08-09T10:00:00.000Z",
  });
  await insertRun({
    id: randomUUID(),
    sessionId: latestSessionId,
    projectId,
    userId,
    status: "failed",
    createdAt: "2026-08-09T11:00:00.000Z",
    deletedAt: "2026-08-09T11:01:00.000Z",
  });
  await insertRun({
    id: randomUUID(), sessionId: approvalSessionId, projectId, userId,
    status: "running", createdAt: "2026-08-09T10:00:00.000Z",
  });
  await insertRun({
    id: randomUUID(), sessionId: inputSessionId, projectId, userId,
    status: "running", createdAt: "2026-08-09T10:00:00.000Z",
  });
  pendingDecisions.set(approvalId, { sessionId: approvalSessionId, kind: "approval" });
  pendingDecisions.set(inputId, { sessionId: inputSessionId, kind: "user_input" });

  const listed = await listAgentSessions(context(userId), { params: { pid: projectId }, query: {} });
  const byId = new Map(listed.data.items.map((item) => [item.id, item]));
  assert.equal(byId.get(latestSessionId).latest_run_id, newestRunId);
  assert.equal(byId.get(latestSessionId).latest_run_status, "running");
  assert.equal(byId.get(latestSessionId).latest_run_viewed_at, null);
  assert.equal(byId.get(latestSessionId).live_interaction_status, null);
  assert.equal(byId.get(approvalSessionId).live_interaction_status, "waiting_approval");
  assert.equal(byId.get(inputSessionId).live_interaction_status, "waiting_user_input");

  await query(
    "UPDATE agent_runs SET archived_at='2026-08-09T12:00:00.000Z', updated_at='2026-08-09T12:00:00.000Z' WHERE id=$1",
    [oldRunId],
  );
  const afterArchive = await listAgentSessions(context(userId), { params: { pid: projectId }, query: {} });
  const archivedSession = afterArchive.data.items.find((item) => item.id === latestSessionId);
  assert.equal(archivedSession.latest_run_id, newestRunId);
  assert.equal(archivedSession.latest_run_status, "running");
  const staleViewed = await markAgentSessionViewed(context(userId), {
    params: { pid: projectId, sid: latestSessionId },
    body: { run_id: oldRunId },
  });
  assert.equal(staleViewed.data.viewed, false);
  assert.equal(staleViewed.data.run_id, newestRunId);
});

test("a recovered run clears the previous viewed result before completing again", async (t) => {
  const userId = `sidebar-recovery-user-${randomUUID()}`;
  const projectId = `sidebar-recovery-project-${randomUUID()}`;
  const sessionId = randomUUID();
  const runId = randomUUID();
  t.after(() => cleanup({ projectIds: [projectId], sessionIds: [sessionId] }));

  await query(
    "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,'恢复状态','active',now(),now())",
    [projectId],
  );
  await insertSession({ id: sessionId, projectId, userId });
  await insertRun({
    id: runId,
    sessionId,
    projectId,
    userId,
    status: "failed",
    createdAt: "2026-08-09T08:00:00.000Z",
    viewedAt: "2026-08-09T08:30:00.000Z",
  });
  await query("UPDATE agent_runs SET finished_at='2026-08-09T08:10:00.000Z' WHERE id=$1", [runId]);

  await transitionAgentRun(context(userId), { runId, status: "recovering", eventType: "run_recovery_requested" });
  const recovering = await queryOne("SELECT status,viewed_at,finished_at FROM agent_runs WHERE id=$1", [runId]);
  assert.deepEqual(recovering, { status: "recovering", viewed_at: null, finished_at: null });

  await transitionAgentRun(context(userId), { runId, status: "completed", finished: true });
  const completed = await queryOne("SELECT status,viewed_at,finished_at FROM agent_runs WHERE id=$1", [runId]);
  assert.equal(completed.status, "completed");
  assert.equal(completed.viewed_at, null);
  assert.ok(completed.finished_at);
});

test("run terminal persistence happens after the message save and save failure cannot complete", async () => {
  const completedOrder = [];
  const completed = await persistAgentTurnBeforeRunTerminal({
    persist: async () => {
      completedOrder.push("persist");
      return { ok: true };
    },
    runtime: {
      completeRun: async (status) => completedOrder.push(`terminal:${status}`),
    },
    runCreated: true,
    finalStatus: "completed",
  });
  assert.deepEqual(completedOrder, ["persist", "terminal:completed"]);
  assert.equal(completed.durable_status, "completed");

  const failedOrder = [];
  const persistenceError = new Error("write failed");
  const failed = await persistAgentTurnBeforeRunTerminal({
    persist: async () => {
      failedOrder.push("persist");
      return { ok: false, error: persistenceError };
    },
    runtime: {
      completeRun: async (status) => failedOrder.push(`terminal:${status}`),
    },
    runCreated: true,
    finalStatus: "completed",
  });
  assert.deepEqual(failedOrder, ["persist", "terminal:failed"]);
  assert.equal(failed.durable_status, "failed");
  assert.equal(failed.persistence.error, persistenceError);
});

test("retention cleanup invalidates the affected conversation after deleting its latest run", async (t) => {
  const userId = `sidebar-retention-user-${randomUUID()}`;
  const projectId = `sidebar-retention-project-${randomUUID()}`;
  const sessionId = randomUUID();
  const previousRunId = randomUUID();
  const expiredRunId = randomUUID();
  t.after(() => cleanup({ projectIds: [projectId], sessionIds: [sessionId] }));

  await query(
    "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,'清理状态','active',now(),now())",
    [projectId],
  );
  await insertSession({ id: sessionId, projectId, userId });
  await insertRun({
    id: previousRunId, sessionId, projectId, userId,
    status: "completed", createdAt: "2026-08-09T08:00:00.000Z", viewedAt: "2026-08-09T08:10:00.000Z",
  });
  await insertRun({
    id: expiredRunId, sessionId, projectId, userId,
    status: "completed", createdAt: "2026-08-09T09:00:00.000Z",
  });
  await query("UPDATE agent_runs SET retention_until='2026-08-09T09:30:00.000Z' WHERE id=$1", [expiredRunId]);

  const events = [];
  const unsubscribe = subscribeConversationStatusEvents((event) => events.push(event), { userId });
  t.after(unsubscribe);
  const result = await cleanupExpiredRunFacts(context(userId), {
    now: "2026-08-09T10:00:00.000Z",
    runIds: [expiredRunId],
    removeRunDirectory: async () => ({ removed: true }),
  });
  assert.deepEqual(result.cleaned_run_ids, [expiredRunId]);
  const invalidation = events.find((event) => event.payload.reason === "run_retention_deleted");
  assert.equal(invalidation?.payload.session_id, sessionId);
  assert.equal(invalidation?.payload.project_id, projectId);
  assert.equal(invalidation?.payload.run_id, expiredRunId);

  const listed = await listAgentSessions(context(userId), { params: { pid: projectId }, query: {} });
  const session = listed.data.items.find((item) => item.id === sessionId);
  assert.equal(session.latest_run_id, previousRunId);
});

test("session list propagates database failures instead of returning an empty success", async () => {
  const databaseError = new Error("database unavailable");
  await assert.rejects(
    listAgentSessions(
      { userId: "sidebar-query-error-user", query: async () => { throw databaseError; } },
      { params: { pid: "sidebar-query-error-project" }, query: {} },
    ),
    databaseError,
  );
});

test("viewed endpoint marks only the newest terminal run and enforces owner and project scope", async (t) => {
  const userId = `sidebar-view-user-${randomUUID()}`;
  const otherUserId = `sidebar-view-other-${randomUUID()}`;
  const projectId = `sidebar-view-project-${randomUUID()}`;
  const otherProjectId = `sidebar-view-project-other-${randomUUID()}`;
  const projectIds = [projectId, otherProjectId];
  const sessionIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [terminalSessionId, runningSessionId, waitingSessionId, protectedSessionId] = sessionIds;
  t.after(() => cleanup({ projectIds, sessionIds }));

  for (const [id, name] of [[projectId, "状态项目"], [otherProjectId, "其他项目"]]) {
    await query(
      "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,$2,'active',now(),now())",
      [id, name],
    );
  }
  for (const sessionId of sessionIds) await insertSession({ id: sessionId, projectId, userId });

  const olderTerminalId = randomUUID();
  const latestTerminalId = randomUUID();
  const runningRunId = randomUUID();
  const waitingRunId = randomUUID();
  const protectedRunId = randomUUID();
  const statusEvents = [];
  const unsubscribeStatus = subscribeConversationStatusEvents((event) => statusEvents.push(event), { userId });
  t.after(unsubscribeStatus);
  await insertRun({
    id: olderTerminalId, sessionId: terminalSessionId, projectId, userId,
    status: "failed", createdAt: "2026-08-09T08:00:00.000Z",
  });
  await insertRun({
    id: latestTerminalId, sessionId: terminalSessionId, projectId, userId,
    status: "completed", createdAt: "2026-08-09T09:00:00.000Z",
  });
  await insertRun({
    id: runningRunId, sessionId: runningSessionId, projectId, userId,
    status: "running", createdAt: "2026-08-09T09:00:00.000Z",
  });
  await insertRun({
    id: waitingRunId, sessionId: waitingSessionId, projectId, userId,
    status: "waiting_user_input", createdAt: "2026-08-09T09:00:00.000Z",
  });
  await insertRun({
    id: protectedRunId, sessionId: protectedSessionId, projectId, userId,
    status: "failed", createdAt: "2026-08-09T09:00:00.000Z",
  });

  const marked = await markAgentSessionViewed(context(userId), {
    params: { pid: projectId, sid: terminalSessionId },
    body: { run_id: latestTerminalId },
  });
  assert.equal(marked.data.run_id, latestTerminalId);
  assert.equal(marked.data.status, "completed");
  assert.equal(marked.data.viewed, true);
  assert.ok(marked.data.viewed_at);
  assert.equal((await queryOne("SELECT viewed_at FROM agent_runs WHERE id=$1", [olderTerminalId])).viewed_at, null);
  assert.ok((await queryOne("SELECT viewed_at FROM agent_runs WHERE id=$1", [latestTerminalId])).viewed_at);
  const viewedEvent = statusEvents.find((event) => (
    event.payload.reason === "run_viewed" && event.payload.run_id === latestTerminalId
  ));
  assert.equal(viewedEvent?.payload.project_id, projectId);
  assert.equal(viewedEvent?.payload.session_id, terminalSessionId);

  const stale = await markAgentSessionViewed(context(userId), {
    params: { pid: projectId, sid: terminalSessionId },
    body: { run_id: olderTerminalId },
  });
  assert.equal(stale.data.viewed, false);
  assert.equal(stale.data.run_id, latestTerminalId);
  assert.equal((await queryOne("SELECT viewed_at FROM agent_runs WHERE id=$1", [olderTerminalId])).viewed_at, null);

  for (const [sessionId, runId, expectedStatus] of [
    [runningSessionId, runningRunId, "running"],
    [waitingSessionId, waitingRunId, "waiting_user_input"],
  ]) {
    const response = await markAgentSessionViewed(context(userId), {
      params: { pid: projectId, sid: sessionId },
      body: { run_id: runId },
    });
    assert.deepEqual(response.data, {
      run_id: runId,
      status: expectedStatus,
      viewed_at: null,
      viewed: false,
    });
    assert.equal((await queryOne("SELECT viewed_at FROM agent_runs WHERE id=$1", [runId])).viewed_at, null);
  }

  await assert.rejects(
    markAgentSessionViewed(context(otherUserId), {
      params: { pid: projectId, sid: protectedSessionId },
      body: { run_id: protectedRunId },
    }),
    (error) => error?.status === 404,
  );
  await assert.rejects(
    markAgentSessionViewed(context(userId), {
      params: { pid: otherProjectId, sid: protectedSessionId },
      body: { run_id: protectedRunId },
    }),
    (error) => error?.status === 404,
  );
  assert.equal((await queryOne("SELECT viewed_at FROM agent_runs WHERE id=$1", [protectedRunId])).viewed_at, null);

  const route = chatRoutes.find((item) => (
    item.m === "POST" && item.p === "/api/agent/projects/:pid/sessions/:sid/viewed"
  ));
  assert.equal(route?.fn, markAgentSessionViewed);
  assert.equal(route?.auth, true);
});
