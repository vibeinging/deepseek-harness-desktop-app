import assert from 'node:assert/strict';
import test from 'node:test';

import {
  previewProjectDataPreparation,
  runProjectDataPreparation,
} from '../../server/src/engine/agents/product_capabilities/data_preparation.js';

const PROJECT_ID = 'project-data-preparation';

test('data preparation preview treats structured and unstructured sources as one project capability', async () => {
  const ctx = {
    query: async (sql) => {
      if (sql.includes('FROM database_connections')) {
        return [{
          id: 'connection-1',
          name: '销售库',
          db_type: 'sqlite',
          database_name: 'sales',
          description: '销售数据库',
        }];
      }
      if (sql.includes('FROM table_metadata')) {
        return [{
          table_id: 'table-1',
          table_name: 'orders',
          schema_name: 'main',
          table_description: '订单表',
          table_embedding: '[1]',
          column_id: 'column-1',
          column_description: '订单金额',
          column_embedding: '[1]',
        }];
      }
      if (sql.includes('FROM unstructured_data_sources')) {
        return [{ id: 'docs-1', name: '制度库', description: '销售制度文档' }];
      }
      if (sql.includes('FROM unstructured_documents')) {
        return [{
          id: 'doc-1',
          unstructured_data_source_id: 'docs-1',
          title: '销售制度.md',
          description: '销售制度摘要',
          status: 'completed',
          chunk_count: 2,
          embedded_chunk_count: 2,
        }];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    queryOne: async () => null,
  };

  const result = await previewProjectDataPreparation(ctx, PROJECT_ID);
  assert.equal(result.success, true);
  assert.equal(result.fully_prepared, true);
  assert.equal(result.structured[0].status, 'prepared');
  assert.equal(result.unstructured[0].status, 'prepared');
  assert.equal(result.coverage.structured.tables_total, 1);
  assert.equal(result.coverage.unstructured.documents_total, 1);
  assert.equal(result.coverage.unstructured.chunks_embedded, 2);
  assert.equal(result.coverage.embedding.mode, 'lexical_only');
});

test('configured embedding capability reports incomplete preparation when vectors are missing', async () => {
  const ctx = {
    query: async (sql) => {
      if (sql.includes('FROM database_connections')) {
        return [{ id: 'connection-1', name: '销售库', db_type: 'sqlite', database_name: 'sales', description: '销售库' }];
      }
      if (sql.includes('FROM table_metadata')) {
        return [{
          table_id: 'table-1', table_name: 'orders', schema_name: 'main', table_description: '订单表',
          table_embedding: null, column_id: 'column-1', column_description: '金额', column_embedding: null,
        }];
      }
      if (sql.includes('FROM unstructured_data_sources') || sql.includes('FROM unstructured_documents')) return [];
      throw new Error(`unexpected query: ${sql}`);
    },
    queryOne: async (sql) => sql.includes('FROM llm_models')
      ? { id: 'embedding-1', model_name: 'text-embedding-v3' }
      : null,
  };
  const result = await previewProjectDataPreparation(ctx, PROJECT_ID);
  assert.equal(result.coverage.embedding.mode, 'vector_and_lexical');
  assert.equal(result.structured[0].descriptions_ready, true);
  assert.equal(result.structured[0].vectors_ready, false);
  assert.equal(result.fully_prepared, false);
});

test('full preparation runs samples, enums, metadata and document preparation as a standalone job', async () => {
  const calls = [];
  const before = {
    success: true,
    fully_prepared: false,
    coverage: { source_count: 2 },
    structured: [{
      connection_id: 'connection-1',
      connection_name: '销售库',
      table_ids: ['table-1'],
      table_count: 1,
      status: 'pending',
    }],
    unstructured: [{
      data_source_id: 'docs-1',
      data_source_name: '制度库',
      document_ids: ['doc-1'],
      document_count: 1,
      documents_completed: 1,
      documents_processing: 0,
      documents_failed: 0,
      chunks_total: 2,
      chunks_embedded: 2,
      parsing_ready: true,
      failures: [],
      status: 'pending',
    }],
  };
  const after = {
    ...before,
    fully_prepared: true,
    coverage: { source_count: 2 },
    structured: [{ ...before.structured[0], status: 'prepared' }],
    unstructured: [{ ...before.unstructured[0], status: 'prepared' }],
  };
  let previewCount = 0;
  const result = await runProjectDataPreparation({ query() {}, queryOne() {} }, PROJECT_ID, {}, {
    previewFn: async () => (++previewCount === 1 ? before : after),
    beginRevisionFn: async () => ({ id: 'revision-1', revision: 1, status: 'running' }),
    transitionRevisionFn: async (_ctx, id, status, details) => {
      calls.push(`transition:${status}`);
      return { id, revision: 1, status, coverage_summary: details.coverageSummary };
    },
    syncExampleValuesFn: async () => {
      calls.push('structured:examples');
      return { data: { columns: 1 } };
    },
    syncDistinctAndEnumsFn: async () => {
      calls.push('structured:enums');
      return { data: { columns: 1, enums: 1 } };
    },
    runStructuredFn: async () => {
      calls.push('structured:metadata');
      return { status: 'completed' };
    },
    generateDocumentDescriptionsFn: async () => {
      calls.push('unstructured:document-descriptions');
      return { data: { status: 'completed' } };
    },
    generateDatasourceDescriptionFn: async () => {
      calls.push('unstructured:datasource-description');
      return { data: { status: 'completed' } };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, [
    'structured:examples',
    'structured:enums',
    'structured:metadata',
    'unstructured:document-descriptions',
    'unstructured:datasource-description',
    'transition:completed',
  ]);
});

test('unfinished document processing cannot complete a preparation run', async () => {
  const preview = {
    success: true,
    fully_prepared: false,
    coverage: { source_count: 1 },
    structured: [],
    unstructured: [{
      data_source_id: 'docs-1',
      data_source_name: '制度库',
      document_ids: ['doc-1'],
      document_count: 1,
      documents_completed: 0,
      documents_processing: 1,
      documents_failed: 0,
      chunks_total: 0,
      chunks_embedded: 0,
      parsing_ready: false,
      failures: [],
      status: 'pending',
    }],
  };
  const transitions = [];
  const result = await runProjectDataPreparation({ query() {}, queryOne() {} }, PROJECT_ID, {}, {
    previewFn: async () => preview,
    beginRevisionFn: async () => ({ id: 'revision-2', revision: 2, status: 'running' }),
    transitionRevisionFn: async (_ctx, id, status, details) => {
      transitions.push({ status, details });
      return { id, revision: 2, status };
    },
  });

  assert.equal(result.success, false);
  assert.equal(result.status, 'failed');
  assert.equal(transitions[0].status, 'failed');
  assert.match(result.failures[0].error, /仍在解析/);
});
