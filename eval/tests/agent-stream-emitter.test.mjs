import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentStreamEmitter } from '../../server/src/engine/stream/agent_stream_emitter.js';

function makeStream(overrides = {}) {
  const events = [];
  const stream = createAgentStreamEmitter({
    emit: (event) => events.push(event),
    turnId: 'turn-1',
    threadId: 'thread-1',
    messageId: 'assistant-1',
    ...overrides,
  });
  return { events, stream };
}

test('AgentStreamEmitter emits one Agent-style turn with stable item lifecycles', () => {
  const { events, stream } = makeStream();

  stream.runStarted({ mode: 'agent' });
  stream.content('我先查询数据。', { content_id: 'commentary-1', content_type: 'markdown', phase: 'commentary' });
  stream.content('read {"path":"a.md"}', {
    content_id: 'tool-1',
    content_type: 'tool',
    title: 'running',
    tool_name: 'read',
  });
  stream.content('read {"path":"a.md"}', {
    content_id: 'tool-1',
    content_type: 'tool',
    title: 'done',
    tool_name: 'read',
  });
  stream.content('file content', {
    content_id: 'result:tool-1',
    content_type: 'tool_result',
    title: 'read',
    tool_name: 'read',
  });
  stream.content('最终答案。', {
    content_id: 'answer-1',
    content_type: 'markdown',
    phase: 'final_answer',
  });
  stream.runCompleted({ status: 'completed' });

  assert.equal(events.every((event) => !Object.hasOwn(event, 'v')), true);
  assert.equal(events.every((event) => event.thread_id === 'thread-1'), true);
  assert.equal(events.every((event) => event.turn_id === 'turn-1'), true);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  assert.deepEqual(events.map((event) => event.type), [
    'turn/started',
    'item/started',
    'item/agentMessage/delta',
    'item/completed',
    'item/started',
    'item/toolCall/outputDelta',
    'item/completed',
    'item/started',
    'item/agentMessage/delta',
    'item/completed',
    'turn/completed',
  ]);

  const commentary = events.find(
    (event) => event.type === 'item/completed' && event.item_id === 'commentary-1',
  );
  const answer = events.find(
    (event) => event.type === 'item/completed' && event.item_id === 'answer-1',
  );
  assert.equal(commentary.payload.item.phase, 'commentary');
  assert.equal(commentary.payload.item.metadata.phase, 'commentary');
  assert.equal(answer.payload.item.phase, 'final_answer');
  assert.equal(answer.payload.item.metadata.phase, 'final_answer');
  assert.equal(Object.hasOwn(answer.payload.item.metadata, 'msg_category'), false);
  assert.equal(events.at(-1).payload.turn.status, 'completed');
  assert.equal(typeof events.at(-1).payload.turn.durationMs, 'number');
});

test('AgentStreamEmitter converts provider snapshots into real deltas', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  stream.content('你', { content_id: 'answer-1', content_type: 'markdown' });
  stream.content('你好', { content_id: 'answer-1', content_type: 'markdown' });
  stream.content('你好！', { content_id: 'answer-1', content_type: 'markdown', msg_category: 'final_answer' });
  stream.runCompleted();

  const deltas = events
    .filter((event) => event.type === 'item/agentMessage/delta')
    .map((event) => [event.payload.delta, event.payload.mode]);
  assert.deepEqual(deltas, [['你', 'append'], ['好', 'append'], ['！', 'append']]);
  assert.equal(
    events.filter((event) => event.type === 'item/started' && event.item_id === 'answer-1').length,
    1,
  );
});

test('AgentStreamEmitter publishes the turn terminal exactly once', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  stream.content('已核对结果。', {
    content_id: 'answer-1',
    content_type: 'markdown',
    phase: 'final_answer',
  });
  const first = stream.runCompleted({ status: 'completed' });
  const second = stream.runCompleted({ status: 'failed', message: 'late failure' });

  assert.equal(second, first);
  assert.equal(events.filter((event) => event.type === 'turn/completed').length, 1);
  assert.equal(events.at(-1).payload.turn.status, 'completed');
});

