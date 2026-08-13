import assert from 'node:assert/strict';
import test from 'node:test';

import { compareEvidenceSnapshots } from '../../server/src/engine/agents/evidence_bundle_rerun.js';

function evidence(id, { hash = 'sha256:same', rows = 2, sum = 30, schema = 'sha256:schema' } = {}) {
  return {
    evidence_id: id,
    source: { binding_id: 'binding-1', source_id: 'source-1', connection_id: 'connection-1' },
    statement: { text: 'SELECT amount FROM orders WHERE amount > ?', parameters: [0] },
    schema: { version: schema },
    result: {
      status: 'completed',
      row_count: rows,
      columns: ['amount'],
      data_hash: hash,
      numeric_summary: { amount: { count: rows, min: 10, max: sum - 10, sum, average: sum / rows } },
    },
  };
}

function validation(id, status = 'passed') {
  return {
    validation_id: id,
    status,
    checks: [{ name: 'numeric_ranges', passed: status === 'passed' }],
  };
}

test('same query snapshot reports identical even when evidence ids are new', () => {
  const comparison = compareEvidenceSnapshots({
    baselineEvidence: [evidence('before')],
    currentEvidence: [evidence('after')],
    baselineValidations: [validation('validation-before')],
    currentValidations: [validation('validation-after')],
  });
  assert.equal(comparison.version, 'agent_evidence_rerun.v1');
  assert.equal(comparison.summary.identical, true);
  assert.equal(comparison.summary.changed_query_count, 0);
  assert.equal(comparison.queries[0].row_count.delta, 0);
  assert.equal(comparison.summary.environment_changed, null);
  assert.equal(comparison.summary.fully_reproducible, false);
});

test('same evidence is not fully reproducible when the captured environment changed', () => {
  const comparison = compareEvidenceSnapshots({
    baselineEvidence: [evidence('before')],
    currentEvidence: [evidence('after')],
    baselineEnvironment: { version: 'agent_run_environment.v1', snapshot_hash: 'sha256:before' },
    currentEnvironment: { version: 'agent_run_environment.v1', snapshot_hash: 'sha256:after' },
  });
  assert.equal(comparison.summary.identical, false);
  assert.equal(comparison.summary.fully_reproducible, false);
  assert.equal(comparison.summary.environment_changed, true);
  assert.equal(comparison.environment.comparable, true);
});

test('same evidence and environment are fully reproducible', () => {
  const environment = { version: 'agent_run_environment.v1', snapshot_hash: 'sha256:same-environment' };
  const comparison = compareEvidenceSnapshots({
    baselineEvidence: [evidence('before')],
    currentEvidence: [evidence('after')],
    baselineEnvironment: environment,
    currentEnvironment: environment,
  });
  assert.equal(comparison.summary.identical, true);
  assert.equal(comparison.summary.fully_reproducible, true);
  assert.equal(comparison.summary.environment_changed, false);
});

test('snapshot comparison exposes data, row, numeric, schema and validation changes', () => {
  const comparison = compareEvidenceSnapshots({
    baselineEvidence: [evidence('before')],
    currentEvidence: [evidence('after', { hash: 'sha256:changed', rows: 3, sum: 60, schema: 'sha256:new-schema' })],
    baselineValidations: [validation('validation-before')],
    currentValidations: [validation('validation-after', 'failed')],
  });
  assert.equal(comparison.summary.identical, false);
  assert.equal(comparison.summary.data_changed, true);
  assert.equal(comparison.summary.schema_changed, true);
  assert.equal(comparison.summary.changed_query_count, 1);
  assert.equal(comparison.summary.changed_validation_count, 1);
  assert.equal(comparison.queries[0].row_count.delta, 1);
  assert.equal(comparison.queries[0].numeric_summary.amount.sum_delta, 30);
  assert.deepEqual(comparison.validations[0].failed_checks.after, ['numeric_ranges']);
});
