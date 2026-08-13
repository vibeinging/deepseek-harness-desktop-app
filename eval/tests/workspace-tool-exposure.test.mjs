import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveWorkspaceToolExposure } from '../../server/src/engine/agents/workspace_tool_exposure.js';

test('chat completions receives core DSH, mounted Plugin, and selected Skill tools directly', () => {
  const options = {
    apiFormat: 'chat_completions',
    mountedPluginNames: new Set(['ask-data']),
    selectedSkills: [{ tool_dependencies: ['skill_exact_tool'] }],
    forceDirectNames: ['automation_exact_tool'],
  };
  assert.equal(resolveWorkspaceToolExposure({ name: 'canvas_create', exposure: 'deferred' }, options), 'direct');
  assert.equal(resolveWorkspaceToolExposure({ name: 'query_orders', plugin_name: 'ask-data', exposure: 'deferred' }, options), 'direct');
  assert.equal(resolveWorkspaceToolExposure({ name: 'skill_exact_tool', exposure: 'deferred' }, options), 'direct');
  assert.equal(resolveWorkspaceToolExposure({ name: 'automation_exact_tool', exposure: 'deferred' }, options), 'direct');
  assert.equal(resolveWorkspaceToolExposure({ name: 'unrelated_tool', exposure: 'deferred' }, options), 'deferred');
});

test('responses keeps deferred loading while web tools stay direct', () => {
  assert.equal(resolveWorkspaceToolExposure({ name: 'canvas_create', exposure: 'deferred' }, {
    apiFormat: 'responses',
  }), 'deferred');
  assert.equal(resolveWorkspaceToolExposure({ name: 'web_search', exposure: 'deferred' }, {
    apiFormat: 'responses',
  }), 'direct');
});
