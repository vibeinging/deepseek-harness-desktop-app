import assert from 'node:assert/strict';
import test from 'node:test';

import {
  completeTurnCapabilities,
  listTurnCompletionPolicies,
  registerTurnCompletionPolicy,
} from '../../server/src/engine/core/turn_completion.js';

test('Turn completion policies evaluate first and settle with one aggregated status', async () => {
  const agentContext = {};
  const settled = [];
  registerTurnCompletionPolicy(agentContext, {
    id: 'later-policy',
    priority: 200,
    evaluate: async () => ({ status: 'passed' }),
    settle: async (input) => settled.push({ id: 'later-policy', status: input.status }),
  });
  registerTurnCompletionPolicy(agentContext, {
    id: 'required-capability',
    priority: 100,
    evaluate: async () => ({
      status: 'failed',
      code: 'CAPABILITY_INCOMPLETE',
      title: '能力未完成',
      message: '缺少一个必需结果',
    }),
    settle: async (input) => settled.push({ id: 'required-capability', status: input.status }),
  });

  assert.deepEqual(listTurnCompletionPolicies(agentContext).map((policy) => policy.id), [
    'required-capability',
    'later-policy',
  ]);
  const completion = await completeTurnCapabilities(agentContext, { status: 'completed' });

  assert.equal(completion.status, 'failed');
  assert.deepEqual(completion.failures.map((failure) => failure.code), ['CAPABILITY_INCOMPLETE']);
  assert.deepEqual(settled, [
    { id: 'required-capability', status: 'failed' },
    { id: 'later-policy', status: 'failed' },
  ]);
});

test('Turn completion fails closed when evaluation or settlement throws', async () => {
  const evaluationContext = {};
  registerTurnCompletionPolicy(evaluationContext, {
    id: 'broken-evaluation',
    evaluate: async () => {
      const error = new Error('裁决存储不可用');
      error.code = 'EVALUATION_STORE_DOWN';
      throw error;
    },
  });
  const evaluation = await completeTurnCapabilities(evaluationContext, { status: 'completed' });
  assert.equal(evaluation.status, 'failed');
  assert.equal(evaluation.failures[0].code, 'EVALUATION_STORE_DOWN');

  const settlementContext = {};
  registerTurnCompletionPolicy(settlementContext, {
    id: 'broken-settlement',
    evaluate: async () => ({ status: 'passed' }),
    settle: async () => {
      throw new Error('最终状态无法持久化');
    },
  });
  const settlement = await completeTurnCapabilities(settlementContext, { status: 'completed' });
  assert.equal(settlement.status, 'failed');
  assert.equal(settlement.failures[0].code, 'TURN_COMPLETION_POLICY_ERROR');
  assert.match(settlement.failures[0].message, /无法持久化/);
});

test('Turn completion fails closed before settlement when the canonical answer is missing', async () => {
  const agentContext = {};
  const settled = [];
  registerTurnCompletionPolicy(agentContext, {
    id: 'capability',
    evaluate: async () => ({ status: 'passed' }),
    settle: async ({ status }) => settled.push(status),
  });

  const completion = await completeTurnCapabilities(agentContext, {
    status: 'completed',
    answerAccepted: false,
  });

  assert.equal(completion.status, 'failed');
  assert.equal(completion.failures[0].code, 'TURN_ANSWER_MISSING');
  assert.deepEqual(settled, ['failed']);
});

test('a late settlement failure reconciles earlier capability entities to failed', async () => {
  const agentContext = {};
  const settled = [];
  registerTurnCompletionPolicy(agentContext, {
    id: 'first-capability',
    priority: 100,
    settle: async ({ status, phase }) => settled.push({ id: 'first-capability', status, phase }),
  });
  registerTurnCompletionPolicy(agentContext, {
    id: 'late-failure',
    priority: 200,
    settle: async ({ status, phase }) => {
      settled.push({ id: 'late-failure', status, phase });
      if (phase === 'settle') throw new Error('late persistence failure');
    },
  });

  const completion = await completeTurnCapabilities(agentContext, { status: 'completed' });
  assert.equal(completion.status, 'failed');
  assert.deepEqual(settled, [
    { id: 'first-capability', status: 'completed', phase: 'settle' },
    { id: 'late-failure', status: 'completed', phase: 'settle' },
    { id: 'first-capability', status: 'failed', phase: 'reconcile' },
    { id: 'late-failure', status: 'failed', phase: 'reconcile' },
  ]);
});

test('Turn completion policy IDs are unique per Agent turn', () => {
  const agentContext = {};
  registerTurnCompletionPolicy(agentContext, { id: 'ask-data', evaluate: async () => null });
  assert.throws(
    () => registerTurnCompletionPolicy(agentContext, { id: 'ask-data', evaluate: async () => null }),
    /重复注册/,
  );
});
