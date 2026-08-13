import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  duckRunRecords,
  duckTableSchema,
  duckWriteRecords,
} from '../../server/src/engine/datasources/duck.js';

test('duck intermediate writer stores all-null extracted id columns as comparable varchar', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-duck-'));
  const dbPath = join(dir, 'intermediate.duckdb');

  try {
    await duckWriteRecords(
      dbPath,
      'r_extract',
      [
        { content_index: 1, content: 'advertisement row', event_id: null, category: 'Advertisement', amount: null },
        { content_index: 2, content: 'another row', event_id: null, category: 'Advertisement', amount: null },
      ],
      ['content_index', 'content', 'event_id', 'category', 'amount'],
      { description: 'test table', sub_query: 'test', sql_query: '' },
    );

    const schema = await duckTableSchema(dbPath, 'r_extract');
    const eventColumn = schema.find((column) => column.name === 'event_id');
    assert.equal(eventColumn?.type, 'VARCHAR');

    const rows = await duckRunRecords(
      dbPath,
      "SELECT event_id FROM r_extract WHERE event_id IN ('recggMW2eyCYceNcy')",
      10,
    );
    assert.deepEqual(rows, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('duck query parameters are bound instead of interpolated into SQL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-duck-params-'));
  const dbPath = join(dir, 'parameters.duckdb');
  try {
    await duckWriteRecords(dbPath, 'orders', [
      { order_id: 'o1', amount: 10 },
      { order_id: 'o2', amount: 20 },
      { order_id: 'o3', amount: 30 },
    ], ['order_id', 'amount']);
    const rows = await duckRunRecords(
      dbPath,
      'SELECT order_id, amount FROM orders WHERE amount > ? ORDER BY amount',
      100,
      [15],
    );
    assert.deepEqual(rows, [
      { order_id: 'o2', amount: 20 },
      { order_id: 'o3', amount: 30 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
