import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import { assertBusiness } from '../../server/src/app/business/business.js';
import { generateMetricEmbeddings } from '../../server/src/app/business/metrics.js';
import {
  bulkImportMetrics,
  createMetric,
  deleteMetric,
  executeMetric,
  exportCodeValues,
  importCodeValues,
  updateMetric,
} from '../../server/src/app/business/metrics.js';
import { MetricService } from '../../server/src/engine/semantic/metric_service.js';
import { compileMetricViewPreview } from '../../server/src/app/business/metric_view_runtime.js';
import {
  applyMetricViewRecommendation,
  createMetricView,
  getLatestMetricViewRecommendation,
  getMetricViewRecommendationTask,
  previewMetricView,
  runMetricViewRecommendation,
  updateMetricView,
  updateMetricViewStatus,
} from '../../server/src/app/business/metric_views.js';
import { MetricViewRecommendationService } from '../../server/src/engine/semantic/metric_view_recommendation_service.js';
import {
  getExamplesStats,
  getMetricsEmbeddingPendingCount,
  listExamples,
  listMetricViews,
  listMetrics,
} from '../../server/src/app/reads/reads_business.js';
import {
  importEntities,
  revertAutoPromoted,
  searchEntities,
  testEntityAgent,
} from '../../server/src/app/business/entity_configs.js';
import { EntityAgentService } from '../../server/src/engine/semantic/entity_agent_service.js';
import { businessRoutes } from '../../server/src/transport/registry.business.js';
import {
  generateIntermediateDescription,
  persistIntermediate,
} from '../../server/src/app/session/index.js';
import { IntermediateStorageService } from '../../server/src/engine/datasources/intermediate_storage_service.js';
import { AiCapabilityError } from '../../server/src/engine/core/structured_ai.js';
import { duckWriteRecords } from '../../server/src/engine/datasources/duck.js';

const userId = '00000000-0000-0000-0000-000000000001';
const ctx = { query, queryOne, userId };

async function waitForRecommendation(pid, taskId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await getMetricViewRecommendationTask(ctx, { params: { pid, taskId } });
    if (result.data.status === 'completed' || result.data.status === 'failed') return result.data;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`recommendation task timeout: ${taskId}`);
}

test('project semantic functions use real project scope and truthful generation results', async () => {
  assert.deepEqual(await assertBusiness('project-1', undefined), { id: 'project-1' });

  const original = MetricService.generate_metric_embeddings;
  let received = null;
  MetricService.generate_metric_embeddings = async (_ctx, options) => {
    received = options;
    return { success: true, completed: true, total: 1, processed: 1 };
  };
  try {
    const result = await generateMetricEmbeddings(ctx, {
      params: { pid: 'project-1' }, query: { metric_id: 'metric-1' }, body: {},
    });
    assert.equal(received.metric_id, 'metric-1');
    assert.equal(result.data.processed, 1);

    MetricService.generate_metric_embeddings = async () => ({
      success: false, completed: false, total: 1, processed: 0, message: 'vector unavailable',
    });
    await assert.rejects(
      () => generateMetricEmbeddings(ctx, {
        params: { pid: 'project-1' }, query: { metric_id: 'metric-1' }, body: {},
      }),
      (error) => error.status === 503 && /vector unavailable/.test(error.message),
    );
  } finally {
    MetricService.generate_metric_embeddings = original;
  }
});

test('business route registry has no semantic 501 placeholder handlers', () => {
  const covered = [
    '/api/projects/:pid/metrics/bulk_import',
    '/api/projects/:pid/metrics/search',
    '/api/projects/:pid/metrics/code_values/import',
    '/api/projects/:pid/metrics/code_values/export',
    '/api/projects/:pid/metrics/:mid/execute',
    '/api/projects/:pid/entity_configs',
    '/api/projects/:pid/entity_mappings/column_names',
    '/api/projects/:pid/entity_mappings/test_agent',
    '/api/projects/:pid/entity_mappings/revert_auto_promoted',
    '/api/projects/:pid/entities/search',
    '/api/projects/:pid/entities/import_excel',
    '/api/projects/:pid/metric-views/preview',
    '/api/projects/:pid/metric-views/column-distinct-values',
    '/api/projects/:pid/metric-views/recommendations',
    '/api/projects/:pid/metric-views/recommendations/:taskId',
    '/api/projects/:pid/metric-views/recommendations/:taskId/apply',
  ];
  for (const path of covered) {
    const route = businessRoutes.find((item) => item.p === path);
    assert.ok(route, `missing route ${path}`);
    assert.notEqual(route.fn.name, 'stub');
  }
});

