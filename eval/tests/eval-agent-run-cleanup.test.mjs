import assert from 'node:assert/strict';
import test from 'node:test';

import { cleanupProjectAgentRuns } from '../lib/agent-run-cleanup.mjs';

test('eval cleanup discovers project runs when the timed-out chat returned no ids', async () => {
  const calls = [];
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    if (method === 'GET' && url.includes('/projects/')) {
      return {
        status: 200,
        json: { data: { items: [
          { id: 'running-run', status: 'running' },
          { id: 'completed-run', status: 'completed' },
        ] } },
      };
    }
    if (method === 'POST' && url.endsWith('/stop')) return { status: 200, json: { data: {} } };
    if (method === 'GET' && url.endsWith('/deletion-impact')) {
      return { status: 200, json: { data: { impact_hash: `hash:${url}` } } };
    }
    if (method === 'DELETE') return { status: 200, json: { data: { deleted: true } } };
    throw new Error(`unexpected call: ${method} ${url}`);
  };

  const result = await cleanupProjectAgentRuns(api, 'project/with spaces');

  assert.deepEqual(result.deleted, ['running-run', 'completed-run']);
  assert.deepEqual(result.stopped, ['running-run']);
  assert.equal(calls.some((call) => call.url.includes('project%2Fwith%20spaces')), true);
  assert.equal(calls.some((call) => call.method === 'POST' && call.url.includes('completed-run')), false);
});

test('eval cleanup still removes known runs when project discovery fails', async () => {
  const calls = [];
  const api = async (method, url) => {
    calls.push({ method, url });
    if (method === 'GET' && url.includes('/projects/')) throw new Error('list unavailable');
    if (method === 'POST') return { status: 200, json: { data: {} } };
    if (method === 'GET') return { status: 200, json: { data: { impact_hash: 'hash:known' } } };
    if (method === 'DELETE') return { status: 200, json: { data: { deleted: true } } };
    throw new Error(`unexpected call: ${method} ${url}`);
  };

  const result = await cleanupProjectAgentRuns(api, 'project', ['known-run']);

  assert.deepEqual(result.deleted, ['known-run']);
  assert.deepEqual(result.failed, []);
  assert.equal(calls.some((call) => call.method === 'POST' && call.url.endsWith('/known-run/stop')), true);
});
