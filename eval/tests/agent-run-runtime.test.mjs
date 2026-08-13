import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createResumeHandle,
  createAgentRuntime,
  resolvePendingUserInput,
} from '../../server/src/engine/agents/agent_run_runtime.js';

function mockCtx() {
  const runs = new Map();
  const pending = new Map();
  const events = [];
  const ctx = {
    runs,
    pending,
    events,
    async query(sql, params) {
      if (sql.includes('INSERT INTO agent_runs')) {
        runs.set(params[0], {
          id: params[0],
          session_id: params[1],
          project_id: params[2],
          user_id: params[3],
          status: params[4],
          skill_name: params[5],
          mode: params[6],
          checkpoint_json: params[7],
          metadata_json: params[8],
          turn_id: params[9],
          recoverable: 0,
          last_event_seq: 0,
        });
        return [];
      }
      if (sql.includes('INSERT INTO agent_run_events')) {
        events.push({ run_id: params[1], seq: params[4], event_type: params[5] });
        return [];
      }
      if (sql.includes('UPDATE agent_runs')) {
        const row = runs.get(params[0]) || { id: params[0] };
        if (sql.includes('last_event_seq=')) row.last_event_seq = params[1];
        if (sql.includes('SET lease_owner=')) {
          row.lease_owner = params[1];
          row.lease_expires_at = params[2];
          row.heartbeat_at = params[3];
        }
        if (sql.includes('SET status=$2')) row.status = params[1];
        if (sql.includes('checkpoint_json=')) row.checkpoint_json = params[3];
        if (sql.includes('lease_owner=NULL')) {
          row.lease_owner = null;
          row.lease_expires_at = null;
        }
        runs.set(params[0], row);
        return [];
      }
      if (sql.includes('INSERT INTO agent_pending_inputs')) {
        pending.set(params[5], {
          id: params[0],
          run_id: params[1],
          session_id: params[2],
          project_id: params[3],
          user_id: params[4],
          request_id: params[5],
          input_type: 'user_input',
          status: 'pending',
          payload_json: params[6],
          response_json: null,
          resume_handle_json: params[7],
          resume_expires_at: params[8],
          record_expires_at: params[9],
        });
        return [];
      }
      if (sql.includes('UPDATE agent_pending_inputs')) {
        const row = pending.get(params[1]);
        row.status = sql.includes("status='expired'") ? 'expired' : 'answered';
        row.response_json = params[2];
        pending.set(params[1], row);
        return [];
      }
      return [];
    },
    async queryOne(sql, params) {
      if (sql.includes('UPDATE agent_pending_inputs') && sql.includes('RETURNING *')) {
        const row = pending.get(params[1]);
        if (!row || row.status !== 'pending') return null;
        row.status = 'answered';
        row.response_json = params[2];
        pending.set(params[1], row);
        return row;
      }
      if (sql.includes('FROM agent_pending_inputs')) return pending.get(params[0]) || null;
      if (sql.includes('MAX(seq)')) {
        const seqs = events.filter((event) => event.run_id === params[0]).map((event) => event.seq);
        return { max_seq: seqs.length ? Math.max(...seqs) : 0 };
      }
      if (sql.includes('FROM agent_runs')) return runs.get(params[0]) || null;
      return null;
    },
  };
  return ctx;
}

test('createResumeHandle creates a stable control-plane handle', () => {
  assert.deepEqual(createResumeHandle({ runId: 'run-1', sessionId: 'session-1', requestId: 'ask-1' }), {
    type: 'user_input_resume',
    run_id: 'run-1',
    session_id: 'session-1',
    request_id: 'ask-1',
    version: 1,
  });
});

test('AgentRunRuntime persists user input suspension and resolves it idempotently', async () => {
  const ctx = mockCtx();
  const events = [];
  const runtime = createAgentRuntime({
    ctx,
    stream: { runSuspended: (payload) => events.push(payload) },
    runId: 'run-2',
    sessionId: 'session-2',
    projectId: 'project-2',
    userId: 'user-2',
    skill: 'query-project-data',
  });

  await runtime.createRun();
  const payload = await runtime.requestUserInput({
    request_id: 'ask-2',
    prompt: '请选择客户',
    options: [{ label: 'Alpha' }],
  });

  assert.equal(ctx.runs.get('run-2').status, 'waiting_user_input');
  assert.equal(ctx.pending.get('ask-2').status, 'pending');
  assert.equal(payload.resume_handle.run_id, 'run-2');
  assert.equal(events[0].request_id, 'ask-2');

  const resolved = await resolvePendingUserInput(ctx, {
    sessionId: 'session-2',
    requestId: 'ask-2',
    runId: 'run-2',
    value: 'Alpha',
    userId: 'user-2',
  });
  assert.equal(resolved.status, 'answered');
  assert.equal(resolved.recorded, true);
  assert.equal(ctx.pending.get('ask-2').status, 'answered');
  assert.equal(ctx.runs.get('run-2').status, 'recovering');

  const again = await resolvePendingUserInput(ctx, {
    sessionId: 'session-2',
    requestId: 'ask-2',
    runId: 'run-2',
    value: 'Alpha',
  });
  assert.equal(again.status, 'answered');
  assert.equal(again.idempotent, true);
});

test('resolvePendingUserInput distinguishes missing and mismatched handles', async () => {
  const ctx = mockCtx();
  const runtime = createAgentRuntime({
    ctx,
    stream: { runSuspended: () => {} },
    runId: 'run-mismatch',
    sessionId: 'session-mismatch',
    projectId: 'project-mismatch',
  });
  await runtime.createRun();
  await runtime.requestUserInput({ request_id: 'ask-mismatch', prompt: '请选择' });

  const missing = await resolvePendingUserInput(ctx, {
    sessionId: 'session-mismatch',
    requestId: 'ask-missing',
    value: 'Alpha',
  });
  assert.equal(missing.status, 'missing');
  assert.equal(missing.recorded, false);

  const mismatched = await resolvePendingUserInput(ctx, {
    sessionId: 'session-mismatch',
    requestId: 'ask-mismatch',
    runId: 'other-run',
    value: 'Alpha',
  });
  assert.equal(mismatched.status, 'mismatched');
  assert.equal(mismatched.recorded, false);
});
