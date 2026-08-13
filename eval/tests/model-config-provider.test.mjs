import test from 'node:test';
import assert from 'node:assert/strict';

import { createDbModelConfigProvider } from '../../server/src/engine/core/model_config_provider.js';

test('createDbModelConfigProvider returns normalized model config from llm_models row', async () => {
  const provider = createDbModelConfigProvider({
    queryOne: async (sql, params) => {
      assert.match(sql, /FROM llm_models/);
      assert.match(sql, /is_enabled=true/);
      assert.match(sql, /category=COALESCE\(\$2,'PRIMARY'\)/);
      assert.deepEqual(params, ['project-1', 'PRIMARY']);
      return {
        id: 'model-1',
        model_name: 'qwen',
        api_base: 'https://example.test/v1',
        api_key: 'sk-test',
        category: 'PRIMARY',
        api_format: 'responses',
        extra_config: JSON.stringify({ context_window: 65536, extra_headers: { 'X-Test': '1' } }),
      };
    },
  });

  const config = await provider({ project_id: 'project-1', category: 'PRIMARY' });

  assert.equal(config.id, 'model-1');
  assert.equal(config.api_format, 'responses');
  assert.equal(config.context_window, 65536);
  assert.deepEqual(config.extra_config.extra_headers, { 'X-Test': '1' });
});

test('createDbModelConfigProvider surfaces the configured not-found message', async () => {
  const provider = createDbModelConfigProvider({
    queryOne: async () => null,
    notFoundMessage: 'missing model',
  });

  await assert.rejects(() => provider({ project_id: 'project-1', category: 'PRIMARY' }), /missing model/);
});

test('createDbModelConfigProvider resolves an explicitly selected non-default model', async () => {
  const provider = createDbModelConfigProvider({
    queryOne: async (sql, params) => {
      assert.match(sql, /id=\$1/);
      assert.doesNotMatch(sql, /is_enabled=true/);
      assert.deepEqual(params, ['model-2', 'project-1', 'PRIMARY']);
      return {
        id: 'model-2',
        model_name: 'qwen-plus',
        api_base: 'https://example.test/v1',
        api_key: 'sk-test',
        category: 'PRIMARY',
        api_format: 'responses',
      };
    },
  });

  const config = await provider({ model_id: 'model-2', project_id: 'project-1', category: 'PRIMARY' });
  assert.equal(config.id, 'model-2');
  assert.equal(config.model_name, 'qwen-plus');
});
