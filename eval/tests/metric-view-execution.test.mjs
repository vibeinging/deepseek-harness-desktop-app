import assert from 'node:assert/strict';
import test from 'node:test';

import { QueryResult } from '../../server/src/engine/datasources/data_source.js';
import { MetricViewExecutionService } from '../../server/src/engine/semantic/metric_view_execution_service.js';
import { canonicalize_metric_view_definition } from '../../server/src/engine/semantic/metric_view_canonicalizer.js';
import {
  compileMetricViewExecution,
  compileMetricViewPreview,
} from '../../server/src/engine/semantic/metric_view_runtime.js';

function definition(overrides = {}) {
  return {
    id: 'view-tax-facts',
    project_id: 'project-tax',
    source_id: 'source-tax',
    name: '税费事实明细',
    tables: [{ table_key: 'main', table_ref: 'pdf_tax_facts', join_conditions: [] }],
    fixed_predicates: [{
      kind: 'comparison', operator: '=',
      field: { table_key: 'main', column_name: 'validation_status' },
      value: 'verified_source',
    }],
    query_dimensions: [{
      name: 'period', op: '=', param_type: 'discrete', required: true,
      allowed_values: ['2022-06', '2022'],
      field: { table_key: 'main', column_name: 'period' },
    }],
    time_dimension: null,
    projections: [
      { projection_key: 'indicator', kind: 'field', alias: '指标', field: { table_key: 'main', column_name: 'indicator' } },
      { projection_key: 'column_path', kind: 'field', alias: '分组路径', field: { table_key: 'main', column_name: 'column_path' } },
      { projection_key: 'value', kind: 'field', alias: '金额', field: { table_key: 'main', column_name: 'value' } },
    ],
    group_by: [],
    sort_spec: { order_by: [{ kind: 'field', field: { table_key: 'main', column_name: 'indicator' }, direction: 'ASC' }], limit_default: 100 },
    status: 'active',
    ...overrides,
  };
}

test('metric view execution asks for required parameters and validates allowed values', () => {
  const missing = compileMetricViewExecution(definition(), {});
  assert.equal(missing.needs_clarification, true);
  assert.deepEqual(missing.missing_parameters, ['period']);

  const invalid = compileMetricViewExecution(definition(), { period: '2023-01' });
  assert.equal(invalid.needs_clarification, true);
  assert.match(invalid.invalid_parameters[0].error, /允许值之一/);
});

test('metric view execution skips an omitted optional dimension instead of comparing it with NULL', () => {
  const compiled = compileMetricViewExecution(definition({
    query_dimensions: [{
      name: 'period', op: '=', param_type: 'discrete', required: false, allowed_values: [],
      field: { table_key: 'main', column_name: 'period' },
    }],
  }), {});
  assert.equal(compiled.success, true);
  assert.doesNotMatch(compiled.sql, /"period"\s*=\s*(NULL|\?)/);
  assert.deepEqual(compiled.parameters, []);
});

test('metric view execution compiles dynamic values as parameters and preserves grouped output', () => {
  const compiled = compileMetricViewExecution(definition({
    projections: [
      { projection_key: 'indicator', kind: 'field', alias: '指标', field: { table_key: 'main', column_name: 'indicator' } },
      { projection_key: 'amount', kind: 'aggregate', function: 'sum', alias: '金额', field: { table_key: 'main', column_name: 'value' } },
    ],
    group_by: [{ kind: 'field', field: { table_key: 'main', column_name: 'indicator' } }],
  }), { period: '2022-06' });
  assert.equal(compiled.success, true);
  assert.match(compiled.sql, /"main"\."period" = \?/);
  assert.match(compiled.sql, /GROUP BY "main"\."indicator"/);
  assert.deepEqual(compiled.parameters, ['2022-06']);
  assert.deepEqual(compiled.parameter_names, ['period']);
  assert.doesNotMatch(compiled.sql, /2022-06/);
});

test('metric view compiler rejects mutating advanced expressions', () => {
  const preview = compileMetricViewPreview(definition({
    fixed_predicates: [{ kind: 'template', expression_template: '{{main.period}} = 1 OR DELETE FROM users' }],
  }));
  assert.equal(preview.validation.status, 'error');
  assert.match(preview.validation.errors[0], /不安全内容/);
});