test('AgentStreamEmitter never infers a final answer from the last readable message', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  stream.content('普通过程消息。', { content_id: 'commentary-1', content_type: 'markdown' });
  stream.runCompleted({ status: 'completed' });

  const completed = events.find(
    (event) => event.type === 'item/completed' && event.item_id === 'commentary-1',
  );
  assert.equal(completed.payload.item.phase, undefined);
  assert.equal(events.at(-1).payload.turn.answer, undefined);
});

test('AgentStreamEmitter carries the Turn Finalizer decision on the terminal event', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  stream.content('最终答案。', {
    content_id: 'answer-1',
    content_type: 'markdown',
    phase: 'final_answer',
  });
  stream.runCompleted({
    status: 'completed',
    answerStatus: 'accepted',
    answerItemId: 'answer-1',
    answerSource: 'runtime_terminal',
  });

  assert.deepEqual(events.at(-1).payload.turn.answer, {
    status: 'accepted',
    itemId: 'answer-1',
    source: 'runtime_terminal',
    rejectionCode: null,
  });
});

test('AgentStreamEmitter can build a terminal payload without publishing a second host terminal event', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  const terminal = stream.runCompleted({ status: 'completed', emitTerminal: false });

  assert.equal(terminal.type, 'turn/completed');
  assert.equal(events.some((event) => event.type === 'turn/completed'), false);
});

test('AgentStreamEmitter treats structured output as a deliverable unless explicitly intermediate', () => {
  const { events, stream } = makeStream();
  stream.content('{"rows":[{"value":42}]}', {
    content_id: 'table-final',
    content_type: 'table',
    title: '查询结果',
  });
  stream.content('{"rows":[{"value":1}]}', {
    content_id: 'table-progress',
    content_type: 'table',
    title: '中间采样',
    result_role: 'intermediate',
  });

  const finalItem = events.find((event) => event.type === 'item/completed' && event.item_id === 'table-final').payload.item;
  const progressItem = events.find((event) => event.type === 'item/completed' && event.item_id === 'table-progress').payload.item;
  assert.equal(finalItem.phase, undefined);
  assert.equal(finalItem.metadata.result_role, 'deliverable');
  assert.equal(progressItem.phase, undefined);
  assert.equal(progressItem.metadata.result_role, 'intermediate');
});

test('AgentStreamEmitter preserves downloadable artifact metadata', () => {
  const { events, stream } = makeStream();
  const outputArtifact = {
    type: 'pdf-document',
    title: '季度报告',
    format: 'application/pdf',
    materialization: 'client-download',
  };
  stream.content('<html><body>42</body></html>', {
    content_id: 'pdf-preview',
    content_type: 'html',
    output_artifact: outputArtifact,
    result_role: 'deliverable',
  });

  const item = events.find((event) => event.type === 'item/completed' && event.item_id === 'pdf-preview').payload.item;
  assert.deepEqual(item.metadata.output_artifact, outputArtifact);
});

test('AgentStreamEmitter treats item/completed as a one-time terminal event', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  stream.content('最终答案。', {
    content_id: 'answer-terminal',
    content_type: 'markdown',
    msg_category: 'final_answer',
  });
  stream.runCompleted();
  stream.itemCompleted({ id: 'answer-terminal', type: 'agentMessage', text: '不应覆盖' });
  stream.content('不应追加', {
    content_id: 'answer-terminal',
    content_type: 'markdown',
    msg_category: 'final_answer',
  });

  assert.equal(
    events.filter((event) => event.type === 'item/completed' && event.item_id === 'answer-terminal').length,
    1,
  );
  assert.equal(
    events.filter((event) => event.type === 'item/agentMessage/delta' && event.item_id === 'answer-terminal').length,
    1,
  );
  assert.equal(stream.persistedItems.get('answer-terminal').content, '最终答案。');
});

