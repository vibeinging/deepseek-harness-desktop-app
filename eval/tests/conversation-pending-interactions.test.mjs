import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import { query, queryOne } from "../../server/src/db.js";
import {
  attachPendingDecisionPublicInteraction,
  pendingDecisions,
} from "../../server/src/app/chat/agent_misc.js";
import { listSessionMessages } from "../../server/src/app/reads/reads_session.js";
import {
  requireOwnedDurablePendingAction,
  resolveAgentPendingAction,
} from "../../server/src/app/agent_actions/pending_actions.js";
import { requireIsolatedTestEnvironment } from "./test-environment.mjs";

requireIsolatedTestEnvironment("conversation-pending-interactions.test.mjs");

const ctx = (userId) => ({ userId, query, queryOne });

async function insertSession({ sessionId, projectId, userId }) {
  await query(
    `INSERT INTO sessions
       (id,project_id,created_by,source_type,source_id,action_type,title,status,message_count,session_config,created_at,updated_at)
     VALUES ($1,$2,$3,'project',$2,'agentic_chat','交互恢复','active',1,'{}',now(),now())`,
    [sessionId, projectId, userId],
  );
  await query(
    `INSERT INTO session_messages
       (id,session_id,role,content_items,sequence_number,created_at,updated_at)
     VALUES ($1,$2,'user',$3,1,now(),now())`,
    [randomUUID(), sessionId, JSON.stringify([{ type: "text", content: "开始任务" }])],
  );
}

async function cleanup({ projectIds, sessionIds, runIds, pendingDecisionIds }) {
  for (const id of pendingDecisionIds) pendingDecisions.delete(id);
  for (const runId of runIds) {
    await query("DELETE FROM agent_run_events WHERE run_id=$1", [runId]);
    await query("DELETE FROM agent_pending_inputs WHERE run_id=$1", [runId]);
    await query("DELETE FROM agent_runs WHERE id=$1", [runId]);
  }
  for (const sessionId of sessionIds) {
    await query("DELETE FROM session_messages WHERE session_id=$1", [sessionId]);
    await query("DELETE FROM sessions WHERE id=$1", [sessionId]);
  }
  for (const projectId of projectIds) {
    await query("DELETE FROM projects WHERE id=$1", [projectId]);
  }
}

test("session messages hydrate only the current user's scoped native interaction", async (t) => {
  const userId = `pending-user-${randomUUID()}`;
  const otherUserId = `pending-other-user-${randomUUID()}`;
  const projectId = `pending-project-${randomUUID()}`;
  const otherProjectId = `pending-other-project-${randomUUID()}`;
  const sessionId = `pending-session-${randomUUID()}`;
  const interactionId = `native-${randomUUID()}`;
  const wrongScopeId = `native-wrong-${randomUUID()}`;
  const runId = `native-run-${randomUUID()}`;
  t.after(() => cleanup({
    projectIds: [projectId, otherProjectId],
    sessionIds: [sessionId],
    runIds: [],
    pendingDecisionIds: [interactionId, wrongScopeId],
  }));

  await query(
    "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,$2,'active',now(),now()),($3,$4,'active',now(),now())",
    [projectId, "交互恢复", otherProjectId, "其他项目"],
  );
  await insertSession({ sessionId, projectId, userId });
  pendingDecisions.set(interactionId, {
    resolve: () => {},
    userId,
    projectId,
    sessionId,
    runId,
    threadId: sessionId,
    turnId: runId,
    itemId: interactionId,
    kind: "approval",
  });
  assert.equal(attachPendingDecisionPublicInteraction(interactionId, {
    block: {
      id: `confirm:${interactionId}`,
      type: "confirm",
      title: "需要确认",
      metadata: { request_id: interactionId },
    },
  }), true);
  pendingDecisions.set(wrongScopeId, {
    resolve: () => {},
    userId: otherUserId,
    projectId: otherProjectId,
    sessionId,
    runId: `wrong-${runId}`,
    threadId: sessionId,
    turnId: `wrong-${runId}`,
    itemId: wrongScopeId,
    kind: "approval",
  });
  assert.equal(attachPendingDecisionPublicInteraction(wrongScopeId, {
    block: { id: `confirm:${wrongScopeId}`, type: "confirm", title: "不应泄露" },
  }), true);

  const response = await listSessionMessages(ctx(userId), { params: { pid: projectId, sid: sessionId } });
  assert.equal(response.data.messages.length, 1);
  assert.equal(response.data.messages[0].role, "user");
  assert.equal(response.data.messages[0].timestamp, response.data.messages[0].created_at);
  assert.deepEqual(response.data.pending_interactions.map((item) => item.request_id), [interactionId]);
  assert.equal(response.data.pending_interactions[0].resolution.type, "native_turn");

  const wrongUser = await listSessionMessages(ctx(otherUserId), { params: { pid: projectId, sid: sessionId } });
  assert.deepEqual(wrongUser.data.messages, []);
  assert.deepEqual(wrongUser.data.pending_interactions, []);
  const wrongProject = await listSessionMessages(ctx(userId), { params: { pid: otherProjectId, sid: sessionId } });
  assert.deepEqual(wrongProject.data.messages, []);
  assert.deepEqual(wrongProject.data.pending_interactions, []);
});

