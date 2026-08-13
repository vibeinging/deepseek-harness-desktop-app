import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import {
  createSessionCanvas,
  getSessionCanvas,
  getSessionCanvasVersion,
  listCanvases,
} from '../../server/src/app/chat/canvases.js';
import {
  editCanvas,
  purgeSessionCanvases,
  restoreCanvasVersion,
} from '../../server/src/engine/agents/canvas_store.js';
import { createProductTools } from '../../server/src/engine/agents/product_tools.js';

const context = (userId) => ({ userId, query, queryOne });

test('local Site reuses immutable Canvas versions with ownership, restore and cleanup', async (t) => {
  const userId = `site-user-${randomUUID()}`;
  const otherUserId = `site-other-${randomUUID()}`;
  const sessionId = randomUUID();
  const ctx = context(userId);
  const initialHtml = '<!doctype html><html><body><button id="go">开始</button><script>document.querySelector("#go").onclick=()=>document.body.dataset.ready="1"</script></body></html>';
  const editedHtml = initialHtml.replace('开始', '继续');

  t.after(async () => {
    await purgeSessionCanvases(ctx, { userId, sessionId }).catch(() => undefined);
    await query('DELETE FROM sessions WHERE id=$1', [sessionId]).catch(() => undefined);
  });

  await query(
    `INSERT INTO sessions
      (id,project_id,created_by,source_type,source_id,action_type,title,status,created_at,updated_at)
     VALUES ($1,'__chat__',$2,'agent','__chat__','agentic_chat','Site test','active',now(),now())`,
    [sessionId, userId],
  );

  const created = await createSessionCanvas(ctx, {
    params: { sid: sessionId },
    body: { title: '交互页', kind: 'site', language: 'html', content: initialHtml },
  });
  const site = created.data.canvas;
  const version1 = site.current_version;
  assert.equal(site.kind, 'site');
  assert.equal(site.language, 'html');
  assert.equal(site.content, initialHtml);
  assert.equal(version1.version_number, 1);

  const list = await listCanvases(ctx, { params: { sid: sessionId }, query: {} });
  assert.equal(list.data.items.some((item) => item.id === site.id && item.kind === 'site'), true);
  await assert.rejects(
    getSessionCanvas(context(otherUserId), { params: { sid: sessionId, canvasId: site.id } }),
    /会话不存在或无权限/,
  );

  const edited = await editCanvas(ctx, {
    userId,
    sessionId,
    canvasId: site.id,
    baseVersionId: version1.id,
    content: editedHtml,
    changeSummary: '更新按钮',
  });
  assert.equal(edited.canvas.content, editedHtml);
  assert.equal(edited.canvas.current_version.version_number, 2);
  await assert.rejects(
    editCanvas(ctx, {
      userId,
      sessionId,
      canvasId: site.id,
      baseVersionId: version1.id,
      content: '<p>旧稿</p>',
    }),
    /已经产生新版本/,
  );

  const version1Read = await getSessionCanvasVersion(ctx, {
    params: { sid: sessionId, canvasId: site.id, versionId: version1.id },
  });
  assert.equal(version1Read.data.content, initialHtml);
  const restored = await restoreCanvasVersion(ctx, {
    userId,
    sessionId,
    canvasId: site.id,
    baseVersionId: edited.canvas.current_version.id,
    versionId: version1.id,
    changeSummary: '恢复初始页面',
  });
  assert.equal(restored.canvas.content, initialHtml);
  assert.equal(restored.canvas.current_version.version_number, 3);
  assert.equal(restored.canvas.current_version.restored_from_version_id, version1.id);

  const storedVersion = await queryOne('SELECT snapshot_path FROM agent_canvas_versions WHERE id=$1', [version1.id]);
  assert.equal(existsSync(storedVersion.snapshot_path), true);
  const purged = await purgeSessionCanvases(ctx, { userId, sessionId });
  assert.equal(purged.canvas_count, 1);
  assert.equal(existsSync(storedVersion.snapshot_path), false);
});