test('AgentStreamEmitter keeps every tool output delta before the terminal item', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  stream.content('query {}', {
    content_id: 'tool-stream', content_type: 'tool', title: 'running', tool_name: 'query',
  });
  stream.content('query {}', {
    content_id: 'tool-stream', content_type: 'tool', title: 'done', tool_name: 'query',
  });
  stream.content('一', {
    content_id: 'result:tool-stream', content_type: 'tool_result', title: 'query', tool_name: 'query',
  });
  stream.content('一二', {
    content_id: 'result:tool-stream', content_type: 'tool_result', title: 'query', tool_name: 'query',
  });
  stream.runCompleted();

  const lifecycle = events.filter((event) => event.item_id === 'tool-stream');
  assert.deepEqual(lifecycle.map((event) => event.type), [
    'item/started',
    'item/toolCall/outputDelta',
    'item/toolCall/outputDelta',
    'item/completed',
  ]);
  assert.deepEqual(
    lifecycle.filter((event) => event.type === 'item/toolCall/outputDelta').map((event) => event.payload.delta),
    ['一', '二'],
  );
});

test('AgentStreamEmitter updates final answer metadata when evidence arrives after text', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  stream.content('销售额为 300。', {
    content_id: 'answer-evidence',
    content_type: 'markdown',
    msg_category: 'final_answer',
  });
  stream.content('销售额为 300。', {
    content_id: 'answer-evidence',
    content_type: 'markdown',
    msg_category: 'final_answer',
    evidence_bundle_ref: { id: 'bundle-1', status: 'verified', snapshot_hash: 'sha256:abc' },
  });

  const deltas = events.filter(
    (event) => event.type === 'item/agentMessage/delta' && event.item_id === 'answer-evidence',
  );
  assert.equal(deltas.length, 2);
  assert.equal(deltas[1].payload.delta, '');
  assert.deepEqual(deltas[1].payload.metadata.evidence_bundle_ref, {
    id: 'bundle-1', status: 'verified', snapshot_hash: 'sha256:abc',
  });
  assert.equal(stream.persistedItems.get('answer-evidence').metadata.evidence_bundle_ref.id, 'bundle-1');
});

test('AgentStreamEmitter streams and persists native memory citations', () => {
  const { events, stream } = makeStream();
  const memoryCitation = {
    path: '/tmp/codex-memory.md',
    lineStart: 12,
    lineEnd: 14,
    note: '项目发布约定',
    sourceThreadId: 'thread-source',
  };
  stream.runStarted();
  stream.content('周四发布。', {
    content_id: 'answer-memory',
    content_type: 'markdown',
    msg_category: 'final_answer',
    memory_citation: memoryCitation,
  });

  const delta = events.find(
    (event) => event.type === 'item/agentMessage/delta' && event.item_id === 'answer-memory',
  );
  assert.deepEqual(delta.payload.metadata.memory_citation, memoryCitation);
  assert.deepEqual(stream.persistedItems.get('answer-memory').metadata.memory_citation, memoryCitation);
});

test('AgentStreamEmitter keeps hidden trace snapshots hidden on every delta', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  const pushed = stream.content('tool_call update_plan {"steps":[]}', {
    content_id: 'trace-1',
    content_type: 'markdown',
    title: 'LLM 工具决策',
    msg_category: 'llm_trace',
    display: false,
  });

  const started = events.find((event) => event.type === 'item/started' && event.item_id === 'trace-1');
  const delta = events.find((event) => event.type === 'item/agentMessage/delta' && event.item_id === 'trace-1');
  assert.equal(started.payload.item.visibility, 'hidden');
  assert.equal(delta.payload.visibility, 'hidden');
  assert.equal(pushed.item.metadata.display, false);
});

