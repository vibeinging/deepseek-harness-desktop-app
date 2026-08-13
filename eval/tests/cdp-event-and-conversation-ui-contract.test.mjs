import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { createCdpEventHub } from '../lib/cdp.mjs';

test('CDP event hub forwards diagnostics and supports unsubscribe', () => {
  const hub = createCdpEventHub();
  const received = [];
  const unsubscribe = hub.on('Runtime.exceptionThrown', (payload) => received.push(payload));
  hub.emit('Runtime.exceptionThrown', { text: 'first' });
  unsubscribe();
  hub.emit('Runtime.exceptionThrown', { text: 'second' });
  assert.deepEqual(received, [{ text: 'first' }]);
});

test('conversation UI exposes stable live-process and final-answer diagnostics', () => {
  const turns = readFileSync(new URL('../../renderer/src/views/agent/conversation/ConversationTurns.tsx', import.meta.url), 'utf8');
  const content = readFileSync(new URL('../../renderer/src/views/agent/conversation/AssistantContent.tsx', import.meta.url), 'utf8');
  const driver = readFileSync(new URL('../lib/driver.mjs', import.meta.url), 'utf8');
  assert.match(turns, /data-agent-turn-status/);
  assert.match(turns, /data-agent-answer-status/);
  assert.match(turns, /data-agent-answer-phase/);
  assert.match(content, /data-agent-block="thinking"/);
  assert.match(content, /data-agent-block="tool"/);
  assert.match(content, /data-tool-name=/);
  assert.match(driver, /onCdpEvent: session\.onEvent/);
});