test("durable pending resolve rejects the wrong user, project, run, and native-only request before consumption", async (t) => {
  const userId = `durable-user-${randomUUID()}`;
  const otherUserId = `durable-other-user-${randomUUID()}`;
  const projectId = `durable-project-${randomUUID()}`;
  const otherProjectId = `durable-other-project-${randomUUID()}`;
  const sessionId = `durable-session-${randomUUID()}`;
  const runId = `durable-run-${randomUUID()}`;
  const requestId = `durable-request-${randomUUID()}`;
  const nativeRequestId = `native-request-${randomUUID()}`;
  const nativeRunId = `native-run-${randomUUID()}`;
  t.after(() => cleanup({
    projectIds: [projectId, otherProjectId],
    sessionIds: [sessionId],
    runIds: [runId],
    pendingDecisionIds: [nativeRequestId],
  }));

  await query(
    "INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,$2,'active',now(),now()),($3,$4,'active',now(),now())",
    [projectId, "长期任务", otherProjectId, "错误项目"],
  );
  await insertSession({ sessionId, projectId, userId });
  await query(
    `INSERT INTO agent_runs
       (id,session_id,project_id,user_id,status,created_at,updated_at)
     VALUES ($1,$2,$3,$4,'waiting_approval',now(),now())`,
    [runId, sessionId, projectId, userId],
  );
  await query(
    `INSERT INTO agent_pending_inputs
       (id,run_id,session_id,project_id,user_id,request_id,input_type,status,payload_json,resume_handle_json,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,'approval','pending','{}','{}',now(),now())`,
    [randomUUID(), runId, sessionId, projectId, userId, requestId],
  );

  const owned = await requireOwnedDurablePendingAction(ctx(userId), {
    projectId,
    sessionId,
    requestId,
    runId,
    inputType: "approval",
  });
  assert.equal(owned.request_id, requestId);

  const invoke = (callCtx, { pid = projectId, suppliedRunId = runId, suppliedRequestId = requestId } = {}) => (
    resolveAgentPendingAction(callCtx, {
      params: { pid, sid: sessionId, requestId: suppliedRequestId },
      body: { action_type: "approval", approved: true, run_id: suppliedRunId },
    }, () => {})
  );
  const assertStillPending = async () => {
    assert.equal((await queryOne(
      "SELECT status FROM agent_pending_inputs WHERE request_id=$1",
      [requestId],
    ))?.status, "pending");
  };

  await assert.rejects(invoke(ctx(otherUserId)), (error) => error?.status === 404);
  await assertStillPending();
  await assert.rejects(invoke(ctx(userId), { pid: otherProjectId }), (error) => error?.status === 404);
  await assertStillPending();
  await assert.rejects(invoke(ctx(userId), { suppliedRunId: `wrong-${runId}` }), (error) => error?.status === 409);
  await assertStillPending();

  await query("UPDATE agent_runs SET project_id=$2 WHERE id=$1", [runId, otherProjectId]);
  await assert.rejects(invoke(ctx(userId)), (error) => error?.status === 409);
  await assertStillPending();
  await query("UPDATE agent_runs SET project_id=$2 WHERE id=$1", [runId, projectId]);

  await query("UPDATE agent_runs SET user_id=$2 WHERE id=$1", [runId, otherUserId]);
  await assert.rejects(invoke(ctx(userId)), (error) => error?.status === 409);
  await assertStillPending();
  await query("UPDATE agent_runs SET user_id=$2 WHERE id=$1", [runId, userId]);

  await query("UPDATE agent_pending_inputs SET project_id=$2 WHERE request_id=$1", [requestId, otherProjectId]);
  await assert.rejects(invoke(ctx(userId)), (error) => error?.status === 409);
  await assertStillPending();
  await query("UPDATE agent_pending_inputs SET project_id=$2 WHERE request_id=$1", [requestId, projectId]);

  await query("UPDATE agent_pending_inputs SET user_id=$2 WHERE request_id=$1", [requestId, otherUserId]);
  await assert.rejects(invoke(ctx(userId)), (error) => error?.status === 409);
  await assertStillPending();
  await query("UPDATE agent_pending_inputs SET user_id=$2 WHERE request_id=$1", [requestId, userId]);

  pendingDecisions.set(nativeRequestId, {
    resolve: () => assert.fail("native interaction must not use durable resolver"),
    userId,
    projectId,
    sessionId,
    runId: nativeRunId,
    threadId: sessionId,
    turnId: nativeRunId,
    itemId: nativeRequestId,
    kind: "approval",
  });
  assert.equal(attachPendingDecisionPublicInteraction(nativeRequestId, {
    block: { id: `confirm:${nativeRequestId}`, type: "confirm", title: "原生确认" },
  }), true);
  await assert.rejects(
    invoke(ctx(userId), { suppliedRunId: nativeRunId, suppliedRequestId: nativeRequestId }),
    (error) => error?.status === 409,
  );
  assert.equal(pendingDecisions.has(nativeRequestId), true);
});
