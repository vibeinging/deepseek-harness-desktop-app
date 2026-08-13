import { dirname } from 'node:path';

export default {
  id: 'workspace-context-menu-state',
  desc: '项目和会话的更多按钮与右键菜单一致，项目设置和返回状态保持一致',
  async run({ driver, assert, writeFixture }) {
    const api = driver.raw.api;
    const ui = driver.ui;
    const stamp = Date.now();
    const firstName = `右键状态 A-${stamp}`;
    const secondName = `右键状态 B-${stamp}`;
    const firstFixture = dirname(writeFixture('workspace-context-menu-a.txt', 'workspace A'));
    const secondFixture = dirname(writeFixture('workspace-context-menu-b.txt', 'workspace B'));
    let firstId = null;
    let secondId = null;
    let sessionId = null;

    try {
      const first = await api('POST', '/api/projects', {
        name: firstName,
        source_folders: [{ path: firstFixture, name: 'A 文件夹' }],
      });
      assert.status(first, 200, '创建项目 A');
      firstId = first.json?.data?.id || null;

      const second = await api('POST', '/api/projects', {
        name: secondName,
        source_folders: [{ path: secondFixture, name: 'B 文件夹' }],
      });
      assert.status(second, 200, '创建项目 B');
      secondId = second.json?.data?.id || null;
      assert.ok(Boolean(firstId && secondId), '两个项目返回真实 ID');

      const session = await api('POST', `/api/projects/${secondId}/sessions`, {
        title: `菜单一致会话-${stamp}`,
        source_type: 'agent',
        source_id: secondId,
        // 自动化会话不需要真实模型或首条用户消息，也会进入同一套会话侧栏组件。
        action_type: 'automation',
      });
      assert.status(session, 200, '在项目 B 中创建菜单测试会话');
      sessionId = session.json?.data?.id || session.json?.data?.session_id || null;
      assert.ok(Boolean(sessionId), '菜单测试会话返回真实 ID');

      await driver.raw.ev(`
        localStorage.setItem('dsh:onboarding:completed:v1', 'true');
        return true;
      `);
      await ui.goto('/agent');
      await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 });
      await ui.waitForText(firstName, { selector: '[title],button,[aria-label]', timeout: 15000 });
      await ui.waitForText(secondName, { selector: '[title],button,[aria-label]', timeout: 15000 });

      const selected = await driver.raw.ev(`
        const picker = document.querySelector('button[class*="wsPickBtn"]');
        if (!picker) return false;
        picker.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const item = [...document.querySelectorAll('button[class*="wsPickItem"]')]
          .find((candidate) => candidate.getAttribute('title') === ${JSON.stringify(firstName)});
        if (!item) return false;
        item.click();
        return true;
      `);
      assert.eq(selected, true, '先选中项目 A');
      await ui.waitUntil(
        `() => document.querySelector('button[class*="wsPickBtn"]')?.textContent?.includes(${JSON.stringify(firstName)})`,
        { timeout: 10000, label: '项目 A 成为当前工作区' },
      );

      const selectedSecond = await driver.raw.ev(`
        const picker = document.querySelector('button[class*="wsPickBtn"]');
        if (!picker) return false;
        picker.click();
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const item = [...document.querySelectorAll('button[class*="wsPickItem"]')]
          .find((candidate) => candidate.getAttribute('title') === ${JSON.stringify(secondName)});
        if (!item) return false;
        item.click();
        return true;
      `);
      assert.eq(selectedSecond, true, '切换到项目 B');
      await driver.raw.ev(`
        const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts');
        eventBus.emit(EVENT_TYPES.NEW_session_CREATED, {
          sessionId: ${JSON.stringify(sessionId)},
          workspaceId: ${JSON.stringify(secondId)},
          projectId: ${JSON.stringify(secondId)},
        });
        return true;
      `);
      await ui.waitFor(`[data-agent-conv-id="${sessionId}"]`, { timeout: 10000 });

      const menuSnapshotScript = `
        const menu = document.querySelector('[role="menu"]');
        if (!menu) return null;
        return {
          className: String(menu.className || ''),
          dividerCount: menu.querySelectorAll('div[class*="ctxDivider"]').length,
          items: [...menu.querySelectorAll('[role="menuitem"]')].map((item) => ({
            label: String(item.textContent || '').trim(),
            disabled: item.disabled,
            danger: String(item.className || '').includes('ctxItemDanger'),
            icon: item.querySelector('svg')?.innerHTML || '',
          })),
        };
      `;

      const projectOverflowOpened = await driver.raw.ev(`
        const row = [...document.querySelectorAll('[title]')]
          .find((candidate) => candidate.getAttribute('title') === ${JSON.stringify(secondName)}
            && String(candidate.className || '').includes('wsFolder'));
        const trigger = row?.querySelector('[data-agent-workspace-menu-trigger]');
        if (!trigger) return false;
        trigger.click();
        return true;
      `);
      assert.eq(projectOverflowOpened, true, '项目更多按钮打开菜单');
      await ui.waitFor('[role="menu"]', { timeout: 10000 });
      const projectOverflowMenu = await driver.raw.ev(menuSnapshotScript);
      await driver.raw.ev(`
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      `);
      await ui.waitUntil(`() => !document.querySelector('[role="menu"]')`, { timeout: 5000, label: '关闭项目更多菜单' });

      const projectContextOpened = await driver.raw.ev(`
        const row = [...document.querySelectorAll('[title]')]
          .find((candidate) => candidate.getAttribute('title') === ${JSON.stringify(secondName)}
            && String(candidate.className || '').includes('wsFolder'));
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: rect.left + Math.min(80, rect.width / 2),
          clientY: rect.top + rect.height / 2,
        }));
        return true;
      `);
      assert.eq(projectContextOpened, true, '右键打开项目 B 菜单');
      await ui.waitFor('[role="menu"]', { timeout: 10000 });
      const projectContextMenu = await driver.raw.ev(menuSnapshotScript);
      assert.eq(JSON.stringify(projectOverflowMenu), JSON.stringify(projectContextMenu), '项目更多按钮与右键菜单逐项一致');
      await driver.raw.ev(`
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      `);
      await ui.waitUntil(`() => !document.querySelector('[role="menu"]')`, { timeout: 5000, label: '关闭项目右键菜单' });

      const conversationOverflowOpened = await driver.raw.ev(`
        const row = document.querySelector('[data-agent-conv-id="${sessionId}"]');
        const trigger = row?.querySelector('[data-agent-conversation-menu-trigger]');
        if (!trigger) return false;
        trigger.click();
        return true;
      `);
      assert.eq(conversationOverflowOpened, true, '会话更多按钮打开菜单');
      await ui.waitFor('[role="menu"]', { timeout: 10000 });
      const conversationOverflowMenu = await driver.raw.ev(menuSnapshotScript);
      await driver.raw.ev(`
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      `);
      await ui.waitUntil(`() => !document.querySelector('[role="menu"]')`, { timeout: 5000, label: '关闭会话更多菜单' });

      const conversationContextOpened = await driver.raw.ev(`
        const row = document.querySelector('[data-agent-conv-id="${sessionId}"]');
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: rect.left + Math.min(80, rect.width / 2),
          clientY: rect.top + rect.height / 2,
        }));
        return true;
      `);
      assert.eq(conversationContextOpened, true, '右键打开会话菜单');
      await ui.waitFor('[role="menu"]', { timeout: 10000 });
      const conversationContextMenu = await driver.raw.ev(menuSnapshotScript);
      assert.eq(JSON.stringify(conversationOverflowMenu), JSON.stringify(conversationContextMenu), '会话更多按钮与右键菜单逐项一致');

      const openedMenu = await driver.raw.ev(`
        const row = [...document.querySelectorAll('[title]')]
          .find((candidate) => candidate.getAttribute('title') === ${JSON.stringify(secondName)}
            && String(candidate.className || '').includes('wsFolder'));
        if (!row) return false;
        const rect = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          button: 2,
          clientX: rect.left + Math.min(80, rect.width / 2),
          clientY: rect.top + rect.height / 2,
        }));
        return true;
      `);
      assert.eq(openedMenu, true, '右键打开项目 B 菜单');
      await ui.clickText('项目设置', { selector: 'button', exact: true, timeout: 10000 });
      await ui.waitForText('B 文件夹', { selector: 'input', timeout: 15000 });

      const settingsState = await driver.raw.ev(`
        return {
          path: location.pathname,
          hash: location.hash,
          inputValues: [...document.querySelectorAll('input')].map((input) => input.value),
        };
      `);
      assert.eq(settingsState.path, '/agent', '项目设置仍在 Agent 页面');
      assert.eq(settingsState.hash, '#basic', '右键打开项目设置默认落在基本信息页');
      assert.ok(settingsState.inputValues.includes('B 文件夹'), '项目设置展示项目 B 的内容');
      assert.ok(!settingsState.inputValues.includes('A 文件夹'), '项目设置不串入项目 A 的内容');

      await ui.clickText('返回项目', { selector: 'button', exact: true, timeout: 10000 });
      await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 10000 });
      const activeWorkspace = await driver.raw.ev(`
        const row = document.querySelector('[class*="wsFolderActive"]');
        return row?.getAttribute('title') || '';
      `);
      assert.eq(activeWorkspace, secondName, '返回后活动工作区仍是项目 B');
    } finally {
      if (sessionId && secondId) await api('DELETE', `/api/projects/${secondId}/sessions/${sessionId}`).catch(() => {});
      if (secondId) await api('DELETE', `/api/projects/${secondId}`).catch(() => {});
      if (firstId) await api('DELETE', `/api/projects/${firstId}`).catch(() => {});
    }
  },
};
