import assert from 'node:assert/strict';
import test from 'node:test';

import { agentsRoutes } from '../../server/src/transport/registry.agents.js';
import { agentEvalRoutes, agentEvalRoutesEnabled } from '../../server/src/transport/registry.agents.eval.js';

test('normal Agent registry excludes destructive Eval diagnostics', () => {
  assert.equal(agentsRoutes.some((route) => route.p.includes('/diagnostics')), false);
  assert.ok(agentEvalRoutes.length > 0);
  assert.ok(agentEvalRoutes.every((route) => route.p.includes('/diagnostics')));
});

test('Eval diagnostic routes require an explicit Eval runtime marker', () => {
  assert.equal(agentEvalRoutesEnabled({}), false);
  assert.equal(agentEvalRoutesEnabled({ DSH_EVAL_MODE: '0' }), false);
  assert.equal(agentEvalRoutesEnabled({ DSH_EVAL_MODE: 'isolated' }), true);
});
