import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import {
  saveRunCheckpoint,
  transitionAgentRun,
} from '../../server/src/engine/agents/run_fact_store.js';
import { createAgentRun } from '../../server/src/engine/agents/agent_run_runtime.js';
import {
  clearActiveRecoveriesForTests,
  resumeRecoverableAgentRuns,
} from '../../server/src/app/agents/run_recovery_scheduler.js';

const ctx = { query, queryOne };

async function cleanup(runId) {
  await query('DELETE FROM agent_run_events WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_tool_calls WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_artifacts WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_pending_inputs WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_runs WHERE id=$1', [runId]);
}

async function prepareRecoveringRun(runId) {
  await createAgentRun(ctx, {
    runId,
    sessionId: `session-${randomUUID()}`,
    projectId: `project-${randomUUID()}`,
    status: 'running',
  });
  await saveRunCheckpoint(ctx, { runId, checkpoint: { transcript: true } });
  await transitionAgentRun(ctx, {
    runId,
    status: 'recovering',
    eventType: 'test_recovery_ready',
    recoverable: true,
  });
}

test('recovery scheduler dispatches selected runs and reports their real final status', async () => {
  clearActiveRecoveriesForTests();
  const completedId = `scheduler-completed-${randomUUID()}`;
  const waitingId = `scheduler-waiting-${randomUUID()}`;
  try {
    await prepareRecoveringRun(completedId);
    await prepareRecoveringRun(waitingId);

    const results = await resumeRecoverableAgentRuns(ctx, {
      runIds: [completedId, waitingId],
      execute: async (runCtx, run) => {
        const waits = run.id === waitingId;
        await transitionAgentRun(runCtx, {
          runId: run.id,
          status: waits ? 'waiting_user_input' : 'completed',
          eventType: waits ? 'test_waiting_input' : 'test_recovery_completed',
          finished: !waits,
        });
      },
    });

    assert.deepEqual(
      new Map(results.map((item) => [item.run_id, item.status])),
      new Map([[completedId, 'completed'], [waitingId, 'waiting_user_input']]),
    );
    for (const runId of [completedId, waitingId]) {
      const events = await query(
        'SELECT event_type FROM agent_run_events WHERE run_id=$1 ORDER BY seq ASC',
        [runId],
      );
      assert.equal(events.some((event) => event.event_type === 'run_recovery_dispatched'), true);
    }
  } finally {
    clearActiveRecoveriesForTests();
    await cleanup(completedId);
    await cleanup(waitingId);
  }
});
