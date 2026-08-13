import assert from 'node:assert/strict';
import test from 'node:test';

import { BusinessDataSources } from '../../server/src/engine/datasources/business_data_sources.js';
import { QueryResult } from '../../server/src/engine/datasources/data_source.js';
import {
  isReadOnlyQueryStatement,
  validateQueryResultEvidence,
} from '../../server/src/engine/agents/query_result_validation.js';
import {
  buildQueryExecutionEvidence,
  extractSqlTableReferences,
} from '../../server/src/engine/datasources/query_execution_evidence.js';

test('SQL evidence extracts real table references without model interpretation', () => {
  assert.deepEqual(
    extractSqlTableReferences(
      'SELECT o.amount, c.name FROM "sales"."orders" o JOIN customers c ON c.id=o.customer_id',
    ),
    [
      { schema: 'sales', table: 'orders' },
      { schema: null, table: 'customers' },
    ],
  );
});

test('query execution evidence binds source, SQL, schema ids, result shape and timing', async () => {
  const sql = 'SELECT o.amount, o.customer_id FROM "sales"."orders" o WHERE o.amount > ?';
  const evidence = await buildQueryExecutionEvidence({
    datasource: {
      id: 'binding-1',
      connection_id: 'connection-1',
      datasource_name: 'Sales DB',
      source_type: 'database_connection',
      db_type: 'duckdb',
    },
    statement: sql,
    parameters: [100],
    result: {
      success: true,
      data: [{ amount: 120, customer_id: 'c1' }, { amount: 180, customer_id: 'c2' }],
      columns: ['amount', 'customer_id'],
      row_count: 2,
      total_count: 2,
    },
    startedAt: '2026-07-29T00:00:00.000Z',
    finishedAt: '2026-07-29T00:00:00.250Z',
    resolver: {
      async queryOne(statement) {
        if (statement.includes('business_data_sources')) {
          return { source_type: 'structured_data_source', source_id: 'file-source-1' };
        }
        return {
          id: 'connection-1', name: 'Sales DB', db_type: 'duckdb', database: 'sales.duckdb',
          schema_config: 'sales', updated_at: '2026-07-28T00:00:00.000Z',
        };
      },
      async query() {
        return [
          {
            table_id: 'table-orders', schema_name: 'sales', table_name: 'orders',
            table_updated_at: '2026-07-28T01:00:00.000Z', column_id: 'column-amount',
            column_name: 'amount', data_type: 'DECIMAL', column_updated_at: '2026-07-28T02:00:00.000Z',
          },
          {
            table_id: 'table-orders', schema_name: 'sales', table_name: 'orders',
            table_updated_at: '2026-07-28T01:00:00.000Z', column_id: 'column-customer',
            column_name: 'customer_id', data_type: 'VARCHAR', column_updated_at: '2026-07-28T02:00:00.000Z',
          },
        ];
      },
    },
  });

  assert.equal(evidence.version, 'query_execution.v1');
  assert.equal(evidence.produced_by, 'data_source_executor');
  assert.equal(evidence.source.binding_id, 'binding-1');
  assert.equal(evidence.source.source_type, 'structured_data_source');
  assert.equal(evidence.source.source_id, 'file-source-1');
  assert.equal(evidence.source.connection_id, 'connection-1');
  assert.equal(evidence.statement.text, sql);
  assert.deepEqual(evidence.statement.parameters, [100]);
  assert.deepEqual(evidence.schema.referenced_tables, [
    { id: 'table-orders', schema_name: 'sales', table_name: 'orders' },
  ]);
  assert.deepEqual(evidence.schema.referenced_columns.map((item) => item.id), ['column-amount', 'column-customer']);
  assert.match(evidence.schema.version, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(evidence.result.columns, ['amount', 'customer_id']);
  assert.equal(evidence.result.row_count, 2);
  assert.equal(evidence.result.status, 'completed');
  assert.equal(evidence.result.empty, false);
  assert.equal(evidence.result.truncated, false);
  assert.match(evidence.result.data_hash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(evidence.result.numeric_summary.amount, {
    count: 2,
    min: 120,
    max: 180,
    sum: 300,
    average: 150,
  });
  assert.equal(evidence.timing.duration_ms, 250);
});

test('result fingerprint changes with row order or values and stays stable for object key order', async () => {
  const makeEvidence = (data) => buildQueryExecutionEvidence({
    datasource: { id: 'source-fingerprint' },
    statement: 'SELECT order_id, amount FROM orders ORDER BY order_id',
    result: { success: true, data, columns: ['order_id', 'amount'], row_count: data.length },
    resolver: { queryOne: async () => null, query: async () => [] },
  });
  const baseline = await makeEvidence([{ order_id: 'o1', amount: 10 }, { order_id: 'o2', amount: 20 }]);
  const same = await makeEvidence([{ amount: 10, order_id: 'o1' }, { amount: 20, order_id: 'o2' }]);
  const reordered = await makeEvidence([{ order_id: 'o2', amount: 20 }, { order_id: 'o1', amount: 10 }]);
  const changed = await makeEvidence([{ order_id: 'o1', amount: 10 }, { order_id: 'o2', amount: 25 }]);
  assert.equal(baseline.result.data_hash, same.result.data_hash);
  assert.notEqual(baseline.result.data_hash, reordered.result.data_hash);
  assert.notEqual(baseline.result.data_hash, changed.result.data_hash);
  assert.equal(changed.result.numeric_summary.amount.sum, 35);
});

test('BusinessDataSources attaches executor evidence to empty query results', async () => {
  const sources = new BusinessDataSources('project-evidence', 'project-evidence');
  sources.data_sources.set('source-1', {
    id: 'source-1',
    source_type: 'intermediate_data_source',
    datasource_name: 'session-data',
    async query() {
      return QueryResult.ok([], ['value'], 0, 'empty');
    },
  });
  const result = await sources.query('session-data', 'SELECT value FROM result_rows WHERE value > 10');
  assert.equal(result.success, true);
  assert.equal(result.evidence?.produced_by, 'data_source_executor');
  assert.equal(result.evidence?.result?.status, 'empty');
  assert.equal(result.evidence?.result?.row_count, 0);
  assert.equal(result.evidence?.result?.empty, true);
  assert.equal(result.toDict().evidence?.evidence_id, result.evidence?.evidence_id);
});

test('query validation checks read-only SQL, columns, filters, nulls, duplicates, ranges, time and units', () => {
  const evidence = {
    evidence_id: 'query-good',
    produced_by: 'data_source_executor',
    statement: { language: 'sql', text: "SELECT order_id, amount_万元, created_at FROM orders WHERE region = '华东'" },
    schema: { referenced_columns: [{ column_name: 'amount_万元' }] },
    result: { status: 'completed', row_count: 2, columns: ['order_id', 'amount_万元', 'created_at'] },
    materialization: { intermediate_table: 'intermediate_1.r_orders' },
  };
  const validation = validateQueryResultEvidence({
    evidence,
    rows: [
      { order_id: 'o1', amount_万元: 10, created_at: '2026-07-01T00:00:00Z' },
      { order_id: 'o2', amount_万元: 20, created_at: '2026-07-02T00:00:00Z' },
    ],
    requirements: {
      required_columns: ['order_id', 'amount_万元'],
      non_null_columns: ['order_id'],
      key_columns: ['order_id'],
      numeric_ranges: [{ column: 'amount_万元', min: 0, max: 100 }],
      required_sql_fragments: ['region'],
      time_range: { column: 'created_at', start: '2026-07-01', end: '2026-07-31' },
      expected_unit: '万元',
    },
  });
  assert.equal(validation.status, 'passed');
  assert.equal(validation.summary.failed, 0);
  assert.equal(validation.checks.every((item) => item.passed), true);
});

test('query validation exposes failures instead of hiding them', () => {
  const validation = validateQueryResultEvidence({
    evidence: {
      evidence_id: 'query-bad',
      produced_by: 'data_source_executor',
      statement: { language: 'sql', text: 'SELECT order_id, amount FROM orders' },
      result: { status: 'completed', row_count: 2, columns: ['order_id', 'amount'] },
      materialization: { intermediate_table: 'intermediate_1.r_orders' },
    },
    rows: [
      { order_id: 'o1', amount: 20 },
      { order_id: 'o1', amount: -1 },
    ],
    requirements: {
      required_columns: ['region'],
      key_columns: ['order_id'],
      numeric_ranges: [{ column: 'amount', min: 0 }],
      required_sql_fragments: ['WHERE region'],
    },
  });
  assert.equal(validation.status, 'failed');
  const failed = new Set(validation.checks.filter((item) => !item.passed).map((item) => item.name));
  assert.equal(failed.has('required_columns'), true);
  assert.equal(failed.has('unique_keys'), true);
  assert.equal(failed.has('numeric_ranges'), true);
  assert.equal(failed.has('critical_filters'), true);
});

test('query validation reconciles aggregate and detail evidence', () => {
  const validation = validateQueryResultEvidence({
    evidence: {
      evidence_id: 'query-total', produced_by: 'data_source_executor',
      statement: { language: 'sql', text: 'SELECT SUM(amount) AS total FROM orders' },
      result: { status: 'completed', row_count: 1, columns: ['total'] },
      materialization: { intermediate_table: 'intermediate_1.r_total' },
    },
    rows: [{ total: 30 }],
    reconcileEvidence: { evidence_id: 'query-detail' },
    reconcileRows: [{ amount: 10 }, { amount: 20 }],
    requirements: {
      reconcile: {
        evidence_id: 'query-detail', aggregate_column: 'total', detail_value_column: 'amount', tolerance: 0,
      },
    },
  });
  assert.equal(validation.status, 'passed');
  assert.equal(validation.checks.find((item) => item.name === 'aggregate_detail_reconciliation')?.passed, true);
});

test('query validation rejects write or multi-statement SQL', () => {
  assert.equal(isReadOnlyQueryStatement('SELECT * FROM orders'), true);
  assert.equal(isReadOnlyQueryStatement('WITH x AS (SELECT 1) SELECT * FROM x'), true);
  assert.equal(isReadOnlyQueryStatement('PRAGMA writable_schema=ON'), false);
  assert.equal(isReadOnlyQueryStatement('SELECT 1; DELETE FROM orders'), false);
  assert.equal(isReadOnlyQueryStatement('UPDATE orders SET amount=0'), false);
});
