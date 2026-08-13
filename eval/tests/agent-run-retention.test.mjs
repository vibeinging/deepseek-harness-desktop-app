import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import {
  cleanupExpiredRunFacts,
  recordRunArtifact,
  transitionAgentRun,
} from '../../server/src/engine/agents/run_fact_store.js';
import { createAgentRun } from '../../server/src/engine/agents/agent_run_runtime.js';
import {
  removeRunnerRunDirectory,
  runnerRunDirectory,
} from '../../server/src/engine/runner/run_paths.js';
import { startAgentRunRetentionScheduler } from '../../server/src/app/agents/run_retention_scheduler.js';

const ctx = { query, queryOne };

async function hardDelete(runId) {
  const children = await query('SELECT run_id FROM agent_subtask_runs WHERE parent_run_id=$1', [runId]);
  await query('DELETE FROM agent_subtask_runs WHERE parent_run_id=$1', [runId]);
  for (const child of children) await hardDelete(child.run_id);
  await query('DELETE FROM agent_pending_inputs WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_run_events WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_tool_calls WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_artifacts WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_evidence_bundles WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_runs WHERE id=$1', [runId]);
}

test('run directory retention removes only the exact non-symlink run directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-run-retention-'));
  const runsRoot = join(root, 'runs');
  const outside = join(root, 'workspace-artifacts');
  const runId = `run-${randomUUID()}`;
  const runDir = runnerRunDirectory(runId, { runsRoot });
  try {
    await mkdir(join(runDir, 'tmp'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(runDir, 'tmp', 'scratch.txt'), 'temporary');
    await writeFile(join(outside, 'report.md'), 'keep');

    const result = await removeRunnerRunDirectory(runId, { runsRoot });
    assert.equal(result.removed, true);
    await assert.rejects(() => access(runDir), (error) => error.code === 'ENOENT');
    await access(join(outside, 'report.md'));

    await symlink(outside, runDir);
    await assert.rejects(
      () => removeRunnerRunDirectory(runId, { runsRoot }),
      (error) => error.code === 'AGENT_RUN_RETENTION_SYMLINK',
    );
    await access(join(outside, 'report.md'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('expired terminal run cleanup removes child facts only after directory cleanup succeeds', async () => {
  const runId = `retention-${randomUUID()}`;
  const childRunId = `retention-child-${randomUUID()}`;
  const removed = [];
  try {
    await createAgentRun(ctx, {
      runId,
      sessionId: `session-${randomUUID()}`,
      projectId: `project-${randomUUID()}`,
      status: 'running',
    });
    await recordRunArtifact(ctx, { runId, kind: 'file', path: '/workspace/report.md' });
    await transitionAgentRun(ctx, { runId, status: 'completed' });
    await query(
      `UPDATE agent_runs SET retention_until=$2 WHERE id=$1`,
      [runId, '2000-01-01T00:00:00.000Z'],
    );
    await query(
      `INSERT INTO agent_pending_inputs (
         id, run_id, session_id, project_id, request_id, input_type, status, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,'approval','answered',now(),now())`,
      [randomUUID(), runId, `session-${randomUUID()}`, `project-${randomUUID()}`, `request-${randomUUID()}`],
    );
    await query(
      `INSERT INTO agent_runs (id,session_id,project_id,status,skill_name,mode,created_at,updated_at)
       VALUES ($1,'retention-session','retention-project','completed','subtask:schema_investigation','subtask',now(),now())`,
      [childRunId],
    );
    await query(
      `INSERT INTO agent_subtask_runs
         (id,run_id,parent_run_id,call_id,subtask_type,title,tool_allowlist,read_only,parallel_eligible,status,input_snapshot,started_at,created_at,updated_at)
       VALUES ($1,$1,$2,'retention-child-call','schema_investigation','Schema 调查','[]',1,1,'completed','{}',now(),now(),now())`,
      [childRunId, runId],
    );
    await query(
      `INSERT INTO agent_run_events (id,run_id,seq,event_type,status,created_at)
       VALUES ($1,$2,1,'subtask_completed','completed',now())`,
      [randomUUID(), childRunId],
    );

    const result = await cleanupExpiredRunFacts(ctx, {
      now: '2026-07-29T00:00:00.000Z',
      removeRunDirectory: async (id) => { removed.push(id); },
    });
    assert.deepEqual(removed, [runId]);
    assert.equal(result.cleaned_runs, 1);
    assert.deepEqual(result.failed_runs, []);
    const run = await queryOne('SELECT deleted_at, checkpoint_json, metadata_json FROM agent_runs WHERE id=$1', [runId]);
    assert.ok(run.deleted_at);
    assert.equal(run.checkpoint_json, null);
    assert.equal(run.metadata_json, null);
    for (const table of ['agent_pending_inputs', 'agent_run_events', 'agent_tool_calls', 'agent_artifacts', 'agent_evidence_bundles']) {
      const row = await queryOne(`SELECT COUNT(*) AS count FROM ${table} WHERE run_id=$1`, [runId]);
      assert.equal(Number(row.count), 0, table);
    }
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS count FROM agent_subtask_runs WHERE parent_run_id=$1', [runId])).count), 0);
    assert.equal(Number((await queryOne('SELECT COUNT(*) AS count FROM agent_run_events WHERE run_id=$1', [childRunId])).count), 0);
    const childRun = await queryOne('SELECT deleted_at,deleted_by FROM agent_runs WHERE id=$1', [childRunId]);
    assert.ok(childRun.deleted_at);
    assert.equal(childRun.deleted_by, 'retention');
  } finally {
    await hardDelete(runId);
    await hardDelete(childRunId);
  }
});

test('failed directory cleanup preserves run facts for a later retry', async () => {
  const runId = `retention-retry-${randomUUID()}`;
  try {
    await createAgentRun(ctx, {
      runId,
      sessionId: `session-${randomUUID()}`,
      projectId: `project-${randomUUID()}`,
      status: 'running',
    });
    await transitionAgentRun(ctx, { runId, status: 'completed' });
    await query('UPDATE agent_runs SET retention_until=$2 WHERE id=$1', [runId, '2000-01-01T00:00:00.000Z']);
    const result = await cleanupExpiredRunFacts(ctx, {
      now: '2026-07-29T00:00:00.000Z',
      removeRunDirectory: async () => {
        const error = new Error('busy');
        error.code = 'EBUSY';
        throw error;
      },
    });
    assert.equal(result.cleaned_runs, 0);
    assert.deepEqual(result.failed_runs.map((item) => item.code), ['EBUSY']);
    const run = await queryOne('SELECT deleted_at FROM agent_runs WHERE id=$1', [runId]);
    assert.equal(run.deleted_at, null);
    const events = await queryOne('SELECT COUNT(*) AS count FROM agent_run_events WHERE run_id=$1', [runId]);
    assert.ok(Number(events.count) > 0);
  } finally {
    await hardDelete(runId);
  }
});

test('retention scheduler prevents overlapping cleanup passes and can stop', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const scheduler = startAgentRunRetentionScheduler(ctx, {
    cleanup: async () => {
      calls += 1;
      await gate;
      return { cleaned_runs: 0, failed_runs: [] };
    },
    logger: { info() {}, warn() {} },
  });
  const first = scheduler.runOnce();
  const skipped = await scheduler.runOnce();
  assert.equal(skipped, null);
  assert.equal(calls, 1);
  release();
  await first;
  scheduler.stop();
  assert.equal(await scheduler.runOnce(), null);
});
