import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import {
  compareProjectOfficeDocument,
  createProjectOfficeDocument,
  editProjectOfficeDocument,
  inspectProjectOfficeDocument,
} from '../../server/src/app/chat/project_artifacts.js';
import { dataPath } from '../../server/src/config/paths.js';
import { createProductTools } from '../../server/src/engine/agents/product_tools.js';
import { chatRoutes } from '../../server/src/transport/registry.chat.js';

const context = (userId) => ({ userId, query, queryOne });

test('office artifacts use current project, trusted Turn, immutable versions and stale-base protection', async (t) => {
  const userId = `office-user-${randomUUID()}`;
  const otherUserId = `office-other-${randomUUID()}`;
  const projectId = `office-project-${randomUUID()}`;
  const memberId = randomUUID();
  const sessionId = randomUUID();
  const ctx = context(userId);
  let artifactId = '';

  t.after(async () => {
    await query('DELETE FROM project_artifact_versions WHERE artifact_id IN (SELECT id FROM project_artifacts WHERE project_id=$1)', [projectId]).catch(() => undefined);
    await query('DELETE FROM project_artifacts WHERE project_id=$1', [projectId]).catch(() => undefined);
    await query('DELETE FROM sessions WHERE id=$1', [sessionId]).catch(() => undefined);
    await query('DELETE FROM project_members WHERE id=$1', [memberId]).catch(() => undefined);
    await query('DELETE FROM projects WHERE id=$1', [projectId]).catch(() => undefined);
    await rm(join(dataPath('project_artifacts'), projectId), { recursive: true, force: true }).catch(() => undefined);
    await rm(join(dataPath('project_office_sources'), projectId), { recursive: true, force: true }).catch(() => undefined);
  });

  await query(`INSERT INTO projects (id,name,status,created_at,updated_at) VALUES ($1,'Office Project','active',now(),now())`, [projectId]);
  await query(
    `INSERT INTO project_members (id,project_id,user_id,is_owner,created_at,updated_at)
     VALUES ($1,$2,$3,1,now(),now())`,
    [memberId, projectId, userId],
  );
  await query(
    `INSERT INTO sessions
      (id,project_id,created_by,source_type,source_id,action_type,title,status,created_at,updated_at)
     VALUES ($1,$2,$3,'agent',$2,'agentic_chat','Office edits','active',now(),now())`,
    [sessionId, projectId, userId],
  );

  const created = await createProjectOfficeDocument(ctx, {
    params: { pid: projectId },
    body: {
      format: 'markdown',
      name: 'launch-report.md',
      title: 'Launch report',
      content: 'Status: waiting',
      session_id: sessionId,
    },
  });
  artifactId = created.data.artifact.id;
  const version1 = created.data.artifact.current_version;
  assert.equal(version1.version_number, 1);
  assert.equal(version1.source_session_id, sessionId);
  assert.equal(version1.metadata.office_format, 'markdown');

  const inspected = await inspectProjectOfficeDocument(ctx, {
    params: { pid: projectId, artifactId },
    query: {},
  });
  const status = inspected.data.document.sections.find((section) => section.text === 'Status: waiting');
  assert.ok(status?.anchor);
  assert.equal(inspected.data.version.id, version1.id);

  const edited = await editProjectOfficeDocument(ctx, {
    params: { pid: projectId, artifactId },
    body: {
      base_version_id: version1.id,
      operations: [{ type: 'replace_text', anchor: status.anchor, text: 'Status: ready' }],
      change_summary: 'Mark ready',
      session_id: sessionId,
    },
  });
  const version2 = edited.data.artifact.current_version;
  assert.equal(version2.version_number, 2);
  assert.equal(version2.metadata.office_edit.base_version_id, version1.id);

  await assert.rejects(
    editProjectOfficeDocument(ctx, {
      params: { pid: projectId, artifactId },
      body: { base_version_id: version1.id, operations: [{ type: 'replace_text', anchor: status.anchor, text: 'stale' }] },
    }),
    /已经产生新版本/,
  );
  await assert.rejects(
    inspectProjectOfficeDocument(context(otherUserId), {
      params: { pid: projectId, artifactId },
      query: {},
    }),
    /产物不存在或无权限/,
  );

  const compared = await compareProjectOfficeDocument(ctx, {
    params: { pid: projectId, artifactId },
    query: { from_version_id: version1.id, to_version_id: version2.id },
  });
  assert.equal(compared.data.format, 'markdown');
  assert.ok(compared.data.changes.some((change) => change.before?.text === 'Status: waiting' && change.after?.text === 'Status: ready'));

  const recordedArtifacts = [];
  const productTools = createProductTools({
    db: { query, queryOne },
    user_id: userId,
    project_id: projectId,
    session_id: sessionId,
    runtime_turn_id: 'office-native-turn',
    task_id: 'office-native-run',
    runtime: {
      runId: 'office-native-run',
      recordArtifact: async (payload) => recordedArtifacts.push(payload),
    },
  });
  const inspectTool = productTools.find((tool) => tool.name === 'artifact_office_inspect');
  const createTool = productTools.find((tool) => tool.name === 'artifact_office_create');
  const editTool = productTools.find((tool) => tool.name === 'artifact_office_edit');
  assert.equal(inspectTool.side_effect, 'read');
  assert.equal(createTool.side_effect, 'write');
  assert.equal(editTool.side_effect, 'write');
  const toolCreated = await createTool.execute('office-create-call', {
    format: 'xlsx',
    name: 'native-table.xlsx',
    title: 'Native table',
    specification: { sheets: [{ name: 'Summary', rows: [['Status'], ['Ready']] }] },
  });
  assert.equal(toolCreated.details.artifact.current_version.source_tool_call_id, 'office-create-call');
  assert.equal(toolCreated.details.host_actions[0].event.event, 'artifact_published');
  const toolInspection = await inspectTool.execute('office-inspect-call', { artifact_id: artifactId });
  const ready = toolInspection.details.document.sections.find((section) => section.text === 'Status: ready');
  const toolEdited = await editTool.execute('office-edit-call', {
    artifact_id: artifactId,
    base_version_id: version2.id,
    operations: [{ type: 'replace_text', anchor: ready.anchor, text: 'Status: launched' }],
    change_summary: 'Launch',
  });
  assert.equal(toolEdited.details.artifact.current_version.version_number, 3);
  assert.equal(toolEdited.details.artifact.current_version.source_turn_id, 'office-native-turn');
  assert.equal(toolEdited.details.artifact.current_version.source_tool_call_id, 'office-edit-call');
  assert.equal(toolEdited.details.host_actions[0].event.event, 'artifact_edited');
  assert.equal(recordedArtifacts.length, 2);
  assert.equal(recordedArtifacts[0].metadata.action, 'office_create');
  assert.equal(recordedArtifacts[0].metadata.office_format, 'xlsx');
  assert.equal(recordedArtifacts[1].metadata.action, 'office_edit');
  assert.equal(recordedArtifacts[1].metadata.operation_count, 1);

  const routes = new Set(chatRoutes.map((route) => `${route.m} ${route.p}`));
  assert.equal(routes.has('POST /api/agent/projects/:pid/artifacts/office'), true);
  assert.equal(routes.has('GET /api/agent/projects/:pid/artifacts/:artifactId/office'), true);
  assert.equal(routes.has('POST /api/agent/projects/:pid/artifacts/:artifactId/office/edits'), true);
  assert.equal(routes.has('GET /api/agent/projects/:pid/artifacts/:artifactId/office/diff'), true);
});
