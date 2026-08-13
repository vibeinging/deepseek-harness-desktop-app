import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerMetadata,
  finalizeTurnAnswer,
  finalizeTurnStatus,
  resolveTurnAnswerCandidate,
} from '../../server/src/engine/core/turn_finalizer.js';
import { AgentStreamAdapter } from '../../server/src/engine/agent_kernel/stream_adapter.js';
import { createAgentStreamEmitter } from '../../server/src/engine/stream/agent_stream_emitter.js';

function items() {
  return [
    { id: 'progress-1', type: 'markdown', content: '正在查询。', metadata: { phase: 'commentary' } },
    { id: 'answer-1', type: 'markdown', content: '共有 4 条记录。', metadata: { phase: 'commentary' } },
  ];
}

test('Turn Finalizer resolves only the Runtime terminal item id', () => {
  const candidate = resolveTurnAnswerCandidate(items(), { answerItemId: 'answer-1' });
  assert.equal(candidate.itemId, 'answer-1');
  assert.equal(candidate.text, '共有 4 条记录。');
  assert.equal(resolveTurnAnswerCandidate(items(), { answerItemId: '' }), null);
  assert.equal(resolveTurnAnswerCandidate(items(), { answerItemId: 'missing' }), null);
});

test('Turn Finalizer trusts an explicit Runtime terminal id but never promotes by title alone', () => {
  const current = items();
  current[0].title = '回答';
  assert.equal(resolveTurnAnswerCandidate(current, { answerItemId: 'progress-1' }).itemId, 'progress-1');
  assert.equal(resolveTurnAnswerCandidate(current, { answerItemId: '' }), null);
});

test('Turn Finalizer rejects punctuation-only and reasoning items', () => {
  assert.equal(resolveTurnAnswerCandidate([
    { id: 'punctuation', type: 'markdown', content: '……', metadata: { phase: 'commentary' } },
  ], { answerItemId: 'punctuation' }), null);
  assert.equal(resolveTurnAnswerCandidate([
    { id: 'reasoning', type: 'agentMessage', content: '分析', metadata: { item_type: 'reasoning' } },
  ], { answerItemId: 'reasoning' }), null);
});

test('Turn Finalizer accepts only after both Turn and capability completion pass', () => {
  const acceptedItems = items();
  const accepted = finalizeTurnAnswer({
    items: acceptedItems,
    answerItemId: 'answer-1',
    turnStatus: 'completed',
    capabilityStatus: 'completed',
  });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(answerMetadata(accepted), {
    answer_status: 'accepted',
    answer_item_id: 'answer-1',
    answer_source: 'runtime_terminal',
    answer_rejection_code: null,
    answer_rejection_message: null,
  });
  assert.equal(acceptedItems[1].metadata.answer_status, 'accepted');
  assert.equal(Object.hasOwn(acceptedItems[1].metadata, 'phase'), false);
  assert.equal(Object.hasOwn(acceptedItems[1].metadata, 'msg_category'), false);

  const rejectedItems = items();
  const rejected = finalizeTurnAnswer({
    items: rejectedItems,
    answerItemId: 'answer-1',
    turnStatus: 'completed',
    capabilityStatus: 'failed',
    rejectionCode: 'ASK_DATA_EVIDENCE_REQUIRED',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejectedItems[1].metadata.display, false);
  assert.equal(rejectedItems[1].metadata.answer_status, 'rejected');
  assert.equal(rejected.rejectionCode, 'ASK_DATA_EVIDENCE_REQUIRED');
});

test('Turn Finalizer accepts a Chat Completions terminal message after native projection', async () => {
  const items = [];
  const stream = createAgentStreamEmitter({ emit: () => {}, turnId: 'turn-1', threadId: 'thread-1' });
  const adapter = new AgentStreamAdapter({
    streamCallback: async (content, options) => {
      const pushed = stream.content(content, options);
      const index = items.findIndex((item) => item.id === pushed.item.id);
      if (index >= 0) items[index] = pushed.item;
      else items.push(pushed.item);
    },
  });
  await adapter.handle('item/agentMessage/delta', {
    itemId: 'chatcmpl-final',
    delta: '4',
  });
  await adapter.handle('item/completed', {
    item: { id: 'chatcmpl-final', type: 'agentMessage', text: '4' },
  });

  const final = finalizeTurnAnswer({
    items,
    answerItemId: 'chatcmpl-final',
    turnStatus: 'completed',
    capabilityStatus: 'completed',
  });
  assert.equal(final.status, 'accepted');
  assert.equal(final.answerText, '4');
});

test('Turn Finalizer fails closed when a completed turn has no accepted answer', () => {
  assert.equal(finalizeTurnStatus('completed', { status: 'missing', accepted: false }), 'failed');
  assert.equal(finalizeTurnStatus('completed', { status: 'rejected', accepted: false }), 'failed');
  assert.equal(finalizeTurnStatus('completed', { status: 'accepted', accepted: true }), 'completed');
  assert.equal(finalizeTurnStatus('interrupted', { status: 'missing', accepted: false }), 'interrupted');
});
