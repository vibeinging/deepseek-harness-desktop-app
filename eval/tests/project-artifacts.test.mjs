import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import {
  compareProjectArtifact,
  createProjectArtifact,
  getProjectArtifactDetail,
  listProjectArtifacts,
  previewProjectArtifactVersion,
  restoreProjectArtifact,
  searchAgentArtifacts,
} from '../../server/src/app/chat/project_artifacts.js';
import { dataPath } from '../../server/src/config/paths.js';
import { publishProjectArtifact } from '../../server/src/engine/agents/project_artifact_store.js';
import { createProductTools } from '../../server/src/engine/agents/product_tools.js';
import { chatRoutes } from '../../server/src/transport/registry.chat.js';

const context = (userId) => ({ userId, query, queryOne });

test('project artifact library keeps stable identity, trusted Turn provenance, immutable versions, diff, restore and reference paths', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'project-artifacts-'));
  const sourceRoot = join(temp, 'source');
  const outsideRoot = join(temp, 'outside');
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  const reportPath = join(sourceRoot, 'launch-report.md');
  const binaryPath = join(sourceRoot, 'parallel-output.bin');
  const rollbackPath = join(sourceRoot, 'rollback-output.md');
  const storageGuardPath = join(sourceRoot, 'storage-guard.md');
  const outsidePath = join(outsideRoot, 'outside.md');
  await writeFile(reportPath, '# 发射报告\n\n状态：准备中\n');
  await writeFile(binaryPath, Buffer.from([0, 1, 2, 3]));
  await writeFile(rollbackPath, '数据库失败时不能留下半个版本');
  await writeFile(storageGuardPath, '存储目录不能经过符号链接');
  await writeFile(outsidePath, '越权内容');
  await writeFile(join(sourceRoot, '.hidden.md'), '隐藏内容');
  await symlink(outsidePath, join(sourceRoot, 'outside-link.md')).catch(() => undefined);

  const userId = `artifact-user-${randomUUID()}`;
  const otherUserId = `artifact-other-${randomUUID()}`;
  const projectId = `artifact-project-${randomUUID()}`;
  const sourceId = randomUUID();
  const memberId = randomUUID();
  const sessionId = randomUUID();
  const ctx = context(userId);
  const managedProjectRoot = join(dataPath('project_artifacts'), projectId);
  let artifactId = '';

  t.after(async () => {
    await query('DELETE FROM agent_artifacts WHERE run_id=$1', ['artifact-run-v2']).catch(() => undefined);
    await query('DELETE FROM project_artifact_versions WHERE artifact_id IN (SELECT id FROM project_artifacts WHERE project_id=$1)', [projectId]).catch(() => undefined);
    await query('DELETE FROM project_artifacts WHERE project_id=$1', [projectId]).catch(() => undefined);
    await query('DELETE FROM sessions WHERE id=$1', [sessionId]).catch(() => undefined);
    await query('DELETE FROM project_source_folders WHERE id=$1', [sourceId]).catch(() => undefined);
    await query('DELETE FROM project_members WHERE id=$1', [memberId]).catch(() => undefined);
    await query('DELETE FROM projects WHERE id=$1', [projectId]).catch(() => undefined);
    await rm(managedProjectRoot, { recursive: true, force: true }).catch(() => undefined);
    await rm(temp, { recursive: true, force: true });
  });

  await query(
    `INSERT INTO projects (id,name,status,created_at,updated_at)
     VALUES ($1,'星舰交付','active',now(),now())`,
    [projectId],
  );
  await query(
    `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
     VALUES ($1,$2,$3,1,now(),now())`,
    [memberId, projectId, userId],
  );
  await query(
    `INSERT INTO project_source_folders
      (id,project_id,local_path,display_name,sort_order,created_at,updated_at)
     VALUES ($1,$2,$3,'交付资料',0,now(),now())`,
    [sourceId, projectId, sourceRoot],
  );
  await query(
    `INSERT INTO sessions
      (id,project_id,created_by,source_type,source_id,action_type,title,status,created_at,updated_at)
     VALUES ($1,$2,$3,'agent',$2,'agentic_chat','发射准备','active',now(),now())`,
    [sessionId, projectId, userId],
  );

  const first = await createProjectArtifact(ctx, {
    params: { pid: projectId },
    body: {
      root_id: sourceId,
      path: 'launch-report.md',
      session_id: sessionId,
      kind: 'report',
      description: '发射状态报告',
      change_summary: '初稿',
    },
    query: {},
  });
  assert.equal(first.data.created, true);
  assert.equal(first.data.deduplicated, false);
  artifactId = first.data.artifact.id;
  assert.match(artifactId, /^[0-9a-f-]{36}$/);
  assert.equal(first.data.artifact.current_version.version_number, 1);
  assert.equal(first.data.artifact.current_version.source_session_id, sessionId);
  assert.equal(first.data.artifact.current_version.source_turn_id, null);
  assert.equal(await readFile(first.data.artifact.current_version.snapshot_path, 'utf8'), '# 发射报告\n\n状态：准备中\n');
  assert.equal((await stat(first.data.artifact.current_version.snapshot_path)).mode & 0o222, 0, 'managed versions are read-only');

  await writeFile(reportPath, '# 发射报告\n\n状态：可以发射\n负责人：测试组\n');
  const recordedRunArtifacts = [];
  const productTool = createProductTools({
    db: { query, queryOne },
    user_id: userId,
    project_id: projectId,
    session_id: sessionId,
    task_id: 'artifact-run-v2',
    runtime_turn_id: 'native-turn-v2',
    workspace_roots: [sourceRoot],
    runtime: {
      runId: 'artifact-run-v2',
      async recordArtifact(payload) { recordedRunArtifacts.push(payload); },
    },
  }).find((tool) => tool.name === 'artifact_publish');
  assert.ok(productTool, 'artifact_publish is exposed as a product dynamic tool');
  assert.equal(productTool.side_effect, 'write');
  assert.equal(productTool.host_action_capable, true);

  const second = await productTool.execute('artifact-call-v2', {
    path: reportPath,
    artifact_id: artifactId,
    name: '发射状态报告.md',
    kind: 'report',
    change_summary: '确认可以发射',
  });
  assert.equal(second.isError, undefined, JSON.stringify(second));
  assert.equal(second.details.artifact.id, artifactId);
  assert.equal(second.details.artifact.current_version.version_number, 2);
  assert.equal(second.details.artifact.current_version.source_turn_id, 'native-turn-v2');
  assert.equal(second.details.artifact.current_version.source_run_id, 'artifact-run-v2');
  assert.equal(second.details.artifact.current_version.source_tool_call_id, 'artifact-call-v2');
  assert.equal(second.details.host_actions[0].event.event, 'artifact_published');
  assert.equal(recordedRunArtifacts[0].metadata.project_artifact_id, artifactId);

  const duplicate = await productTool.execute('artifact-call-duplicate', {
    path: reportPath,
    artifact_id: artifactId,
  });
  assert.equal(duplicate.details.deduplicated, true);
  assert.equal(duplicate.details.artifact.version_count, 2);

  const listed = await listProjectArtifacts(ctx, { params: { pid: projectId }, query: {} });
  assert.equal(listed.data.items.length, 1);
  assert.equal(listed.data.items[0].id, artifactId);
  assert.equal(listed.data.items[0].current_version.version_number, 2);

  const searched = await searchAgentArtifacts(ctx, { query: { q: '发射状态', project_id: projectId } });
  assert.deepEqual(searched.data.items.map((item) => item.id), [artifactId]);
  const hiddenFromOtherUser = await searchAgentArtifacts(context(otherUserId), { query: { q: '发射状态' } });
  assert.deepEqual(hiddenFromOtherUser.data.items, []);

  const [parallelA, parallelB] = await Promise.all([
    createProjectArtifact(ctx, {
      params: { pid: projectId },
      body: { root_id: sourceId, path: 'parallel-output.bin', session_id: sessionId },
      query: {},
    }),
    createProjectArtifact(ctx, {
      params: { pid: projectId },
      body: { root_id: sourceId, path: 'parallel-output.bin', session_id: sessionId },
      query: {},
    }),
  ]);
  assert.equal(parallelA.data.artifact.id, parallelB.data.artifact.id);
  assert.deepEqual(
    [parallelA.data.created, parallelB.data.created].sort(),
    [false, true],
    'parallel publication creates one stable artifact',
  );
  assert.deepEqual(
    [parallelA.data.deduplicated, parallelB.data.deduplicated].sort(),
    [false, true],
    'the waiter observes and deduplicates the committed version',
  );
  assert.equal(parallelB.data.artifact.version_count, 1);

  await writeFile(binaryPath, Buffer.from([0, 1, 9, 3]));
  const binaryUpdated = await createProjectArtifact(ctx, {
    params: { pid: projectId },
    body: { root_id: sourceId, path: 'parallel-output.bin', session_id: sessionId },
    query: {},
  });
  const binaryDetail = await getProjectArtifactDetail(ctx, {
    params: { pid: projectId, artifactId: binaryUpdated.data.artifact.id },
  });
  const binaryCompared = await compareProjectArtifact(ctx, {
    params: { pid: projectId, artifactId: binaryUpdated.data.artifact.id },
    query: {
      from_version_id: binaryDetail.data.versions[1].id,
      to_version_id: binaryDetail.data.versions[0].id,
    },
  });
  assert.equal(binaryCompared.data.mode, 'binary');
  assert.equal(binaryCompared.data.summary, '二进制内容不同');

  const failingContext = {
    userId,
    query: async (sql, params) => {
      if (/UPDATE\s+project_artifacts\s+SET\s+current_version_id/i.test(sql)) {
        throw new Error('simulated current version update failure');
      }
      return query(sql, params);
    },
    queryOne,
  };
  await assert.rejects(
    createProjectArtifact(failingContext, {
      params: { pid: projectId },
      body: { root_id: sourceId, path: 'rollback-output.md', session_id: sessionId },
      query: {},
    }),
    /simulated current version update failure/,
  );
  const rollbackArtifact = await queryOne(
    "SELECT id FROM project_artifacts WHERE project_id=$1 AND source_locator LIKE '%rollback-output.md' LIMIT 1",
    [projectId],
  );
  const rollbackVersion = await queryOne(
    "SELECT id FROM project_artifact_versions WHERE original_path LIKE '%rollback-output.md' LIMIT 1",
  );
  assert.equal(rollbackArtifact, null, 'failed publication removes the new stable artifact row');
  assert.equal(rollbackVersion, null, 'failed publication removes the already-inserted version row');
  const managedEntries = await readdir(managedProjectRoot, { recursive: true }).catch(() => []);
  assert.equal(managedEntries.some((entry) => String(entry).includes('rollback-output.md')), false);

  const guardedStorageRoot = join(temp, 'guarded-artifact-storage');
  await mkdir(guardedStorageRoot, { recursive: true });
  await symlink(outsideRoot, join(guardedStorageRoot, projectId));
  await assert.rejects(
    publishProjectArtifact({ query, queryOne }, {
      userId,
      projectId,
      sourcePath: storageGuardPath,
      allowedRoots: [sourceRoot],
      storageRoot: guardedStorageRoot,
    }),
    /产物存储目录无效/,
  );
  const guardedArtifact = await queryOne(
    "SELECT id FROM project_artifacts WHERE project_id=$1 AND source_locator LIKE '%storage-guard.md' LIMIT 1",
    [projectId],
  );
  assert.equal(guardedArtifact, null, 'a symlinked managed directory is rejected before database insertion');

  const detail = await getProjectArtifactDetail(ctx, { params: { pid: projectId, artifactId } });
  assert.deepEqual(detail.data.versions.map((version) => version.version_number), [2, 1]);
  const v1 = detail.data.versions.find((version) => version.version_number === 1);
  const v2 = detail.data.versions.find((version) => version.version_number === 2);

  const compared = await compareProjectArtifact(ctx, {
    params: { pid: projectId, artifactId },
    query: { from_version_id: v1.id, to_version_id: v2.id },
  });
  assert.equal(compared.data.mode, 'text');
  assert.match(compared.data.diff, /-状态：准备中/);
  assert.match(compared.data.diff, /\+状态：可以发射/);
  assert.match(compared.data.summary, /新增/);

  const restored = await restoreProjectArtifact(ctx, {
    params: { pid: projectId, artifactId },
    body: { version_id: v1.id, session_id: sessionId, change_summary: '撤回到准备中版本' },
  });
  assert.equal(restored.data.restored, true);
  assert.equal(restored.data.artifact.current_version.version_number, 3);
  assert.equal(restored.data.artifact.current_version.restored_from_version_id, v1.id);
  assert.equal(restored.data.artifact.current_version.sha256, v1.sha256);

  const duplicateRestore = await restoreProjectArtifact(ctx, {
    params: { pid: projectId, artifactId },
    body: { version_id: v1.id, session_id: sessionId },
  });
  assert.equal(duplicateRestore.data.restored, false);
  assert.equal(duplicateRestore.data.deduplicated, true);
  assert.equal(duplicateRestore.data.artifact.version_count, 3);

  const preview = await previewProjectArtifactVersion(ctx, {
    params: {
      pid: projectId,
      artifactId,
      versionId: restored.data.artifact.current_version.id,
    },
  });
  assert.equal(preview.data.preview.can_preview, true);
  assert.match(preview.data.preview.content, /状态：准备中/);
  assert.equal(preview.data.version.snapshot_root, await realpath(join(dataPath('project_artifacts'), projectId, artifactId)));

  await rm(reportPath);
  assert.match(await readFile(restored.data.artifact.current_version.snapshot_path, 'utf8'), /状态：准备中/);

  await assert.rejects(
    createProjectArtifact(ctx, {
      params: { pid: projectId },
      body: { root_id: sourceId, path: '.hidden.md', session_id: sessionId },
      query: {},
    }),
    /文件不存在或无权限/,
  );
  await assert.rejects(
    createProjectArtifact(ctx, {
      params: { pid: projectId },
      body: { root_id: sourceId, path: 'outside-link.md', session_id: sessionId },
      query: {},
    }),
    /文件不存在或无权限/,
  );
  await assert.rejects(
    createProjectArtifact(ctx, {
      params: { pid: projectId },
      body: { root_id: sourceId, path: '../outside/outside.md', session_id: sessionId },
      query: {},
    }),
    /文件不存在或无权限/,
  );
  await assert.rejects(
    createProjectArtifact(context(otherUserId), {
      params: { pid: projectId },
      body: { root_id: sourceId, path: 'parallel-output.bin', session_id: sessionId },
      query: {},
    }),
    /不存在或无权限/,
  );
  await assert.rejects(
    getProjectArtifactDetail(context(otherUserId), { params: { pid: projectId, artifactId } }),
    /产物不存在或无权限/,
  );

  await chmod(v2.snapshot_path, 0o600);
  await writeFile(v2.snapshot_path, 'tampered historical snapshot');
  await assert.rejects(
    previewProjectArtifactVersion(ctx, {
      params: { pid: projectId, artifactId, versionId: v2.id },
    }),
    /历史版本指纹校验失败/,
  );
  await assert.rejects(
    restoreProjectArtifact(ctx, {
      params: { pid: projectId, artifactId },
      body: { version_id: v2.id, session_id: sessionId },
    }),
    /历史版本指纹校验失败/,
  );

  const routePaths = new Set(chatRoutes.map((route) => `${route.m} ${route.p}`));
  assert.equal(routePaths.has('GET /api/agent/search/artifacts'), true);
  assert.equal(routePaths.has('POST /api/agent/projects/:pid/artifacts'), true);
  assert.equal(routePaths.has('GET /api/agent/projects/:pid/artifacts/:artifactId/diff'), true);
  assert.equal(routePaths.has('POST /api/agent/projects/:pid/artifacts/:artifactId/restore'), true);
});