test('metric-view recommendation reads fail only stale tasks in the current project and user scope', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pid = `recommend-reconcile-project-${suffix}`;
  const latestPid = `recommend-reconcile-latest-${suffix}`;
  const foreignPid = `recommend-reconcile-foreign-${suffix}`;
  const foreignUserId = `recommend-reconcile-user-${suffix}`;
  const staleTaskId = `recommend-reconcile-stale-${suffix}`;
  const freshTaskId = `recommend-reconcile-fresh-${suffix}`;
  const latestTaskId = `recommend-reconcile-latest-task-${suffix}`;
  const foreignUserTaskId = `recommend-reconcile-foreign-user-task-${suffix}`;
  const foreignProjectTaskId = `recommend-reconcile-foreign-project-task-${suffix}`;
  const taskIds = [
    staleTaskId,
    freshTaskId,
    latestTaskId,
    foreignUserTaskId,
    foreignProjectTaskId,
  ];
  t.after(async () => {
    for (const taskId of taskIds) {
      await query('DELETE FROM metric_view_recommendation_tasks WHERE id=$1', [taskId]);
    }
  });

  const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  const freshAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const insertTask = (id, projectId, initiatedBy, status, timestamp) => query(
    `INSERT INTO metric_view_recommendation_tasks
       (id, project_id, initiated_by, status, input_params, candidates, user_selections,
        applied_view_ids, stats, error_message, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'{}','[]','[]','[]','{}',NULL,$5,$5)`,
    [id, projectId, initiatedBy, status, timestamp],
  );
  await insertTask(staleTaskId, pid, userId, 'synthesizing', staleAt);
  await insertTask(freshTaskId, pid, userId, 'extracting', freshAt);
  await insertTask(latestTaskId, latestPid, userId, 'pending', staleAt);
  await insertTask(foreignUserTaskId, pid, foreignUserId, 'clustering', staleAt);
  await insertTask(foreignProjectTaskId, foreignPid, userId, 'pending', staleAt);

  const staleRead = await getMetricViewRecommendationTask(ctx, {
    params: { pid, taskId: staleTaskId },
  });
  assert.equal(staleRead.data.status, 'failed');
  assert.match(staleRead.data.error_message, /超过 30 分钟没有进展/);

  const fresh = await queryOne(
    'SELECT status, error_message FROM metric_view_recommendation_tasks WHERE id=$1',
    [freshTaskId],
  );
  assert.deepEqual(fresh, { status: 'extracting', error_message: null });
  assert.equal((await queryOne(
    'SELECT status FROM metric_view_recommendation_tasks WHERE id=$1',
    [foreignUserTaskId],
  )).status, 'clustering');
  assert.equal((await queryOne(
    'SELECT status FROM metric_view_recommendation_tasks WHERE id=$1',
    [foreignProjectTaskId],
  )).status, 'pending');

  const latestRead = await getLatestMetricViewRecommendation(ctx, { params: { pid: latestPid } });
  assert.equal(latestRead.data.id, latestTaskId);
  assert.equal(latestRead.data.status, 'failed');
  assert.match(latestRead.data.error_message, /应用重启或处理超时中断/);
});

