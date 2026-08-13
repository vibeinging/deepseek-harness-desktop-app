import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  normalizeConfiguredModelRows,
  readConfiguredModels,
  seedConfiguredModels,
} from '../lib/configured-models.mjs';

const require = createRequire(import.meta.url);
const BetterSqlite3 = require('../../server/node_modules/better-sqlite3');

test('configured model rows keep one enabled model per category and parse extra config', () => {
  const rows = [
    {
      model_name: 'primary-new', display_name: 'Primary', category: 'primary', api_base: 'https://model.invalid/v1',
      api_key: 'secret-new', api_format: 'chat_completions', supports_streaming: 1, is_enabled: 1,
      dimension: null, extra_config: '{"supports_image_input":true}',
    },
    {
      model_name: 'primary-old', display_name: 'Old', category: 'PRIMARY', api_base: 'https://old.invalid/v1',
      api_key: 'secret-old', api_format: 'responses', supports_streaming: 1, is_enabled: 1,
      dimension: null, extra_config: '{}',
    },
    {
      model_name: 'disabled', display_name: 'Disabled', category: 'VISION', api_base: 'https://disabled.invalid/v1',
      api_key: 'disabled-secret', api_format: 'chat_completions', supports_streaming: 1, is_enabled: 0,
      dimension: null, extra_config: '{}',
    },
  ];

  const models = normalizeConfiguredModelRows(rows);
  assert.equal(models.length, 1);
  assert.equal(models[0].model_name, 'primary-new');
  assert.deepEqual(models[0].extra_config, { supports_image_input: true });
});

test('configured models are read from a local database and seeded without leaking secrets in summary', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'configured-models-test-'));
  const dbPath = path.join(root, 'local.db');
  const db = new BetterSqlite3(dbPath);
  try {
    db.exec(`
      CREATE TABLE llm_models (
        model_name TEXT, display_name TEXT, category TEXT, api_base TEXT, api_key TEXT,
        api_format TEXT, supports_streaming INTEGER, dimension INTEGER, is_enabled INTEGER,
        extra_config TEXT, project_id TEXT, deleted_at TEXT, updated_at TEXT, created_at TEXT
      );
    `);
    db.prepare(`
      INSERT INTO llm_models VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      'real-primary', 'Real Primary', 'PRIMARY', 'https://model.invalid/v1', 'top-secret-key',
      'chat_completions', 1, null, 1, '{"reasoning_effort":"medium"}',
      '2026-08-02T02:00:00.000Z', '2026-08-02T01:00:00.000Z',
    );
  } finally {
    db.close();
  }

  try {
    const models = readConfiguredModels(dbPath);
    assert.equal(models[0].api_key, 'top-secret-key');

    const calls = [];
    const summary = await seedConfiguredModels(async (method, url, body) => {
      calls.push({ method, url, body });
      return { status: 200, json: { data: { id: 'model-id' } } };
    }, { models });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.api_key, 'top-secret-key');
    assert.deepEqual(summary.models, [{
      category: 'PRIMARY',
      model_name: 'real-primary',
      display_name: 'Real Primary',
      api_format: 'chat_completions',
    }]);
    assert.equal(JSON.stringify(summary).includes('top-secret-key'), false);
    assert.equal(JSON.stringify(summary).includes('model.invalid'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('configured model seed requires an active primary model', async () => {
  await assert.rejects(
    () => seedConfiguredModels(async () => ({ status: 200 }), {
      models: [{
        model_name: 'embedding', display_name: 'Embedding', category: 'EMBEDDING',
        api_base: 'https://embedding.invalid/v1', api_key: 'secret', api_format: 'chat_completions',
        supports_streaming: false, dimension: 1024, extra_config: {},
      }],
    }),
    /PRIMARY/,
  );
});
