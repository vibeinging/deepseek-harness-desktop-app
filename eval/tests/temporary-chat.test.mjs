import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

import { query, queryOne } from '../../server/src/db.js';
import {
  cleanupTemporarySessions,
  createSession,
  deleteSession,
} from '../../server/src/app/session/index.js';
import { createSessionCanvas } from '../../server/src/app/chat/canvases.js';
import { createProjectOfficeDocument } from '../../server/src/app/chat/project_artifacts.js';
import { listAgentSessions } from '../../server/src/app/chat/agent_misc.js';
import {
  disposeTemporaryDshRuntime,
  getTemporaryDshRuntimeLease,
} from '../../server/src/engine/dsh_runtime/temporary_runtime.js';

function context(userId) {
  return { userId, query, queryOne };
}

async function createTemporary(ctx, projectId = '__chat__') {
  return createSession(ctx, {
    params: { pid: projectId },
    body: {
      title: '不会保存的内容',
      source_type: 'agent',
      source_id: projectId,
      action_type: 'agentic_chat',
      temporary: true,
    },
  });
}

test('temporary chat is hidden from history and hard-purged on exit', async () => {
  const userId = `temporary-user-${randomUUID()}`;
  const ctx = context(userId);
  const created = await createTemporary(ctx);
  const sessionId = created.data.id;
  const runId = randomUUID();

  assert.equal(created.data.temporary, true);
  assert.equal(created.data.action_type, 'temporary_chat');
  assert.deepEqual(JSON.parse(created.data.session_config), { temporary: true });

  await query(
    `INSERT INTO session_messages
       (id,session_id,role,content_items,sequence_number,created_at,updated_at)
     VALUES ($1,$2,'user',$3,1,now(),now())`,
    [randomUUID(), sessionId, JSON.stringify([{ type: 'text', content: 'sensitive' }])],
  );
  await query(
    `INSERT INTO agent_runs
       (id,session_id,project_id,user_id,status,mode,created_at,updated_at)
     VALUES ($1,$2,'__chat__',$3,'completed','temporary',now(),now())`,
    [runId, sessionId, userId],
  );
  await query(
    `INSERT INTO llm_call_logs
       (id,project_id,session_id,user_id,call_site,created_at,updated_at)
     VALUES ($1,'__chat__',$2,$3,'temporary-test',now(),now())`,
    [randomUUID(), sessionId, userId],
  );
  const canvasResponse = await createSessionCanvas(ctx, {
    params: { sid: sessionId },
    body: { title: '临时草稿', kind: 'document', content: '关闭临时对话后必须清理' },
  });
  const canvasId = canvasResponse.data.canvas.id;
  const canvasVersion = await queryOne(
    'SELECT snapshot_path FROM agent_canvas_versions WHERE canvas_id=$1',
    [canvasId],
  );
  assert.equal((await stat(canvasVersion.snapshot_path)).isFile(), true);

  await assert.rejects(
    createProjectOfficeDocument(ctx, {
      params: { pid: '__chat__' },
      body: { format: 'markdown', title: '不能保存', session_id: sessionId },
    }),
    /临时聊天不会保存到 Library/,
  );
  await assert.rejects(
    createProjectOfficeDocument(ctx, {
      params: { pid: '__chat__' },
      body: { format: 'markdown', title: '不能保存', temporary: true },
    }),
    /临时聊天不会保存到 Library/,
  );

  const history = await listAgentSessions(ctx, { params: { pid: '__chat__' }, query: {} });
  assert.equal(history.data.items.some((item) => item.id === sessionId), false);

  const removed = await deleteSession(ctx, { params: { pid: '__chat__', sid: sessionId } });
  assert.equal(removed.data.temporary, true);
  assert.equal(removed.data.purged, true);
  assert.equal(await queryOne('SELECT id FROM sessions WHERE id=$1', [sessionId]), null);
  assert.equal(await queryOne('SELECT id FROM session_messages WHERE session_id=$1', [sessionId]), null);
  assert.equal(await queryOne('SELECT id FROM agent_runs WHERE session_id=$1', [sessionId]), null);
  assert.equal(await queryOne('SELECT id FROM llm_call_logs WHERE session_id=$1', [sessionId]), null);
  assert.equal(await queryOne('SELECT id FROM agent_canvases WHERE id=$1', [canvasId]), null);
  assert.equal(await queryOne('SELECT id FROM agent_canvas_versions WHERE canvas_id=$1', [canvasId]), null);
  await assert.rejects(stat(canvasVersion.snapshot_path), (error) => error?.code === 'ENOENT');
});

