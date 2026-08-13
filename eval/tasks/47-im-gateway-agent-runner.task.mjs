import { createServer } from 'node:http';

async function startFakeStreamingChatServer() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }

    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      if (body.stream === false) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-im-eval',
          object: 'chat.completion',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'im agent pong' },
            finish_reason: 'stop',
          }],
        }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'im agent pong' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
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

export default {
  id: 'im-gateway-agent-runner',
  desc: 'IM Gateway 复用 app agent runner',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('im-gateway-agent-runner-eval');
    let connectorId = '';
    let modelId = '';
    const fakeModel = await startFakeStreamingChatServer();

    try {
      const models = await api('GET', `/api/projects/${pid}/models?per_page=100`);
      for (const item of models.json?.data?.items || []) {
        await api('DELETE', `/api/projects/${pid}/models/${item.id}`).catch(() => {});
      }
      const model = await api('POST', `/api/projects/${pid}/models`, {
        model_name: `im-agent-eval-${Date.now()}`,
        display_name: 'IM Agent Eval Model',
        category: 'PRIMARY',
        api_base: fakeModel.baseUrl,
        api_key: 'eval-key',
        api_format: 'chat_completions',
        supports_streaming: true,
      });
      assert.status(model, 200, '可创建 IM agent eval 模型');
      modelId = model.json?.data?.id || '';
      assert.ok(!!modelId, '模型返回 id');

      const connector = await api('POST', '/api/im/connectors', {
        provider: 'fake',
        name: `fake-im-agent-${Date.now()}`,
        default_workspace_id: pid,
        allowed_workspace_ids: [pid],
        session_policy: 'per_user',
        settings: {
          execution_mode: 'agent',
          approval: 'ask',
        },
      });
      assert.status(connector, 200, '可创建 agent 模式 IM connector');
      connectorId = connector.json?.data?.id || '';
      assert.ok(!!connectorId, 'connector 返回 id');

      const identity = await api('POST', `/api/im/connectors/${connectorId}/identities`, {
        external_user_id: 'remote-agent-user',
        display_name: 'Remote Agent User',
        status: 'trusted',
      });
      assert.status(identity, 200, '可绑定 agent 模式远程用户');

      const event = await api('POST', `/api/im/connectors/${connectorId}/events`, {
        event_id: `im-agent-runner-${Date.now()}`,
        message_id: `im-agent-runner-${Date.now()}`,
        external_user_id: 'remote-agent-user',
        text: '请回复 im agent pong',
      });
      assert.status(event, 200, '远程消息可进入 agent runner');
      assert.eq(event.json?.data?.status, 'routed', 'agent runner 消息路由成功');
      assert.eq(event.json?.data?.execution_mode, 'agent', '执行模式为 agent');
      assert.eq(event.json?.data?.agent_status, 'completed', 'agent 执行完成');
      assert.ok(String(event.json?.data?.outbound || '').includes('im agent pong'), 'IM 出站内容包含 agent 输出');
      assert.ok(!!event.json?.data?.session_id, 'agent runner 使用 app session');
    } finally {
      if (connectorId) await api('DELETE', `/api/im/connectors/${connectorId}`).catch(() => {});
      if (modelId) await api('DELETE', `/api/projects/${pid}/models/${modelId}`).catch(() => {});
      await fakeModel.close();
    }
  },
};
