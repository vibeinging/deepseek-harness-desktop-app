import { createServer } from 'node:http';

async function startFakeStreamingModel() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'not found' } }));
      return;
    }
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'protocol ' }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'pong' }, finish_reason: null }] })}\n\n`);
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
  id: 'agent-output-protocol',
  desc: '真实 App 通过 IPC 输出 Agent 风格 turn/item 流',
  async run({ driver, assert }) {
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('agent-output-protocol-eval');
    const fakeModel = await startFakeStreamingModel();
    let modelId = '';

    try {
      const models = await api('GET', `/api/projects/${pid}/models?per_page=100`);
      for (const item of models.json?.data?.items || []) {
        await api('DELETE', `/api/projects/${pid}/models/${item.id}`).catch(() => {});
      }
      const model = await api('POST', `/api/projects/${pid}/models`, {
        model_name: `agent-output-protocol-${Date.now()}`,
        display_name: 'Agent Output Protocol Eval',
        category: 'PRIMARY',
        api_base: fakeModel.baseUrl,
        api_key: 'eval-key',
        api_format: 'chat_completions',
        supports_streaming: true,
      });
      assert.status(model, 200, '可创建本地假模型');
      modelId = model.json?.data?.id || '';

      const result = await driver.askAgent(pid, '只回复 protocol pong', {
        title: 'agent-output-protocol',
        mode: 'workspace',
      });
      const events = result.events || [];
      const turnIds = new Set(events.map((event) => event.turn_id).filter(Boolean));
      const finalItems = events.filter(
        (event) => event.type === 'item/completed' && event.phase === 'final_answer',
      );

      assert.ok(events.length > 0, `收到真实流事件(${events.length})`);
      assert.ok(events.every((event) => !Object.hasOwn(event, 'v')), '事件信封不带未发布的版本标记');
      assert.eq(events[0]?.type, 'turn/started', '首事件是 turn/started');
      assert.eq(events.at(-1)?.type, 'turn/completed', '末事件是 turn/completed');
      assert.eq(events.at(-1)?.status, 'completed', 'turn 最终状态为 completed');
      assert.eq(turnIds.size, 1, '一次请求只有一个稳定 turn_id');
      assert.ok(events.some((event) => event.type === 'item/started'), '包含 item/started');
      assert.ok(events.some((event) => event.type === 'item/agentMessage/delta'), '包含 agentMessage delta');
      assert.ok(finalItems.length === 1, '只有一个明确 final_answer item');
      assert.contains(result.blocks, 'protocol pong', 'Renderer reducer 得到最终答案');
    } finally {
      if (modelId) await api('DELETE', `/api/projects/${pid}/models/${modelId}`).catch(() => {});
      await fakeModel.close();
    }
  },
};
