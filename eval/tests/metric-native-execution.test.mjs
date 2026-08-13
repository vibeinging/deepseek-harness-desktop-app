import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MetricExecutionService,
  replaceMetricExecutionPlans,
  validateMetricExecutionPlan,
} from '../../server/src/engine/semantic/metric_execution_service.js';
import { ExecuteMetricTool } from '../../server/src/engine/tools/execute_metric_tool.js';

function catalog(entries) {
  const metrics = {};
  const plans = {};
  for (const entry of entries) {
    metrics[entry.id] = {
      id: entry.id, project_id: 'p1', name: entry.name, description: entry.description || null,
    };
    plans[entry.id] = {
      id: `plan:${entry.id}`, metric_id: entry.id,
      plan_type: entry.plan_type, source_id: entry.source_id || null, source_type: entry.source_type || null,
      spec: JSON.stringify(entry.spec || {}),
      evidence_policy: entry.evidence_policy == null ? null : JSON.stringify(entry.evidence_policy),
      version: 1,
    };
  }
  return { metrics, plans };
}

function context({ root, metrics, plans }) {
  return {
    async queryOne(sql, params) {
      if (sql.includes('metric_execution_plans')) return plans[params[0]] || null;
      if (sql.includes('metric_definitions')) return metrics[params[0]] || null;
      return null;
    },
    async query() { return []; },
  };
}

test('metric plans reject retired PDF facts and old field shapes', () => {
  assert.throws(
    () => validateMetricExecutionPlan({ plan_type: 'pdf_fact', spec: {} }),
    /plan_type 必须是 sql、formula/,
  );
  assert.throws(
    () => validateMetricExecutionPlan({ plan_type: 'formula', spec: '{bad json' }),
    /spec 必须是有效的 JSON 对象/,
  );
  assert.throws(
    () => validateMetricExecutionPlan({
      plan_type: 'formula', spec: { expression: 'a', operands: { a: { value: 1 } } }, evidence_policy: '[]',
    }),
    /evidence_policy 必须是有效的 JSON 对象/,
  );
  assert.throws(
    () => validateMetricExecutionPlan({
      execution_type: 'sql', plan_type: 'sql', spec: { sql_template: 'SELECT 1' },
    }),
    /不接受旧字段/,
  );
});

test('formula plans cannot claim a verified result when required evidence is missing', async () => {
  const setup = catalog([{
    id: 'literal', name: '无证据公式', plan_type: 'formula',
    spec: { expression: 'a + b', operands: { a: { value: 1 }, b: { value: 2 } } },
    evidence_policy: { require_evidence: true },
  }]);
  const result = await MetricExecutionService.execute(context({ root: '/fixture', ...setup }), {
    project_id: 'p1', metric_id: 'literal',
  });
  assert.equal(result.success, false);
  assert.match(result.error, /要求原始证据/);
});

test('SQL plan executes saved parameters and preserves source evidence', async () => {
  const setup = catalog([{
    id: 'sql-total', name: '期间销售额', plan_type: 'sql', source_id: 'source-1',
    spec: {
      sql_template: 'SELECT ? AS amount',
      parameters: [{ name: 'period', type: 'string', required: true, description: '统计期间' }],
      result: { value_column: 'amount', unit: '人民币元' },
    },
    evidence_policy: { require_evidence: true },
  }]);
  let call = null;
  const evidence = { evidence_id: 'sql-evidence-1', produced_by: 'data_source_executor' };
  const result = await MetricExecutionService.execute(context({ root: '/fixture', ...setup }), {
    project_id: 'p1', metric_id: 'sql-total', parameters: { period: '2022-06' },
    sql_runner: async (input) => {
      call = input;
      return { success: true, data: [{ amount: '838316.11' }], columns: ['amount'], evidence };
    },
  });
  assert.equal(result.value, 838316.11);
  assert.equal(result.unit, '人民币元');
  assert.equal(result.plan_id, 'plan:sql-total');
  assert.equal(result.source_id, 'source-1');
  assert.deepEqual(result.parameters, ['2022-06']);
  assert.deepEqual(result.evidence, [evidence]);
  assert.equal(call.sql, 'SELECT ? AS amount');
  assert.equal(call.plan.source_id, 'source-1');
});

test('SQL runner fails closed for an explicit missing or non-database source and only falls back when unbound', async () => {
  const database = {
    id: 'database-1', source_type: 'database_connection', datasource_name: '项目数据库',
  };
  const unstructured = {
    id: 'documents-1', source_type: 'unstructured_data_source', datasource_name: '项目文档',
  };
  const calls = [];
  const bds = {
    get_data_source(sourceId) {
      if (sourceId === database.id) return database;
      if (sourceId === unstructured.id) return unstructured;
      return null;
    },
    get_database_sources() { return [database]; },
    async query(name, sql) {
      calls.push({ name, sql });
      return { success: true, data: [{ value: 1 }], columns: ['value'] };
    },
  };
  const tool = new ExecuteMetricTool({ business_data_sources: bds });
  const runner = tool.createSqlRunner({ project_id: 'p1' });

  for (const plan of [
    { source_id: 'deleted-binding', source_type: 'database' },
    { source_id: 'foreign-project-binding', source_type: 'database_connection' },
    { source_id: unstructured.id, source_type: 'unstructured_data_source' },
    { source_id: database.id, source_type: 'unstructured_data_source' },
  ]) {
    const result = await runner({ plan, sql: 'SELECT 1 AS value', parameters: [], spec: {} });
    assert.equal(result.success, false);
    assert.match(result.message, /不存在或不可用/);
  }
  assert.equal(calls.length, 0);

  const fallback = await runner({
    plan: { source_id: null, source_type: null },
    sql: 'SELECT 1 AS value', parameters: [], spec: {},
  });
  assert.equal(fallback.success, true);
  assert.deepEqual(calls, [{ name: '项目数据库', sql: 'SELECT 1 AS value' }]);
});

