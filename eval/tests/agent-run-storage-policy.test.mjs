import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import {
  archiveAgentRun,
  deleteAgentRun,
  getAgentRunDeletionImpact,
} from '../../server/src/app/agents/run_center.js';
import {
  cleanupExpiredRunFacts,
  transitionAgentRun,
} from '../../server/src/engine/agents/run_fact_store.js';
import {
  cleanupFailedRunTemporaryFiles,
  enforceRunStoragePolicy,
} from '../../server/src/engine/agents/run_storage_policy.js';
import { createAgentRun } from '../../server/src/engine/agents/agent_run_runtime.js';
import { readAgentRunWorkspace } from '../../server/src/engine/runner/run_workspace.js';
import { removeRunnerRunDirectory } from '../../server/src/engine/runner/run_paths.js';

const ctx = { query, queryOne, userId: 'storage-user' };

async function hardDelete(runId) {
  const run = await queryOne('SELECT project_id FROM agent_runs WHERE id=$1', [runId]);
  for (const table of ['agent_pending_inputs', 'agent_run_events', 'agent_tool_calls', 'agent_artifacts', 'agent_evidence_bundles']) {
    await query(`DELETE FROM ${table} WHERE run_id=$1`, [runId]);
  }
  await query('DELETE FROM agent_runs WHERE id=$1', [runId]);
  if (run?.project_id) {
    await query('DELETE FROM project_members WHERE project_id=$1', [run.project_id]);
    await query('DELETE FROM projects WHERE id=$1', [run.project_id]);
  }
  await removeRunnerRunDirectory(runId).catch(() => {});
}

