import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { query, queryOne } from '../../server/src/db.js';
import {
  appendRunEvent,
  beginToolCall,
  canTransitionRun,
  finishToolCall,
  recordRunArtifact,
  recoverStaleAgentRuns,
  saveRunCheckpoint,
  transitionAgentRun,
} from '../../server/src/engine/agents/run_fact_store.js';
import {
  createAgentRun,
  resolvePendingApproval,
  suspendRunForApproval,
  suspendRunForUserInput,
} from '../../server/src/engine/agents/agent_run_runtime.js';
import {
  activeRunSnapshot,
  clearActiveRunsForTests,
  registerActiveRun,
  stopActiveRun,
} from '../../server/src/engine/agents/active_run_registry.js';
import {
  getAgentRun,
  listAgentRuns,
  prepareAgentRunRecovery,
  stopAgentRun,
} from '../../server/src/app/agents/run_center.js';

const ctx = { query, queryOne };

async function cleanup(runId) {
  await query('DELETE FROM session_messages WHERE id=$1', [`assistant:${runId}`]);
  await query('DELETE FROM agent_run_events WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_tool_calls WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_artifacts WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_pending_inputs WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_runs WHERE id=$1', [runId]);
}

test('run state machine rejects invalid terminal transitions', () => {
  assert.equal(canTransitionRun('queued', 'running'), true);
  assert.equal(canTransitionRun('running', 'waiting_approval'), true);
  assert.equal(canTransitionRun('waiting_user_input', 'recovering'), true);
  assert.equal(canTransitionRun('completed', 'running'), false);
  assert.equal(canTransitionRun('expired', 'recovering'), false);
});

test('run events are append-only with one strictly increasing sequence', async () => {
  const runId = `facts-${randomUUID()}`;
  try {
    await createAgentRun(ctx, {
      runId,
      sessionId: `session-${randomUUID()}`,
      projectId: `project-${randomUUID()}`,
      status: 'running',
    });
    await Promise.all(Array.from({ length: 12 }, (_, index) => appendRunEvent(ctx, {
      runId,
      eventType: 'test_event',
      outputSummary: `event-${index}`,
    })));
    const events = await query(
      'SELECT seq, event_type FROM agent_run_events WHERE run_id=$1 ORDER BY seq ASC',
      [runId],
    );
    assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
    const run = await queryOne('SELECT last_event_seq FROM agent_runs WHERE id=$1', [runId]);
    assert.equal(run.last_event_seq, events.length);

    await transitionAgentRun(ctx, { runId, status: 'completed' });
    await assert.rejects(
      () => transitionAgentRun(ctx, { runId, status: 'running' }),
      (error) => error.code === 'AGENT_RUN_INVALID_TRANSITION',
    );
  } finally {
    await cleanup(runId);
  }
});

test('completed write calls replay their stored result and never execute twice', async () => {
  const runId = `write-idempotency-${randomUUID()}`;
  const callId = `call-${randomUUID()}`;
  try {
    await createAgentRun(ctx, { runId, sessionId: `session-${randomUUID()}`, status: 'running' });
    const first = await beginToolCall(ctx, {
      runId,
      callId,
      toolName: 'write',
      accessMode: 'write',
      input: { path: 'report.md', content: 'first' },
    });
    assert.equal(first.action, 'execute');
    const storedResult = { content: [{ type: 'text', text: 'Successfully wrote report.md' }] };
    await finishToolCall(ctx, {
      runId,
      callId,
      toolName: 'write',
      ok: true,
      result: storedResult,
    });
    const duplicate = await beginToolCall(ctx, {
      runId,
      callId,
      toolName: 'write',
      accessMode: 'write',
      input: { path: 'report.md', content: 'second' },
    });
    assert.equal(duplicate.action, 'replay');
    assert.deepEqual(duplicate.result, storedResult);
    const call = await queryOne(
      'SELECT attempt_count, status FROM agent_tool_calls WHERE run_id=$1 AND call_id=$2',
      [runId, callId],
    );
    assert.deepEqual(call, { attempt_count: 1, status: 'completed' });
  } finally {
    await cleanup(runId);
  }
});

