import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { query, queryOne } from '../../server/src/db.js';
import { getAgentFiles } from '../../server/src/app/chat/agent_misc.js';
import {
  searchAgentFiles,
  searchFileContentsWithRipgrep,
  searchFileNamesLocally,
  resolveDshWorkRipgrep,
} from '../../server/src/app/chat/file_search.js';
import { chatRoutes } from '../../server/src/transport/registry.chat.js';

function context(userId) {
  return { userId, query, queryOne };
}

test('dsh-work local name search and packaged rg content search stay inside visible project files', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'file-search-root-'));
  const root = join(parent, 'root');
  const outside = join(parent, 'outside');
  t.after(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(root, 'plans'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'launch-package'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, 'plans', 'launch-roadmap.md'), '正文包含唯一词：星舰交付');
  await writeFile(join(root, 'plans', '.launch-secret.md'), '隐藏文件');
  await writeFile(join(root, 'node_modules', 'launch-package', 'index.js'), '跳过依赖目录');
  await writeFile(join(outside, 'launch-outside.txt'), '不能越界');
  await symlink(outside, join(root, 'launch-link')).catch(() => undefined);

  const projectRoot = {
    id: 'source-1',
    name: '项目目录',
    path: root,
    kind: 'source_folder',
    project_id: 'project-1',
    project_name: '发射项目',
  };
  const canonicalRoot = await realpath(root);
  const groups = [{ path: canonicalRoot, roots: [projectRoot] }];
  const native = await searchFileNamesLocally({ groups, query: 'launch' });

  assert.deepEqual(native.items.map((item) => item.path), ['plans/launch-roadmap.md']);
  assert.equal(native.items[0].file_kind, 'document');
  assert.equal(native.items[0].root_id, 'source-1');
  assert.equal(native.items[0].project_id, 'project-1');
  assert.equal(native.items[0].match_type, 'name');

  const content = await searchFileContentsWithRipgrep({
    binary: await resolveDshWorkRipgrep(),
    groups,
    query: '星舰交付',
    cancellationKey: 'file-search-unit',
  });
  assert.deepEqual(content.items.map((item) => item.path), ['plans/launch-roadmap.md']);
  assert.equal(content.items[0].match_type, 'content');
  assert.equal(content.items[0].line_number, 1);
  assert.match(content.items[0].snippet, /星舰交付/);
});

