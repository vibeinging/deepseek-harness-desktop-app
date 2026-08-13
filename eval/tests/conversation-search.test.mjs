import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { query, queryOne } from '../../server/src/db.js';
import {
  buildConversationSearchSnippet,
  extractConversationSearchText,
  extractWebSources,
  searchAgentConversations,
  searchAgentWebSources,
} from '../../server/src/app/chat/agent_misc.js';
import { chatRoutes } from '../../server/src/transport/registry.chat.js';

function context(userId) {
  return { userId, query, queryOne };
}

test('conversation search text contains visible messages but not reasoning or tool payloads', () => {
  const text = extractConversationSearchText([
    { type: 'text', content: '用户可见内容' },
    { type: 'markdown', content: '助手可见内容' },
    { type: 'agentMessage', content: '最终回答' },
    { type: 'text', content: '内部推理', metadata: { display: false } },
    { type: 'tool', content: '工具返回值' },
  ]);

  assert.match(text, /用户可见内容/);
  assert.match(text, /助手可见内容/);
  assert.match(text, /最终回答/);
  assert.doesNotMatch(text, /内部推理/);
  assert.doesNotMatch(text, /工具返回值/);

  const snippet = buildConversationSearchSnippet(`${'前文'.repeat(50)}火星计划${'后文'.repeat(50)}`, '火星计划', 80);
  assert.match(snippet, /火星计划/);
  assert.ok(snippet.length <= 82);
  assert.match(snippet, /^…/);
  assert.match(snippet, /…$/);

  const route = chatRoutes.find((item) => item.m === 'GET' && item.p === '/api/agent/search/conversations');
  assert.equal(route?.fn, searchAgentConversations);
  assert.equal(route?.auth, true);

  const sources = extractWebSources([{
    type: 'web_sources',
    content: JSON.stringify({ sources: [{ source_id: 'S1', url: 'https://example.com/mars', title: '火星日报' }] }),
  }]);
  assert.deepEqual(sources.map((source) => source.title), ['火星日报']);
});