test('AgentStreamEmitter maps approval, user input, action, and workspace extension items', () => {
  const { events, stream } = makeStream();
  const approvalRequest = {
    action: 'bash',
    risk: 'command_execution',
    target: 'python clean.py',
    sandbox: { system_enforced: true, mode: 'workspace-write', network: 'blocked' },
    network: 'blocked',
    approval_scope: 'once',
  };
  stream.runStarted();
  stream.content('bash {"cmd":"python clean.py"}', {
    content_id: 'confirm:tool-2',
    content_type: 'confirm',
    title: 'bash',
    tool_call_id: 'tool-2',
    approval_request: approvalRequest,
  });
  stream.content('bash {"cmd":"python clean.py"}', {
    content_id: 'confirm:tool-2',
    content_type: 'confirm',
    title: 'approved',
    tool_call_id: 'tool-2',
    approval_request: approvalRequest,
  });
  stream.content(JSON.stringify({ request_id: 'ask-1', prompt: '请选择客户' }), {
    content_id: 'user_input:ask-1',
    content_type: 'user_input',
    title: '需要确认',
    request_id: 'ask-1',
  });
  stream.userInputResolved({ request_id: 'ask-1', value: '宏远科技' });
  const action = stream.content(JSON.stringify({
    type: 'navigate',
    label: '添加数据源',
    target: 'project.settings.datasource',
  }), {
    content_id: 'action-1',
    content_type: 'action',
    title: '需要数据源',
  });
  stream.content(JSON.stringify({ event: 'project_ready_for_query', project_id: 'project-1' }), {
    content_id: 'workspace:tool-3',
    content_type: 'workspace_event',
    workspace_event: { event: 'project_ready_for_query', project_id: 'project-1' },
    display: false,
  });

  const completedItems = events
    .filter((event) => event.type === 'item/completed')
    .map((event) => event.payload.item);
  assert.equal(completedItems.some((item) => item.type === 'skill'), false);
  assert.ok(completedItems.some((item) => (
    item.type === 'approval'
    && item.status === 'approved'
    && item.approvalRequest === approvalRequest
  )));
  assert.ok(completedItems.some((item) => item.type === 'userInput' && item.value === '宏远科技'));
  assert.ok(completedItems.some((item) => item.type === 'dataResult' && item.format === 'action'));
  assert.ok(completedItems.some((item) => item.type === 'workspaceEvent' && item.visibility === 'hidden'));
  assert.equal(action.item.metadata.item_type, 'dataResult');
});

test('AgentStreamEmitter exposes suspended, resumed, and expired turn states', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  stream.runSuspended({ request_id: 'ask-2', resumable: true });
  stream.runResumed({ request_id: 'ask-2', mode: 'handle' });
  stream.runExpired({ request_id: 'ask-2' });

  assert.deepEqual(events.map((event) => event.type), [
    'turn/started',
    'turn/statusChanged',
    'turn/statusChanged',
    'turn/statusChanged',
  ]);
  assert.deepEqual(events.slice(1).map((event) => event.payload.status), [
    'suspended',
    'inProgress',
    'expired',
  ]);
});

test('AgentStreamEmitter emits plan and artifact as first-class items', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  stream.content(JSON.stringify([{ title: '查询数据', status: 'doing' }]), {
    content_id: 'plan',
    content_type: 'plan',
  });
  stream.content('bash {"cmd":"python generate.py"}', {
    content_id: 'tool-image',
    content_type: 'tool',
    title: 'done',
    tool_name: 'bash',
    artifact: '/tmp/dsh/projects/__chat__/red_solid.png',
  });

  const plan = events.find((event) => event.type === 'turn/plan/updated');
  const artifact = events.find(
    (event) => event.type === 'item/completed' && event.payload.item.type === 'artifact',
  );
  assert.equal(plan.item_id, 'plan');
  assert.equal(plan.payload.plan[0].status, 'inProgress');
  assert.equal(artifact.payload.item.kind, 'image');
  assert.equal(artifact.payload.item.name, 'red_solid.png');
  assert.equal(artifact.payload.item.source_tool_call_id, 'tool-image');
});

test('AgentStreamEmitter replaces a repeated plan snapshot with the latest state', () => {
  const { events, stream } = makeStream();
  const first = stream.content(JSON.stringify([
    { step: '检查目录', status: 'in_progress' },
    { step: '汇总发现', status: 'pending' },
  ]), {
    content_id: 'plan:turn-1',
    content_type: 'plan',
  });
  const second = stream.content(JSON.stringify([
    { step: '检查目录', status: 'completed' },
    { step: '汇总发现', status: 'in_progress' },
  ]), {
    content_id: 'plan:turn-1',
    content_type: 'plan',
  });

  const updates = events.filter((event) => event.type === 'turn/plan/updated');
  assert.equal(updates.length, 2);
  assert.equal(updates[1].payload.plan[0].status, 'completed');
  assert.equal(updates[1].payload.plan[1].status, 'inProgress');
  assert.equal(first.item, second.item);
  assert.equal(JSON.parse(second.item.content)[0].status, 'completed');
});