test('unknown write outcome blocks recovery while failed reads can retry', async () => {
  const runId = `unknown-write-${randomUUID()}`;
  try {
    await createAgentRun(ctx, { runId, sessionId: `session-${randomUUID()}`, status: 'running' });
    await beginToolCall(ctx, {
      runId,
      callId: 'write-uncertain',
      toolName: 'edit',
      accessMode: 'write',
      input: { path: 'a.md' },
    });
    await query(
      `UPDATE agent_runs
          SET lease_owner=NULL, lease_expires_at=NULL, heartbeat_at=NULL,
              checkpoint_json=$2, recoverable=1
        WHERE id=$1`,
      [runId, JSON.stringify({ transcript: true })],
    );
    const recovered = await recoverStaleAgentRuns(ctx);
    assert.ok(recovered.some((item) => item.run_id === runId && item.status === 'interrupted'));
    const run = await queryOne('SELECT status, recoverable FROM agent_runs WHERE id=$1', [runId]);
    assert.deepEqual(run, { status: 'interrupted', recoverable: 0 });

    const duplicateWrite = await beginToolCall(ctx, {
      runId,
      callId: 'write-uncertain',
      toolName: 'edit',
      accessMode: 'write',
      input: { path: 'a.md' },
    });
    assert.equal(duplicateWrite.action, 'blocked');
    assert.equal(duplicateWrite.code, 'AGENT_TOOL_OUTCOME_UNKNOWN');

    const readStart = await beginToolCall(ctx, {
      runId,
      callId: 'read-retry',
      toolName: 'read',
      accessMode: 'read',
      input: { path: 'a.md' },
    });
    assert.equal(readStart.action, 'execute');
    await finishToolCall(ctx, {
      runId,
      callId: 'read-retry',
      toolName: 'read',
      ok: false,
      error: Object.assign(new Error('temporary'), { code: 'TEMPORARY' }),
    });
    const retry = await beginToolCall(ctx, {
      runId,
      callId: 'read-retry',
      toolName: 'read',
      accessMode: 'read',
      input: { path: 'a.md' },
    });
    assert.equal(retry.action, 'execute');
    assert.equal(retry.attempt, 2);
  } finally {
    await cleanup(runId);
  }
});

test('startup recovery keeps user-input and approval waits and marks checkpointed runs recoverable', async () => {
  const waitingId = `waiting-${randomUUID()}`;
  const approvalId = `waiting-approval-${randomUUID()}`;
  const recoveringId = `recovering-${randomUUID()}`;
  const waitingSessionId = `session-${randomUUID()}`;
  const approvalSessionId = `session-${randomUUID()}`;
  try {
    await createAgentRun(ctx, { runId: waitingId, sessionId: waitingSessionId, status: 'running' });
    await suspendRunForUserInput(ctx, {
      runId: waitingId,
      sessionId: waitingSessionId,
      requestId: 'ask-1',
      payload: { questions: [{ id: 'scope', question: '范围？' }] },
      checkpoint: { request_id: 'ask-1' },
    });
    await query('UPDATE agent_runs SET lease_owner=NULL, lease_expires_at=NULL WHERE id=$1', [waitingId]);

    await createAgentRun(ctx, { runId: approvalId, sessionId: approvalSessionId, status: 'running' });
    await suspendRunForApproval(ctx, {
      runId: approvalId,
      sessionId: approvalSessionId,
      requestId: 'approval-1',
      payload: { tool_name: 'write' },
      checkpoint: { request_id: 'approval-1' },
    });
    await query('UPDATE agent_runs SET lease_owner=NULL, lease_expires_at=NULL WHERE id=$1', [approvalId]);

    await createAgentRun(ctx, { runId: recoveringId, sessionId: `session-${randomUUID()}`, status: 'running' });
    const checkpoint = await saveRunCheckpoint(ctx, {
      runId: recoveringId,
      checkpoint: { transcript: true },
      metadata: { source: 'test' },
    });
    assert.equal(checkpoint.saved, true);
    await query('UPDATE agent_runs SET lease_owner=NULL, lease_expires_at=NULL WHERE id=$1', [recoveringId]);

    const recovered = await recoverStaleAgentRuns(ctx);
    assert.ok(recovered.some((item) => item.run_id === waitingId && item.action === 'kept_waiting'));
    assert.ok(recovered.some((item) => item.run_id === approvalId && item.action === 'kept_waiting'));
    assert.ok(recovered.some((item) => item.run_id === recoveringId && item.status === 'recovering'));
    const waiting = await queryOne('SELECT status FROM agent_runs WHERE id=$1', [waitingId]);
    const approval = await queryOne('SELECT status FROM agent_runs WHERE id=$1', [approvalId]);
    const recovering = await queryOne('SELECT status FROM agent_runs WHERE id=$1', [recoveringId]);
    assert.equal(waiting.status, 'waiting_user_input');
    assert.equal(approval.status, 'waiting_approval');
    assert.equal(recovering.status, 'recovering');
  } finally {
    await cleanup(waitingId);
    await cleanup(approvalId);
    await cleanup(recoveringId);
  }
});

