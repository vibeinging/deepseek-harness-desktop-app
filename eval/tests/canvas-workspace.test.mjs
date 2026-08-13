import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rm, stat, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import {
  createSessionCanvas,
  getSessionCanvas,
  getSessionCanvasVersion,
} from '../../server/src/app/chat/canvases.js';
import {
  autoCreateCanvasFromTurn,
  createCanvasSuggestion,
  decideCanvasSuggestion,
  detectAutoCanvasCandidate,
  editCanvas,
  getCanvas,
  purgeSessionCanvases,
  restoreCanvasVersion,
} from '../../server/src/engine/agents/canvas_store.js';
import { createProductTools } from '../../server/src/engine/agents/product_tools.js';
import { chatRoutes } from '../../server/src/transport/registry.chat.js';

const context = (userId) => ({ userId, query, queryOne });

test('Canvas works in normal chat with immutable versions, stale-base protection, exact suggestions and trusted tools', async (t) => {
  const userId = `canvas-user-${randomUUID()}`;
  const otherUserId = `canvas-other-${randomUUID()}`;
  const sessionId = randomUUID();
  const otherSessionId = randomUUID();
  const ctx = context(userId);

  t.after(async () => {
    await purgeSessionCanvases(ctx, { userId, sessionId }).catch(() => undefined);
    await purgeSessionCanvases(ctx, { userId, sessionId: otherSessionId }).catch(() => undefined);
    await query('DELETE FROM sessions WHERE id IN ($1,$2)', [sessionId, otherSessionId]).catch(() => undefined);
  });

  for (const id of [sessionId, otherSessionId]) {
    await query(
      `INSERT INTO sessions
        (id,project_id,created_by,source_type,source_id,action_type,title,status,created_at,updated_at)
       VALUES ($1,'__chat__',$2,'agent','__chat__','agentic_chat','Canvas test','active',now(),now())`,
      [id, userId],
    );
  }

  const created = await createSessionCanvas(ctx, {
    params: { sid: sessionId },
    body: { title: '发布说明', kind: 'document', content: '# 发布说明\n\n状态：准备中' },
  });
  const canvasId = created.data.canvas.id;
  const version1 = created.data.canvas.current_version;
  assert.equal(created.data.created, true);
  assert.equal(created.data.canvas.project_id, '__chat__');
  assert.equal(created.data.canvas.content, '# 发布说明\n\n状态：准备中');
  assert.equal(version1.version_number, 1);
  assert.equal('snapshot_path' in version1, false, 'managed paths are not exposed through the Canvas API');

  const storedV1 = await queryOne('SELECT * FROM agent_canvas_versions WHERE id=$1', [version1.id]);
  assert.equal(await readFile(storedV1.snapshot_path, 'utf8'), '# 发布说明\n\n状态：准备中');
  assert.equal((await stat(storedV1.snapshot_path)).mode & 0o222, 0, 'Canvas history is read-only');

  await assert.rejects(
    getSessionCanvas(context(otherUserId), { params: { sid: sessionId, canvasId } }),
    /会话不存在或无权限/,
  );
  await assert.rejects(
    getSessionCanvas(ctx, { params: { sid: otherSessionId, canvasId } }),
    /Canvas 不存在或无权限/,
  );

  const [parallelA, parallelB] = await Promise.allSettled([
    editCanvas(ctx, {
      userId,
      sessionId,
      canvasId,
      baseVersionId: version1.id,
      operations: [{ type: 'replace_range', start: 10, end: 13, text: '可以发布' }],
      changeSummary: '更新状态',
    }),
    editCanvas(ctx, {
      userId,
      sessionId,
      canvasId,
      baseVersionId: version1.id,
      content: '# 发布说明\n\n并发旧稿',
    }),
  ]);
  assert.equal([parallelA, parallelB].filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal([parallelA, parallelB].filter((item) => item.status === 'rejected').length, 1);
  const afterParallel = await getCanvas(ctx, { userId, sessionId, canvasId });
  assert.equal(afterParallel.current_version.version_number, 2);
  assert.equal(afterParallel.version_count, 2);
  assert.match(String([parallelA, parallelB].find((item) => item.status === 'rejected').reason), /已经产生新版本/);

  const currentText = afterParallel.content;
  const selected = currentText.slice(0, 6);
  const suggestion = await createCanvasSuggestion(ctx, {
    userId,
    sessionId,
    canvasId,
    baseVersionId: afterParallel.current_version.id,
    start: 0,
    end: 6,
    selectedText: selected,
    replacementText: '# 正式说明',
    instruction: '标题更明确',
  });
  assert.equal(suggestion.status, 'pending');
  await assert.rejects(
    createCanvasSuggestion(ctx, {
      userId,
      sessionId,
      canvasId,
      baseVersionId: afterParallel.current_version.id,
      start: 0,
      end: 6,
      selectedText: '错误原文',
      replacementText: '不会保存',
    }),
    /所选文字已经变化/,
  );

  const accepted = await decideCanvasSuggestion(ctx, {
    userId,
    sessionId,
    canvasId,
    suggestionId: suggestion.id,
    decision: 'accept',
  });
  assert.equal(accepted.suggestion.status, 'accepted');
  assert.equal(accepted.canvas.current_version.version_number, 3);
  assert.match(accepted.canvas.content, /^# 正式说明/);

  const rejectedSuggestion = await createCanvasSuggestion(ctx, {
    userId,
    sessionId,
    canvasId,
    baseVersionId: accepted.canvas.current_version.id,
    start: 0,
    end: 6,
    selectedText: accepted.canvas.content.slice(0, 6),
    replacementText: '# 拒绝内容',
  });
  const rejected = await decideCanvasSuggestion(ctx, {
    userId,
    sessionId,
    canvasId,
    suggestionId: rejectedSuggestion.id,
    decision: 'reject',
  });
  assert.equal(rejected.suggestion.status, 'rejected');
  assert.equal(rejected.canvas.current_version.id, accepted.canvas.current_version.id);

  const pendingStale = await createCanvasSuggestion(ctx, {
    userId,
    sessionId,
    canvasId,
    baseVersionId: accepted.canvas.current_version.id,
    start: 0,
    end: 6,
    selectedText: accepted.canvas.content.slice(0, 6),
    replacementText: '# 旧建议',
  });
  const directEdit = await editCanvas(ctx, {
    userId,
    sessionId,
    canvasId,
    baseVersionId: accepted.canvas.current_version.id,
    content: `${accepted.canvas.content}\n\n发布日期：今天`,
    changeSummary: '补充日期',
  });
  await assert.rejects(
    decideCanvasSuggestion(ctx, {
      userId,
      sessionId,
      canvasId,
      suggestionId: pendingStale.id,
      decision: 'accept',
    }),
    /建议已经处理/,
  );
  assert.equal((await queryOne('SELECT status FROM agent_canvas_suggestions WHERE id=$1', [pendingStale.id])).status, 'stale');

  const restored = await restoreCanvasVersion(ctx, {
    userId,
    sessionId,
    canvasId,
    baseVersionId: directEdit.canvas.current_version.id,
    versionId: version1.id,
  });
  assert.equal(restored.restored, true);
  assert.equal(restored.canvas.current_version.version_number, 5);
  assert.equal(restored.canvas.current_version.restored_from_version_id, version1.id);
  assert.equal(restored.canvas.content, '# 发布说明\n\n状态：准备中');
  const restoredSameText = await restoreCanvasVersion(ctx, {
    userId,
    sessionId,
    canvasId,
    baseVersionId: restored.canvas.current_version.id,
    versionId: version1.id,
  });
  assert.equal(restoredSameText.canvas.current_version.version_number, 6);
  assert.equal(restoredSameText.canvas.current_version.restored_from_version_id, version1.id);
  await assert.rejects(
    restoreCanvasVersion(ctx, {
      userId,
      sessionId,
      canvasId,
      baseVersionId: restoredSameText.canvas.current_version.id,
      versionId: restoredSameText.canvas.current_version.id,
    }),
    /已经是当前版本/,
  );
  const oldVersion = await getSessionCanvasVersion(ctx, {
    params: { sid: sessionId, canvasId, versionId: directEdit.canvas.current_version.id },
  });
  assert.match(oldVersion.data.content, /发布日期/);

  await chmod(storedV1.snapshot_path, 0o600);
  await writeFile(storedV1.snapshot_path, 'tampered');
  await assert.rejects(
    getSessionCanvasVersion(ctx, { params: { sid: sessionId, canvasId, versionId: version1.id } }),
    /指纹校验失败/,
  );

  const recorded = [];
  const tools = createProductTools({
    db: { query, queryOne },
    user_id: userId,
    project_id: '__chat__',
    session_id: otherSessionId,
    runtime_turn_id: 'canvas-native-turn',
    task_id: 'canvas-native-run',
    runtime: { runId: 'canvas-native-run', recordArtifact: async (item) => recorded.push(item) },
  });
  const names = new Set(['canvas_inspect', 'canvas_create', 'canvas_edit', 'canvas_suggest']);
  assert.deepEqual(new Set(tools.filter((tool) => names.has(tool.name)).map((tool) => tool.name)), names);
  const createTool = tools.find((tool) => tool.name === 'canvas_create');
  const inspectTool = tools.find((tool) => tool.name === 'canvas_inspect');
  const editTool = tools.find((tool) => tool.name === 'canvas_edit');
  const suggestTool = tools.find((tool) => tool.name === 'canvas_suggest');
  assert.equal(inspectTool.side_effect, 'read');
  assert.equal(createTool.side_effect, 'write');
  assert.equal(createTool.host_action_capable, true);
  const toolCreated = await createTool.execute('canvas-create-call', {
    title: '代码草稿', kind: 'code', language: 'js', content: 'const ready = false;\n',
  });
  assert.equal(toolCreated.isError, undefined, JSON.stringify(toolCreated));
  assert.equal(toolCreated.details.canvas.session_id, otherSessionId);
  assert.equal(toolCreated.details.canvas.current_version.source_tool_call_id, 'canvas-create-call');
  assert.equal(toolCreated.details.host_actions[0].event.event, 'canvas_opened');
  const toolCanvas = toolCreated.details.canvas;
  const inspected = await inspectTool.execute('canvas-inspect-call', { canvas_id: toolCanvas.id });
  assert.equal(inspected.details.canvas.content, 'const ready = false;\n');
  const toolEdited = await editTool.execute('canvas-edit-call', {
    canvas_id: toolCanvas.id,
    base_version_id: toolCanvas.current_version.id,
    operations: [{ type: 'replace_range', start: 14, end: 19, text: 'true' }],
  });
  assert.equal(toolEdited.details.canvas.content, 'const ready = true;\n');
  assert.equal(toolEdited.details.host_actions[0].event.event, 'canvas_updated');
  const toolSuggested = await suggestTool.execute('canvas-suggest-call', {
    canvas_id: toolCanvas.id,
    base_version_id: toolEdited.details.canvas.current_version.id,
    start: 6,
    end: 11,
    selected_text: 'ready',
    replacement_text: 'active',
    instruction: '命名更明确',
  });
  assert.equal(toolSuggested.details.suggestion.status, 'pending');
  assert.equal(toolSuggested.details.host_actions[0].event.event, 'canvas_suggestion_created');
  assert.equal(recorded.length, 2);
  assert.deepEqual(recorded.map((item) => item.metadata.action), ['create', 'edit']);

  const routes = new Set(chatRoutes.map((route) => `${route.m} ${route.p}`));
  assert.equal(routes.has('GET /api/agent/sessions/:sid/canvases'), true);
  assert.equal(routes.has('POST /api/agent/sessions/:sid/canvases/:canvasId/edits'), true);
  assert.equal(routes.has('POST /api/agent/sessions/:sid/canvases/:canvasId/suggestions/:suggestionId/decision'), true);
});

test('automatic Canvas capture only uses completed final long content and deduplicates by item', async (t) => {
  const userId = `canvas-auto-${randomUUID()}`;
  const sessionId = randomUUID();
  const ctx = context(userId);
  t.after(async () => {
    await purgeSessionCanvases(ctx, { userId, sessionId }).catch(() => undefined);
    await query('DELETE FROM sessions WHERE id=$1', [sessionId]).catch(() => undefined);
  });
  await query(
    `INSERT INTO sessions
      (id,project_id,created_by,source_type,source_id,action_type,title,status,created_at,updated_at)
     VALUES ($1,'__chat__',$2,'agent','__chat__','agentic_chat','Auto Canvas','active',now(),now())`,
    [sessionId, userId],
  );

  const short = [{ id: 'short', type: 'markdown', content: '简短回答', metadata: { answer_status: 'accepted' } }];
  assert.equal(detectAutoCanvasCandidate(short), null);
  const commentary = [{ id: 'commentary', type: 'markdown', content: '进展'.repeat(1_000), metadata: {} }];
  assert.equal(detectAutoCanvasCandidate(commentary), null);

  const code = Array.from({ length: 18 }, (_, index) => `const value${index} = ${index};`).join('\n');
  const codeCandidate = detectAutoCanvasCandidate([{
    id: 'final-code',
    type: 'markdown',
    content: `下面是实现：\n\n\`\`\`js\n${code}\n\`\`\``,
    metadata: { answer_status: 'accepted' },
  }]);
  assert.equal(codeCandidate.kind, 'code');
  assert.equal(codeCandidate.language, 'js');
  assert.equal(codeCandidate.content, code);

  const document = ['# 发布计划', '', '## 范围', '- 第一项', '- 第二项', '', '## 验收', ...Array.from({ length: 120 }, (_, index) => `第 ${index + 1} 行说明。`)].join('\n');
  const items = [{ id: 'final-document', type: 'markdown', content: document, title: '发布计划', metadata: { answer_status: 'accepted' } }];
  const first = await autoCreateCanvasFromTurn(ctx, {
    userId,
    sessionId,
    assistantMessageId: 'assistant:auto',
    turnId: 'turn:auto',
    runId: 'run:auto',
    items,
  });
  const second = await autoCreateCanvasFromTurn(ctx, {
    userId,
    sessionId,
    assistantMessageId: 'assistant:auto',
    turnId: 'turn:auto',
    runId: 'run:auto',
    items,
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.deduplicated, true);
  assert.equal(first.canvas.id, second.canvas.id);
  assert.equal(first.canvas.source_item_id, 'final-document');
  assert.equal(first.canvas.current_version.source_type, 'assistant');
});
