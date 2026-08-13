import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAttachmentContextMessage,
  buildUserContentItems,
  normalizeMessageAttachments,
} from '../../server/src/app/chat/message_blocks.js';

test('agent chat stores local attachments as structured user blocks', () => {
  const attachments = normalizeMessageAttachments([
    { path: '/tmp/dsh/projects/project-123/AGENTS.md', name: 'AGENTS.md' },
  ]);
  const items = buildUserContentItems('介绍一下这个文件', attachments);

  assert.equal(items[0].type, 'attachment');
  assert.equal(items[0].content, 'AGENTS.md');
  assert.equal(items[0].metadata.path, '/tmp/dsh/projects/project-123/AGENTS.md');
  assert.equal(items[1].type, 'text');
  assert.equal(items[1].content, '介绍一下这个文件');
});

test('agent chat injects attachment paths into workspace-agent context', () => {
  const content = buildAttachmentContextMessage('介绍一下这个文件', [
    { path: '/tmp/AGENTS.md', name: 'AGENTS.md', is_dir: false },
  ]);

  assert.match(content, /用户随消息附加的本地文件/);
  assert.match(content, /\/tmp\/AGENTS\.md/);
  assert.match(content, /不要回答无法访问本地文件/);
});

test('office selections instruct the model to use the DSH office tool chain', () => {
  const content = buildAttachmentContextMessage('修改标题', [{
    path: '/tmp/launch.pptx',
    name: 'launch.pptx',
    artifact_id: 'artifact-1',
    artifact_version_id: 'version-1',
    artifact_selections: [{ format: 'pptx', anchor: 'slide:1:title', label: '第一页标题' }],
  }]);

  assert.match(content, /artifact_office_inspect/);
  assert.match(content, /artifact_office_edit/);
  assert.doesNotMatch(content, /PowerPoint Plugin|powerpoint_deck_/);
});