test('native product tools create and update Site with Site host events and HTML artifacts', async (t) => {
  const userId = `site-tool-user-${randomUUID()}`;
  const sessionId = randomUUID();
  const ctx = context(userId);
  const recorded = [];

  t.after(async () => {
    await purgeSessionCanvases(ctx, { userId, sessionId }).catch(() => undefined);
    await query('DELETE FROM sessions WHERE id=$1', [sessionId]).catch(() => undefined);
  });

  await query(
    `INSERT INTO sessions
      (id,project_id,created_by,source_type,source_id,action_type,title,status,created_at,updated_at)
     VALUES ($1,'__chat__',$2,'agent','__chat__','agentic_chat','Site tool test','active',now(),now())`,
    [sessionId, userId],
  );

  const tools = createProductTools({
    db: { query, queryOne },
    user_id: userId,
    project_id: '__chat__',
    session_id: sessionId,
    runtime_turn_id: 'site-turn',
    task_id: 'site-run',
    runtime: { runId: 'site-run', recordArtifact: async (item) => recorded.push(item) },
  });
  const createTool = tools.find((tool) => tool.name === 'canvas_create');
  const inspectTool = tools.find((tool) => tool.name === 'canvas_inspect');
  const editTool = tools.find((tool) => tool.name === 'canvas_edit');
  assert.ok(createTool && inspectTool && editTool);

  const created = await createTool.execute('site-create-call', {
    title: '工具 Site',
    kind: 'site',
    language: 'html',
    content: '<!doctype html><html><body><h1>第一版</h1></body></html>',
  });
  assert.equal(created.isError, undefined, JSON.stringify(created));
  assert.equal(created.details.canvas.kind, 'site');
  assert.equal(created.details.host_actions[0].event.event, 'site_opened');
  assert.equal(recorded[0].mimeType, 'text/html');

  const inspected = await inspectTool.execute('site-inspect-call', { canvas_id: created.details.canvas.id });
  const edited = await editTool.execute('site-edit-call', {
    canvas_id: created.details.canvas.id,
    base_version_id: inspected.details.canvas.current_version.id,
    content: '<!doctype html><html><body><h1>第二版</h1></body></html>',
  });
  assert.equal(edited.details.canvas.content.includes('第二版'), true);
  assert.equal(edited.details.host_actions[0].event.event, 'site_updated');
  assert.deepEqual(recorded.map((item) => item.mimeType), ['text/html', 'text/html']);
});

test('Canvas kind validation accepts only document, code or site', async (t) => {
  const userId = `site-kind-user-${randomUUID()}`;
  const sessionId = randomUUID();
  const ctx = context(userId);
  t.after(async () => {
    await purgeSessionCanvases(ctx, { userId, sessionId }).catch(() => undefined);
    await query('DELETE FROM sessions WHERE id=$1', [sessionId]).catch(() => undefined);
  });
  await query(
    `INSERT INTO sessions
      (id,project_id,created_by,source_type,source_id,action_type,title,status,created_at,updated_at)
     VALUES ($1,'__chat__',$2,'agent','__chat__','agentic_chat','Site validation','active',now(),now())`,
    [sessionId, userId],
  );
  const normalizedSite = await createSessionCanvas(ctx, {
    params: { sid: sessionId },
    body: {
      kind: 'site',
      language: 'javascript',
      content: '<!doctype html><html><head><title>自动页面标题</title></head><body></body></html>',
    },
  });
  assert.equal(normalizedSite.data.canvas.title, '自动页面标题');
  assert.equal(normalizedSite.data.canvas.language, 'html');
  await assert.rejects(
    createSessionCanvas(ctx, { params: { sid: sessionId }, body: { kind: 'website', content: '<p>x</p>' } }),
    /document、code 或 site/,
  );
});
