import assert from 'node:assert/strict';
import test from 'node:test';

import { artifactActionsFor, normalizeArtifactActions } from '../../server/src/engine/agents/artifact_actions.js';
import { deliverToolOutput } from '../../server/src/engine/agents/tool_output_delivery.js';

test('artifact action matrix covers media, structured data, files and client downloads', () => {
  assert.deepEqual(artifactActionsFor({ kind: 'image', path: '/tmp/image.png' }), ['reveal', 'copy']);
  assert.deepEqual(artifactActionsFor({ kind: 'audio', path: '/tmp/audio.mp3' }), ['open', 'reveal']);
  assert.deepEqual(artifactActionsFor({ kind: 'video', path: '/tmp/video.mp4' }), ['open', 'reveal']);
  assert.deepEqual(artifactActionsFor({ kind: 'table' }), ['copy']);
  assert.deepEqual(artifactActionsFor({ kind: 'chart' }), ['copy']);
  assert.deepEqual(artifactActionsFor({ kind: 'json' }), ['copy']);
  assert.deepEqual(artifactActionsFor({ kind: 'document', path: '/tmp/report.docx' }), ['open', 'reveal']);
  assert.deepEqual(artifactActionsFor({ kind: 'pdf', materialization: 'client-download' }), ['download']);
  assert.deepEqual(normalizeArtifactActions(['remove', 'reveal', 'open', 'open']), ['open', 'reveal']);
});

test('temporary chat keeps a generated deliverable inline without saving it to Library', async () => {
  const result = await deliverToolOutput({
    agentContext: { project_id: '__chat__', temporary: true },
    tool: {
      name: 'image_gen',
      output_contract: {
        role: 'deliverable',
        surface: 'both',
        persistence: 'library',
        kind: 'image',
        path_field: 'path',
      },
    },
    result: {
      content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      details: { success: true, path: '/tmp/generated.png' },
    },
    callId: 'temporary-image-1',
  });

  assert.equal(result.content[0].type, 'image');
  assert.equal(result.details.output_delivery.role, 'deliverable');
  assert.equal(result.details.output_delivery.persistence, 'none');
  assert.equal(result.details.output_delivery.temporary, true);
  assert.equal(result.details.output_delivery.status, 'inline_only');
  assert.deepEqual(result.details.output_delivery.actions, ['reveal', 'copy']);
  assert.equal(result.details.artifact, undefined);
});

test('a Library publication failure never removes an already-created inline result', async () => {
  const result = await deliverToolOutput({
    agentContext: {
      project_id: '__chat__',
      user_id: 'user-1',
      db: { query: async () => [], queryOne: async () => null },
      workspace_roots: ['/tmp'],
    },
    tool: {
      name: 'create_media',
      output_contract: {
        role: 'deliverable',
        surface: 'both',
        persistence: 'library',
        kind: 'image',
        path_field: 'path',
      },
    },
    result: {
      content: [{ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }],
      details: { success: true, path: '/tmp/file-does-not-exist.png' },
    },
    callId: 'missing-image-1',
  });

  assert.equal(result.content[0].type, 'image');
  assert.equal(result.details.output_delivery.status, 'publication_failed');
  assert.match(result.details.artifact_warning, /产物已生成/);
});

test('host output delivery derives file actions centrally', async () => {
  const result = await deliverToolOutput({
    agentContext: { project_id: '__chat__', temporary: true },
    tool: {
      name: 'create_document',
      output_contract: {
        role: 'deliverable',
        surface: 'workspace',
        persistence: 'none',
        kind: 'document',
        path_field: 'path',
      },
    },
    result: { details: { success: true, path: '/tmp/report.docx' } },
    callId: 'document-1',
  });

  assert.deepEqual(result.details.output_delivery.actions, ['open', 'reveal']);
});