async function createTerminalRun(prefix, status = 'completed') {
  const runId = `${prefix}-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  await query(
    `INSERT INTO projects (id,name,status,created_at,updated_at)
     VALUES ($1,$2,'active',now(),now())`,
    [projectId, `${prefix} project`],
  );
  await query(
    `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
     VALUES ($1,$2,$3,1,now(),now())`,
    [randomUUID(), projectId, ctx.userId],
  );
  await createAgentRun(ctx, {
    runId,
    sessionId: `session-${randomUUID()}`,
    projectId,
    userId: 'storage-user',
    status: 'running',
  });
  await transitionAgentRun(ctx, { runId, status });
  return { runId, workspace: await readAgentRunWorkspace(runId) };
}

test('evidence-bound and archived runs are protected from automatic retention cleanup', async () => {
  const plain = await createTerminalRun('storage-plain');
  const protectedRun = await createTerminalRun('storage-evidence');
  const archived = await createTerminalRun('storage-archived');
  try {
    await query(
      `INSERT INTO agent_evidence_bundles
        (id, run_id, turn_id, session_id, project_id, final_item_id, bundle_version, status, snapshot_hash, payload_json, created_at, updated_at)
       VALUES ($1,$2,$2,'session','project','answer','agent_evidence_bundle.v1','verified','sha256:test','{}',now(),now())`,
      [randomUUID(), protectedRun.runId],
    );
    await query('UPDATE agent_runs SET retention_until=$2 WHERE id IN ($1,$3)', [plain.runId, '2000-01-01T00:00:00.000Z', protectedRun.runId]);
    await archiveAgentRun(ctx, { params: { runId: archived.runId }, body: {}, query: {} });
    await query('UPDATE agent_runs SET retention_until=$2 WHERE id=$1', [archived.runId, '2000-01-01T00:00:00.000Z']);
    const result = await cleanupExpiredRunFacts(ctx, { now: '2026-07-29T00:00:00.000Z' });
    assert.ok(result.cleaned_run_ids.includes(plain.runId));
    assert.ok(result.protected_run_ids.includes(protectedRun.runId));
    assert.equal((await queryOne('SELECT deleted_at FROM agent_runs WHERE id=$1', [archived.runId])).deleted_at, null);
  } finally {
    await hardDelete(plain.runId);
    await hardDelete(protectedRun.runId);
    await hardDelete(archived.runId);
  }
});

test('failed-run cleanup deletes only tmp contents and storage policy never evicts evidence', async () => {
  const failed = await createTerminalRun('storage-failed', 'failed');
  const protectedRun = await createTerminalRun('storage-protected');
  try {
    await writeFile(`${failed.workspace.tmp}/scratch.bin`, Buffer.alloc(4096, 1));
    await writeFile(`${protectedRun.workspace.artifacts}/evidence.bin`, Buffer.alloc(4096, 2));
    await query(
      `INSERT INTO agent_evidence_bundles
        (id, run_id, turn_id, session_id, project_id, final_item_id, bundle_version, status, snapshot_hash, payload_json, created_at, updated_at)
       VALUES ($1,$2,$2,'session','project','answer','agent_evidence_bundle.v1','verified','sha256:test','{}',now(),now())`,
      [randomUUID(), protectedRun.runId],
    );
    const cleared = await cleanupFailedRunTemporaryFiles(failed.runId);
    assert.equal(cleared.removed_bytes, 4096);
    await assert.rejects(() => access(`${failed.workspace.tmp}/scratch.bin`), (error) => error.code === 'ENOENT');

    await writeFile(`${failed.workspace.artifacts}/large.bin`, Buffer.alloc(4096, 3));
    const policy = await enforceRunStoragePolicy(ctx, {
      limits: { max_run_bytes: 1024, max_total_bytes: 1024 },
    });
    assert.ok(policy.scheduled_cleanup.some((item) => item.run_id === failed.runId));
    assert.equal(policy.scheduled_cleanup.some((item) => item.run_id === protectedRun.runId), false);
    assert.equal((await queryOne('SELECT deleted_at FROM agent_runs WHERE id=$1', [protectedRun.runId])).deleted_at, null);
  } finally {
    await hardDelete(failed.runId);
    await hardDelete(protectedRun.runId);
  }
});

test('manual deletion requires a current impact hash and explicit force for evidence', async () => {
  const run = await createTerminalRun('storage-manual');
  try {
    await writeFile(`${run.workspace.artifacts}/report.md`, '# report');
    await query(
      `INSERT INTO agent_evidence_bundles
        (id, run_id, turn_id, session_id, project_id, final_item_id, bundle_version, status, snapshot_hash, payload_json, created_at, updated_at)
       VALUES ($1,$2,$2,'session','project','answer','agent_evidence_bundle.v1','verified','sha256:test','{}',now(),now())`,
      [randomUUID(), run.runId],
    );
    const impact = (await getAgentRunDeletionImpact(ctx, { params: { runId: run.runId }, body: {}, query: {} })).data;
    assert.equal(impact.evidence_protected, true);
    assert.ok(impact.workspace.bytes > 0);
    await assert.rejects(
      () => deleteAgentRun(ctx, { params: { runId: run.runId }, body: { impact_hash: impact.impact_hash }, query: {} }),
      (error) => error.status === 409 || error.statusCode === 409,
    );
    const deleted = await deleteAgentRun(ctx, {
      params: { runId: run.runId },
      body: { impact_hash: impact.impact_hash, force: true },
      query: {},
    });
    assert.equal(deleted.data.deleted, true);
    assert.ok((await queryOne('SELECT deleted_at FROM agent_runs WHERE id=$1', [run.runId])).deleted_at);
  } finally {
    await hardDelete(run.runId);
  }
});

test('an interrupted run is closed and can be deleted explicitly', async () => {
  const run = await createTerminalRun('storage-interrupted', 'interrupted');
  try {
    const impact = (await getAgentRunDeletionImpact(ctx, {
      params: { runId: run.runId },
      body: {},
      query: {},
    })).data;
    const deleted = await deleteAgentRun(ctx, {
      params: { runId: run.runId },
      body: { impact_hash: impact.impact_hash, force: true },
      query: {},
    });
    assert.equal(deleted.data.deleted, true);
    assert.ok((await queryOne('SELECT deleted_at FROM agent_runs WHERE id=$1', [run.runId])).deleted_at);
  } finally {
    await hardDelete(run.runId);
  }
});
