import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import { createAgentRun } from '../../server/src/engine/agents/agent_run_runtime.js';
import { IntermediateDataSource } from '../../server/src/engine/datasources/intermediate_data_source.js';
import { removeRunnerRunDirectory } from '../../server/src/engine/runner/run_paths.js';
import {
  AGENT_RUN_WORKSPACE_DIRS,
  ensureAgentRunWorkspace,
  readAgentRunWorkspace,
} from '../../server/src/engine/runner/run_workspace.js';

const ctx = { query, queryOne };

async function deleteRunFacts(runId) {
  for (const table of ['agent_pending_inputs', 'agent_run_events', 'agent_tool_calls', 'agent_artifacts', 'agent_evidence_bundles']) {
    await query(`DELETE FROM ${table} WHERE run_id=$1`, [runId]);
  }
  await query('DELETE FROM agent_runs WHERE id=$1', [runId]);
}

test('run workspace creates a private immutable manifest and the complete directory layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-run-workspace-'));
  const runsRoot = join(root, 'runs');
  const runId = `workspace-${randomUUID()}`;
  try {
    const first = await ensureAgentRunWorkspace({
      runId,
      sessionId: 'session-workspace',
      projectId: 'project-workspace',
      userId: 'user-workspace',
      mode: 'agent',
      runsRoot,
    });
    assert.equal(first.manifest_data.version, 'agent_run_workspace.v1');
    assert.equal(first.manifest_data.run_id, runId);
    assert.match(first.manifest_hash, /^sha256:[a-f0-9]{64}$/);
    assert.equal((await lstat(first.root)).mode & 0o777, 0o700);
    assert.equal((await lstat(first.manifest)).mode & 0o777, 0o600);
    for (const name of AGENT_RUN_WORKSPACE_DIRS) await access(first[name]);

    const second = await ensureAgentRunWorkspace({
      runId,
      sessionId: 'session-workspace',
      projectId: 'project-workspace',
      userId: 'user-workspace',
      mode: 'agent',
      runsRoot,
    });
    assert.equal(second.manifest_hash, first.manifest_hash);
    assert.equal((await readAgentRunWorkspace(runId, { runsRoot })).manifest_hash, first.manifest_hash);
    assert.equal(JSON.parse(await readFile(first.manifest, 'utf8')).directories.intermediate, 'intermediate');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('run workspace rejects unsafe ids and symbolic-link run directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-run-workspace-guard-'));
  const runsRoot = join(root, 'runs');
  const outside = join(root, 'outside');
  try {
    await assert.rejects(
      () => ensureAgentRunWorkspace({ runId: '../escape', sessionId: 'session', runsRoot }),
      (error) => error.code === 'AGENT_RUN_WORKSPACE_INVALID_ID',
    );
    await ensureAgentRunWorkspace({ runId: 'safe-seed', sessionId: 'session', runsRoot });
    await rm(join(runsRoot, 'safe-seed'), { recursive: true, force: true });
    await symlink(outside, join(runsRoot, 'safe-seed'));
    await assert.rejects(
      () => ensureAgentRunWorkspace({ runId: 'safe-seed', sessionId: 'session', runsRoot }),
      (error) => error.code === 'AGENT_RUN_WORKSPACE_SYMLINK',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent run facts bind the persisted workspace manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-run-workspace-db-'));
  const runsRoot = join(root, 'runs');
  const runId = `workspace-db-${randomUUID()}`;
  try {
    const created = await createAgentRun(ctx, {
      runId,
      sessionId: `session-${randomUUID()}`,
      projectId: `project-${randomUUID()}`,
      userId: 'workspace-user',
      runsRoot,
    });
    assert.equal(created.workspace_version, 'agent_run_workspace.v1');
    const row = await queryOne(
      'SELECT workspace_path, manifest_path, workspace_version, manifest_hash FROM agent_runs WHERE id=$1',
      [runId],
    );
    assert.equal(row.workspace_path, created.workspace_path);
    assert.equal(row.manifest_path, created.manifest_path);
    assert.equal(row.workspace_version, 'agent_run_workspace.v1');
    assert.equal(row.manifest_hash, created.manifest_hash);
    assert.equal((await readAgentRunWorkspace(runId, { runsRoot })).manifest_hash, row.manifest_hash);
  } finally {
    await deleteRunFacts(runId);
    await rm(root, { recursive: true, force: true });
  }
});

test('two runs in one session use different DuckDB files and cannot see each other intermediate rows', async () => {
  const runA = `workspace-a-${randomUUID()}`;
  const runB = `workspace-b-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  try {
    await createAgentRun(ctx, { runId: runA, sessionId, projectId });
    await createAgentRun(ctx, { runId: runB, sessionId, projectId });
    const sourceA = new IntermediateDataSource({
      session_id: sessionId,
      project_id: projectId,
      business_id: projectId,
      intermediate_data_source_id: `intermediate_${runA}`,
      run_id: runA,
    });
    const sourceB = new IntermediateDataSource({
      session_id: sessionId,
      project_id: projectId,
      business_id: projectId,
      intermediate_data_source_id: `intermediate_${runB}`,
      run_id: runB,
    });
    await sourceA.add([{ value: 'only-a' }], 'shared_result');
    await sourceB.add([{ value: 'only-b' }], 'shared_result');
    assert.notEqual(sourceA.duckdb_path, sourceB.duckdb_path);
    assert.deepEqual((await sourceA.query('SELECT value FROM shared_result')).data, [{ value: 'only-a' }]);
    assert.deepEqual((await sourceB.query('SELECT value FROM shared_result')).data, [{ value: 'only-b' }]);
  } finally {
    await deleteRunFacts(runA);
    await deleteRunFacts(runB);
    await removeRunnerRunDirectory(runA).catch(() => {});
    await removeRunnerRunDirectory(runB).catch(() => {});
  }
});
