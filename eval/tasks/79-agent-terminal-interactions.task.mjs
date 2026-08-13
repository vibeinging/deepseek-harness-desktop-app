function parseArray(value) {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function assistantItems(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => parseArray(message.content_items));
}

function assertRealInterrupt(assert, output, itemType, criterion) {
  assert.eq(output.interruptErrors?.length || 0, 0, `${itemType} 停止请求没有错误`, { criterion });
  assert.ok((output.interruptResults || []).some((result) => result?.interrupted === true), `${itemType} 被产品接口真实停止`, {
    criterion,
  });
  assert.ok((output.events || []).some((event) => (
    String(event.type || '').endsWith('item/started') && event.item_type === itemType
  )), `收到 ${itemType} started 事件`, { criterion });
  assert.ok((output.events || []).some((event) => (
    event.type === 'turn/completed' && event.status === 'interrupted'
  )), `${itemType} 所在 Turn 最终状态为 interrupted`, { criterion });
}

async function openConversation(driver, pid, sid, projectName) {
  await driver.ui.goto('/agent');
  await driver.raw.ev(`
    localStorage.setItem('dsh:onboarding:completed:v1', 'true');
    const pid = ${JSON.stringify(pid)};
    const sid = ${JSON.stringify(sid)};
    const detail = await window.electronAPI.apiRequest({
      method: 'GET', url: '/api/projects/' + encodeURIComponent(pid),
      headers: { 'Content-Type': 'application/json' }, body: null,
    });
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
}

export default {
  id: 'agent-terminal-interactions',
  desc: '真实批准和用户提问在 Turn 中断后收口为不可操作的终态',
  eval: {
    feature: 'agent.interactions.terminal-interrupt',
    layer: 'model_eval',
    risk: 'P0',
    interaction: 'app',
    model: 'real',
    data: 'synthetic',
    platforms: ['darwin', 'win32', 'linux'],
    timeoutMs: 480_000,
    repeats: 1,
    minPassRate: 1,
    requirements: ['agent.approval', 'agent.native-tool.request-user-input', 'agent.interrupt', 'agent.history', 'agent.ui'],
    tags: ['model-nightly', 'dsh-alignment'],
    criteria: [
      {
        id: 'approval.interrupted-terminal',
        description: '等待产品写入批准时停止 Turn，批准卡在历史和 UI 中变为不可操作的 stopped',
        evidence: ['stream_events', 'api', 'ui', 'cdp'],
      },
      {
        id: 'user-input.interrupted-terminal',
        description: '等待 request_user_input 回答时停止 Turn，提问卡在历史和 UI 中变为不可操作的 stopped',
        evidence: ['stream_events', 'api', 'ui', 'cdp'],
      },
    ],
    scenario: {
      project: { mode: 'new', name: 'agent-terminal-interactions-eval' },
      plugins: [],
      turns: [
        {
          id: 'interrupt-approval',
          user: '发起产品写入并在等待批准时停止',
          criteria: ['approval.interrupted-terminal'],
        },
        {
          id: 'interrupt-user-input',
          user: '发起原生提问并在等待回答时停止',
          criteria: ['user-input.interrupted-terminal'],
        },
      ],
    },
  },
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const stamp = Date.now().toString(36);
    const projectName = `terminal-interactions-${stamp}`;
    const sessions = [];
    let pid = '';
    try {
      const created = await api('POST', '/api/projects', {
        name: projectName,
        description: '交互卡片中断终态真实 Eval',
      });
      assert.status(created, 200, '创建隔离项目');
      pid = created.json?.data?.id || '';
      if (!pid) return;

      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      if (!model?.json?.data?.model_name) assert.blocked('隔离环境没有可用的真实 PRIMARY 模型');

      const marker = `INTERRUPTED_APPROVAL_${stamp}`;
      const approvalOutput = await driver.askAgent(
        pid,
        [
          `把当前对话重命名为“${marker}”。`,
          '必须调用 conversation_rename 发起真实产品写入，不要只解释；出现批准请求后等待用户决定。',
        ].join('\n'),
        {
          title: `interrupt-approval-${stamp}`,
          approval: 'ask',
          autoApprove: false,
          interruptOnItemType: 'approval',
          searchMode: 'off',
          timeoutMs: 180_000,
        },
      );
      sessions.push(approvalOutput.sid);
      assertRealInterrupt(assert, approvalOutput, 'approval', 'approval.interrupted-terminal');

      const approvalHistory = await api('GET', `/api/projects/${pid}/sessions/${approvalOutput.sid}/messages`);
      assert.status(approvalHistory, 200, '读取批准中断后的历史');
      const approvalMessages = approvalHistory.json?.data?.messages || [];
      const approvalMessage = approvalMessages.find((message) => message.role === 'assistant');
      assert.eq(parseObject(approvalMessage?.message_metadata).turn_status, 'interrupted', '批准所在历史 Turn 保持 interrupted', {
        criterion: 'approval.interrupted-terminal',
      });
      const approval = assistantItems(approvalMessages).find((item) => item.type === 'confirm');
      assert.eq(approval?.title, 'stopped', '未决批准以 stopped 写入历史', {
        criterion: 'approval.interrupted-terminal',
      });
      assert.eq(approval?.metadata?.status, 'interrupted', '未决批准保存 interrupted 原因', {
        criterion: 'approval.interrupted-terminal',
      });
      if (approval) {
        await openConversation(driver, pid, approvalOutput.sid, projectName);
        await driver.ui.waitFor('[data-agent-approval="true"][data-state="stopped"]', { timeout: 15_000 });
        const renderedApproval = await driver.raw.ev(`
          const card = document.querySelector('[data-agent-approval="true"][data-state="stopped"]');
          return {
            text: String(card?.textContent || '').replace(/\\s+/g, ' ').trim(),
            buttons: card?.querySelectorAll('button').length || 0,
          };
        `);
        assert.ok(renderedApproval.text.includes('确认已停止'), '重载 UI 显示批准已停止', {
          criterion: 'approval.interrupted-terminal',
        });
        assert.eq(renderedApproval.buttons, 0, '已停止批准卡没有操作按钮', {
          criterion: 'approval.interrupted-terminal',
        });
      }

      const userInputOutput = await driver.askAgent(
        pid,
        [
          '为当前项目制定运行配置方案，禁止自行决定配置。',
          '回答任何普通文字之前，必须真实调用 request_user_input 一次，只问“请选择运行配置”，提供“推荐配置”和“精简配置”两个选项，然后等待用户回答。',
          '不要修改任何文件。',
        ].join('\n'),
        {
          title: `interrupt-user-input-${stamp}`,
          collaborationMode: 'plan',
          autoResolveUserInput: false,
          interruptOnItemType: 'userInput',
          searchMode: 'off',
          timeoutMs: 180_000,
        },
      );
      sessions.push(userInputOutput.sid);
      assertRealInterrupt(assert, userInputOutput, 'userInput', 'user-input.interrupted-terminal');

      const userInputHistory = await api('GET', `/api/projects/${pid}/sessions/${userInputOutput.sid}/messages`);
      assert.status(userInputHistory, 200, '读取提问中断后的历史');
      const userInputMessages = userInputHistory.json?.data?.messages || [];
      const userInputMessage = userInputMessages.find((message) => message.role === 'assistant');
      assert.eq(parseObject(userInputMessage?.message_metadata).turn_status, 'interrupted', '提问所在历史 Turn 保持 interrupted', {
        criterion: 'user-input.interrupted-terminal',
      });
      const userInput = assistantItems(userInputMessages).find((item) => item.type === 'user_input');
      assert.eq(userInput?.title, 'stopped', '未决提问以 stopped 写入历史', {
        criterion: 'user-input.interrupted-terminal',
      });
      assert.eq(parseObject(userInput?.content).status, 'interrupted', '未决提问内容保存 interrupted 原因', {
        criterion: 'user-input.interrupted-terminal',
      });
      if (userInput) {
        await openConversation(driver, pid, userInputOutput.sid, projectName);
        await driver.ui.waitFor('[data-agent-user-input="true"][data-state="stopped"]', { timeout: 15_000 });
        const renderedUserInput = await driver.raw.ev(`
          const card = document.querySelector('[data-agent-user-input="true"][data-state="stopped"]');
          return {
            text: String(card?.textContent || '').replace(/\\s+/g, ' ').trim(),
            submit: [...(card?.querySelectorAll('button') || [])].some((button) => String(button.textContent || '').trim() === '提交'),
            enabledButtons: [...(card?.querySelectorAll('button') || [])].filter((button) => !button.disabled).length,
          };
        `);
        assert.ok(renderedUserInput.text.includes('问题已停止'), '重载 UI 显示提问已停止', {
          criterion: 'user-input.interrupted-terminal',
        });
        assert.eq(renderedUserInput.submit, false, '已停止提问卡没有提交按钮', {
          criterion: 'user-input.interrupted-terminal',
        });
        assert.eq(renderedUserInput.enabledButtons, 0, '已停止提问卡不能修改选项', {
          criterion: 'user-input.interrupted-terminal',
        });
      }
    } finally {
      for (const sid of sessions.filter(Boolean)) {
        if (pid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      }
      if (pid) await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
