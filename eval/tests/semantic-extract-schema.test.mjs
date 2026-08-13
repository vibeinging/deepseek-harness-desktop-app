import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBatchExtractedRows,
  normalizeExtractSchemaParam,
  normalizeExtractedRows,
} from '../../server/src/engine/tools/semantic_extract_subtask.js';

test('semantic extract schema accepts array input', () => {
  const schema = [{ name: 'molecule_id', type: 'string', description: '分子ID' }];

  assert.deepEqual(normalizeExtractSchemaParam(schema), schema);
});

test('semantic extract schema accepts JSON string input from function calling', () => {
  const schema = normalizeExtractSchemaParam('[{"name":"molecule_id","type":"string"}]');

  assert.deepEqual(schema, [{ name: 'molecule_id', type: 'string' }]);
});

test('semantic extract schema wraps single object input', () => {
  const schema = normalizeExtractSchemaParam({ name: 'is_carcinogenic', type: 'boolean' });

  assert.deepEqual(schema, [{ name: 'is_carcinogenic', type: 'boolean' }]);
});

test('semantic extract cardinality many expands every record from one document row', () => {
  const schema = [
    { name: 'customer_id', type: 'string' },
    { name: 'risk_level', type: 'string' },
  ];
  const rows = normalizeExtractedRows({
    data: [
      { customer_id: 'C001', risk_level: 'high' },
      { customer_id: 'C002', risk_level: 'low' },
      { customer_id: 'C003', risk_level: 'high' },
    ],
  }, { content_index: 0, content: 'markdown table' }, schema, 'many');

  assert.deepEqual(rows.map((row) => row.customer_id), ['C001', 'C002', 'C003']);
  assert.deepEqual(rows.map((row) => row.risk_level), ['high', 'low', 'high']);
});

test('semantic extract cardinality many accepts one object and empty extraction', () => {
  const schema = [{ name: 'customer_id', type: 'string' }];

  assert.deepEqual(
    normalizeExtractedRows({ data: { customer_id: 'C001' } }, {}, schema, 'many'),
    [{ customer_id: 'C001' }],
  );
  assert.deepEqual(normalizeExtractedRows({ data: [] }, {}, schema, 'many'), []);
});

test('semantic extract follows only the declared schema and does not add hidden domain fields', () => {
  const schema = [
    { name: 'entity_key', type: 'string' },
    { name: 'measure', type: 'number' },
  ];
  const rows = normalizeExtractedRows(
    { data: { entity_key: 'A-17', measure: 42, hidden_guess: 'must-not-leak' } },
    { content: 'source row' },
    schema,
    'one',
  );

  assert.deepEqual(rows, [{ entity_key: 'A-17', measure: 42 }]);
  assert.equal(Object.hasOwn(rows[0], 'record_id'), false);
  assert.equal(Object.hasOwn(rows[0], 'hidden_guess'), false);
});

test('semantic batch extract maps results back by stable row index and fills missing rows', () => {
  const items = [
    { rowIndex: 4, row: { content: 'first' }, instruction: 'extract' },
    { rowIndex: 9, row: { content: 'second' }, instruction: 'extract' },
  ];
  const schema = [{ name: 'entity_key', type: 'string' }, { name: 'measure', type: 'number' }];
  const normalized = normalizeBatchExtractedRows({
    data: [
      { row_index: 4, values: { entity_key: 'A', measure: 2, hidden: 'drop' } },
      { row_index: 999, values: { entity_key: 'outside', measure: 9 } },
    ],
  }, items, schema, 'one');

  assert.deepEqual(normalized[0].extractedRows, [{ entity_key: 'A', measure: 2 }]);
  assert.deepEqual(normalized[1].extractedRows, [{ entity_key: null, measure: null }]);
});

test('semantic batch extract supports multiple records per input row', () => {
  const items = [{ rowIndex: 3, row: { content: 'list' }, instruction: 'extract all' }];
  const schema = [{ name: 'item_key', type: 'string' }];
  const normalized = normalizeBatchExtractedRows({
    data: [
      { row_index: 3, values: { item_key: 'A' } },
      { row_index: 3, values: { item_key: 'B' } },
    ],
  }, items, schema, 'many');

  assert.deepEqual(normalized[0].extractedRows, [{ item_key: 'A' }, { item_key: 'B' }]);
});