test('metric trial executes the saved project metric and returns clarification without leaking evidence details', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pid = `metric-trial-project-${suffix}`;
  const foreignPid = `metric-trial-foreign-${suffix}`;
  const formulaMetricId = `metric-trial-formula-${suffix}`;
  const parameterMetricId = `metric-trial-parameter-${suffix}`;
  const sqlMetricId = `metric-trial-sql-${suffix}`;
  const failingMetricId = `metric-trial-failing-${suffix}`;
  const foreignMetricId = `metric-trial-foreign-metric-${suffix}`;
  const connectionId = `metric-trial-connection-${suffix}`;
  const bindingId = `metric-trial-binding-${suffix}`;
  const duckDir = mkdtempSync(join(tmpdir(), 'dsh-metric-trial-'));
  const duckPath = join(duckDir, 'trial.duckdb');

  await duckWriteRecords(duckPath, 'orders', [
    { period: '2026-07', amount: 12 },
    { period: '2026-07', amount: 30 },
    { period: '2026-08', amount: 99 },
  ], ['period', 'amount']);
  await query(
    `INSERT INTO database_connections
       (id, project_id, name, db_type, database, created_at, updated_at)
     VALUES ($1,$2,'试跑本地库','duckdb',$3,now(),now())`,
    [connectionId, pid, duckPath],
  );
  await query(
    `INSERT INTO business_data_sources
       (id, project_id, source_type, source_id, created_at, updated_at)
     VALUES ($1,$2,'database_connection',$3,now(),now())`,
    [bindingId, pid, connectionId],
  );

  await query(
    `INSERT INTO metric_definitions
       (id, project_id, name, is_active, created_at, updated_at)
     VALUES ($1,$2,'试跑公式指标',true,now(),now()),
            ($3,$2,'试跑参数指标',true,now(),now()),
            ($4,$2,'试跑数据库指标',true,now(),now()),
            ($5,$2,'试跑失败指标',true,now(),now()),
            ($6,$7,'其他项目指标',true,now(),now())`,
    [formulaMetricId, pid, parameterMetricId, sqlMetricId, failingMetricId, foreignMetricId, foreignPid],
  );
  await query(
    `INSERT INTO metric_execution_plans
       (id, project_id, metric_id, plan_type, spec, evidence_policy,
        priority, version, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,'formula',$4,$5,100,1,true,now(),now()),
            ($6,$2,$7,'sql',$8,$5,100,1,true,now(),now()),
            ($9,$2,$10,'sql',$11,$12,100,1,true,now(),now()),
            ($13,$14,$15,'formula',$4,$5,100,1,true,now(),now())`,
    [
      `plan:${formulaMetricId}`, pid, formulaMetricId,
      JSON.stringify({ expression: 'a + b', operands: { a: { value: 2 }, b: { value: 3 } }, unit: '元' }),
      JSON.stringify({ require_evidence: false }),
      `plan:${parameterMetricId}`, parameterMetricId,
      JSON.stringify({
        sql_template: 'SELECT ? AS value',
        parameters: [{ name: 'period', type: 'string', required: true }],
        result: { value_column: 'value' },
      }),
      `plan:${sqlMetricId}`, sqlMetricId,
      JSON.stringify({
        sql_template: 'SELECT SUM(amount) AS value FROM orders WHERE period = ?',
        parameters: [{ name: 'period', type: 'string', required: true }],
        result: { value_column: 'value', unit: '元' },
      }),
      JSON.stringify({ require_evidence: true }),
      `plan:${foreignMetricId}`, foreignPid, foreignMetricId,
    ],
  );
  await query(
    'UPDATE metric_execution_plans SET source_id=$1, source_type=$2 WHERE metric_id=$3',
    [bindingId, 'database', sqlMetricId],
  );
  const internalLeak = `/private/secret/customer-${suffix}.duckdb SELECT secret_value FROM hidden_table`;
  await query(
    `INSERT INTO metric_execution_plans
       (id, project_id, metric_id, plan_type, spec, evidence_policy,
        priority, version, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,'formula',$4,$5,100,1,true,now(),now())`,
    [
      `plan:${failingMetricId}`,
      pid,
      failingMetricId,
      JSON.stringify({ expression: 'x', operands: { [internalLeak]: {} } }),
      JSON.stringify({ require_evidence: false }),
    ],
  );
  t.after(async () => {
    await query('DELETE FROM metric_execution_plans WHERE metric_id = ANY($1)', [
      [formulaMetricId, parameterMetricId, sqlMetricId, failingMetricId, foreignMetricId],
    ]);
    await query('DELETE FROM metric_definitions WHERE id = ANY($1)', [
      [formulaMetricId, parameterMetricId, sqlMetricId, failingMetricId, foreignMetricId],
    ]);
    await query('DELETE FROM business_data_sources WHERE id=$1', [bindingId]);
    await query('DELETE FROM database_connections WHERE id=$1', [connectionId]);
    rmSync(duckDir, { recursive: true, force: true });
  });

  const completed = await executeMetric(ctx, {
    params: { pid, mid: formulaMetricId }, body: { parameters: {} },
  });
  assert.equal(completed.data.success, true);
  assert.equal(completed.data.executed, true);
  assert.equal(completed.data.metric_id, formulaMetricId);
  assert.deepEqual(completed.data.result, {
    value: 5,
    raw_value: null,
    value_column: null,
    unit: '元',
    operands: [
      { name: 'a', metric_id: null, value: 2 },
      { name: 'b', metric_id: null, value: 3 },
    ],
  });
  assert.deepEqual(completed.data.evidence_summary, {
    count: 0,
    validation_status: 'not_required',
    items: [],
  });

  const sqlCompleted = await executeMetric(ctx, {
    params: { pid, mid: sqlMetricId }, body: { parameters: { period: '2026-07' } },
  });
  assert.equal(sqlCompleted.data.success, true);
  assert.equal(sqlCompleted.data.executed, true);
  assert.equal(sqlCompleted.data.result.value, 42);
  assert.equal(sqlCompleted.data.evidence_summary.count, 1);
  assert.equal(sqlCompleted.data.evidence_summary.items[0].result.status, 'completed');
  assert.equal(sqlCompleted.data.evidence_summary.items[0].result.row_count, 1);
  assert.equal(sqlCompleted.data.evidence_summary.items[0].source.name, '试跑本地库');
  const serializedSqlResult = JSON.stringify(sqlCompleted.data);
  assert.doesNotMatch(serializedSqlResult, /SELECT SUM\(amount\)/);
  assert.doesNotMatch(serializedSqlResult, new RegExp(duckPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await query(
    'UPDATE metric_execution_plans SET source_id=$1 WHERE metric_id=$2',
    [`deleted-or-foreign-binding-${suffix}`, sqlMetricId],
  );
  const missingBoundSource = await executeMetric(ctx, {
    params: { pid, mid: sqlMetricId }, body: { parameters: { period: '2026-07' } },
  });
  assert.equal(missingBoundSource.data.success, false);
  assert.equal(missingBoundSource.data.executed, false);
  assert.equal(missingBoundSource.data.error, '指标试跑失败，请检查指标定义和数据源配置');
  assert.doesNotMatch(JSON.stringify(missingBoundSource.data), /SELECT SUM\(amount\)|deleted-or-foreign-binding/);
  await query(
    'UPDATE metric_execution_plans SET source_id=$1 WHERE metric_id=$2',
    [bindingId, sqlMetricId],
  );

  const clarification = await executeMetric(ctx, {
    params: { pid, mid: parameterMetricId }, body: { parameters: {} },
  });
  assert.equal(clarification.data.success, false);
  assert.equal(clarification.data.executed, false);
  assert.equal(clarification.data.needs_clarification, true);
  assert.deepEqual(clarification.data.required_parameters, [
    { name: 'period', type: 'string', required: true },
  ]);
  assert.match(clarification.data.error, /缺少参数: period/);

  const failed = await executeMetric(ctx, {
    params: { pid, mid: failingMetricId }, body: { parameters: {} },
  });
  assert.equal(failed.data.success, false);
  assert.equal(failed.data.executed, false);
  assert.equal(failed.data.needs_clarification, false);
  assert.equal(failed.data.error, '指标试跑失败，请检查指标定义和数据源配置');
  const serializedFailure = JSON.stringify(failed.data);
  assert.doesNotMatch(serializedFailure, /\/private\/secret/);
  assert.doesNotMatch(serializedFailure, /SELECT secret_value FROM hidden_table/);

  await assert.rejects(
    () => executeMetric(ctx, {
      params: { pid, mid: foreignMetricId }, body: { parameters: {} },
    }),
    (error) => error.status === 404 && /指标不存在/.test(error.message),
  );
  await assert.rejects(
    () => executeMetric(ctx, {
      params: { pid, mid: 'missing-metric' }, body: { parameters: {} },
    }),
    (error) => error.status === 404 && /指标不存在/.test(error.message),
  );
  await assert.rejects(
    () => executeMetric(ctx, {
      params: { pid, mid: formulaMetricId }, body: { parameters: [] },
    }),
    (error) => error.status === 400 && /parameters 必须是 JSON 对象/.test(error.message),
  );
});

test('metric view preview compiles joins, dimensions and demo SQL', () => {
  const preview = compileMetricViewPreview({
    source_id: 'source-1',
    tables: [
      { table_key: 'main', table_ref: 'sales.orders', join_conditions: [] },
      {
        table_key: 'customer', table_ref: 'sales.customers', join_type: 'left',
        join_conditions: [{
          kind: 'field_compare', operator: '=',
          left: { table_key: 'main', column_name: 'customer_id' },
          right: { table_key: 'customer', column_name: 'id' },
        }],
      },
    ],
    fixed_predicates: [{
      kind: 'comparison', operator: '>', field: { table_key: 'main', column_name: 'amount' }, value: 0,
    }],
    query_dimensions: [{
      name: 'region', op: '=', param_type: 'discrete', required: true,
      allowed_values: ['华东'], field: { table_key: 'customer', column_name: 'region' },
    }],
    projections: [{
      projection_key: 'total', kind: 'aggregate', function: 'sum', alias: 'total_amount',
      field: { table_key: 'main', column_name: 'amount' },
    }],
    group_by: null,
    sort_spec: { order_by: [{ kind: 'projection', projection_key: 'total', direction: 'DESC' }], limit_default: 50 },
  });

  assert.equal(preview.validation.status, 'success');
  assert.match(preview.template_sql, /LEFT JOIN "sales"\."customers" AS "customer"/);
  assert.match(preview.template_sql, /"customer"\."region" = :region/);
  assert.match(preview.demo_sql, /"customer"\."region" = '华东'/);
  assert.match(preview.demo_sql, /LIMIT 50/);

  const invalid = compileMetricViewPreview({ tables: [], projections: [] });
  assert.equal(invalid.validation.status, 'error');
  assert.match(invalid.validation.errors[0], /至少需要一张表/);
});

test('semantic lists expose real vector state, paging and statistics', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pid = `semantic-project-${suffix}`;
  const metricId = `semantic-metric-${suffix}`;
  const exampleA = `semantic-example-a-${suffix}`;
  const exampleB = `semantic-example-b-${suffix}`;
  const viewId = `semantic-view-${suffix}`;

  await query(
    `INSERT INTO metric_definitions
       (id, project_id, name, aliases, related_tables, related_columns, embedding, is_active, created_at, updated_at)
     VALUES ($1,$2,'收入','["营收"]','["orders"]','{"orders":["amount"]}',NULL,true,now(),now())`,
    [metricId, pid],
  );
  await query(
    `INSERT INTO metric_execution_plans
       (id, project_id, metric_id, plan_type, spec, evidence_policy, priority, version, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,'sql','{"sql_template":"SELECT 1 AS value"}','{"require_evidence":false}',100,1,true,now(),now())`,
    [`plan:${metricId}`, pid, metricId],
  );
  await query(
    `INSERT INTO examples
       (id, project_id, example_type, question, content, embedding, embedding_model, is_active, created_at, updated_at)
     VALUES ($1,$3,'sql','问题一','SELECT 1',NULL,NULL,true,now(),now()),
            ($2,$3,'qa','问题二','答案','[0.1]','test',true,now(),now())`,
    [exampleA, exampleB, pid],
  );
  await query(
    `INSERT INTO metric_view_definitions
       (id, project_id, source_id, name, tables, projections, sort_spec, status, embedding_model, created_at, updated_at)
     VALUES ($1,$2,'source','收入视图','[]','[]','{}','draft','test',now(),now())`,
    [viewId, pid],
  );

  t.after(async () => {
    await query('DELETE FROM metric_view_definitions WHERE id=$1', [viewId]);
    await query('DELETE FROM examples WHERE id = ANY($1)', [[exampleA, exampleB]]);
    await query('DELETE FROM metric_execution_plans WHERE metric_id=$1', [metricId]);
    await query('DELETE FROM metric_definitions WHERE id=$1', [metricId]);
  });

  const metrics = await listMetrics(ctx, { params: { pid }, query: { page: 1, page_size: 10 } });
  assert.equal(metrics.data.total, 1);
  assert.deepEqual(metrics.data.items[0].aliases, ['营收']);
  assert.equal(metrics.data.items[0].execution_plans[0].plan_type, 'sql');
  assert.equal(metrics.data.items[0].has_embedding, 0);
  const pending = await getMetricsEmbeddingPendingCount(ctx, { params: { pid } });
  assert.deepEqual(pending.data, { pending: 1, count: 1 });

  const examples = await listExamples(ctx, { params: { pid }, query: { page: 1, page_size: 1 } });
  assert.equal(examples.data.total, 2);
  assert.equal(examples.data.items.length, 1);
  assert.ok(Object.hasOwn(examples.data.items[0], 'has_embedding'));
  const stats = await getExamplesStats(ctx, { params: { pid } });
  assert.deepEqual(stats.data, { total: 2, by_type: { qa: 1, sql: 1 } });

  const views = await listMetricViews(ctx, { params: { pid }, query: { page: 1, page_size: 10 } });
  assert.equal(views.data.items[0].embedding_model, 'test');
  assert.deepEqual(views.data.items[0].tables, []);
  const matchingViews = await listMetricViews(ctx, {
    params: { pid }, query: { page: 1, page_size: 10, keyword: '收入' },
  });
  assert.equal(matchingViews.data.total, 1);
  const missingViews = await listMetricViews(ctx, {
    params: { pid }, query: { page: 1, page_size: 10, keyword: '不存在的视图' },
  });
  assert.equal(missingViews.data.total, 0);
});

