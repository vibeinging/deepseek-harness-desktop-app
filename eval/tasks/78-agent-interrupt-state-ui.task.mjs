function parseArray(value) {
  if (Array.isArray(value)) return value;
  try { return Array.isArray(JSON.parse(String(value || '[]'))) ? JSON.parse(String(value || '[]')) : []; } catch { return []; }
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(String(value || '{}')) || {}; } catch { return {}; }
}

export default {
  id: 'agent-interrupt-state-ui',
  desc: '真实命令执行被停止后，流、历史和 Electron UI 都显示已停止',
  eval: {
    feature: 'agent.interrupt.terminal-ui',
    layer: 'model_eval',
    risk: 'P0',
    interaction: 'app',
    model: 'real',
    data: 'synthetic',
    platforms: ['darwin', 'win32', 'linux'],
    timeoutMs: 300_000,
    repeats: 1,
    minPassRate: 1,
    requirements: ['agent.native-tool.command', 'agent.interrupt', 'agent.history', 'agent.ui'],
    tags: ['model-nightly', 'dsh-alignment'],
    criteria: [
      { id: 'interrupt.real', description: '真实命令开始后通过产品停止接口中断 Turn', evidence: ['stream_events', 'api'] },
      { id: 'interrupt.history', description: '中断的命令和 Turn 以 stopped/interrupted 写入历史', evidence: ['api'] },
      { id: 'interrupt.ui', description: '历史重载后工具静态显示已停止且没有运行动画', evidence: ['ui', 'cdp'] },
    ],
    scenario: {
      project: { mode: 'new', name: 'agent-interrupt-state-eval' },
      turns: [{ id: 'interrupt-command', user: '执行长命令后停止', criteria: ['interrupt.real', 'interrupt.history', 'interrupt.ui'] }],
    },
  },
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const stamp = Date.now().toString(36);
    const projectName = `interrupt-command-${stamp}`;
    let pid = '';
    let sid = '';
    try {
      const created = await api('POST', '/api/projects', { name: projectName, description: '真实停止状态 Eval' });
      assert.status(created, 200, '创建隔离项目');
      pid = created.json?.data?.id || '';
      if (!pid) return;
      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      if (!model?.json?.data?.model_name) assert.blocked('隔离环境没有可用的真实 PRIMARY 模型');

      const output = await driver.askAgent(
        pid,
        '必须调用原生 shell 命令工具执行 `sleep 30`，不要改写成其他命令，也不要只解释。命令结束后再回答。',
        {
          title: `interrupt-command-${stamp}`,
          approval: 'full',
          collaborationMode: 'default',
          searchMode: 'off',
          interruptOnItemType: 'commandExecution',
          timeoutMs: 120_000,
        },
      );
      sid = output.sid;
      assert.eq(output.interruptErrors?.length || 0, 0, '产品停止请求没有错误', { criterion: 'interrupt.real' });
      assert.ok((output.interruptResults || []).some((result) => result?.interrupted === true), '产品停止接口真实中断任务', {
        criterion: 'interrupt.real',
      });
      assert.ok((output.events || []).some((event) => (
        event.item_type === 'commandExecution' && String(event.type || '').endsWith('item/started')
      )), '真实命令已经开始执行', { criterion: 'interrupt.real' });
      assert.ok((output.events || []).some((event) => (
        event.type === 'turn/completed' && event.status === 'interrupted'
      )), 'Turn 最终状态为 interrupted', { criterion: 'interrupt.real' });

      const history = await api('GET', `/api/projects/${pid}/sessions/${sid}/messages`);
      assert.status(history, 200, '读取中断后的会话历史');
      const messages = history.json?.data?.messages || [];
      const assistant = messages.find((message) => message.role === 'assistant');
      assert.eq(parseObject(assistant?.message_metadata).turn_status, 'interrupted', '历史 Turn 状态保持 interrupted', {
        criterion: 'interrupt.history',
      });
      const tool = messages
        .filter((message) => message.role === 'assistant')
        .flatMap((message) => parseArray(message.content_items))
        .find((item) => item.type === 'tool' && item.metadata?.tool_name === 'command');
      assert.eq(tool?.title, 'stopped', '中断命令以 stopped 写入历史', { criterion: 'interrupt.history' });
      const persistedCommand = String(tool?.metadata?.trace_input || '');
      assert.ok(persistedCommand.includes('sleep 30'), '中断命令保留底座原始参数', { criterion: 'interrupt.history' });
      if (!tool) return;

      const workstationTool = await driver.raw.ev(`
        const messages = ${JSON.stringify(messages)};
        const { mapServerMessage } = await import('/src/views/agent/stream/streamAdapter.ts');
        const { backfillWorkstationFromMessages } = await import('/src/views/agent/stream/reducer.ts');
        const draft = backfillWorkstationFromMessages(messages.map(mapServerMessage));
        return [...draft.tools.values()].find((entry) => entry.name === 'command') || null;
      `);
      assert.eq(workstationTool?.args, persistedCommand, '历史回放精确恢复底座 command 参数', {
        criterion: 'interrupt.history',
      });

      await driver.ui.goto('/agent');
      await driver.raw.ev(`
        localStorage.setItem('dsh:onboarding:completed:v1', 'true');
        const pid = ${JSON.stringify(pid)}; const sid = ${JSON.stringify(sid)};
        const detail = await window.electronAPI.apiRequest({ method: 'GET', url: '/api/projects/' + encodeURIComponent(pid), headers: {}, body: null });
        const { useProjectStore } = await import('/src/store/project.ts');
        const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts');
        useProjectStore.getState().setCurrentProject(detail?.json?.data || { id: pid, name: ${JSON.stringify(projectName)} });
        eventBus.emit(EVENT_TYPES.NEW_session_CREATED, { sessionId: sid, workspaceId: pid, projectId: pid });
        return true;
      `);
      const conversationSelector = `[data-agent-conv-id="${sid}"]`;
      await driver.ui.waitFor(conversationSelector, { timeout: 15_000 });
      await driver.ui.click(conversationSelector, { timeout: 10_000 });
      await driver.ui.waitFor(`[data-agent-session-id="${sid}"]`, { timeout: 15_000 });
      await driver.raw.ev(`
        for (const button of document.querySelectorAll('[data-agent-process-toggle]')) {
          if (button.closest('[data-agent-process]')?.getAttribute('data-expanded') !== 'true') button.click();
        }
        return true;
      `);
      await driver.ui.waitFor('[data-agent-process] [data-state="stopped"]', { timeout: 15_000 });
      const rendered = await driver.raw.ev(`
        const row = document.querySelector('[data-agent-process] [data-state="stopped"]');
        return { text: String(row?.textContent || '').replace(/\\s+/g, ' ').trim(), running: Boolean(row?.querySelector('[class*="typing"]')) };
      `);
      assert.ok(rendered.text.includes('已停止'), '历史重载 UI 明确显示已停止', { criterion: 'interrupt.ui' });
      assert.eq(rendered.running, false, '历史重载 UI 没有运行动画', { criterion: 'interrupt.ui' });
    } finally {
      if (pid && sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      if (pid) await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
