import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterAllowedProjects,
  normalizeConnectorSettings,
  renderAgentEventsForIm,
} from '../../server/src/app/im/gateway.js';

test('IM connector defaults to record-only and interactive approval', () => {
  assert.deepEqual(normalizeConnectorSettings({}), {
    execution_mode: 'record_only',
    approval: 'ask',
  });
});

test('IM connector rejects remote full mode and hidden runtime settings', () => {
  assert.throws(
    () => normalizeConnectorSettings({ execution_mode: 'agent', approval: 'full' }, { strict: true }),
    (error) => error?.status === 400 && /不能使用 full 权限/.test(error.message),
  );
  assert.throws(
    () => normalizeConnectorSettings({ agent_settings: { timeoutMs: 1 } }, { strict: true }),
    (error) => error?.status === 400 && /不支持的 IM connector 设置/.test(error.message),
  );
});

test('IM connector keeps only its explicit public settings', () => {
  assert.deepEqual(normalizeConnectorSettings({
    execution_mode: 'agent',
    approval: 'auto',
    fixed_session_id: ' session-1 ',
    legacy_runner_timeout: 10,
  }), {
    execution_mode: 'agent',
    approval: 'auto',
    fixed_session_id: 'session-1',
  });
});

test('empty IM workspace allowlist grants no project access', () => {
  const projects = [{ id: 'project-a' }, { id: 'project-b' }];
  assert.deepEqual(filterAllowedProjects(projects, []), []);
  assert.deepEqual(filterAllowedProjects(projects, ['project-b']), [{ id: 'project-b' }]);
});

test('IM renders the canonical answer item from prefixed runtime events', () => {
  const events = [
    {
      method: 'dsh/item/agentMessage/delta',
      params: { itemId: 'progress-1', delta: '过程消息' },
    },
    {
      method: 'dsh/item/agentMessage/delta',
      params: { itemId: 'answer-1', delta: '最终答案' },
    },
    {
      method: 'dsh/turn/completed',
      params: {
        turn: {
          status: 'completed',
          answer: { status: 'accepted', itemId: 'answer-1' },
        },
        message: '处理完成',
      },
    },
  ];
  assert.equal(renderAgentEventsForIm(events), '最终答案');
});