test('metric-view recommendation can be saved as a real draft', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pid = `recommend-project-${suffix}`;
  const connectionId = `recommend-connection-${suffix}`;
  const bindingId = `recommend-binding-${suffix}`;
  const metricId = `recommend-metric-${suffix}`;
  const tableId = `recommend-table-${suffix}`;
  const columnId = `recommend-column-${suffix}`;
  const sessionId = `recommend-session-${suffix}`;
  const questionId = `recommend-question-${suffix}`;
  const foreignPid = `recommend-foreign-project-${suffix}`;
  const foreignSessionId = `recommend-foreign-session-${suffix}`;
  const foreignQuestionId = `recommend-foreign-question-${suffix}`;

  await query(
    `INSERT INTO database_connections (id, project_id, name, db_type, database, created_at, updated_at)
     VALUES ($1,$2,'推荐数据','sqlite','test.db',now(),now())`,
    [connectionId, pid],
  );
  await query(
    `INSERT INTO business_data_sources (id, project_id, source_type, source_id, created_at, updated_at)
     VALUES ($1,$2,'database_connection',$3,now(),now())`,
    [bindingId, pid, connectionId],
  );
  await query(
    `INSERT INTO metric_definitions
       (id, project_id, name, description, aliases, related_tables, related_columns, is_active, created_at, updated_at)
     VALUES ($1,$2,'订单金额','订单金额指标','[]','["orders"]','{"orders":["amount"]}',true,now(),now())`,
    [metricId, pid],
  );
  await query(
    `INSERT INTO metric_execution_plans
       (id, project_id, metric_id, plan_type, source_id, source_type, spec, evidence_policy,
        priority, version, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,'sql',$4,'database','{"sql_template":"SELECT SUM(amount) FROM orders"}','{}',100,1,true,now(),now())`,
    [`plan:${metricId}`, pid, metricId, connectionId],
  );
  await query(
    `INSERT INTO table_metadata
       (id, database_connection_id, table_name, table_type, created_at, updated_at)
     VALUES ($1,$2,'orders','TABLE',now(),now())`,
    [tableId, connectionId],
  );
  await query(
    `INSERT INTO column_metadata
       (id, table_id, column_name, data_type, created_at, updated_at)
     VALUES ($1,$2,'amount','DECIMAL',now(),now())`,
    [columnId, tableId],
  );
  const validViewDefinition = {
    name: '订单金额严格校验视图',
    source_id: bindingId,
    status: 'draft',
    tables: [{ table_key: 'main', table_ref: 'orders', join_conditions: [] }],
    fixed_predicates: [],
    query_dimensions: [],
    time_dimension: null,
    projections: [{
      projection_key: 'amount', kind: 'aggregate', function: 'sum', alias: 'amount',
      field: { table_key: 'main', column_name: 'amount' },
    }],
    group_by: [],
    sort_spec: { order_by: [], limit_default: 100 },
  };
  const strictPreview = await previewMetricView(ctx, {
    params: { pid }, body: validViewDefinition,
  });
  assert.equal(strictPreview.data.validation.status, 'success');
  assert.equal(strictPreview.data.definition.tables[0].table_ref, 'orders');
  await assert.rejects(
    () => previewMetricView(ctx, {
      params: { pid },
      body: {
        ...validViewDefinition,
        projections: [{
          projection_key: 'missing', kind: 'field',
          field: { table_key: 'main', column_name: 'missing_column' },
        }],
      },
    }),
    (error) => error.status === 400 && /不存在的列/.test(error.message),
  );
  await assert.rejects(
    () => createMetricView(ctx, {
      params: { pid },
      body: {
        ...validViewDefinition,
        name: '未知投影类型不能保存',
        projections: [{
          projection_key: 'amount', kind: 'sum',
          field: { table_key: 'main', column_name: 'amount' },
        }],
      },
    }),
    (error) => error.status === 400 && /kind 必须是 field、aggregate 或 expression/.test(error.message),
  );
  await query(
    `INSERT INTO sessions
       (id, project_id, created_by, source_type, source_id, title, created_at, updated_at)
     VALUES ($1,$2,$3,'project',$2,'订单分析',now(),now())`,
    [sessionId, pid, userId],
  );
  await query(
    `INSERT INTO session_messages
       (id, session_id, role, content_items, sequence_number, created_at, updated_at)
     VALUES ($1,$2,'user',$3,1,now(),now())`,
    [questionId, sessionId, JSON.stringify([{ type: 'text', content: '查询订单金额' }])],
  );
  await query(
    `INSERT INTO sessions
       (id, project_id, created_by, source_type, source_id, title, created_at, updated_at)
     VALUES ($1,$2,$3,'project',$2,'其他项目分析',now(),now())`,
    [foreignSessionId, foreignPid, userId],
  );
  await query(
    `INSERT INTO session_messages
       (id, session_id, role, content_items, sequence_number, created_at, updated_at)
     VALUES ($1,$2,'user',$3,1,now(),now())`,
    [foreignQuestionId, foreignSessionId, JSON.stringify([{ type: 'text', content: '其他项目的秘密问题' }])],
  );

  let taskId = null;
  let failedTaskId = null;
  let viewId = null;
  t.after(async () => {
    if (viewId) await query('DELETE FROM metric_view_definitions WHERE id=$1', [viewId]);
    if (taskId) await query('DELETE FROM metric_view_recommendation_tasks WHERE id=$1', [taskId]);
    if (failedTaskId) await query('DELETE FROM metric_view_recommendation_tasks WHERE id=$1', [failedTaskId]);
    await query('DELETE FROM session_messages WHERE id=$1', [foreignQuestionId]);
    await query('DELETE FROM sessions WHERE id=$1', [foreignSessionId]);
    await query('DELETE FROM session_messages WHERE id=$1', [questionId]);
    await query('DELETE FROM sessions WHERE id=$1', [sessionId]);
    await query('DELETE FROM column_metadata WHERE id=$1', [columnId]);
    await query('DELETE FROM table_metadata WHERE id=$1', [tableId]);
    await query('DELETE FROM metric_execution_plans WHERE metric_id=$1', [metricId]);
    await query('DELETE FROM metric_definitions WHERE id=$1', [metricId]);
    await query('DELETE FROM business_data_sources WHERE id=$1', [bindingId]);
    await query('DELETE FROM database_connections WHERE id=$1', [connectionId]);
  });

  const originalRecommend = MetricViewRecommendationService.recommend;
  MetricViewRecommendationService.recommend = (options) => originalRecommend.call(
    MetricViewRecommendationService,
    {
      ...options,
      chatFn: async (messages) => {
        const prompt = JSON.stringify(messages);
        assert.match(prompt, /查询订单金额/);
        assert.doesNotMatch(prompt, /其他项目的秘密问题/);
        return {
          candidates: [{
            metric_id: metricId,
            supporting_question_ids: [questionId],
            name: '订单金额视图',
            description: '根据历史订单金额问题推荐',
            aliases: [],
            confidence: 0.95,
            intent_labels: ['金额汇总'],
            key_challenges: ['保留 SUM 口径'],
            reasoning: '历史问题明确查询订单金额。',
          }],
        };
      },
    },
  );
  let completedTask;
  try {
    const taskResult = await runMetricViewRecommendation(ctx, {
      params: { pid }, body: { source_id: bindingId, max_questions: 10 },
    });
    taskId = taskResult.data.id;
    assert.equal(taskResult.data.status, 'pending');
    completedTask = await waitForRecommendation(pid, taskId);
  } finally {
    MetricViewRecommendationService.recommend = originalRecommend;
  }
  assert.equal(completedTask.status, 'completed', completedTask.error_message || 'task failed');
  assert.equal(completedTask.stats.questions_scanned, 1);
  assert.equal(completedTask.stats.llm_calls, 1);
  assert.equal(completedTask.candidates.length, 1);
  assert.equal(completedTask.candidates[0].source_id, bindingId);
  assert.equal(completedTask.candidates[0].projections[0].kind, 'aggregate');
  assert.equal(completedTask.candidates[0].projections[0].function, 'sum');
  assert.equal(completedTask.candidates[0].supporting_questions[0].question_id, questionId);

  const applied = await applyMetricViewRecommendation(ctx, {
    params: { pid, taskId }, body: { selections: [{ candidate_id: completedTask.candidates[0].candidate_id }] },
  });
  assert.equal(applied.data.results[0].success, true);
  viewId = applied.data.results[0].view_id;
  const row = await queryOne('SELECT status, project_id, projections FROM metric_view_definitions WHERE id=$1', [viewId]);
  assert.equal(row.status, 'draft');
  assert.equal(row.project_id, pid);
  await assert.rejects(
    () => updateMetricView(ctx, {
      params: { pid, mvid: viewId },
      body: {
        projections: [{
          projection_key: 'amount', kind: 'sum',
          field: { table_key: 'main', column_name: 'amount' },
        }],
      },
    }),
    (error) => error.status === 400 && /kind 必须是 field、aggregate 或 expression/.test(error.message),
  );
  await query(
    `UPDATE metric_view_definitions SET projections=$1, status='draft' WHERE id=$2`,
    [JSON.stringify([{
      projection_key: 'missing', kind: 'field',
      field: { table_key: 'main', column_name: 'missing_column' },
    }]), viewId],
  );
  await assert.rejects(
    () => updateMetricViewStatus(ctx, {
      params: { pid, mvid: viewId }, body: { status: 'active' },
    }),
    (error) => error.status === 400 && /不存在的列/.test(error.message),
  );
  await query(
    `UPDATE metric_view_definitions SET projections=$1, status='draft' WHERE id=$2`,
    [row.projections, viewId],
  );
  const activated = await updateMetricViewStatus(ctx, {
    params: { pid, mvid: viewId }, body: { status: 'active' },
  });
  assert.equal(activated.data.status, 'active');
  await assert.rejects(
    () => updateMetricView(ctx, {
      params: { pid, mvid: viewId }, body: { tables: [] },
    }),
    (error) => error.status === 400 && /至少需要一张表/.test(error.message),
  );

  MetricViewRecommendationService.recommend = async () => {
    throw new AiCapabilityError('AI 模型暂时不可用', { code: 'AI_MODEL_UNAVAILABLE', attempts: 2 });
  };
  let failedTask;
  try {
    const started = await runMetricViewRecommendation(ctx, {
      params: { pid }, body: { source_id: bindingId, max_questions: 10 },
    });
    failedTaskId = started.data.id;
    failedTask = await waitForRecommendation(pid, failedTaskId);
  } finally {
    MetricViewRecommendationService.recommend = originalRecommend;
  }
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.candidates.length, 0);
  assert.equal(failedTask.stats.llm_calls, 2);
  assert.match(failedTask.error_message, /AI 模型暂时不可用/);
});