test('startup recovery closes a wait whose durable interaction is missing and terminalizes partial history', async () => {
  const runId = `waiting-missing-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  try {
    await createAgentRun(ctx, { runId, sessionId, status: 'running' });
    await transitionAgentRun(ctx, {
      runId,
      status: 'waiting_user_input',
      checkpoint: { waiting_for: { type: 'user_input', request_id: 'missing' } },
    });
    await query('UPDATE agent_runs SET lease_owner=NULL, lease_expires_at=NULL WHERE id=$1', [runId]);
    await query(
      `INSERT INTO session_messages
         (id,session_id,role,content_items,message_metadata,sequence_number,created_at,updated_at)
       VALUES ($1,$2,'assistant',$3,$4,1,now(),now())`,
      [
        `assistant:${runId}`,
        sessionId,
        JSON.stringify([{
          id: 'user_input:missing',
          type: 'user_input',
          title: 'requested',
          content: JSON.stringify({ status: 'requested', questions: [] }),
          metadata: { status: 'requested' },
        }]),
        JSON.stringify({ turn_status: 'inProgress', partial: true }),
      ],
    );

    const recovered = await recoverStaleAgentRuns(ctx);
    assert.ok(recovered.some((item) => item.run_id === runId && item.action === 'interrupt_missing_pending'));
    const run = await queryOne('SELECT status,finished_at FROM agent_runs WHERE id=$1', [runId]);
    assert.equal(run.status, 'interrupted');
    assert.ok(run.finished_at);
    const message = await queryOne(
      'SELECT content_items,message_metadata FROM session_messages WHERE id=$1',
      [`assistant:${runId}`],
    );
    const blocks = JSON.parse(message.content_items);
    const metadata = JSON.parse(message.message_metadata);
    assert.equal(blocks[0].metadata.status, 'interrupted');
    assert.equal(blocks.at(-1).id, `recovery:${runId}`);
    assert.equal(metadata.turn_status, 'interrupted');
    assert.equal(metadata.partial, false);
    assert.equal(metadata.answer_status, 'missing');
  } finally {
    await cleanup(runId);
  }
});

test('startup recovery never resumes an explicitly interrupted run even when a checkpoint exists', async () => {
  const runId = `explicit-stop-${randomUUID()}`;
  try {
    await createAgentRun(ctx, { runId, sessionId: `session-${randomUUID()}`, status: 'running' });
    await saveRunCheckpoint(ctx, { runId, checkpoint: { transcript: true } });
    await transitionAgentRun(ctx, {
      runId,
      status: 'interrupted',
      eventType: 'run_interrupted',
      eventMetadata: { reason: 'user_stop' },
    });

    const recovered = await recoverStaleAgentRuns(ctx, { includeUnexpiredLeases: true });
    assert.equal(recovered.some((item) => item.run_id === runId), false);
    const run = await queryOne('SELECT status,finished_at,lease_owner FROM agent_runs WHERE id=$1', [runId]);
    assert.equal(run.status, 'interrupted');
    assert.ok(run.finished_at);
    assert.equal(run.lease_owner, null);
  } finally {
    await cleanup(runId);
  }
});

test('startup recovery can reclaim a prior Server lease and resume without erasing checkpoint facts', async () => {
  const runId = `startup-reclaim-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const originalCheckpoint = { transcript_session_id: sessionId, persisted_message_count: 3 };
  try {
    await createAgentRun(ctx, {
      runId,
      sessionId,
      projectId,
      status: 'running',
      metadata: { source: 'startup-reclaim-test' },
    });
    await saveRunCheckpoint(ctx, {
      runId,
      checkpoint: originalCheckpoint,
      metadata: { reason: 'checkpoint-ready' },
    });

    const beforeExpiry = await recoverStaleAgentRuns(ctx);
    assert.equal(beforeExpiry.some((item) => item.run_id === runId), false);

    const reclaimed = await recoverStaleAgentRuns(ctx, { includeUnexpiredLeases: true });
    assert.ok(reclaimed.some((item) => item.run_id === runId && item.status === 'recovering'));

    await createAgentRun(ctx, { runId, sessionId, projectId, status: 'running' });
    const resumed = await queryOne(
      'SELECT status, checkpoint_json, metadata_json FROM agent_runs WHERE id=$1',
      [runId],
    );
    assert.equal(resumed.status, 'running');
    assert.deepEqual(JSON.parse(resumed.checkpoint_json), originalCheckpoint);
    assert.equal(JSON.parse(resumed.metadata_json).source, 'startup-reclaim-test');
  } finally {
    await cleanup(runId);
  }
});

