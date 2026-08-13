function outputText(output) {
  return (output?.blocks || []).map((block) => String(block?.content || '')).join('\n');
}

export default {
  id: 'dsh-real-core',
  desc: '当前真实模型遵守项目指令，并在新对话中真实使用可控的项目记忆',
  eval: {
    feature: 'dsh.local-core',
    layer: 'model_eval',
    risk: 'P0',
    interaction: 'app',
    model: 'real',
    data: 'synthetic',
    platforms: ['darwin', 'win32', 'linux'],
    timeoutMs: 900_000,
    repeats: 1,
    minPassRate: 1,
    requirements: ['chat.project-instructions', 'chat.project-memory'],
    tags: ['model-nightly', 'dsh-alignment'],
    criteria: [
      {
        id: 'instructions.applied',
        description: '真实模型回答遵守项目指令中的唯一标记',
        evidence: ['model_output'],
      },
      {
        id: 'memory.recalled',
        description: '开启项目记忆后，新对话能召回上一段对话的唯一值',
        evidence: ['model_output', 'api'],
      },
      {
        id: 'memory.control',
        description: '关闭项目记忆后，同样的新对话不再得到唯一值',
        evidence: ['model_output', 'api'],
      },
    ],
    scenario: {
      project: { mode: 'new', name: 'dsh-real-core-eval' },
      turns: [
        { id: 'instruction', user: '按项目指令确认状态', criteria: ['instructions.applied'] },
        { id: 'memory-source', user: '记录项目唯一值', criteria: ['memory.recalled'] },
        { id: 'memory-recall', user: '在新对话中召回唯一值', criteria: ['memory.recalled'] },
        { id: 'memory-off-control', user: '关闭记忆后再发起同样问题', criteria: ['memory.control'] },
      ],
    },
  },
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const stamp = Date.now().toString(36);
    const instructionMarker = `PROJECT_INSTRUCTION_OK_${stamp}`;
    const memoryMarker = `MARS_MEMORY_${stamp}`;
    const projectName = `真实核心能力-${stamp}`;
    let pid = '';
    const sessions = [];

    try {
      const created = await api('POST', '/api/projects', {
        name: projectName,
        description: 'DSH 本地核心能力真实模型 Eval',
        instructions: `每次回答的第一行必须精确写成 ${instructionMarker}。然后再回答用户问题。`,
      });
      assert.status(created, 200, '创建带项目指令的隔离项目');
      pid = created.json?.data?.id || '';
      if (!pid) return;

      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      if (!model?.json?.data?.model_name) assert.blocked('隔离环境没有可用的真实 PRIMARY 模型');

      const instruction = await driver.askAgent(pid, '请按项目指令确认：核心能力可用。不要调用工具。', {
        title: `项目指令-${stamp}`,
        searchMode: 'off',
        timeoutMs: 240_000,
      });
      sessions.push(instruction.sid);
      assert.ok(
        outputText(instruction).includes(instructionMarker),
        '真实模型执行项目指令中的唯一标记',
        { criterion: 'instructions.applied' },
      );

      const memoryEnabled = await api('PUT', `/api/agent/projects/${pid}/chat-memory`, { enabled: true });
      assert.status(memoryEnabled, 200, '显式开启项目对话记忆', { criterion: 'memory.recalled' });

      const source = await driver.askAgent(
        pid,
        `请记住“火星交付暗号”的精确值是 ${memoryMarker}。只确认已经记录，不要调用工具。`,
        { title: `火星交付暗号-${stamp}`, searchMode: 'off', timeoutMs: 240_000 },
      );
      sessions.push(source.sid);

      const recalled = await driver.askAgent(
        pid,
        '上次同一项目中提到的“火星交付暗号”精确值是什么？只给出精确值，不要猜。',
        { title: `记忆召回-${stamp}`, searchMode: 'off', timeoutMs: 240_000 },
      );
      sessions.push(recalled.sid);
      assert.ok(
        outputText(recalled).includes(memoryMarker),
        '新对话真实召回上一段项目对话的唯一值',
        { criterion: 'memory.recalled' },
      );

      const memoryDisabled = await api('PUT', `/api/agent/projects/${pid}/chat-memory`, { enabled: false });
      assert.status(memoryDisabled, 200, '关闭项目对话记忆', { criterion: 'memory.control' });
      const control = await driver.askAgent(
        pid,
        '上次同一项目中提到的“火星交付暗号”精确值是什么？不知道就只回答不知道，不要猜。',
        { title: `记忆关闭对照-${stamp}`, searchMode: 'off', timeoutMs: 240_000 },
      );
      sessions.push(control.sid);
      assert.ok(
        !outputText(control).includes(memoryMarker),
        '关闭记忆后的新对话不再得到唯一值',
        { criterion: 'memory.control' },
      );
    } finally {
      for (const sid of sessions.filter(Boolean)) {
        if (pid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      }
      if (pid) await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