test('metric Excel/JSON endpoints execute against parsed rows and produce real downloads', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pid = `metric-io-project-${suffix}`;
  let metricId = null;
  t.after(async () => {
    if (metricId) {
      await query('DELETE FROM metric_execution_plans WHERE metric_id=$1', [metricId]);
      await query('DELETE FROM metric_definitions WHERE id=$1', [metricId]);
    }
  });

  const imported = await bulkImportMetrics(ctx, {
    params: { pid }, query: { overwrite: 'false' },
    body: {
      rows: [{
        指标名称: '审计金额',
        执行计划JSON: JSON.stringify([{
          plan_type: 'sql', spec: { sql_template: 'SELECT SUM(amount) AS value FROM audit_orders' },
        }]),
        描述: '审计订单金额',
      }],
      columns: ['指标名称', '执行计划JSON', '描述'],
    },
  });
  assert.equal(imported.data.created, 1);
  const metric = await queryOne(
    'SELECT id, name FROM metric_definitions WHERE project_id=$1',
    [pid],
  );
  metricId = metric.id;
  assert.equal(metric.name, '审计金额');
  const plan = await queryOne(
    'SELECT plan_type, version FROM metric_execution_plans WHERE metric_id=$1 AND deleted_at IS NULL',
    [metricId],
  );
  assert.deepEqual(plan, { plan_type: 'sql', version: 1 });

  const codeImport = await importCodeValues(ctx, {
    params: { pid }, query: { import_format: 'by-metric' },
    body: {
      rows: [{ 指标名称: '审计金额', 字段名: 'status', 码值编码: '1', 码值标签: '有效' }],
      columns: ['指标名称', '字段名', '码值编码', '码值标签'],
    },
  });
  assert.equal(codeImport.data.success, true);
  assert.equal(codeImport.data.success_count, 1);

  const json = await exportCodeValues(ctx, {
    params: { pid }, query: { export_type: 'json' },
  });
  assert.equal(json._binary, true);
  assert.match(json.data.toString('utf8'), /审计金额/);

  const workbook = await exportCodeValues(ctx, {
    params: { pid }, query: { export_type: 'excel', export_format: 'by-metric' },
  });
  assert.equal(workbook._binary, true);
  assert.ok(Buffer.isBuffer(workbook.data));
  assert.ok(workbook.data.length > 100);
});

