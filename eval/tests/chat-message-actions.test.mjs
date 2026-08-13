import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { query, queryOne } from '../../server/src/db.js';
import { dataPath } from '../../server/src/config/paths.js';
import { branchAgentMessage } from '../../server/src/app/chat/message_actions.js';
import { chatRoutes } from '../../server/src/transport/registry.chat.js';

function context(userId, queryFn = query) {
  return { userId, query: queryFn, queryOne };
}

async function insertMessage(sessionId, id, role, sequence, items, metadata = {}) {
  await query(
    `INSERT INTO session_messages
       (id,session_id,role,content_items,message_metadata,sequence_number,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,now(),now())`,
    [id, sessionId, role, JSON.stringify(items), JSON.stringify(metadata), sequence],
  );
}

test('legacy non-DSH message branches are rejected without changing the source conversation', async () => {
  const userId = `message-actions-user-${randomUUID()}`;
  const sourceSessionId = randomUUID();
  const sourceThreadId = `thread-${randomUUID()}`;
  const ids = {
    user1: randomUUID(),
    assistant1: randomUUID(),
    user2: randomUUID(),
    assistant2: randomUUID(),
  };
  const attachmentRoot = dataPath('attachments', '__chat__', sourceSessionId);
  const workspaceRoot = dataPath('projects', '__chat__', sourceSessionId);
  const attachmentPath = join(attachmentRoot, 'photo.png');
  mkdirSync(attachmentRoot, { recursive: true });
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(attachmentPath, 'image-bytes');
  writeFileSync(join(workspaceRoot, 'notes.txt'), 'branch workspace');
  const createdSessionIds = [];

  await query(
    `INSERT INTO sessions
       (id,project_id,created_by,source_type,source_id,action_type,title,status,message_count,session_config,created_at,updated_at)
     VALUES ($1,'__chat__',$2,'agent','__chat__','agentic_chat','原对话','active',4,$3,now(),now())`,
    [sourceSessionId, userId, JSON.stringify({ agent_runtime_thread_id: sourceThreadId })],
  );
  await insertMessage(sourceSessionId, ids.user1, 'user', 1, [{ type: 'text', content: '第一问' }], {
    turn_input: [{ type: 'text', text: '第一问' }],
    turn_request: { model: 'model-a', approvalMode: 'ask', searchMode: 'auto', skills: [] },
  });
  await insertMessage(sourceSessionId, ids.assistant1, 'assistant', 2, [{ type: 'markdown', content: '第一答' }], {
    runtime_thread_id: sourceThreadId,
    turn_id: 'turn-1',
    turn_status: 'completed',
  });
  await insertMessage(sourceSessionId, ids.user2, 'user', 3, [
    { type: 'attachment', content: 'photo.png', metadata: { path: attachmentPath, name: 'photo.png', mime_type: 'image/png' } },
    { type: 'text', content: '第二问' },
  ], {
    runtime_thread_id: sourceThreadId,
    turn_id: 'turn-2',
    turn_input: [{ type: 'text', text: '第二问' }, { type: 'localImage', path: attachmentPath }],
    turn_request: {
      model: 'model-b',
      effort: 'high',
      approvalMode: 'auto',
      searchMode: 'required',
      skills: ['imagegen'],
      plugins: ['sample-plugin'],
    },
  });
  await insertMessage(sourceSessionId, ids.assistant2, 'assistant', 4, [{ type: 'markdown', content: '第二答' }], {
    runtime_thread_id: sourceThreadId,
    turn_id: 'turn-2',
    turn_status: 'completed',
  });

  try {
    const route = chatRoutes.find((item) =>
      item.m === 'POST' && item.p === '/api/agent/projects/:pid/sessions/:sid/messages/:mid/branch');
    assert.equal(route?.fn, branchAgentMessage);
    assert.equal(route?.auth, true);

    await assert.rejects(branchAgentMessage(context(userId), {
      params: { pid: '__chat__', sid: sourceSessionId, mid: ids.assistant1 },
      body: { mode: 'branch' },
    }), (error) => error?.status === 409 && /未绑定 DSH Session/.test(error.message));

    const sourceRows = await query('SELECT id FROM session_messages WHERE session_id=$1 ORDER BY sequence_number', [sourceSessionId]);
    assert.deepEqual(sourceRows.map((row) => row.id), [ids.user1, ids.assistant1, ids.user2, ids.assistant2]);
    assert.equal(existsSync(attachmentPath), true);
  } finally {
    for (const sessionId of createdSessionIds) {
      await query('DELETE FROM session_messages WHERE session_id=$1', [sessionId]);
      await query('DELETE FROM sessions WHERE id=$1', [sessionId]);
      rmSync(dataPath('attachments', '__chat__', sessionId), { recursive: true, force: true });
      rmSync(dataPath('projects', '__chat__', sessionId), { recursive: true, force: true });
    }
    await query('DELETE FROM session_messages WHERE session_id=$1', [sourceSessionId]);
    await query('DELETE FROM sessions WHERE id=$1', [sourceSessionId]);
    rmSync(attachmentRoot, { recursive: true, force: true });
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('message branching blocks active runs before rejecting the legacy non-DSH fallback', async () => {
  const userId = `message-actions-rollback-user-${randomUUID()}`;
  const sourceSessionId = randomUUID();
  const sourceThreadId = `thread-${randomUUID()}`;
  const userMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  const attachmentRoot = dataPath('attachments', '__chat__', sourceSessionId);
  const attachmentPath = join(attachmentRoot, 'source.txt');
  const runId = randomUUID();
  mkdirSync(attachmentRoot, { recursive: true });
  writeFileSync(attachmentPath, 'keep-source');

  await query(
    `INSERT INTO sessions
       (id,project_id,created_by,source_type,source_id,action_type,title,status,message_count,session_config,created_at,updated_at)
     VALUES ($1,'__chat__',$2,'agent','__chat__','agentic_chat','回收测试','active',2,$3,now(),now())`,
    [sourceSessionId, userId, JSON.stringify({ agent_runtime_thread_id: sourceThreadId })],
  );
  await insertMessage(sourceSessionId, userMessageId, 'user', 1, [{ type: 'text', content: '问题' }], {
    turn_request: { model: 'model-rollback' },
  });
  await insertMessage(sourceSessionId, assistantMessageId, 'assistant', 2, [{ type: 'text', content: '回答' }], {
    runtime_thread_id: sourceThreadId,
    turn_id: 'turn-rollback',
    turn_status: 'completed',
  });

  try {
    await query(
      `INSERT INTO agent_runs
         (id,session_id,project_id,user_id,turn_id,status,created_at,updated_at)
       VALUES ($1,$2,'__chat__',$3,'active-turn','running',now(),now())`,
      [runId, sourceSessionId, userId],
    );
    await assert.rejects(
      branchAgentMessage(context(userId), {
        params: { pid: '__chat__', sid: sourceSessionId, mid: assistantMessageId },
        body: { mode: 'branch' },
      }),
      /对话仍在运行/,
    );
    await query('DELETE FROM agent_runs WHERE id=$1', [runId]);

    await assert.rejects(
      branchAgentMessage(context(userId), {
        params: { pid: '__chat__', sid: sourceSessionId, mid: assistantMessageId },
        body: { mode: 'branch' },
      }),
      /未绑定 DSH Session/,
    );
    assert.equal(readFileSync(attachmentPath, 'utf8'), 'keep-source');
  } finally {
    await query('DELETE FROM agent_runs WHERE id=$1', [runId]);
    await query('DELETE FROM session_messages WHERE session_id=$1', [sourceSessionId]);
    await query('DELETE FROM sessions WHERE id=$1', [sourceSessionId]);
    rmSync(attachmentRoot, { recursive: true, force: true });
  }
});

test('DSH message branching forks the authoritative session at the completed turn seq', async () => {
  const userId = `dsh-message-actions-user-${randomUUID()}`;
  const sourceSessionId = randomUUID();
  const dshSessionId = `dsh-source-${randomUUID()}`;
  const createdSessionIds = [];
  const sourceEvents = [
    { event: { seq: 0, type: 'user/message', time: 1000, data: { content: [{ type: 'text', text: '第一问' }], source: { kind: 'user' } } } },
    { event: { seq: 1, type: 'turn/start', time: 1001, data: { turn: 1 } } },
    { event: { seq: 2, type: 'assistant/message', time: 1002, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: '第一答' }] } } } },
    { event: { seq: 3, type: 'turn/end', time: 1003, data: { turn: 1, reason: { kind: 'completed' } } } },
    { event: { seq: 4, type: 'user/message', time: 1004, data: { content: [{ type: 'text', text: '第二问' }], source: { kind: 'user' } } } },
    { event: { seq: 5, type: 'turn/start', time: 1005, data: { turn: 2 } } },
    { event: { seq: 6, type: 'assistant/message', time: 1006, data: { turn: 2, step: 1, message: { content: [{ type: 'text', text: '第二答' }] } } } },
    { event: { seq: 7, type: 'turn/end', time: 1007, data: { turn: 2, reason: { kind: 'completed' } } } },
  ];
  const calls = [];
  const dshClient = {
    start: async () => {},
    request: async (method, payload) => {
      calls.push({ method, payload });
      if (method === 'workspace.create') return { workspace: { workspaceId: 'workspace-1', path: payload.path } };
      if (method === 'session.create') return { sessionId: payload.sessionId || 'dsh-created' };
      if (method === 'session.history') {
        const events = payload.sessionId === dshSessionId ? sourceEvents : sourceEvents.slice(0, 4);
        return { events, hasMore: false, projections: { asOfSeq: events.at(-1)?.event.seq ?? -1, values: {} } };
      }
      if (method === 'session.fork') return { sessionId: 'dsh-forked' };
      if (method === 'session.rename') return { title: payload.title, seq: 4 };
      if (method === 'workspace.archiveSession') return { archivedSessionIds: [payload.sessionId] };
      throw new Error(`unexpected ${method}`);
    },
  };

  await query(
    `INSERT INTO sessions
       (id,project_id,created_by,source_type,source_id,action_type,title,status,message_count,session_config,created_at,updated_at)
     VALUES ($1,'__chat__',$2,'agent','__chat__','agentic_chat','DSH 原对话','active',4,$3,now(),now())`,
    [sourceSessionId, userId, JSON.stringify({ runtime_backend: 'dsh', dsh_runtime_session_id: dshSessionId, dsh_runtime_cwd: '/repo' })],
  );
  await insertMessage(sourceSessionId, randomUUID(), 'user', 1, [{ type: 'text', content: '第一问' }], { turn_request: { model: 'model-a' } });
  await insertMessage(sourceSessionId, randomUUID(), 'assistant', 2, [{ type: 'markdown', content: '第一答' }], { turn_status: 'completed' });
  await insertMessage(sourceSessionId, randomUUID(), 'user', 3, [{ type: 'text', content: '第二问' }], { turn_request: { model: 'model-a' } });
  await insertMessage(sourceSessionId, randomUUID(), 'assistant', 4, [{ type: 'markdown', content: '第二答' }], { turn_status: 'completed' });

  try {
    const result = await branchAgentMessage(context(userId), {
      params: { pid: '__chat__', sid: sourceSessionId, mid: `dsh:${dshSessionId}:turn:1` },
      body: { mode: 'branch' },
    }, { dshClient });
    createdSessionIds.push(result.data.session.id);
    assert.equal(result.data.runtime_thread_id, 'dsh-forked');
    assert.equal(result.data.messages.length, 2);
    const forkCall = calls.find((call) => call.method === 'session.fork');
    assert.deepEqual(forkCall.payload, { sessionId: dshSessionId, atSeq: 3 });
    const stored = await queryOne('SELECT session_config FROM sessions WHERE id=$1', [result.data.session.id]);
    const config = typeof stored.session_config === 'string' ? JSON.parse(stored.session_config) : stored.session_config;
    assert.equal(config.dsh_runtime_session_id, 'dsh-forked');
    assert.equal(config.dsh_runtime_cwd, '/repo');
  } finally {
    for (const id of createdSessionIds) {
      await query('DELETE FROM session_messages WHERE session_id=$1', [id]);
      await query('DELETE FROM sessions WHERE id=$1', [id]);
      rmSync(dataPath('attachments', '__chat__', id), { recursive: true, force: true });
      rmSync(dataPath('projects', '__chat__', id), { recursive: true, force: true });
    }
    await query('DELETE FROM session_messages WHERE session_id=$1', [sourceSessionId]);
    await query('DELETE FROM sessions WHERE id=$1', [sourceSessionId]);
  }
});