test('startup cleanup removes temporary chats left by a forced shutdown', async () => {
  const userId = `temporary-cleanup-${randomUUID()}`;
  const ctx = context(userId);
  const first = await createTemporary(ctx);
  const second = await createTemporary(ctx);

  const result = await cleanupTemporarySessions(ctx);
  assert.equal(result.data.cleaned_sessions, 2);
  assert.equal(await queryOne('SELECT id FROM sessions WHERE id=$1', [first.data.id]), null);
  assert.equal(await queryOne('SELECT id FROM sessions WHERE id=$1', [second.data.id]), null);
});

test('temporary chat uses an ephemeral runtime and skips durable message projection', async () => {
  const [workspaceAgent, temporaryRuntime, desktopPatch, agentChat, runCenter, conversation, shell, artifacts, files] = await Promise.all([
    readFile(new URL('../../server/src/engine/agents/workspace_agent.js', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/engine/dsh_runtime/temporary_runtime.js', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/engine/dsh_runtime/desktop_web.patch.yml', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/app/chat/agent_chat.js', import.meta.url), 'utf8'),
    readFile(new URL('../../server/src/app/agents/run_center.js', import.meta.url), 'utf8'),
    readFile(new URL('../../renderer/src/views/agent/AgentConversation.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../renderer/src/views/agent/AgentShell.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../renderer/src/views/agent/WorkspaceArtifactsSection.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../renderer/src/views/agent/WorkspaceFilesSection.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(workspaceAgent, /temporary \? getTemporaryDshRuntimeLease\(sessionId\) : null/);
  assert.match(temporaryRuntime, /DSH_RUNTIME_SESSION_ROOT/);
  assert.match(temporaryRuntime, /DSH_RUNTIME_STORAGE_ROOT/);
  assert.match(temporaryRuntime, /DSH_DESKTOP_WEB_PORT:\s*["']0["']/);
  assert.match(desktopPatch, /DSH_DESKTOP_WEB_PORT/);
  assert.match(desktopPatch, /process\.env\.DSH_RUNTIME_SESSION_ROOT \|\| dshHomePath\('sessions'\)/);
  assert.match(desktopPatch, /process\.env\.DSH_RUNTIME_STORAGE_ROOT \|\| dshHomePath\('storages'\)/);
  assert.match(
    agentChat,
    /persistAgentTurnBeforeRunTerminal\(\{[\s\S]*persist:\s*\(\)\s*=>\s*temporary\s*\?\s*Promise\.resolve\(\{ ok: true, skipped: true \}\)/,
  );
  assert.match(agentChat, /sessionId:\s*temporary \? null : sessionId/);
  assert.match(runCenter, /NOT IN \('subtask','temporary'\)/);
  assert.match(conversation, /这段对话不会出现在历史记录中，也不会读取或写入任何对话记忆/);
  assert.doesNotMatch(conversation, /persistConversationInputQueue/);
  assert.match(
    conversation,
    /if \(temporary \|\| !selectedId\) \{[\s\S]*applyDshQueueSnapshot\(null\)/,
  );
  assert.match(shell, /<WorkspaceArtifactsSection[\s\S]*temporary=\{temporaryMode\}/);
  assert.match(shell, /<WorkspaceFilesSection[\s\S]*temporary=\{temporaryMode\}/);
  assert.match(artifacts, /!temporary && officeFormat/);
  assert.match(artifacts, /!temporary && \(/);
  assert.match(files, /preview\.scope === 'project' && !temporary/);
});

test('temporary DSH lease uses isolated roots and deletes them on disposal', async () => {
  const sessionId = `temporary-dsh-${randomUUID()}`;
  const lease = getTemporaryDshRuntimeLease(sessionId);
  assert.notEqual(lease.client.env.DSH_RUNTIME_SESSION_ROOT, lease.client.env.DSH_RUNTIME_STORAGE_ROOT);
  assert.match(lease.client.env.DSH_RUNTIME_SESSION_ROOT, /temporary-dsh/);
  assert.match(lease.client.env.DSH_RUNTIME_STORAGE_ROOT, /temporary-dsh/);
  await disposeTemporaryDshRuntime(sessionId);
  await assert.rejects(stat(lease.root), (error) => error?.code === 'ENOENT');
});