test('conversation search finds archived visible text and titles without leaking temporary or foreign chats', async () => {
  const userId = `conversation-search-user-${randomUUID()}`;
  const otherUserId = `conversation-search-other-${randomUUID()}`;
  const projectId = `conversation-search-project-${randomUUID()}`;
  const memberId = randomUUID();
  const sessionIds = {
    visible: randomUUID(),
    title: randomUUID(),
    temporary: randomUUID(),
    foreign: randomUUID(),
    reasoning: randomUUID(),
    tool: randomUUID(),
    web: randomUUID(),
  };
  const allSessionIds = Object.values(sessionIds);

  const insertSession = async ({ id, owner = userId, project = '__chat__', title, actionType = 'agentic_chat', status = 'active' }) => {
    await query(
      `INSERT INTO sessions
         (id,project_id,created_by,source_type,source_id,action_type,title,status,message_count,created_at,updated_at)
       VALUES ($1,$2,$3,'agent',$2,$4,$5,$6,1,now(),now())`,
      [id, project, owner, actionType, title, status],
    );
  };
  const insertMessage = async (sessionId, items, role = 'assistant') => {
    await query(
      `INSERT INTO session_messages
         (id,session_id,role,content_items,sequence_number,created_at,updated_at)
       VALUES ($1,$2,$3,$4,1,now(),now())`,
      [randomUUID(), sessionId, role, JSON.stringify(items)],
    );
  };

  try {
    await query(
      `INSERT INTO projects (id,name,status,created_at,updated_at)
       VALUES ($1,'发射项目','active',now(),now())`,
      [projectId],
    );
    await query(
      `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
       VALUES ($1,$2,$3,1,now(),now())`,
      [memberId, projectId, userId],
    );

    await insertSession({ id: sessionIds.visible, title: '交付记录', status: 'archived' });
    await insertMessage(sessionIds.visible, [{ type: 'markdown', content: '这里保存了火星计划的交付清单。' }]);

    await insertSession({ id: sessionIds.title, project: projectId, title: '火星会议' });
    await insertMessage(sessionIds.title, [{ type: 'text', content: '标题命中即可找到。' }], 'user');

    await insertSession({ id: sessionIds.temporary, title: '临时内容', actionType: 'temporary_chat' });
    await insertMessage(sessionIds.temporary, [{ type: 'text', content: '火星计划不应保存。' }]);

    await insertSession({ id: sessionIds.foreign, owner: otherUserId, title: '别人的内容' });
    await insertMessage(sessionIds.foreign, [{ type: 'text', content: '别人的火星计划。' }]);

    await insertSession({ id: sessionIds.reasoning, title: '推理内容' });
    await insertMessage(sessionIds.reasoning, [{ type: 'text', content: '隐藏的火星推理。', metadata: { display: false } }]);

    await insertSession({ id: sessionIds.tool, title: '工具内容' });
    await insertMessage(sessionIds.tool, [{ type: 'tool', content: '工具里的火星结果。' }]);

    await insertSession({ id: sessionIds.web, project: projectId, title: '网页调研' });
    await insertMessage(sessionIds.web, [{
      type: 'web_sources',
      content: JSON.stringify({
        sources: [{
          source_id: 'S1',
          url: 'https://example.com/mars',
          canonical_url: 'https://example.com/mars',
          title: '火星日报',
          site_name: 'Example',
          excerpt: '火星发射窗口研究',
          accessed_at: '2026-08-01T00:00:00.000Z',
        }],
      }),
    }]);

    const result = await searchAgentConversations(context(userId), { query: { q: '火星', limit: '20' } });
    assert.deepEqual(result.data.items.map((item) => item.session_id), [sessionIds.title, sessionIds.visible]);

    const titleMatch = result.data.items[0];
    assert.equal(titleMatch.project_id, projectId);
    assert.equal(titleMatch.project_name, '发射项目');
    assert.equal(titleMatch.match_type, 'title');

    const bodyMatch = result.data.items[1];
    assert.equal(bodyMatch.status, 'archived');
    assert.equal(bodyMatch.match_type, 'message');
    assert.equal(bodyMatch.role, 'assistant');
    assert.match(bodyMatch.snippet, /火星计划/);

    const projectOnly = await searchAgentConversations(context(userId), {
      query: { q: '火星', project_id: projectId, limit: '20' },
    });
    assert.deepEqual(projectOnly.data.items.map((item) => item.session_id), [sessionIds.title]);

    const futureOnly = await searchAgentConversations(context(userId), {
      query: { q: '火星', since: '2999-01-01T00:00:00.000Z', limit: '20' },
    });
    assert.deepEqual(futureOnly.data.items, []);

    const webResult = await searchAgentWebSources(context(userId), {
      query: { q: '发射窗口', project_id: projectId, limit: '20' },
    });
    assert.equal(webResult.data.items.length, 1);
    assert.equal(webResult.data.items[0].title, '火星日报');
    assert.equal(webResult.data.items[0].session_id, sessionIds.web);
    assert.equal(webResult.data.items[0].project_name, '发射项目');

    const webRoute = chatRoutes.find((item) => item.m === 'GET' && item.p === '/api/agent/search/web-sources');
    assert.equal(webRoute?.fn, searchAgentWebSources);
    assert.equal(webRoute?.auth, true);

    const empty = await searchAgentConversations(context(userId), { query: { q: '   ' } });
    assert.deepEqual(empty.data.items, []);
  } finally {
    await query('DELETE FROM session_messages WHERE session_id = ANY($1::text[])', [allSessionIds]);
    await query('DELETE FROM sessions WHERE id = ANY($1::text[])', [allSessionIds]);
    await query('DELETE FROM project_members WHERE id=$1', [memberId]);
    await query('DELETE FROM projects WHERE id=$1', [projectId]);
  }
});
