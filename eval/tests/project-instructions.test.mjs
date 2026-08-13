import test from 'node:test';
import assert from 'node:assert/strict';

import { query } from '../../server/src/db.js';
import {
  MAX_PROJECT_INSTRUCTIONS_LENGTH,
  normalizeProjectInstructions,
  updateProject,
} from '../../server/src/app/projects/index.js';
import { buildProjectInstructionsMarkdown } from '../../server/src/engine/agents/workspace_context.js';

test('projects schema persists general project instructions separately', async () => {
  const columns = await query(`SELECT * FROM pragma_table_info('projects')`);
  const instructions = columns.find((column) => column.name === 'instructions');
  assert.equal(instructions?.type, 'TEXT');
  assert.equal(instructions?.notnull, 1);
});

test('project instructions preserve line breaks and enforce the storage limit', () => {
  assert.equal(normalizeProjectInstructions('  先给结论\r\n再说明依据  '), '先给结论\n再说明依据');
  assert.throws(
    () => normalizeProjectInstructions('x'.repeat(MAX_PROJECT_INSTRUCTIONS_LENGTH + 1)),
    /项目指令不能超过 8000 个字符/,
  );
});

test('project update supports an instructions-only patch without losing identity fields', async () => {
  let persistedInstructions = '旧指令';
  const writes = [];
  const ctx = {
    userId: 'user-1',
    async query(sql, args = []) {
      if (sql.includes('FROM projects p')) {
        return [{
          id: 'project-1',
          name: '销售分析',
          description: '本地项目',
          instructions: persistedInstructions,
          status: 'active',
          is_open: 0,
          created_at: '2026-07-31T00:00:00.000Z',
          updated_at: '2026-07-31T00:00:00.000Z',
          is_owner: 1,
          role_id: 'owner-role',
          conversation_count: 0,
          data_source_count: 0,
        }];
      }
      if (sql.includes('FROM project_source_folders')) return [];
      if (sql.includes('UPDATE projects SET')) {
        writes.push({ sql, args });
        persistedInstructions = args[3];
        return [];
      }
      return [];
    },
  };

  const result = await updateProject(ctx, {
    params: { id: 'project-1' },
    body: { instructions: '  默认使用中文\r\n先给结论  ' },
  });

  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args, ['project-1', '销售分析', '本地项目', '默认使用中文\n先给结论']);
  assert.equal(result.data.name, '销售分析');
  assert.equal(result.data.description, '本地项目');
  assert.equal(result.data.instructions, '默认使用中文\n先给结论');
});

test('project instructions state their safety and permission boundary', () => {
  const content = buildProjectInstructionsMarkdown('先给结论。');
  assert.match(content, /apply only to the current project/);
  assert.match(content, /system safety requirements, tool permissions, or approval results/);
  assert.equal(buildProjectInstructionsMarkdown(''), '');
});
