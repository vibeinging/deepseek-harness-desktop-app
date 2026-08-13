import test from 'node:test';
import assert from 'node:assert/strict';

import { query } from '../../server/src/db.js';
import {
  MAX_APP_INSTRUCTIONS_LENGTH,
  buildAppInstructionsMarkdown,
  getAppInstructions,
  updateAppInstructions,
} from '../../server/src/app/agents/app_settings.js';

test('app instructions have a dedicated local settings table', async () => {
  const columns = await query(`SELECT * FROM pragma_table_info('app_user_settings')`);
  assert.deepEqual(
    columns.map((column) => column.name),
    ['user_id', 'instructions', 'created_at', 'updated_at'],
  );
  assert.equal(columns.find((column) => column.name === 'instructions')?.notnull, 1);
});

test('app instruction API normalizes, stores and reads the current user value', async () => {
  const values = new Map();
  const ctx = {
    userId: 'user-1',
    async query(_sql, args) {
      values.set(args[0], args[1]);
      return [];
    },
    async queryOne(_sql, args) {
      return values.has(args[0]) ? { instructions: values.get(args[0]) } : null;
    },
  };

  const updated = await updateAppInstructions(ctx, {
    body: { instructions: '  默认使用中文\r\n先给结论  ' },
  });
  assert.equal(updated.data.instructions, '默认使用中文\n先给结论');

  const loaded = await getAppInstructions(ctx);
  assert.equal(loaded.data.instructions, '默认使用中文\n先给结论');
  assert.equal(loaded.data.max_length, MAX_APP_INSTRUCTIONS_LENGTH);
});

test('app instructions enforce length and state their safety boundary', async () => {
  const ctx = { userId: 'user-1', query: async () => [] };
  await assert.rejects(
    updateAppInstructions(ctx, { body: { instructions: 'x'.repeat(MAX_APP_INSTRUCTIONS_LENGTH + 1) } }),
    /全局指令不能超过 8000 个字符/,
  );

  const content = buildAppInstructionsMarkdown('先给结论。');
  assert.match(content, /## Application instructions/);
  assert.match(content, /user-configured local preferences/);
  assert.match(content, /system safety requirements, tool permissions, or approval results/);
  assert.equal(buildAppInstructionsMarkdown(''), '');
});
