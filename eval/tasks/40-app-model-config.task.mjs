import { createServer } from 'node:http';

async function startFakeChatServer() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'chatcmpl-eval',
      object: 'chat.completion',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'eval pong' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function parseExtraConfig(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

// App feature: project-level model config CRUD and model test API response behavior.
export default {
  id: 'app-model-config',
  desc: '项目级模型配置 CRUD',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('app-feature-model-config-eval');
    assert.ok(!!pid, '可准备模型配置 eval 项目');

    const listBefore = await api('GET', `/api/projects/${pid}/models?per_page=100`);
    assert.status(listBefore, 200, '项目模型列表接口可用');

    const existing = listBefore.json?.data?.items || [];
    for (const item of existing) {
      await api('DELETE', `/api/projects/${pid}/models/${item.id}`).catch(() => {});
    }

    const primaryPayload = {
      model_name: `eval-primary-${Date.now()}`,
      display_name: 'Eval Primary Model',
      category: 'PRIMARY',
      api_base: 'http://127.0.0.1:1/v1',
      api_key: 'eval-key',
      api_format: 'chat_completions',
      supports_streaming: true,
      extra_config: { extra_headers: { 'X-Eval': '1' }, context_window: 65536 },
    };
    const primary = await api('POST', `/api/projects/${pid}/models`, primaryPayload);
    assert.status(primary, 200, '可创建项目级 PRIMARY 模型');
    const primaryId = primary.json?.data?.id;
    assert.ok(!!primaryId, '创建 PRIMARY 返回 id');
    assert.eq(primary.json?.data?.project_id, pid, 'PRIMARY 绑定当前项目');
    assert.eq(parseExtraConfig(primary.json?.data?.extra_config).context_window, 65536, 'PRIMARY 保存上下文长度');

    const duplicate = await api('POST', `/api/projects/${pid}/models`, primaryPayload);
    assert.eq(duplicate.status, 400, '同项目同角色重复创建会被拒绝');

    const embedding = await api('POST', `/api/projects/${pid}/models`, {
      model_name: `eval-embedding-${Date.now()}`,
      display_name: 'Eval Embedding Model',
      category: 'EMBEDDING',
      api_base: 'http://127.0.0.1:1/v1',
      api_key: 'eval-key',
      api_format: 'chat_completions',
      dimension: 8,
      supports_streaming: false,
      extra_config: { input_field: 'input' },
    });
    assert.status(embedding, 200, '可创建项目级 EMBEDDING 模型');
    const embeddingId = embedding.json?.data?.id;
    assert.eq(embedding.json?.data?.dimension, 8, 'EMBEDDING dimension 保留');

    const listed = await api('GET', `/api/projects/${pid}/models?per_page=100`);
    const items = listed.json?.data?.items || [];
    assert.ok(items.some((m) => m.id === primaryId), '列表包含 PRIMARY 模型');
    assert.ok(items.some((m) => m.id === embeddingId), '列表包含 EMBEDDING 模型');

    const updated = await api('PUT', `/api/projects/${pid}/models`, {
      id: primaryId,
      display_name: 'Eval Primary Model Updated',
      supports_streaming: false,
    });
    assert.status(updated, 200, '可更新项目级模型');
    assert.eq(updated.json?.data?.display_name, 'Eval Primary Model Updated', '更新后的 display_name 正确');
    assert.eq(Boolean(updated.json?.data?.supports_streaming), false, '更新后的 supports_streaming 正确');

    const fakeModel = await startFakeChatServer();
    try {
      const tested = await api('POST', '/api/llm_model/test-config', {
        model_name: 'eval-chat-model',
        category: 'PRIMARY',
        api_base: fakeModel.baseUrl,
        api_key: 'eval-key',
        api_format: 'chat_completions',
      });
      assert.status(tested, 200, '模型测试接口返回标准响应');
      assert.eq(tested.json?.data?.success, true, '可连通模型返回 success=true');
      assert.ok((tested.json?.data?.response_preview || '').includes('eval pong'), '模型测试返回预览内容');
    } finally {
      await fakeModel.close();
    }

    const delPrimary = await api('DELETE', `/api/projects/${pid}/models/${primaryId}`);
    assert.status(delPrimary, 200, '可删除项目级 PRIMARY 模型');
    const delEmbedding = await api('DELETE', `/api/projects/${pid}/models/${embeddingId}`);
    assert.status(delEmbedding, 200, '可删除项目级 EMBEDDING 模型');

    const afterDelete = await api('GET', `/api/projects/${pid}/models?per_page=100`);
    const remaining = afterDelete.json?.data?.items || [];
    assert.eq(remaining.some((m) => m.id === primaryId || m.id === embeddingId), false, '删除后列表不再包含 eval 模型');
  },
};