test('durable approval releases the run lease and resolves idempotently on the same run', async () => {
  const runId = `approval-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const requestId = `tool-${randomUUID()}`;
  const concurrentRunId = `approval-concurrent-${randomUUID()}`;
  try {
    await createAgentRun(ctx, { runId, sessionId, projectId, status: 'running' });
    const pending = await suspendRunForApproval(ctx, {
      runId,
      sessionId,
      projectId,
      requestId,
      payload: {
        tool_call_id: requestId,
        tool_name: 'write',
        args_fingerprint: '{"path":"report.md"}',
      },
      checkpoint: { transcript_session_id: sessionId },
    });
    assert.equal(pending.resume_handle.type, 'approval_resume');
    const waiting = await queryOne(
      'SELECT status, lease_owner, lease_expires_at FROM agent_runs WHERE id=$1',
      [runId],
    );
    assert.deepEqual(waiting, {
      status: 'waiting_approval',
      lease_owner: null,
      lease_expires_at: null,
    });

    const resolved = await resolvePendingApproval(ctx, {
      sessionId,
      requestId,
      runId,
      approved: true,
    });
    assert.equal(resolved.recorded, true);
    assert.equal(resolved.approved, true);
    assert.equal(resolved.run_id, runId);
    const recovering = await queryOne('SELECT status FROM agent_runs WHERE id=$1', [runId]);
    assert.equal(recovering.status, 'recovering');

    const duplicate = await resolvePendingApproval(ctx, {
      sessionId,
      requestId,
      runId,
      approved: false,
    });
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.recorded, false);
    assert.equal(duplicate.approved, true);

    const concurrentSessionId = `session-${randomUUID()}`;
    const concurrentRequestId = `tool-${randomUUID()}`;
    await createAgentRun(ctx, {
      runId: concurrentRunId,
      sessionId: concurrentSessionId,
      projectId,
      status: 'running',
    });
    await suspendRunForApproval(ctx, {
      runId: concurrentRunId,
      sessionId: concurrentSessionId,
      projectId,
      requestId: concurrentRequestId,
      payload: { tool_call_id: concurrentRequestId, tool_name: 'write' },
    });
    const concurrent = await Promise.all([
      resolvePendingApproval(ctx, {
        sessionId: concurrentSessionId,
        requestId: concurrentRequestId,
        runId: concurrentRunId,
        approved: true,
      }),
      resolvePendingApproval(ctx, {
        sessionId: concurrentSessionId,
        requestId: concurrentRequestId,
        runId: concurrentRunId,
        approved: true,
      }),
    ]);
    assert.equal(concurrent.filter((item) => item.recorded).length, 1);
    assert.equal(concurrent.filter((item) => item.idempotent).length, 1);
  } finally {
    await cleanup(concurrentRunId);
    await cleanup(runId);
  }
});

test('active run registry stops exactly one live run and removes it', async () => {
  clearActiveRunsForTests();
  const runId = `active-${randomUUID()}`;
  const reasons = [];
  const unregister = registerActiveRun(runId, {
    sessionId: 'session-active',
    projectId: 'project-active',
    cancel: async (reason) => reasons.push(reason),
  });
  assert.equal(activeRunSnapshot(runId)?.session_id, 'session-active');
  const stopped = await stopActiveRun(runId, 'user_stop');
  assert.deepEqual(stopped, { found: true, stopped: true });
  assert.deepEqual(reasons, ['user_stop']);
  assert.equal(activeRunSnapshot(runId), null);
  unregister();
  clearActiveRunsForTests();
});

test('run center returns facts, stops a live run, and prepares checkpoint recovery', async () => {
  clearActiveRunsForTests();
  const runId = `center-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const userId = `user-${randomUUID()}`;
  const runCtx = { query, queryOne, userId };
  const membershipId = randomUUID();
  let cancelCount = 0;
  try {
    await query(
      `INSERT INTO projects (id,name,status,created_at,updated_at)
       VALUES ($1,'运行中心权限测试','active',now(),now())`,
      [projectId],
    );
    await query(
      `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
       VALUES ($1,$2,$3,1,now(),now())`,
      [membershipId, projectId, userId],
    );
    await createAgentRun(runCtx, { runId, sessionId, projectId, userId, status: 'running' });
    await saveRunCheckpoint(runCtx, {
      runId,
      checkpoint: { transcript_session_id: sessionId, persisted_message_count: 2 },
    });
    await recordRunArtifact(runCtx, {
      runId,
      callId: 'artifact-call',
      path: 'reports/result.md',
      kind: 'file',
      sizeBytes: 12,
    });
    await appendRunEvent(runCtx, {
      runId,
      turnId: 'parent-turn-1',
      callId: 'spawn-agent-1',
      eventType: 'native_collaboration_started',
      status: 'running',
      metadata: {
        item_type: 'collabAgentToolCall',
        item_id: 'spawn-agent-1',
        tool: 'spawnAgent',
        title: '创建子任务',
        prompt: '检查运行中心',
        sender_thread_id: 'parent-thread-1',
        child_thread_ids: ['child-thread-1'],
        agents_states: { 'child-thread-1': { status: 'running', message: null } },
      },
    });
    await appendRunEvent(runCtx, {
      runId,
      turnId: 'parent-turn-1',
      callId: 'spawn-agent-1',
      eventType: 'native_collaboration_completed',
      status: 'completed',
      metadata: {
        item_type: 'collabAgentToolCall',
        item_id: 'spawn-agent-1',
        tool: 'spawnAgent',
        title: '创建子任务',
        prompt: '检查运行中心',
        sender_thread_id: 'parent-thread-1',
        child_thread_ids: ['child-thread-1'],
        agents_states: { 'child-thread-1': { status: 'completed', message: '检查通过' } },
      },
    });
    registerActiveRun(runId, {
      sessionId,
      projectId,
      cancel: async () => { cancelCount += 1; },
    });

    const listed = await listAgentRuns(runCtx, {
      params: { pid: projectId },
      query: { session_id: sessionId },
    });
    assert.equal(listed.data.items.some((item) => item.id === runId && item.live), true);

    const detail = await getAgentRun(runCtx, { params: { runId } });
    assert.equal(detail.data.run.id, runId);
    assert.equal(detail.data.run.checkpoint.persisted_message_count, 2);
    assert.equal(detail.data.artifacts[0].path, 'reports/result.md');
    assert.deepEqual(detail.data.subagents, [{
      thread_id: 'child-thread-1',
      parent_thread_id: 'parent-thread-1',
      call_id: 'spawn-agent-1',
      title: '创建子任务',
      tool: 'spawnAgent',
      prompt: '检查运行中心',
      model: null,
      reasoning_effort: null,
      status: 'completed',
      message: '检查通过',
      created_at: detail.data.subagents[0].created_at,
      updated_at: detail.data.subagents[0].updated_at,
    }]);
    assert.deepEqual(
      detail.data.events.map((event) => event.seq),
      detail.data.events.map((_, index) => index + 1),
    );

    const stopped = await stopAgentRun(runCtx, { params: { runId } });
    assert.equal(stopped.data.stopped, true);
    assert.equal(stopped.data.settled, false);
    assert.equal(stopped.data.run.status, 'interrupted');
    assert.equal(cancelCount, 1);

    let scheduledRunId = null;
    const recovered = await prepareAgentRunRecovery(
      runCtx,
      { params: { runId }, body: { dispatch: true } },
      { schedule: (_ctx, requestedRunId) => { scheduledRunId = requestedRunId; } },
    );
    assert.equal(recovered.data.run.status, 'recovering');
    assert.equal(recovered.data.resume.checkpoint.persisted_message_count, 2);
    assert.equal(recovered.data.resume.dispatched, true);
    assert.equal(scheduledRunId, runId);
  } finally {
    clearActiveRunsForTests();
    await cleanup(runId);
    await query('DELETE FROM project_members WHERE id=$1', [membershipId]);
    await query('DELETE FROM projects WHERE id=$1', [projectId]);
  }
});