test('metric bulk import accepts formula plans without an SQL compatibility column', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pid = `metric-native-import-${suffix}`;
  t.after(async () => {
    await query('DELETE FROM metric_execution_plans WHERE project_id=$1', [pid]);
    await query('DELETE FROM metric_definitions WHERE project_id=$1', [pid]);
  });
  const formulaSpec = {
    expression: 'a + b',
    operands: { a: { value: 1 }, b: { value: 2 } },
    unit: '人民币元',
  };
  const imported = await bulkImportMetrics(ctx, {
    params: { pid }, query: { overwrite: 'false' },
    body: {
      rows: [
        {
          指标名称: '附加税合计',
          执行计划JSON: JSON.stringify([{
            plan_type: 'formula', spec: formulaSpec, evidence_policy: { require_evidence: false },
          }]),
        },
      ],
      columns: ['指标名称', '执行计划JSON'],
    },
  });

  assert.equal(imported.data.created, 1);
  const metrics = await query(
    `SELECT name FROM metric_definitions
      WHERE project_id=$1 ORDER BY name`,
    [pid],
  );
  assert.deepEqual(metrics.map((item) => item.name), ['附加税合计']);
  const plans = await query(
    `SELECT plan_type, spec FROM metric_execution_plans
      WHERE project_id=$1 AND deleted_at IS NULL ORDER BY plan_type`,
    [pid],
  );
  assert.deepEqual(plans.map((item) => item.plan_type), ['formula']);
});

