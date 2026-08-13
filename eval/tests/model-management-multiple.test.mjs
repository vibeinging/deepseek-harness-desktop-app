import test from 'node:test';
import assert from 'node:assert/strict';

import { createModel, updateModel, deleteModel } from '../../server/src/app/models/index.js';

const baseBody = {
  model_name: 'model-b',
  category: 'PRIMARY',
  api_base: 'https://example.test/v1',
  api_key: 'sk-test',
  api_format: 'responses',
};

test('creating another model keeps the existing default', async () => {
  const writes = [];
  const ctx = {
    userId: 'user-1',
    queryOne: async (sql) => {
      if (sql.includes('FROM users')) return { company_id: 'company-1' };
      if (sql.includes('is_enabled=true')) return { id: 'model-a' };
      if (sql.includes('WHERE id=$1')) return { id: 'model-b', is_enabled: false };
      return null;
    },
    query: async (sql, params) => {
      writes.push({ sql, params });
      return [];
    },
  };

  await createModel(ctx, { body: baseBody });

  const insert = writes.find((item) => item.sql.includes('INSERT INTO llm_models'));
  assert.ok(insert, 'model insert should run');
  assert.equal(insert.params[9], false, 'new rows do not replace the default unless explicitly requested');
  assert.equal(writes.filter((item) => item.sql.includes('CASE WHEN id=')).length, 0,
    'a second model should not replace the default model implicitly');
});

test('different models can share the same API address and key', async () => {
  const writes = [];
  const ctx = {
    userId: 'user-1',
    queryOne: async (sql) => {
      if (sql.includes('FROM users')) return { company_id: 'company-1' };
      if (sql.includes('is_enabled=true')) return { id: 'model-existing' };
      if (sql.includes('WHERE id=$1')) return { id: 'created-model', is_enabled: false };
      return null;
    },
    query: async (sql, params) => {
      writes.push({ sql, params });
      return [];
    },
  };

  await createModel(ctx, { body: { ...baseBody, model_name: 'model-a' } });
  await createModel(ctx, { body: { ...baseBody, model_name: 'model-b' } });

  const inserts = writes.filter((item) => item.sql.includes('INSERT INTO llm_models'));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map((item) => item.params[2]), ['model-a', 'model-b']);
  assert.ok(inserts.every((item) => item.params[5] === baseBody.api_base));
  assert.ok(inserts.every((item) => item.params[6] === baseBody.api_key));
});

test('model CRUD rejects malformed or non-object extra_config', async () => {
  const writes = [];
  const ctx = {
    userId: 'user-1',
    queryOne: async (sql) => {
      if (sql.includes('FROM users')) return { company_id: 'company-1' };
      if (sql.includes('is_enabled=true')) return null;
      return null;
    },
    query: async (sql, params) => {
      writes.push({ sql, params });
      return [];
    },
  };
  for (const extraConfig of ['not-json', '[]', '"text"']) {
    await assert.rejects(
      createModel(ctx, { body: { ...baseBody, extra_config: extraConfig } }),
      (error) => error?.status === 400,
    );
  }
  assert.equal(writes.some((item) => item.sql.includes('INSERT INTO llm_models')), false);
});

test('image models are stored in their own IMAGE category', async () => {
  const writes = [];
  const ctx = {
    userId: 'user-1',
    queryOne: async (sql) => {
      if (sql.includes('FROM users')) return { company_id: 'company-1' };
      if (sql.includes('is_enabled=true')) return null;
      if (sql.includes('WHERE id=$1')) return { id: 'image-model', category: 'IMAGE', is_enabled: true };
      return null;
    },
    query: async (sql, params) => {
      writes.push({ sql, params });
      return [];
    },
  };
  await createModel(ctx, { body: {
    model_name: 'qwen-image-2.0-pro',
    category: 'IMAGE',
    api_base: 'https://workspace.cn-beijing.maas.aliyuncs.com/api/v1',
    api_key: 'sk-test',
    extra_config: { image_provider: 'dashscope_multimodal' },
  } });
  const insert = writes.find((item) => item.sql.includes('INSERT INTO llm_models'));
  assert.equal(insert.params[4], 'IMAGE');
  assert.match(insert.params[10], /dashscope_multimodal/);
});

test('vision models are stored independently from the primary model', async () => {
  const writes = [];
  const ctx = {
    userId: 'user-1',
    queryOne: async (sql) => {
      if (sql.includes('FROM users')) return { company_id: 'company-1' };
      if (sql.includes('is_enabled=true')) return null;
      if (sql.includes('WHERE id=$1')) return { id: 'vision-model', category: 'VISION', is_enabled: true };
      return null;
    },
    query: async (sql, params) => {
      writes.push({ sql, params });
      return [];
    },
  };
  await createModel(ctx, { body: {
    model_name: 'qwen-vl-max',
    category: 'VISION',
    api_base: 'https://vision.test/v1',
    api_key: 'sk-test',
    api_format: 'chat_completions',
  } });
  const insert = writes.find((item) => item.sql.includes('INSERT INTO llm_models'));
  assert.equal(insert.params[4], 'VISION');
});

test('setting a default model clears the default flag from its siblings first', async () => {
  const writes = [];
  const ctx = {
    userId: 'user-1',
    queryOne: async (sql) => {
      if (sql.includes('FROM users')) return { company_id: 'company-1' };
      if (sql.includes('SELECT id, category, api_key')) {
        return { id: 'model-b', category: 'PRIMARY', api_key: 'sk-test', api_format: 'responses' };
      }
      if (sql.includes('WHERE id=$1')) return { id: 'model-b', is_enabled: true };
      return null;
    },
    query: async (sql, params) => {
      writes.push({ sql, params });
      return [];
    },
  };

  await updateModel(ctx, { body: { id: 'model-b', is_enabled: true } });

  assert.match(writes[0].sql, /SET is_enabled=CASE WHEN id=\$3 THEN true ELSE false END/);
  assert.deepEqual(writes[0].params, ['company-1', 'PRIMARY', 'model-b']);
  assert.doesNotMatch(writes[1].sql, /is_enabled=/,
    'the following detail update must not re-enable a second row after a concurrent switch');
});

test('deleting the default model promotes the newest remaining model', async () => {
  const writes = [];
  const ctx = {
    userId: 'user-1',
    queryOne: async (sql) => {
      if (sql.includes('FROM users')) return { company_id: 'company-1' };
      if (sql.includes('SELECT id, category, is_enabled')) {
        return { id: 'model-a', category: 'PRIMARY', is_enabled: true };
      }
      if (sql.includes('ORDER BY updated_at DESC')) return { id: 'model-b' };
      return null;
    },
    query: async (sql, params) => {
      writes.push({ sql, params });
      return [];
    },
  };

  await deleteModel(ctx, { body: { model_id: 'model-a' } });

  assert.match(writes[0].sql, /deleted_at=now\(\)/);
  assert.match(writes[1].sql, /SET is_enabled=true/);
  assert.deepEqual(writes[1].params, ['model-b']);
});
