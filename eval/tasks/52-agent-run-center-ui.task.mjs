export default {
  id: 'agent-run-center-ui',
  desc: '真实桌面运行审查中心展示运行事实并恢复同一个运行',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const ui = driver.ui;
    const pid = await driver.ensureProjectRecord('agent-run-center-ui-eval');
    let sid = '';

    try {
      await driver.raw.ev(`
        localStorage.setItem('dsh:onboarding:completed:v1', 'true');
        localStorage.setItem('dsh-layout-nav-width', '248');
        document.querySelector('[aria-label="关闭引导"]')?.click();
      `);
      await ui.goto('/agent');
      await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 });

      const session = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'agent-run-center-ui-eval',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      assert.status(session, 200, '可创建运行审查会话');
      sid = session.json?.data?.id || session.json?.data?.session_id || '';
      assert.ok(Boolean(sid), '运行审查会话包含 session id');
      if (!sid) return;

      const prepared = await api('POST', '/api/agents/recovery/diagnostics/prepare', {
        project_id: pid,
        session_id: sid,
      });
      assert.status(prepared, 200, 'Server 创建真实可恢复运行');
      const diagnostic = prepared.json?.data || {};
      const runId = String(diagnostic.run_id || '');
      assert.ok(Boolean(runId), '真实运行包含稳定 run id');
      if (!runId) return;

      const activation = await driver.raw.ev(`
        const pid = ${JSON.stringify(pid)};
        const sid = ${JSON.stringify(sid)};
        const detail = await window.electronAPI.apiRequest({
          method: 'GET',
          url: '/api/projects/' + encodeURIComponent(pid),
          headers: { 'Content-Type': 'application/json' },
          body: null,
        });
        const project = detail?.json?.data || { id: pid, name: 'agent-run-center-ui-eval' };
        const { useProjectStore } = await import('/src/store/project.ts');
        const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts');
        useProjectStore.getState().setCurrentProject(project);
        eventBus.emit(EVENT_TYPES.NEW_session_CREATED, {
          sessionId: sid,
          workspaceId: pid,
          projectId: pid,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const listed = await window.electronAPI.apiRequest({
          method: 'GET',
          url: '/api/agent/projects/' + encodeURIComponent(pid) + '/sessions',
          headers: { 'Content-Type': 'application/json' },
          body: null,
        });
        return {
          path: location.pathname + location.search + location.hash,
          currentProjectId: useProjectStore.getState().currentProject?.id || '',
          eventListeners: eventBus.events?.[EVENT_TYPES.NEW_session_CREATED]?.length || 0,
          listedSessionIds: (listed?.json?.data?.items || listed?.json?.data || []).map((item) => item.id),
          visibleSessionIds: [...document.querySelectorAll('[data-agent-conv-id]')].map((item) => item.getAttribute('data-agent-conv-id')),
          workspaceTogglePresent: !!document.querySelector('[data-edge-toggle="workspace"]'),
        };
      `);
      assert.eq(activation.path, '/agent', '真实页面位于 Agent 主窗口');
      assert.eq(activation.currentProjectId, pid, '真实页面已切换到 Eval 项目');
      assert.ok(activation.eventListeners > 0, `主窗口已注册会话事件(${JSON.stringify(activation)})`);
      assert.ok(activation.listedSessionIds.includes(sid), `Server 会话列表包含 Eval 会话(${JSON.stringify(activation)})`);

      const conversationSelector = `[data-agent-conv-id="${sid}"]`;
      await ui.waitFor(conversationSelector, { timeout: 15000 });
      await ui.click(conversationSelector, { timeout: 10000 });
      await ui.waitFor('[data-edge-toggle="workspace"]', { timeout: 15000 });
      if (!(await ui.exists('[data-run-center]'))) {
        await ui.click('[data-edge-toggle="workspace"]', { timeout: 10000 });
      }
      await ui.waitFor('[data-run-center]', { timeout: 15000 });
      const runSelector = `[data-run-id="${runId}"]`;
      await ui.waitFor(runSelector, { timeout: 15000 });

      const before = await ui.waitUntil(
        `async () => {
          const root = document.querySelector(${JSON.stringify(runSelector)});
          const text = String(document.querySelector('[data-run-center]')?.textContent || '');
          return text.includes('write') && text.includes(${JSON.stringify(`${runId}.txt`)})
            ? {
                status: root?.getAttribute('data-run-status') || '',
                text,
                recoverVisible: !!document.querySelector('[data-run-action="recover"]'),
              }
            : false;
        }`,
        { timeout: 15000, interval: 100, label: '运行审查界面加载工具和产物事实' },
      );
      assert.eq(before.status, 'recovering', '界面展示真实恢复中状态');
      assert.ok(before.text.includes('write'), '界面展示已保存的真实工具调用');
      assert.ok(before.text.includes(`${runId}.txt`), '界面展示真实文件产物');
      assert.ok(before.recoverVisible, '可恢复运行显示恢复按钮');

      await ui.click('[data-run-action="recover"]', { timeout: 10000 });
      const completed = await ui.waitUntil(
        `async () => {
          const root = document.querySelector(${JSON.stringify(runSelector)});
          return root?.getAttribute('data-run-status') === 'completed'
            ? {
                status: root.getAttribute('data-run-status'),
                text: String(document.querySelector('[data-run-center]')?.textContent || ''),
                recoverVisible: !!document.querySelector('[data-run-action="recover"]'),
              }
            : false;
        }`,
        { timeout: 30000, interval: 250, label: '运行审查界面更新为完成' },
      );
      assert.eq(completed.status, 'completed', '点击恢复后同一个运行在界面变为完成');
      assert.ok(completed.text.includes('恢复完成') || completed.text.includes('run_recovery_completed'), '界面保留恢复完成事件');
      assert.ok(!completed.recoverVisible, '完成后不再显示恢复按钮');

      const facts = await api('GET', `/api/agents/runs/${encodeURIComponent(runId)}`);
      assert.status(facts, 200, '恢复后仍可读取运行事实');
      assert.eq(facts.json?.data?.run?.status, 'completed', 'Server 中同一个 run id 已完成');
      const writeCall = (facts.json?.data?.tools || []).find((tool) => tool.call_id === diagnostic.call_id);
      assert.eq(Number(writeCall?.attempt_count), 1, '界面恢复没有重复执行已完成写调用');
    } finally {
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
    }
  },
};
