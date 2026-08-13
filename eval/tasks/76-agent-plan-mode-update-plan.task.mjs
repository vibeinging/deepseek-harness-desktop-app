import { PRODUCT_WRITE_TOOL_NAMES } from '../../server/src/engine/agents/product_tool_catalog.js';

function outputText(output) {
  return (output?.blocks || []).map((block) => String(block?.content || '')).join('\n');
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

async function persistedTurnRequest(api, pid, sid) {
  const history = await api('GET', `/api/projects/${pid}/sessions/${sid}/messages`);
  const messages = history.json?.data?.messages || [];
  const user = messages.find((message) => message.role === 'user');
  return parseObject(parseObject(user?.message_metadata).turn_request);
}

export default {
  id: 'agent-plan-mode-update-plan',
  desc: '真实模型分别验证 Codex Plan 协作模式和 update_plan 进度工具',
  eval: {
    feature: 'agent.collaboration-plan-and-update-plan',
    layer: 'model_eval',
    risk: 'P0',
    interaction: 'app',
    model: 'real',
    data: 'synthetic',
    platforms: ['darwin', 'win32', 'linux'],
    timeoutMs: 600_000,
    repeats: 1,
    minPassRate: 1,
    requirements: ['agent.collaboration-mode.plan', 'agent.native-tool.update-plan'],
    tags: ['model-nightly', 'dsh-alignment'],
    criteria: [
      {
        id: 'plan.mode.ui',
        description: '真实会话输入区可以在执行与计划模式之间切换',
        evidence: ['ui', 'cdp'],
      },
      {
        id: 'plan.mode.contract',
        description: 'Plan 模式生成原生计划方案且没有产生任何修改',
        evidence: ['model_output', 'stream_events', 'api'],
      },
      {
        id: 'update-plan.native-events',
        description: 'Default 模式真实调用 update_plan 并发出多次原生计划更新事件',
        evidence: ['stream_events'],
      },
      {
        id: 'update-plan.status-preserved',
        description: '未完成步骤保持原生状态，不因 Turn 成功被前端自动改成完成',
        evidence: ['renderer_output', 'stream_events'],
      },
      {
        id: 'update-plan.ui-status',
        description: 'Turn 结束后进度摘要准确，未完成步骤静态展示且不伪装成仍在运行',
        evidence: ['ui', 'cdp', 'renderer_output'],
      },
    ],
    scenario: {
      project: { mode: 'new', name: 'agent-plan-mode-update-plan-eval' },
      turns: [
        { id: 'plan-mode-ui', user: '在会话输入区切换到计划模式', criteria: ['plan.mode.ui'] },
        { id: 'plan-mode', user: '只调查并制定方案', criteria: ['plan.mode.contract'] },
        { id: 'update-plan', user: '真实更新任务进度但保留未完成步骤', criteria: ['update-plan.native-events', 'update-plan.status-preserved', 'update-plan.ui-status'] },
      ],
    },
  },
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const stamp = Date.now().toString(36);
    const targetFile = `PLAN_MODE_MUST_NOT_CREATE_${stamp}.md`;
    const projectName = `Plan 与 update_plan-${stamp}`;
    let pid = '';
    const sessions = [];

    try {
      const created = await api('POST', '/api/projects', {
        name: projectName,
        description: 'Codex Plan 和 update_plan 真实模型隔离 Eval',
      });
      assert.status(created, 200, '创建隔离项目');
      pid = created.json?.data?.id || '';
      if (!pid) return;

      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      if (!model?.json?.data?.model_name) assert.blocked('隔离环境没有可用的真实 PRIMARY 模型');

      await driver.raw.ev(`
        localStorage.setItem('dsh:onboarding:completed:v1', 'true');
        return true;
      `);
      await driver.ui.goto('/agent');
      await driver.ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15_000 });
      await driver.ui.click('[data-collaboration-mode="default"] > button');
      await driver.ui.clickText('计划', { selector: '[role="menuitemradio"]', exact: false });
      assert.ok(
        await driver.ui.exists('[data-collaboration-mode="plan"]'),
        '真实输入区切换到计划模式',
        { criterion: 'plan.mode.ui' },
      );
      await driver.ui.click('[data-collaboration-mode="plan"] > button');
      await driver.ui.clickText('执行', { selector: '[role="menuitemradio"]', exact: false });
      assert.ok(
        await driver.ui.exists('[data-collaboration-mode="default"]'),
        '真实输入区可以切回执行模式',
        { criterion: 'plan.mode.ui' },
      );

      const planned = await driver.askAgent(
        pid,
        `请为“在当前项目增加 ${targetFile}，内容用于记录发布检查结果”制定详细实施方案。先只读调查当前项目，再给出分步骤方案；不要创建或修改任何文件、数据、配置，也不要执行方案。方案中必须写出文件名 ${targetFile}。完成调查后必须严格遵循当前 Plan 模式规则，把完整正式方案放进唯一一组 <proposed_plan> 和 </proposed_plan> 标签，不能用普通 Markdown 回答代替正式计划块。`,
        {
          title: `Plan 模式-${stamp}`,
          collaborationMode: 'plan',
          autoResolveUserInput: true,
          searchMode: 'off',
          timeoutMs: 240_000,
        },
      );
      sessions.push(planned.sid);
      const planEvents = planned.events || [];
      const mutatingDynamicTools = planEvents.filter((event) => (
        event.item_type === 'dynamicToolCall'
        && PRODUCT_WRITE_TOOL_NAMES.has(String(event.tool_name || ''))
      ));
      assert.ok(
        planEvents.some((event) => event.item_type === 'plan')
          || planned.blocks?.some((block) => block.metadata?.item_type === 'planDocument'),
        'Plan 模式产生原生 plan 方案 item',
        { criterion: 'plan.mode.contract' },
      );
      assert.ok(
        !planEvents.some((event) => event.item_type === 'fileChange'),
        'Plan 模式没有产生文件修改事件',
        { criterion: 'plan.mode.contract' },
      );
      assert.eq(mutatingDynamicTools.length, 0, 'Plan 模式没有调用dsh-work写工具', { criterion: 'plan.mode.contract' });
      assert.ok(outputText(planned).includes(targetFile), 'Plan 方案包含目标文件名', { criterion: 'plan.mode.contract' });
      assert.eq(
        (await persistedTurnRequest(api, pid, planned.sid)).collaborationMode,
        'plan',
        '请求快照保存 Plan 模式',
        { criterion: 'plan.mode.contract' },
      );

      const updated = await driver.askAgent(
        pid,
        [
          '这是 update_plan 原生协议测试。必须真实调用 update_plan，不能只在文字里描述调用。',
          '第一次调用创建三个步骤：1. 检查当前目录（in_progress）；2. 汇总发现（pending）；3. 给出建议（pending）。',
          '随后只读检查当前目录。',
          '第二次调用必须把第 1 步设为 completed、第 2 步设为 in_progress、第 3 步保持 pending。',
          '到这里立即停止，不要完成第 2、3 步；最终只回答“状态已保留”。',
        ].join('\n'),
        {
          title: `update_plan-${stamp}`,
          collaborationMode: 'default',
          searchMode: 'off',
          timeoutMs: 240_000,
        },
      );
      sessions.push(updated.sid);
      const updateEvents = (updated.events || []).filter((event) => event.type === 'turn/plan/updated');
      assert.ok(updateEvents.length >= 2, `收到至少两次原生 turn/plan/updated（实际 ${updateEvents.length}）`, {
        criterion: 'update-plan.native-events',
      });
      const latestPlanBlock = [...(updated.blocks || [])].reverse().find((block) => block.type === 'plan');
      const latestSteps = (() => {
        try { return JSON.parse(latestPlanBlock?.content || '[]'); } catch { return []; }
      })();
      assert.eq(latestSteps.length, 3, '最后一次 update_plan 仍有三个步骤', {
        criterion: 'update-plan.status-preserved',
      });
      assert.eq(String(latestSteps[0]?.status || '').toLowerCase(), 'completed', '第 1 步保持 completed', {
        criterion: 'update-plan.status-preserved',
      });
      assert.ok(
        ['inprogress', 'in_progress'].includes(String(latestSteps[1]?.status || '').toLowerCase()),
        '第 2 步保持 in_progress',
        { criterion: 'update-plan.status-preserved' },
      );
      assert.eq(String(latestSteps[2]?.status || '').toLowerCase(), 'pending', '第 3 步保持 pending', {
        criterion: 'update-plan.status-preserved',
      });
      assert.eq(
        (await persistedTurnRequest(api, pid, updated.sid)).collaborationMode,
        'default',
        '请求快照保存 Default 模式',
        { criterion: 'update-plan.native-events' },
      );

      await driver.raw.ev(`
        const pid = ${JSON.stringify(pid)};
        const sid = ${JSON.stringify(updated.sid)};
        const detail = await window.electronAPI.apiRequest({
          method: 'GET',
          url: '/api/projects/' + encodeURIComponent(pid),
          headers: { 'Content-Type': 'application/json' },
          body: null,
        });
        const project = detail?.json?.data || { id: pid, name: ${JSON.stringify(projectName)} };
        const { useProjectStore } = await import('/src/store/project.ts');
        const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts');
        useProjectStore.getState().setCurrentProject(project);
        eventBus.emit(EVENT_TYPES.NEW_session_CREATED, {
          sessionId: sid,
          workspaceId: pid,
          projectId: pid,
        });
        await new Promise((resolve) => setTimeout(resolve, 800));
        return true;
      `);
      const conversationSelector = `[data-agent-conv-id="${updated.sid}"]`;
      await driver.ui.waitFor(conversationSelector, { timeout: 15_000 });
      await driver.ui.click(conversationSelector, { timeout: 10_000 });
      await driver.ui.waitFor(`[data-agent-session-id="${updated.sid}"]`, { timeout: 15_000 });
      const processToggles = await driver.raw.ev(`return document.querySelectorAll('[data-agent-process-toggle]').length;`);
      if (processToggles > 0) {
        await driver.raw.ev(`
          const toggles = document.querySelectorAll('[data-agent-process-toggle]');
          const button = toggles[toggles.length - 1];
          if (button?.closest('[data-agent-process]')?.getAttribute('data-expanded') !== 'true') button.click();
          return true;
        `);
      }
      await driver.ui.waitFor('[data-plan-float]', { timeout: 15_000 });
      const renderedPlan = await driver.raw.ev(`
        const root = document.querySelector('[data-plan-float]');
        return {
          running: root?.getAttribute('data-running') || '',
          summary: String(root?.querySelector('[data-plan-summary]')?.textContent || '').trim(),
          steps: [...(root?.querySelectorAll('[data-plan-step]') || [])].map((step) => ({
            state: step.getAttribute('data-state') || '',
            active: step.getAttribute('data-active') || '',
            text: String(step.textContent || '').replace(/\\s+/g, ' ').trim(),
          })),
          inline: Boolean(document.querySelector('[data-message-role="assistant"] [data-plan-progress], [data-message-role="assistant"] [data-plan-float]')),
        };
      `);
      assert.eq(renderedPlan.running, 'false', '完成的 Turn 不再把计划标成运行中', {
        criterion: 'update-plan.ui-status',
      });
      assert.eq(renderedPlan.summary, '1/3 已完成 · 2 项未完成', '折叠详情展示真实完成摘要', {
        criterion: 'update-plan.ui-status',
      });
      assert.eq(renderedPlan.inline, false, '计划详情不进入助手消息正文', {
        criterion: 'update-plan.ui-status',
      });
      assert.eq(renderedPlan.steps[1]?.active, 'false', 'Turn 结束后的 in_progress 步骤不再播放运行动画', {
        criterion: 'update-plan.ui-status',
      });
      assert.ok(renderedPlan.steps[1]?.text.includes('未完成'), 'Turn 结束后的 in_progress 步骤显示为未完成', {
        criterion: 'update-plan.ui-status',
      });
    } finally {
      for (const sid of sessions.filter(Boolean)) {
        if (pid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      }
      if (pid) await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
