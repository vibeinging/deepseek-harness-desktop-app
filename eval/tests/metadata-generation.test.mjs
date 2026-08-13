import assert from 'node:assert/strict';
import test from 'node:test';

import { query, queryOne } from '../../server/src/db.js';
import { listTables } from '../../server/src/app/reads/reads_datasource.js';
import {
  buildDescriptionGenerationResult,
  generateDatabaseDescription,
  storeVectors,
  summarizeSchemaVectorCoverage,
} from '../../server/src/app/datasource/tables.js';

test('metadata generation uses truthful progress and persistent results', async (t) => {
  const suffix = `${process.pid}-${Date.now()}`;
  const projectId = `metadata-project-${suffix}`;
  const connectionId = `metadata-connection-${suffix}`;
  const tableA = `metadata-table-a-${suffix}`;
  const tableB = `metadata-table-b-${suffix}`;
  const columnA1 = `metadata-column-a1-${suffix}`;
  const columnA2 = `metadata-column-a2-${suffix}`;
  const columnB1 = `metadata-column-b1-${suffix}`;

  await query(
    `INSERT INTO database_connections
      (id, project_id, name, db_type, database, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), now())`,
    [connectionId, projectId, '财务数据', 'sqlite', 'finance.db'],
  );
  await query(
    `INSERT INTO table_metadata
      (id, database_connection_id, schema_name, table_name, description, embedding, created_at, updated_at)
     VALUES ($1, $2, 'main', 'orders', '订单信息', NULL, now(), now()),
            ($3, $2, 'main', 'departments', '部门信息', '[0.1]', now(), now())`,
    [tableA, connectionId, tableB],
  );
  await query(
    `INSERT INTO column_metadata
      (id, table_id, column_name, data_type, description, embedding, created_at, updated_at)
     VALUES ($1, $2, 'order_id', 'text', '订单编号', NULL, now(), now()),
            ($3, $2, 'amount', 'number', NULL, NULL, now(), now()),
            ($4, $5, 'department_id', 'text', '部门编号', '[0.2]', now(), now())`,
    [columnA1, tableA, columnA2, columnB1, tableB],
  );

  try {
    await t.test('table list returns every aggregate used by the progress cards', async () => {
      const result = await listTables(
        { query, queryOne },
        { params: { pid: projectId, cid: connectionId } },
      );
      const orders = result.data.items.find((row) => row.id === tableA);
      const departments = result.data.items.find((row) => row.id === tableB);

      assert.deepEqual(
        {
          column_count: orders.column_count,
          columns_with_description: orders.columns_with_description,
          has_embedding: orders.has_embedding,
          columns_with_vectors: orders.columns_with_vectors,
        },
        { column_count: 2, columns_with_description: 1, has_embedding: 0, columns_with_vectors: 0 },
      );
      assert.deepEqual(
        {
          column_count: departments.column_count,
          columns_with_description: departments.columns_with_description,
          has_embedding: departments.has_embedding,
          columns_with_vectors: departments.columns_with_vectors,
        },
        { column_count: 1, columns_with_description: 1, has_embedding: 1, columns_with_vectors: 1 },
      );
    });

    await t.test('database AI description is written back before success is returned', async () => {
      let prompt = '';
      const description = '该数据库集中管理订单金额与部门归属信息，可用于财务审计和部门经营分析。';
      const result = await generateDatabaseDescription(
        {
          query,
          queryOne,
          chat: async (nextPrompt, options) => {
            prompt = nextPrompt;
            assert.equal(options.call_site, 'database_description');
            return JSON.stringify({ description });
          },
        },
        { params: { pid: projectId, cid: connectionId } },
      );

      assert.equal(result.data.description, description);
      assert.match(prompt, /已同步表数：2/);
      const persisted = await queryOne(
        'SELECT description FROM database_connections WHERE id=$1',
        [connectionId],
      );
      assert.equal(persisted.description, description);
    });

    await t.test('batch vector generation honors table scope and reports actual coverage', async () => {
      let receivedOptions = null;
      const result = await storeVectors(
        {
          query,
          queryOne,
          embedConnectionSchema: async (_connectionId, options) => {
            receivedOptions = options;
            await query('UPDATE table_metadata SET embedding=$1 WHERE id=$2', ['[0.3]', tableA]);
            await query('UPDATE column_metadata SET embedding=$1 WHERE table_id=$2', ['[0.4]', tableA]);
            return { tables: 1, columns: 2 };
          },
        },
        {
          params: { pid: projectId, cid: connectionId },
          body: { table_ids: [tableA], only_pending: false, scope: 'all' },
        },
      );

      assert.deepEqual(receivedOptions.tableIds, [tableA]);
      assert.equal(receivedOptions.force, true);
      assert.equal(receivedOptions.scope, 'all');
      assert.equal(result.data.status, 'completed');
      assert.equal(result.data.tables_targeted, 1);
      assert.equal(result.data.table_vectors_completed, 1);
      assert.equal(result.data.column_vector_tables_completed, 1);
      assert.equal(result.data.failures.length, 0);
    });

    await t.test('description response keeps renderer field names and partial failures', () => {
      const result = buildDescriptionGenerationResult(
        {
          columns: 1,
          details: [{
            table_id: tableA,
            table_name: 'orders',
            success: false,
            columns_requested: 2,
            columns_generated: 1,
            error: '有 1 个列描述未生成',
          }],
        },
        {
          tables: 1,
          details: [{
            table_id: tableA,
            table_name: 'orders',
            success: true,
            table_description_generated: 1,
          }],
        },
      );

      assert.equal(result.status, 'partial');
      assert.equal(result.columns_generated, 1);
      assert.equal(result.tables_generated, 1);
      assert.equal(result.details[0].success, false);
      assert.match(result.details[0].error, /列描述未生成/);
    });

    await t.test('coverage summary never turns an embedding error into success', () => {
      const result = summarizeSchemaVectorCoverage(
        [{ id: tableA, table_name: 'orders', has_embedding: 0, column_count: 2, columns_with_vectors: 0 }],
        { tables: 0, columns: 0, error: 'embedding service unavailable' },
        'all',
      );
      assert.equal(result.status, 'failed');
      assert.ok(result.failures.some((failure) => failure.scope === 'schema_vectors'));
    });
  } finally {
    await query('DELETE FROM column_metadata WHERE id = ANY($1)', [[columnA1, columnA2, columnB1]]);
    await query('DELETE FROM table_metadata WHERE id = ANY($1)', [[tableA, tableB]]);
    await query('DELETE FROM database_connections WHERE id=$1', [connectionId]);
  }
});