test('AgentStreamEmitter replaces a native status placeholder with its final visual result', () => {
  const { events, stream } = makeStream();
  const started = stream.content('正在生成图片…', {
    content_id: 'image-native-1',
    content_type: 'status',
    title: 'running',
    native_item_type: 'imageGeneration',
    replace_snapshot: true,
  });
  const completed = stream.content('data:image/png;base64,aW1hZ2U=', {
    content_id: 'image-native-1',
    content_type: 'image',
    title: '生成的图片',
    display_type: 'image',
    native_item_type: 'imageGeneration',
    replace_snapshot: true,
  });

  assert.equal(started.item, completed.item);
  assert.equal(completed.item.type, 'image');
  assert.equal(completed.item.content, 'data:image/png;base64,aW1hZ2U=');
  assert.equal(events.filter((event) => event.item_id === 'image-native-1' && event.type === 'item/completed').length, 1);
});

test('AgentStreamEmitter exposes delegated subtask lifecycle as one stable item', () => {
  const { events, stream } = makeStream();
  stream.runStarted();
  stream.content(JSON.stringify({
    run_id: 'child-run-1', parent_run_id: 'parent-run-1', call_id: 'call-1',
    type: 'schema_investigation', title: 'Schema 调查', tool_name: 'grep_tables', status: 'running',
    parallel_group: 'readonly-1',
  }), {
    content_id: 'subtask:child-run-1', content_type: 'delegated_subtask', status: 'running',
  });
  stream.content(JSON.stringify({
    run_id: 'child-run-1', parent_run_id: 'parent-run-1', call_id: 'call-1',
    type: 'schema_investigation', title: 'Schema 调查', tool_name: 'grep_tables', status: 'completed',
    summary: '子任务已完成', parallel_group: 'readonly-1',
  }), {
    content_id: 'subtask:child-run-1', content_type: 'delegated_subtask', status: 'completed',
  });

  const lifecycle = events.filter((event) => event.item_id === 'subtask:child-run-1');
  assert.deepEqual(lifecycle.map((event) => event.type), ['item/started', 'item/completed']);
  assert.equal(lifecycle[0].payload.item.type, 'subtask');
  assert.equal(lifecycle[1].payload.item.status, 'completed');
  assert.equal(lifecycle[1].payload.item.runId, 'child-run-1');
  assert.equal(lifecycle[1].payload.item.parallelGroup, 'readonly-1');
});

test('AgentStreamEmitter persists the authoritative turn and item metadata', () => {
  const { stream } = makeStream();
  stream.runStarted();
  const pushed = stream.content('答案', {
    content_id: 'answer-1',
    content_type: 'markdown',
    msg_category: 'final_answer',
  });
  stream.runCompleted();

  assert.equal(Object.hasOwn(pushed.item.metadata, 'protocol_version'), false);
  assert.equal(pushed.item.metadata.item_type, 'agentMessage');
  assert.equal(pushed.item.metadata.phase, 'final_answer');
  assert.equal(pushed.item.metadata.msg_category, undefined);
  const metadata = stream.turnMetadata();
  assert.equal(Object.hasOwn(metadata, 'protocol_version'), false);
  assert.equal(metadata.thread_id, 'thread-1');
  assert.equal(metadata.turn_id, 'turn-1');
  assert.equal(metadata.message_id, 'assistant-1');
  assert.equal(metadata.turn_status, 'completed');
  assert.equal(typeof metadata.started_at, 'string');
  assert.equal(typeof metadata.completed_at, 'string');
  assert.equal(typeof metadata.duration_ms, 'number');
});
