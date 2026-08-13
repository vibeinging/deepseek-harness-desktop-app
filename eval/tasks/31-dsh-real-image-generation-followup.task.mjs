function calledTools(output) {
  return new Set((output?.events || [])
    .filter((event) => event.item_type === 'dynamicToolCall' && event.tool_name)
    .map((event) => String(event.tool_name).replace(/^.*__/, '')));
}

function finalAnswerText(output) {
  return (output?.blocks || [])
    .filter((block) => (
      block?.metadata?.phase === 'final_answer'
      || block?.metadata?.msg_category === 'final_answer'
      || block?.title === '回答'
    ))
    .map((block) => String(block.content || '').trim())
    .filter(Boolean)
    .join('\n');
}

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export default {
  id: 'dsh-real-image-generation-followup',
  desc: '真实主模型调用图片工具后承接当前请求，不复用旧问候语作为最终回答',
  eval: {
    feature: 'dsh.image-generation-followup',
    layer: 'model_eval',
    risk: 'P0',
    interaction: 'app',
    model: 'real',
    data: 'synthetic',
    platforms: ['darwin', 'win32', 'linux'],
    timeoutMs: 420_000,
    repeats: 1,
    minPassRate: 1,
    requirements: ['chat.image-generation', 'chat.tool-followup'],
    tags: ['model-nightly', 'dsh-alignment'],
    criteria: [
      {
        id: 'image.generated',
        description: '真实图片模型生成图片并在对话中返回可见图片块',
        evidence: ['tool_event', 'model_output'],
      },
      {
        id: 'followup.grounded',
        description: '主模型最终回答承接本轮图片结果，不回到旧问候或新对话状态',
        evidence: ['model_output'],
      },
    ],
    scenario: {
      project: { mode: 'new', name: 'dsh-real-image-generation-followup-eval' },
      turns: [{
        id: 'generate-image',
        user: '帮我画一个小猫吃鱼的图片。卡通的',
        criteria: ['image.generated', 'followup.grounded'],
      }],
    },
  },
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const stamp = Date.now().toString(36);
    const pid = await driver.ensureProjectRecord(`真实图片收尾-${stamp}`);
    let sid = null;

    try {
      const primary = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      if (!primary?.json?.data?.model_name) assert.blocked('隔离环境没有可用的真实 PRIMARY 模型');
      const imageModels = await api('GET', '/api/llm_model/llm_models?category=IMAGE').catch(() => null);
      const configuredImages = imageModels?.json?.data?.items || imageModels?.json?.data || [];
      if (!Array.isArray(configuredImages) || !configuredImages.some((model) => model?.is_enabled !== false)) {
        assert.blocked('隔离环境没有可用的真实 IMAGE 模型');
      }

      const output = await driver.askAgent(
        pid,
        '帮我画一个小猫吃鱼的图片。卡通的',
        { title: `真实图片收尾-${stamp}`, searchMode: 'off', timeoutMs: 360_000 },
      );
      sid = output.sid;
      const messageResponse = await api('GET', `/api/projects/${pid}/sessions/${sid}/messages`);
      const messagePayload = messageResponse?.json?.data;
      const messages = Array.isArray(messagePayload)
        ? messagePayload
        : messagePayload?.messages || messagePayload?.items || [];
      const assistantMessage = messages.filter((message) => message.role === 'assistant').at(-1);
      const persistedBlocks = arrayValue(assistantMessage?.content_items);

      assert.ok(calledTools(output).has('image_gen'), '真实主模型调用 image_gen', {
        criterion: 'image.generated',
      });
      assert.ok(persistedBlocks.some((block) => block.type === 'image'), '最终消息保存可见图片块', {
        criterion: 'image.generated',
      });

      const finalText = finalAnswerText({ blocks: persistedBlocks });
      assert.ok(finalText, '图片工具完成后存在最终回答', { criterion: 'followup.grounded' });
      assert.ok(!/你好[！!，,]?\s*(?:有什么|我可以)/.test(finalText), '最终回答没有回到默认问候', {
        criterion: 'followup.grounded',
      });
      assert.ok(/(?:图|图片|生成|画好)/.test(finalText), '最终回答明确承接图片生成结果', {
        criterion: 'followup.grounded',
      });
      return {
        sid,
        tools: [...calledTools(output)],
        finalText,
        blocks: persistedBlocks.map((block) => ({
          id: block.id,
          type: block.type,
          title: block.title,
          content_prefix: String(block.content || '').slice(0, 240),
          phase: block?.metadata?.phase || null,
        })),
      };
    } finally {
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