test('metric view compiler rejects unknown projection kinds instead of treating them as SUM', () => {
  const unknownKind = compileMetricViewPreview(definition({
    projections: [{
      projection_key: 'amount', kind: 'sum', alias: '金额',
      field: { table_key: 'main', column_name: 'value' },
    }],
  }));
  assert.equal(unknownKind.validation.status, 'error');
  assert.match(unknownKind.validation.errors[0], /kind 必须是 field、aggregate 或 expression/);

  const missingFunction = compileMetricViewPreview(definition({
    projections: [{
      projection_key: 'amount', kind: 'aggregate', alias: '金额',
      field: { table_key: 'main', column_name: 'value' },
    }],
  }));
  assert.equal(missingFunction.validation.status, 'error');
  assert.match(missingFunction.validation.errors[0], /缺少 function/);
});

test('metric view source validation resolves structured bindings to their database schema', async () => {
  const ctx = {
    async queryOne(sql) {
      if (sql.includes('FROM business_data_sources')) {
        return { id: 'binding-1', source_type: 'structured_data_source', source_id: 'structured-1' };
      }
      if (sql.includes('FROM structured_data_sources')) {
        return { database_connection_id: 'connection-1' };
      }
      return null;
    },
    async query(sql, params) {
      if (sql.includes('FROM table_metadata')) {
        assert.deepEqual(params, ['connection-1']);
        return [{ id: 'table-1', schema_name: 'sales', table_name: 'orders' }];
      }
      if (sql.includes('FROM column_metadata')) {
        return [{ table_id: 'table-1', column_name: 'amount' }];
      }
      return [];
    },
  };
  const canonical = await canonicalize_metric_view_definition(ctx, definition({
    tables: [{ table_key: 'main', table_ref: 'orders', join_conditions: [] }],
    fixed_predicates: [],
    query_dimensions: [],
    projections: [{
      projection_key: 'amount', kind: 'field',
      field: { table_key: 'main', column_name: 'amount' },
    }],
    sort_spec: { order_by: [], limit_default: 100 },
  }), { source_id: 'binding-1', strict_source_resolution: true });
  assert.equal(canonical.tables[0].table_ref, 'sales.orders');
});

test('MetricViewExecutionService executes the saved definition and enriches source evidence', async () => {
  const row = definition({
    aliases: JSON.stringify(['税费明细']),
    tables: JSON.stringify(definition().tables),
    fixed_predicates: JSON.stringify(definition().fixed_predicates),
    query_dimensions: JSON.stringify(definition().query_dimensions),
    projections: JSON.stringify(definition().projections),
    group_by: JSON.stringify([]),
    sort_spec: JSON.stringify(definition().sort_spec),
  });
  const ctx = {
    async queryOne(sql, params) {
      assert.match(sql, /metric_view_definitions/);
      assert.deepEqual(params, ['view-tax-facts', 'project-tax']);
      return row;
    },
  };
  const calls = [];
  const result = await MetricViewExecutionService.execute(ctx, {
    project_id: 'project-tax',
    definition_id: 'view-tax-facts',
    parameters: { period: '2022-06' },
    query_runner: async (input) => {
      calls.push(input);
      const queryResult = QueryResult.ok([
        { 指标: '城市维护建设税', 分组路径: '计税（费）依据 / 增值税税额', 金额: 46.49 },
      ], ['指标', '分组路径', '金额'], 1);
      queryResult.evidence = {
        version: 'query_execution.v1', evidence_id: 'query-tax-view', produced_by: 'data_source_executor',
        source: { name: 'PDF核验事实库', source_type: 'database_connection' },
        result: { status: 'completed', row_count: 1, columns: ['指标', '分组路径', '金额'] },
      };
      return { query_result: queryResult, source_name: 'PDF核验事实库' };
    },
  });

  assert.equal(result.executed, true);
  assert.equal(result.definition_kind, 'query_view');
  assert.equal(result.output_shape, 'table');
  assert.deepEqual(result.query_result.data[0], {
    指标: '城市维护建设税', 分组路径: '计税（费）依据 / 增值税税额', 金额: 46.49,
  });
  assert.equal(result.evidence.produced_by, 'metric_view_executor');
  assert.equal(result.evidence.business_definition.definition_id, 'view-tax-facts');
  assert.equal(calls[0].source_id, 'source-tax');
  assert.deepEqual(calls[0].parameters, ['2022-06']);
});