test('metric CRUD keeps execution plans versioned without inline compatibility fields', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pid = `metric-plan-crud-${suffix}`;
  let metricId = null;
  t.after(async () => {
    if (!metricId) return;
    await query('DELETE FROM metric_execution_plans WHERE metric_id=$1', [metricId]);
    await query('DELETE FROM metric_definitions WHERE id=$1', [metricId]);
  });
  const firstSpec = { expression: 'a + b', operands: { a: { value: 1 }, b: { value: 2 } }, unit: '元' };
  const columns = await query('PRAGMA table_info("metric_definitions")');
  const columnNames = columns.map((column) => column.name);
  for (const legacy of ['sql_template', 'execution_type', 'execution_spec', 'evidence_policy', 'source_id', 'source_type']) {
    assert.equal(columnNames.includes(legacy), false, `${legacy} 不应继续存在于 metric_definitions`);
  }
  await assert.rejects(
    () => createMetric(ctx, {
      params: { pid },
      body: { name: '旧接口必须失败', execution_type: 'formula', execution_spec: firstSpec },
    }),
    (error) => error.status === 400 && /不接受旧字段/.test(error.message),
  );
  for (const sqlTemplate of ['DELETE FROM orders', 'SELECT 1 AS value; DELETE FROM orders']) {
    await assert.rejects(
      () => createMetric(ctx, {
        params: { pid },
        body: {
          name: '不安全 SQL 必须失败',
          execution_plans: [{ plan_type: 'sql', spec: { sql_template: sqlTemplate } }],
        },
      }),
      (error) => error.status === 400 && /单条只读 SELECT\/WITH/.test(error.message),
    );
  }
  await assert.rejects(
    () => createMetric(ctx, {
      params: { pid },
      body: {
        name: '不支持的复杂参数必须失败',
        execution_plans: [{
          plan_type: 'sql',
          spec: {
            sql_template: 'SELECT ? AS value',
            parameters: [{ name: 'periods', type: 'array', required: true }],
          },
        }],
      },
    }),
    (error) => error.status === 400 && /type 必须是 string、number、integer、boolean、date/.test(error.message),
  );
  const created = await createMetric(ctx, {
    params: { pid },
    body: {
      name: '公式计划版本测试',
      execution_plans: [{
        plan_type: 'formula', spec: firstSpec, evidence_policy: { require_evidence: false },
      }],
    },
  });
  metricId = created.data.id;
  assert.equal(Object.hasOwn(created.data, 'sql_template'), false);
  let currentPlan = await queryOne(
    'SELECT id, plan_type, source_id, source_type, spec, evidence_policy, priority, version, is_active FROM metric_execution_plans WHERE metric_id=$1 AND deleted_at IS NULL',
    [metricId],
  );
  assert.equal(currentPlan.version, 1);

  await updateMetric(ctx, {
    params: { pid, mid: metricId },
    body: { description: '只修改业务说明，不产生执行计划新版本' },
  });
  assert.equal((await queryOne(
    'SELECT version FROM metric_execution_plans WHERE metric_id=$1 AND deleted_at IS NULL',
    [metricId],
  )).version, 1);

  await updateMetric(ctx, {
    params: { pid, mid: metricId },
    body: {
      execution_plans: [{
        id: currentPlan.id,
        plan_type: 'formula',
        spec: { expression: 'a + b', operands: { a: { value: 2 }, b: { value: 3 } }, unit: '元' },
        evidence_policy: JSON.parse(currentPlan.evidence_policy),
        priority: currentPlan.priority,
        is_active: true,
      }],
    },
  });
  assert.equal((await queryOne(
    'SELECT version FROM metric_execution_plans WHERE metric_id=$1 AND deleted_at IS NULL',
    [metricId],
  )).version, 2);

  const current = await queryOne('SELECT * FROM metric_definitions WHERE id=$1', [metricId]);
  currentPlan = await queryOne(
    'SELECT id, plan_type, source_id, source_type, spec, evidence_policy, priority, version, is_active FROM metric_execution_plans WHERE metric_id=$1 AND deleted_at IS NULL',
    [metricId],
  );
  await MetricService.update_metric(ctx, {
    metric_id: metricId,
    project_id: pid,
    name: current.name,
    description: '服务层重复保存同一执行规则，也不产生新版本',
    aliases: JSON.parse(current.aliases || '[]'),
    related_tables: JSON.parse(current.related_tables || '[]'),
    related_columns: JSON.parse(current.related_columns || '{}'),
    execution_plans: [{
      id: currentPlan.id,
      plan_type: currentPlan.plan_type,
      source_id: currentPlan.source_id,
      source_type: currentPlan.source_type,
      spec: JSON.parse(currentPlan.spec),
      evidence_policy: JSON.parse(currentPlan.evidence_policy),
      priority: currentPlan.priority,
      is_active: currentPlan.is_active !== 0,
    }],
    is_active: current.is_active !== 0,
  });
  assert.equal((await queryOne(
    'SELECT version FROM metric_execution_plans WHERE metric_id=$1 AND deleted_at IS NULL',
    [metricId],
  )).version, 2);

  await deleteMetric(ctx, { params: { pid, mid: metricId } });
  assert.ok((await queryOne('SELECT deleted_at FROM metric_definitions WHERE id=$1', [metricId])).deleted_at);
  const deletedPlan = await queryOne(
    'SELECT deleted_at, is_active FROM metric_execution_plans WHERE metric_id=$1',
    [metricId],
  );
  assert.ok(deletedPlan.deleted_at);
  assert.equal(deletedPlan.is_active, 0);
});

