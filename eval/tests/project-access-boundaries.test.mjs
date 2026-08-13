import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import { createSession } from '../../server/src/app/session/index.js';
import { createAgentAutomation } from '../../server/src/app/agents/automations.js';
import { getProjectRules, updateProjectRules } from '../../server/src/app/agents/index.js';
import { listSkills } from '../../server/src/app/projects/index.js';

const context = (userId) => ({ userId, query, queryOne });

test('project-scoped Agent entrypoints reject a logged-in non-member', async (t) => {
  const projectId = randomUUID();
  const ownerId = `owner-${randomUUID()}`;
  const memberId = `member-${randomUUID()}`;
  const outsiderId = `outsider-${randomUUID()}`;
  const membershipIds = [randomUUID(), randomUUID()];

  t.after(async () => {
    await query('DELETE FROM project_rules WHERE project_id=$1', [projectId]).catch(() => undefined);
    await query('DELETE FROM project_members WHERE project_id=$1', [projectId]).catch(() => undefined);
    await query('DELETE FROM projects WHERE id=$1', [projectId]).catch(() => undefined);
  });
  await query(
    `INSERT INTO projects (id,name,status,created_at,updated_at)
     VALUES ($1,'权限边界测试','active',now(),now())`,
    [projectId],
  );
  await query(
    `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
     VALUES ($1,$3,$4,1,now(),now()),($2,$3,$5,0,now(),now())`,
    [membershipIds[0], membershipIds[1], projectId, ownerId, memberId],
  );

  const outsider = context(outsiderId);
  const denied = (promise) => assert.rejects(promise, (error) => error?.status === 404);
  await denied(listSkills(outsider, { params: { pid: projectId } }));
  await denied(getProjectRules(outsider, { params: { pid: projectId, ruleType: 'query' } }));
  await denied(createSession(outsider, {
    params: { pid: projectId },
    body: { source_type: 'agent', source_id: projectId, action_type: 'agentic_chat' },
  }));
  await denied(createAgentAutomation(outsider, {
    params: { pid: projectId },
    body: { name: '越权任务', prompt: '读取项目文件' },
  }));

  await assert.rejects(
    updateProjectRules(context(memberId), {
      params: { pid: projectId, ruleType: 'query' },
      body: { content: '注入规则', operation: 'replace' },
    }),
    (error) => error?.status === 403,
  );
});

test('turn scope keeps a defensive project membership check', async () => {
  const source = await readFile(
    new URL('../../server/src/app/chat/agent_chat.js', import.meta.url),
    'utf8',
  );
  assert.match(source, /validateTurnScope[\s\S]*requireProjectMember\(ctx, projectId, \{ allowChat: true \}\)/);
});
