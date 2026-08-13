import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  completeRunWriteback,
  stageRunWriteback,
} from '../../server/src/engine/agents/run_writeback_store.js';

test('writeback proposal and receipt are separate immutable run files with before and after values', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-writeback-'));
  const workspace = { work: join(root, 'work'), artifacts: join(root, 'artifacts') };
  const input = {
    workspace,
    runId: 'run-writeback-test',
    callId: 'call:rules/update',
    toolName: 'project_rules_update',
    projectId: 'project-writeback-test',
    argsFingerprint: '{"content":"new"}',
    proposal: {
      kind: 'project_rules',
      target: { project_id: 'project-writeback-test', rule_type: 'sql' },
      operation: 'append',
      before: { rules: 'old', rules_length: 3 },
      proposed_after: { rules: 'old\n\nnew', rules_length: 8 },
    },
  };
  try {
    const first = await stageRunWriteback(input);
    const second = await stageRunWriteback(input);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(second.proposal_hash, first.proposal_hash);
    assert.match(first.path, /\/work\/writebacks\/.*\.proposal\.json$/);
    const proposal = JSON.parse(await readFile(first.path, 'utf8'));
    assert.equal(proposal.status, 'staged');
    assert.equal(proposal.before.rules, 'old');
    assert.equal(proposal.proposed_after.rules, 'old\n\nnew');

    const receipt = await completeRunWriteback({
      workspace,
      runId: input.runId,
      callId: input.callId,
      toolName: input.toolName,
      projectId: input.projectId,
      staged: first,
      actualAfter: { rules: 'old\n\nnew', rules_length: 8 },
      approvedRequestId: 'approval-writeback-test',
    });
    assert.equal(receipt.created, true);
    assert.match(receipt.path, /\/artifacts\/writebacks\/.*\.applied\.json$/);
    const applied = JSON.parse(await readFile(receipt.path, 'utf8'));
    assert.equal(applied.status, 'applied');
    assert.equal(applied.proposal_hash, first.proposal_hash);
    assert.equal(applied.approved_request_id, 'approval-writeback-test');
    assert.equal(applied.before.rules, 'old');
    assert.equal(applied.actual_after.rules, 'old\n\nnew');
    assert.match(applied.receipt_hash, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('same call id cannot be reused for a different proposal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-writeback-conflict-'));
  const workspace = { work: join(root, 'work'), artifacts: join(root, 'artifacts') };
  const base = {
    workspace,
    runId: 'run-writeback-conflict',
    callId: 'same-call',
    toolName: 'project_rules_update',
    projectId: 'project-writeback-conflict',
    argsFingerprint: 'first',
    proposal: {
      kind: 'project_rules',
      target: { project_id: 'project-writeback-conflict', rule_type: 'sql' },
      before: { rules: 'old' },
      proposed_after: { rules: 'first' },
    },
  };
  try {
    await stageRunWriteback(base);
    await assert.rejects(
      () => stageRunWriteback({
        ...base,
        argsFingerprint: 'second',
        proposal: { ...base.proposal, proposed_after: { rules: 'second' } },
      }),
      (error) => error.code === 'AGENT_RUN_WRITEBACK_CONFLICT',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
