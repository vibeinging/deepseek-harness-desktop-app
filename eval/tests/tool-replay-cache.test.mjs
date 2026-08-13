import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createSuccessfulToolReplayCache,
  toolCallFingerprint,
} from '../../server/src/engine/agents/tool_replay_cache.js';

test('tool replay fingerprint is stable across object key order', () => {
  assert.equal(
    toolCallFingerprint('query', { b: 2, a: { y: 2, x: 1 } }),
    toolCallFingerprint('query', { a: { x: 1, y: 2 }, b: 2 }),
  );
});

test('successful identical tool action executes once and reuses its result', async () => {
  const cache = createSuccessfulToolReplayCache();
  let executions = 0;
  const run = async () => {
    executions += 1;
    return { content: [{ type: 'text', text: 'table r_result' }] };
  };

  const first = await cache.execute('execute_readonly_sql', { question: 'q', task_id: 't1' }, run);
  const second = await cache.execute('execute_readonly_sql', { task_id: 't1', question: 'q' }, run);

  assert.equal(executions, 1);
  assert.equal(first.details, undefined);
  assert.equal(second.details.replayed, true);
  assert.match(second.content[0].text, /已复用/);
  assert.match(second.content[1].text, /r_result/);
  assert.deepEqual(cache.stats(), { successful_action_count: 1, replay_count: 1 });
});

test('failed tool action is not cached and changed parameters execute independently', async () => {
  const cache = createSuccessfulToolReplayCache();
  let executions = 0;
  const fail = async () => {
    executions += 1;
    return { content: [{ type: 'text', text: 'failed' }], isError: true };
  };
  await cache.execute('query', { value: 1 }, fail);
  await cache.execute('query', { value: 1 }, fail);
  await cache.execute('query', { value: 2 }, async () => {
    executions += 1;
    return { content: [{ type: 'text', text: 'ok' }] };
  });

  assert.equal(executions, 3);
  assert.deepEqual(cache.stats(), { successful_action_count: 1, replay_count: 0 });
});
