import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getProjectRules,
  updateProjectRules,
} from '../../server/src/app/agents/index.js';
import { queryOne } from '../../server/src/db.js';

test('database schema stores project rules without the old Agent prompt table', async () => {
  assert.equal((await queryOne(`SELECT name FROM sqlite_master WHERE type='table' AND name='project_rules'`))?.name, 'project_rules');
  assert.equal(await queryOne(`SELECT name FROM sqlite_master WHERE type='table' AND name='agents'`), null);
});

test('project rules use simple rule types and no prompt configuration', async () => {
  const queries = [];
  const ctx = {
    userId: 'user-1',
    queryOne: async (sql, args) => {
      queries.push({ sql, args });
      if (/FROM projects/.test(sql)) return { id: 'project-1', user_id: 'user-1', is_owner: 1 };
      return { content: '退款订单不计入销售额' };
    },
  };

  const result = await getProjectRules(ctx, {
    params: { pid: 'project-1', ruleType: 'sql' },
  });

  assert.equal(result.data.rule_type, 'sql');
  assert.equal(result.data.rules, '退款订单不计入销售额');
  assert.deepEqual(queries.find((item) => /FROM project_rules/.test(item.sql))?.args, ['project-1', 'sql']);
  await assert.rejects(
    () => getProjectRules(ctx, { params: { pid: 'project-1', ruleType: 'query_agent' } }),
    /rule_type 仅支持 query、sql 或 format/,
  );
});

test('project rule append preserves existing rules and avoids exact duplicates', async () => {
  const writes = [];
  const ctx = {
    userId: 'user-1',
    queryOne: async (sql) => /FROM projects/.test(sql)
      ? { id: 'project-1', user_id: 'user-1', is_owner: 1 }
      : { id: 'rule-1', content: '已有规则' },
    query: async (sql, args) => writes.push({ sql, args }),
  };

  const first = await updateProjectRules(ctx, {
    params: { pid: 'project-1', ruleType: 'query' },
    body: { operation: 'append', content: '新增规则' },
  });
  assert.equal(first.data.rules, '已有规则\n\n新增规则');
  assert.equal(first.data.unchanged, false);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].args[0], '已有规则\n\n新增规则');

  ctx.queryOne = async (sql) => /FROM projects/.test(sql)
    ? { id: 'project-1', user_id: 'user-1', is_owner: 1 }
    : { id: 'rule-1', content: '已有规则\n\n新增规则' };
  const duplicate = await updateProjectRules(ctx, {
    params: { pid: 'project-1', ruleType: 'query' },
    body: { operation: 'append', content: '新增规则' },
  });
  assert.equal(duplicate.data.unchanged, true);
  assert.equal(writes.length, 1);
});