test('entity import, search, agent test and auto-generated revert form a working loop', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pid = `entity-project-${suffix}`;
  let configId = null;
  t.after(async () => {
    if (configId) {
      await query('DELETE FROM entity_mappings WHERE config_id=$1', [configId]);
      await query('DELETE FROM entity_mapping_configs WHERE id=$1', [configId]);
    }
  });

  const imported = await importEntities(ctx, {
    params: { pid },
    body: { config_name: '客户名词', entities: [{ name: '上海客户', city: '上海' }, { name: '北京客户', city: '北京' }] },
  });
  configId = imported.data.config_id;
  assert.equal(imported.data.count, 2);

  const searched = await searchEntities(ctx, {
    params: { pid }, query: { query: '上海', limit: 10 }, body: {},
  });
  assert.equal(searched.data.items[0].entity_name, '上海客户');
  assert.ok(searched.data.items[0].similarity > 0);

  const originalRun = EntityAgentService.run;
  EntityAgentService.run = (options) => originalRun.call(EntityAgentService, {
    ...options,
    chatFn: async () => ({
      matches: [{
        entity_id: String(options.candidates[0].id),
        original_text: '上海',
        confidence: 0.96,
        reasoning: '问题中的上海对应上海客户。',
      }],
    }),
  });
  let agent;
  try {
    agent = await testEntityAgent(ctx, {
      params: { pid }, body: { question: '查询上海的订单' }, query: {},
    });
  } finally {
    EntityAgentService.run = originalRun;
  }
  assert.equal(agent.data.user_message, '查询上海客户的订单');
  assert.equal(agent.data.entities[0].original_text, '上海');
  assert.equal(agent.data.entities[0].entity_value, '上海客户');

  await query('UPDATE entity_mapping_configs SET auto_promoted=true WHERE id=$1', [configId]);
  const reverted = await revertAutoPromoted(ctx, { params: { pid }, body: {}, query: {} });
  assert.equal(reverted.data.reverted_count, 1);
  const config = await queryOne('SELECT deleted_at FROM entity_mapping_configs WHERE id=$1', [configId]);
  assert.ok(config.deleted_at);
});

test('intermediate result description and persistence create a real structured source contract', async () => {
  const original = {
    list: IntermediateStorageService.list_tables,
    schema: IntermediateStorageService.get_table_schema,
    sample: IntermediateStorageService.get_sample_rows,
    read: IntermediateStorageService.read_dataframe,
    write: IntermediateStorageService.write_dataframe,
  };
  const statements = [];
  const fakeCtx = {
    userId,
    queryOne: async (sql) => {
      if (sql.includes('FROM sessions')) return { id: 'session-1', title: '收入分析' };
      if (sql.includes('FROM session_intermediate_tables')) return null;
      return null;
    },
    query: async (sql, params) => { statements.push({ sql, params }); return []; },
  };
  IntermediateStorageService.list_tables = async () => [{
    table_name: 'r_income', description: '', row_count: 2, column_count: 2,
    sub_query: '收入', sql_query: 'SELECT month, revenue FROM income',
  }];
  IntermediateStorageService.get_table_schema = async () => [
    { name: 'month', type: 'VARCHAR' }, { name: 'revenue', type: 'DOUBLE' },
  ];
  IntermediateStorageService.get_sample_rows = async () => [{ month: '2026-01', revenue: 10 }];
  IntermediateStorageService.read_dataframe = async () => [
    { month: '2026-01', revenue: 10 }, { month: '2026-02', revenue: 12 },
  ];
  IntermediateStorageService.write_dataframe = async (_path, records, name) => ({
    success: true, table_name: name, row_count: records.length, column_count: 2,
  });
  try {
    const described = await generateIntermediateDescription(fakeCtx, {
      params: { pid: 'project-1', sid: 'session-1' }, body: { selected_tables: ['r_income'] },
    });
    assert.equal(described.data.total, 1);
    assert.match(described.data.items[0].description, /2 行/);
    assert.ok(statements.some((item) => item.sql.includes('INSERT INTO session_intermediate_tables')));

    statements.length = 0;
    const persisted = await persistIntermediate(fakeCtx, {
      params: { pid: 'project-1', sid: 'session-1' },
      body: { selected_tables: ['r_income'], name: '收入快照' },
    });
    assert.equal(persisted.data.name, '收入快照');
    assert.equal(persisted.data.tables[0].table_name, 'r_income');
    assert.ok(statements.some((item) => item.sql.includes('INSERT INTO structured_data_sources')));
    assert.ok(statements.some((item) => item.sql.includes('INSERT INTO business_data_sources')));
    assert.ok(statements.some((item) => item.sql.includes('INSERT INTO table_metadata')));
  } finally {
    IntermediateStorageService.list_tables = original.list;
    IntermediateStorageService.get_table_schema = original.schema;
    IntermediateStorageService.get_sample_rows = original.sample;
    IntermediateStorageService.read_dataframe = original.read;
    IntermediateStorageService.write_dataframe = original.write;
  }
});