test('SQL plan asks for declared missing or invalid parameters before querying', async () => {
  const setup = catalog([{
    id: 'sql-period', name: '期间销售额', plan_type: 'sql',
    spec: {
      sql_template: 'SELECT ? AS amount',
      parameters: [{ name: 'period', type: 'string', required: true, description: '统计期间' }],
      result: { value_column: 'amount' },
    },
  }]);
  let called = false;
  const run = (parameters = {}) => MetricExecutionService.execute(context({ root: '/fixture', ...setup }), {
    project_id: 'p1', metric_id: 'sql-period', parameters,
    sql_runner: async () => { called = true; return { success: true, data: [] }; },
  });
  const missing = await run();
  assert.equal(missing.needs_clarification, true);
  assert.equal(called, false);
  const invalid = await run({ period: { year: 2022 } });
  assert.equal(invalid.needs_clarification, true);
  assert.match(invalid.error, /period必须是文字/);
  assert.equal(called, false);
});

test('SQL plan rejects unsafe, non-scalar, and evidence-free results', async () => {
  const unsafeSetup = catalog([{
    id: 'sql-unsafe', name: '危险指标', plan_type: 'sql', spec: { sql_template: 'PRAGMA writable_schema=ON' },
  }]);
  let called = false;
  const rejected = await MetricExecutionService.execute(context({ root: '/fixture', ...unsafeSetup }), {
    project_id: 'p1', metric_id: 'sql-unsafe',
    sql_runner: async () => { called = true; return { success: true, data: [] }; },
  });
  assert.match(rejected.error, /只允许单条只读/);
  assert.equal(called, false);

  const wideSetup = catalog([{
    id: 'sql-wide', name: '多列指标', plan_type: 'sql',
    spec: { sql_template: 'SELECT 1 AS a, 2 AS b' }, evidence_policy: { require_evidence: false },
  }]);
  const notScalar = await MetricExecutionService.execute(context({ root: '/fixture', ...wideSetup }), {
    project_id: 'p1', metric_id: 'sql-wide',
    sql_runner: async () => ({ success: true, data: [{ a: 1, b: 2 }], columns: ['a', 'b'] }),
  });
  assert.match(notScalar.error, /返回多列/);

  const evidenceSetup = catalog([{
    id: 'sql-evidence', name: '证据指标', plan_type: 'sql', spec: { sql_template: 'SELECT 1 AS amount' },
  }]);
  const withoutEvidence = await MetricExecutionService.execute(context({ root: '/fixture', ...evidenceSetup }), {
    project_id: 'p1', metric_id: 'sql-evidence',
    sql_runner: async () => ({ success: true, data: [{ amount: 1 }], columns: ['amount'] }),
  });
  assert.match(withoutEvidence.error, /没有返回证据/);
});

test('metric execution fails explicitly when no active plan exists', async () => {
  const setup = catalog([{ id: 'orphan', name: '孤立指标', plan_type: 'sql', spec: { sql_template: 'SELECT 1' } }]);
  delete setup.plans.orphan;
  await assert.rejects(
    () => MetricExecutionService.execute(context({ root: '/fixture', ...setup }), {
      project_id: 'p1', metric_id: 'orphan', sql_runner: async () => ({ success: true }),
    }),
    /没有可用的执行计划/,
  );
});

test('plan replacement rejects foreign ids and keeps the old plan until new plans are saved', async () => {
  const current = [{
    id: 'plan:current', metric_id: 'metric-1', plan_type: 'sql', source_id: null, source_type: null,
    spec: JSON.stringify({ sql_template: 'SELECT 1 AS amount' }), evidence_policy: '{}',
    priority: 100, version: 1, is_active: 1,
  }];
  const writes = [];
  const ctx = {
    async query(sql) {
      if (sql.includes('SELECT id, metric_id')) return current;
      writes.push(sql);
      return [];
    },
  };

  await assert.rejects(
    () => replaceMetricExecutionPlans(ctx, {
      project_id: 'p1', metric_id: 'metric-1',
      execution_plans: [{
        id: 'plan:another-metric', plan_type: 'sql', spec: { sql_template: 'SELECT 2 AS amount' },
      }],
    }),
    /不属于当前指标/,
  );
  assert.equal(writes.length, 0);

  await replaceMetricExecutionPlans(ctx, {
    project_id: 'p1', metric_id: 'metric-1',
    execution_plans: [{ plan_type: 'sql', spec: { sql_template: 'SELECT 2 AS amount' } }],
  });
  assert.match(writes[0], /INSERT INTO metric_execution_plans/);
  assert.match(writes[1], /UPDATE metric_execution_plans/);
  assert.match(writes[1], /<> ALL/);
});
