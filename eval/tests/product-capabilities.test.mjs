import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRODUCT_CONFIRM_TOOL_NAMES,
  PRODUCT_TOOL_NAMES,
} from '../../server/src/engine/agents/product_tool_catalog.js';
import { createProductTools } from '../../server/src/engine/agents/product_tools.js';

test('product capability registry exposes the general conversation tools without the removed app Plugin tools', () => {
  for (const name of [
    'project_open',
    'conversation_list',
    'conversation_create',
    'conversation_open',
    'conversation_rename',
    'conversation_archive',
  ]) {
    assert.ok(PRODUCT_TOOL_NAMES.has(name), `missing product tool: ${name}`);
  }
  for (const name of ['conversation_create', 'conversation_rename', 'conversation_archive']) {
    assert.ok(PRODUCT_CONFIRM_TOOL_NAMES.has(name), `missing confirmation boundary: ${name}`);
  }
  for (const removedName of [
    'plugin_list',
    'plugin_validate',
    'plugin_reload',
    'query_project_data',
    'structured_import',
    'database_file_import',
    'unstructured_import',
    'entity_column_preview',
    'entity_values_create',
    'metadata_enrichment_preview',
    'metadata_enrichment_run',
    'data_preparation_preview',
    'data_preparation_run',
    'project_rules_get',
    'project_rules_update',
  ]) {
    assert.equal(PRODUCT_TOOL_NAMES.has(removedName), false, `removed Ask Data tool remains: ${removedName}`);
  }
});

test('conversation host tools return navigation events and enforce workspace membership', async () => {
  const session = {
    id: 'session-target',
    project_id: 'project-target',
    title: '目标对话',
    status: 'active',
    created_by: 'user-1',
  };
  const allowedTools = createProductTools({
    user_id: 'user-1',
    project_id: 'project-target',
    db: {
      query: async () => [],
      queryOne: async (sql) => sql.includes('FROM sessions') ? session : { id: 'project-target' },
    },
  });
  const opened = await allowedTools.find((tool) => tool.name === 'conversation_open').execute('call-open', {
    conversation_id: session.id,
  });
  assert.equal(opened.details.success, true);
  assert.deepEqual(opened.details.host_actions, [{
    type: 'workspace_event',
    event: {
      event: 'conversation_opened',
      project_id: 'project-target',
      session_id: 'session-target',
      conversation: session,
    },
  }]);

  const deniedTools = createProductTools({
    user_id: 'user-1',
    project_id: 'project-target',
    db: { query: async () => [], queryOne: async () => null },
  });
  const denied = await deniedTools.find((tool) => tool.name === 'conversation_create').execute('call-create', {
    project_id: 'project-other',
    title: '不应创建',
  });
  assert.equal(denied.details.success, false);
  assert.equal(denied.isError, true);
  assert.match(denied.details.error, /无权限/);
});