test('ordinary chat Library persists created files per user while keeping users isolated', async (t) => {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'chat-library-'));
  const sourcePath = join(sourceRoot, 'chat-report.md');
  await writeFile(sourcePath, '# 普通聊天产物\n');
  const userId = `chat-library-user-${randomUUID()}`;
  const otherUserId = `chat-library-other-${randomUUID()}`;
  let artifactId = '';
  let otherArtifactId = '';

  t.after(async () => {
    for (const id of [artifactId, otherArtifactId].filter(Boolean)) {
      await query('DELETE FROM project_artifact_versions WHERE artifact_id=$1', [id]).catch(() => undefined);
      await query('DELETE FROM project_artifacts WHERE id=$1', [id]).catch(() => undefined);
      await rm(join(dataPath('project_artifacts'), '__chat__', id), { recursive: true, force: true }).catch(() => undefined);
    }
    await rm(sourceRoot, { recursive: true, force: true });
  });

  const published = await publishProjectArtifact({ query, queryOne }, {
    userId,
    projectId: '__chat__',
    sourcePath,
    allowedRoots: [sourceRoot],
    name: '聊天报告.md',
    kind: 'document',
  });
  artifactId = published.artifact.id;
  assert.equal(published.artifact.project_id, '__chat__');
  assert.equal(published.artifact.project_name, '我的 Library');

  const ownList = await listProjectArtifacts(context(userId), { params: { pid: '__chat__' }, query: {} });
  const otherList = await listProjectArtifacts(context(otherUserId), { params: { pid: '__chat__' }, query: {} });
  assert.equal(ownList.data.items.some((item) => item.id === artifactId), true);
  assert.equal(otherList.data.items.some((item) => item.id === artifactId), false);
  await assert.rejects(
    getProjectArtifactDetail(context(otherUserId), { params: { pid: '__chat__', artifactId } }),
    /产物不存在或无权限/,
  );

  const otherPublished = await publishProjectArtifact({ query, queryOne }, {
    userId: otherUserId,
    projectId: '__chat__',
    sourcePath,
    allowedRoots: [sourceRoot],
    name: '另一位用户的聊天报告.md',
    kind: 'document',
  });
  otherArtifactId = otherPublished.artifact.id;
  assert.notEqual(otherArtifactId, artifactId, 'ordinary chat Library deduplicates paths inside one user only');

  const ownAfterCollision = await listProjectArtifacts(context(userId), { params: { pid: '__chat__' }, query: {} });
  const otherAfterCollision = await listProjectArtifacts(context(otherUserId), { params: { pid: '__chat__' }, query: {} });
  assert.equal(ownAfterCollision.data.items.some((item) => item.id === artifactId), true);
  assert.equal(ownAfterCollision.data.items.some((item) => item.id === otherArtifactId), false);
  assert.equal(otherAfterCollision.data.items.some((item) => item.id === otherArtifactId), true);
  assert.equal(otherAfterCollision.data.items.some((item) => item.id === artifactId), false);
});