test('global file search returns only authorized project files and openable latest-run artifacts', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'file-search-api-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const sourceRoot = join(parent, 'source');
  const otherSourceRoot = join(parent, 'other-source');
  const runRoot = join(parent, 'run');
  const temporaryRunRoot = join(parent, 'temporary-run');
  const otherRunRoot = join(parent, 'other-run');
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(join(sourceRoot, 'nested'), { recursive: true }),
    mkdir(otherSourceRoot, { recursive: true }),
    mkdir(join(runRoot, 'work'), { recursive: true }),
    mkdir(join(runRoot, 'artifacts'), { recursive: true }),
    mkdir(join(temporaryRunRoot, 'artifacts'), { recursive: true }),
    mkdir(join(otherRunRoot, 'artifacts'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(sourceRoot, 'orion-roadmap.md'), '项目文件'),
    writeFile(join(sourceRoot, 'nested', 'detail.txt'), '分层目录文件'),
    writeFile(join(otherSourceRoot, 'orion-other-project.md'), '无权限项目'),
    writeFile(join(runRoot, 'work', 'orion-notes.txt'), '本轮文件'),
    writeFile(join(runRoot, 'artifacts', 'orion-chart.png'), '本轮产物'),
    writeFile(join(temporaryRunRoot, 'artifacts', 'orion-temporary-secret.txt'), '临时聊天'),
    writeFile(join(otherRunRoot, 'artifacts', 'orion-foreign.txt'), '其他用户'),
  ]);

  const userId = `file-search-user-${randomUUID()}`;
  const otherUserId = `file-search-other-${randomUUID()}`;
  const projectId = `file-search-project-${randomUUID()}`;
  const otherProjectId = `file-search-project-${randomUUID()}`;
  const sessionId = randomUUID();
  const temporarySessionId = randomUUID();
  const otherSessionId = randomUUID();
  const runIds = [randomUUID(), randomUUID(), randomUUID()];
  const memberIds = [randomUUID(), randomUUID()];
  const sourceIds = [randomUUID(), randomUUID()];
  const ctx = context(userId);

  try {
    await query(
      `INSERT INTO projects (id,name,status,created_at,updated_at)
       VALUES ($1,'猎户项目','active',now(),now()),($2,'无权限项目','active',now(),now())`,
      [projectId, otherProjectId],
    );
    await query(
      `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
       VALUES ($1,$2,$3,1,now(),now()),($4,$5,$6,1,now(),now())`,
      [memberIds[0], projectId, userId, memberIds[1], otherProjectId, otherUserId],
    );
    await query(
      `INSERT INTO project_source_folders
         (id,project_id,local_path,display_name,sort_order,created_at,updated_at)
       VALUES ($1,$2,$3,'项目资料',0,now(),now()),($4,$5,$6,'其他资料',0,now(),now())`,
      [sourceIds[0], projectId, sourceRoot, sourceIds[1], otherProjectId, otherSourceRoot],
    );
    await query(
      `INSERT INTO sessions
         (id,project_id,created_by,source_type,source_id,action_type,title,status,created_at,updated_at)
       VALUES
         ($1,$2,$3,'agent',$2,'agentic_chat','猎户交付','active',now(),now()),
         ($4,$2,$3,'agent',$2,'temporary_chat','临时聊天','active',now(),now()),
         ($5,$6,$7,'agent',$6,'agentic_chat','其他用户','active',now(),now())`,
      [sessionId, projectId, userId, temporarySessionId, otherSessionId, otherProjectId, otherUserId],
    );
    await query(
      `INSERT INTO agent_runs
         (id,session_id,project_id,user_id,status,mode,workspace_path,created_at,updated_at)
       VALUES
         ($1,$2,$3,$4,'completed','agent',$5,now(),now()),
         ($6,$7,$3,$4,'completed','temporary',$8,now(),now()),
         ($9,$10,$11,$12,'completed','agent',$13,now(),now())`,
      [
        runIds[0], sessionId, projectId, userId, runRoot,
        runIds[1], temporarySessionId, temporaryRunRoot,
        runIds[2], otherSessionId, otherProjectId, otherUserId, otherRunRoot,
      ],
    );

    const response = await searchAgentFiles(ctx, { query: { q: 'orion', limit: '20' } });
    const names = response.data.items.map((item) => item.name).sort();
    assert.deepEqual(names, ['orion-chart.png', 'orion-notes.txt', 'orion-roadmap.md']);
    assert.equal(response.data.items.every((item) => item.project_id === projectId), true);
    assert.equal(response.data.items.some((item) => item.root_kind === 'run_artifacts' && item.file_kind === 'image'), true);
    assert.equal(response.data.items.some((item) => item.root_kind === 'run_work'), true);
    assert.equal(response.data.items.some((item) => item.root_kind === 'source_folder' && item.session_id === null), true);
    assert.deepEqual(response.data.engines, { name: 'dsh_work_local', content: 'dsh_packaged_ripgrep' });

    const imagesOnly = await searchAgentFiles(ctx, {
      query: { q: 'orion', project_id: projectId, session_id: sessionId, file_kinds: 'image', limit: '20' },
    });
    assert.deepEqual(imagesOnly.data.items.map((item) => item.name), ['orion-chart.png']);

    const futureOnly = await searchAgentFiles(ctx, {
      query: { q: 'orion', since: '2999-01-01T00:00:00.000Z', limit: '20' },
    });
    assert.deepEqual(futureOnly.data.items, []);

    const panel = await getAgentFiles(ctx, { params: { pid: projectId }, query: { session_id: sessionId } });
    const panelRootIds = panel.data.roots.map((root) => root.id);
    assert.equal(panelRootIds.includes('run-work'), true);
    assert.equal(panelRootIds.includes('run-artifacts'), true);
    for (const item of response.data.items) {
      if (item.session_id === sessionId) assert.equal(panelRootIds.includes(item.root_id), true);
    }
    const sourcePanelRoot = panel.data.roots.find((root) => root.id === sourceIds[0]);
    const nested = sourcePanelRoot.tree.find((item) => item.path === 'nested');
    assert.equal(nested.type, 'dir');
    assert.equal(nested.loaded, false);
    assert.deepEqual(nested.children, []);

    const nestedChildren = await getAgentFiles(ctx, {
      params: { pid: projectId },
      query: { session_id: sessionId, root_id: sourceIds[0], path: 'nested' },
    });
    assert.deepEqual(nestedChildren.data.items.map((item) => item.path), ['nested/detail.txt']);

    await query('UPDATE projects SET deleted_at=now() WHERE id=$1', [projectId]);
    const afterProjectDeletion = await searchAgentFiles(ctx, { query: { q: 'orion', limit: '20' } });
    assert.deepEqual(afterProjectDeletion.data.items, []);

    const empty = await searchAgentFiles(ctx, { query: { q: '   ' } });
    assert.deepEqual(empty.data.items, []);

    const route = chatRoutes.find((item) => item.m === 'GET' && item.p === '/api/agent/search/files');
    assert.equal(route?.fn, searchAgentFiles);
    assert.equal(route?.auth, true);
  } finally {
    await query('DELETE FROM agent_runs WHERE id = ANY($1::text[])', [runIds]);
    await query('DELETE FROM sessions WHERE id = ANY($1::text[])', [[sessionId, temporarySessionId, otherSessionId]]);
    await query('DELETE FROM project_source_folders WHERE id = ANY($1::text[])', [sourceIds]);
    await query('DELETE FROM project_members WHERE id = ANY($1::text[])', [memberIds]);
    await query('DELETE FROM projects WHERE id = ANY($1::text[])', [[projectId, otherProjectId]]);
  }
});
