import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import {
  createEvidenceBundle,
  EVIDENCE_BUNDLE_VERSION,
  getEvidenceBundle,
  listEvidenceBundlesForRun,
} from '../../server/src/engine/agents/evidence_bundle_store.js';
import {
  beginToolCall,
  finishToolCall,
  recordRunArtifact,
} from '../../server/src/engine/agents/run_fact_store.js';
import { createAgentRun } from '../../server/src/engine/agents/agent_run_runtime.js';

const ctx = { query, queryOne };

async function cleanup(runId) {
  await query('DELETE FROM agent_evidence_bundles WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_pending_inputs WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_run_events WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_tool_calls WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_artifacts WHERE run_id=$1', [runId]);
  await query('DELETE FROM agent_runs WHERE id=$1', [runId]);
}

test('evidence bundle immutably binds final answer, query, validation, tool, approval and artifact facts', async () => {
  const runId = `evidence-bundle-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  const projectId = `project-${randomUUID()}`;
  const queryCallId = `query-${randomUUID()}`;
  const validationCallId = `validation-${randomUUID()}`;
  const evidenceId = `evidence-${randomUUID()}`;
  const validationId = `validation-${randomUUID()}`;
  const finalItemId = `answer-${randomUUID()}`;
  try {
    await createAgentRun(ctx, { runId, sessionId, projectId, userId: 'bundle-user' });
    await beginToolCall(ctx, {
      runId,
      callId: queryCallId,
      toolName: 'execute_readonly_sql',
      input: { question: '销售额', sql: 'SELECT SUM(amount) AS total FROM sales' },
    });
    await finishToolCall(ctx, {
      runId,
      callId: queryCallId,
      toolName: 'execute_readonly_sql',
      ok: true,
      result: { total: 300 },
    });
    await beginToolCall(ctx, {
      runId,
      callId: validationCallId,
      toolName: 'validate_query_result',
      input: { required_columns: ['total'] },
    });
    await finishToolCall(ctx, {
      runId,
      callId: validationCallId,
      toolName: 'validate_query_result',
      ok: true,
      result: { status: 'passed' },
    });
    const artifact = await recordRunArtifact(ctx, {
      runId,
      callId: queryCallId,
      kind: 'file',
      path: '/workspace/sales.csv',
      sha256: 'sha256:artifact',
    });
    await query(
      `INSERT INTO agent_pending_inputs (
         id, run_id, session_id, project_id, request_id, input_type, status,
         payload_json, response_json, responded_by, responded_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,'approval','answered',$6,$7,$8,now(),now(),now())`,
      [
        randomUUID(), runId, sessionId, projectId, `approval-${randomUUID()}`,
        JSON.stringify({ tool_name: 'export', risk: 'write' }),
        JSON.stringify({ approved: true }),
        'bundle-user',
      ],
    );
    const evidence = {
      version: 'query_execution.v1',
      evidence_id: evidenceId,
      produced_by: 'data_source_executor',
      tool_call_id: queryCallId,
      source: { binding_id: 'binding-1', connection_id: 'connection-1' },
      statement: { language: 'sql', text: 'SELECT SUM(amount) AS total FROM sales', parameters: [] },
      schema: { version: 'sha256:schema', referenced_tables: [{ id: 'table-sales' }], unresolved_references: [] },
      result: { status: 'completed', row_count: 1, columns: ['total'], empty: false },
    };
    const validation = {
      version: 'query_validation.v1',
      validation_id: validationId,
      evidence_id: evidenceId,
      tool_call_id: validationCallId,
      status: 'passed',
      checks: [{ name: 'required_columns', passed: true, severity: 'error' }],
    };
    const first = await createEvidenceBundle(ctx, {
      runId,
      sessionId,
      projectId,
      finalItemId,
      answerText: '销售额合计为 300。',
      evidence: [evidence],
      validations: [validation],
      toolCallIds: [queryCallId, validationCallId],
    });
    assert.equal(first.version, EVIDENCE_BUNDLE_VERSION);
    assert.equal(first.status, 'verified');
    assert.equal(first.answer.item_id, finalItemId);
    assert.equal(first.answer.text, '销售额合计为 300。');
    assert.match(first.snapshot_hash, /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(first.evidence.map((item) => item.evidence_id), [evidenceId]);
    assert.deepEqual(first.validations.map((item) => item.validation_id), [validationId]);
    assert.deepEqual(first.tool_calls.map((item) => item.call_id), [queryCallId, validationCallId]);
    assert.equal(first.approvals[0].response.approved, true);
    assert.ok(first.artifacts.some((item) => item.id === artifact.id));
    assert.equal(first.uncertainty.has_uncertainty, false);

    const replay = await createEvidenceBundle(ctx, {
      runId,
      sessionId,
      projectId,
      finalItemId,
      answerText: '不应覆盖原答案',
      evidence: [],
    });
    assert.equal(replay.id, first.id);
    assert.equal(replay.snapshot_hash, first.snapshot_hash);
    assert.equal(replay.answer.text, '销售额合计为 300。');
    assert.equal((await getEvidenceBundle(ctx, first.id)).snapshot_hash, first.snapshot_hash);
    assert.deepEqual((await listEvidenceBundlesForRun(ctx, runId)).map((item) => item.id), [first.id]);
  } finally {
    await cleanup(runId);
  }
});

test('evidence bundle exposes failed validation as uncertainty', async () => {
  const runId = `evidence-bundle-failed-${randomUUID()}`;
  const sessionId = `session-${randomUUID()}`;
  try {
    await createAgentRun(ctx, { runId, sessionId, projectId: 'project-evidence-failed' });
    const evidenceId = `evidence-${randomUUID()}`;
    const bundle = await createEvidenceBundle(ctx, {
      runId,
      sessionId,
      projectId: 'project-evidence-failed',
      finalItemId: `answer-${randomUUID()}`,
      answerText: '结果存在口径问题。',
      evidence: [{
        evidence_id: evidenceId,
        produced_by: 'data_source_executor',
        result: { status: 'completed' },
        schema: { unresolved_references: [] },
      }],
      validations: [{
        validation_id: `validation-${randomUUID()}`,
        evidence_id: evidenceId,
        status: 'failed',
        checks: [{ name: 'critical_filters', passed: false }],
      }],
    });
    assert.equal(bundle.status, 'needs_attention');
    assert.equal(bundle.uncertainty.has_uncertainty, true);
    assert.deepEqual(bundle.uncertainty.items[0].failed_checks, ['critical_filters']);
  } finally {
    await cleanup(runId);
  }
});
