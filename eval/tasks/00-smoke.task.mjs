// Smoke test: verifies app is operable in real UI. Fast and does not call LLM.
export default {
  id: 'smoke',
  desc: 'UI 冒烟',
  eval: {
    feature: 'app.shell',
    layer: 'ui_e2e',
    risk: 'P0',
    interaction: 'cdp',
    model: 'none',
    data: 'synthetic',
    platforms: ['darwin', 'win32'],
    timeoutMs: 60_000,
    repeats: 1,
    minPassRate: 1,
    requirements: ['app.shell.ready', 'app.legacy-route-removed'],
    tags: ['pr', 'ui'],
    criteria: [
      {
        id: 'project.available',
        description: '隔离环境可以创建或选择项目',
        evidence: ['api'],
      },
      {
        id: 'shell.input-ready',
        description: '真实 Renderer 显示主窗口输入框',
        evidence: ['ui'],
      },
      {
        id: 'shell.input-interactive',
        description: '真实鼠标和键盘可以编辑消息输入框',
        evidence: ['ui', 'cdp'],
      },
      {
        id: 'shell.legacy-hidden',
        description: '旧入口统一回到主窗口且不挂载旧页面',
        evidence: ['ui'],
      },
    ],
  },
  async run({ driver, assert }) {
    const pid = await driver.ensureProjectRecord('smoke-eval');
    assert.ok(!!pid, '可创建或选择项目', { criterion: 'project.available' });

    // 首次引导有独立用例；本用例只判定主窗口交互，避免异步弹窗遮挡输入框。
    await driver.raw.ev(`
      localStorage.setItem('dsh:onboarding:completed:v1', 'true');
      return true;
    `);
    await driver.ui.goto('/agent');
    await driver.ui.waitUntil(
      `() => !document.querySelector('[aria-labelledby="dsh-onboarding-title"]')`,
      { timeout: 5000, label: '主窗口没有首次引导遮挡' },
    );
    await driver.ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 });
    assert.ok(
      await driver.ui.exists('[data-testid="agent-message-input"]'),
      'app 主界面输入框可用',
      { criterion: 'shell.input-ready' },
    );
    const marker = `EVAL_INPUT_${Date.now().toString(36)}`;
    await driver.ui.fill('[data-testid="agent-message-input"]', marker);
    const typed = await driver.ui.waitUntil(
      `() => document.querySelector('[data-testid="agent-message-input"]')?.value === ${JSON.stringify(marker)}`,
      { timeout: 5000, label: '消息输入框接收真实键盘输入' },
    );
    assert.ok(typed, '真实鼠标和键盘可以填写消息', { criterion: 'shell.input-interactive' });
    await driver.ui.fill('[data-testid="agent-message-input"]', '');
    assert.eq(
      await driver.ui.exists('#Sidebar'),
      false,
      'app 主界面不挂载旧侧边栏',
      { criterion: 'shell.legacy-hidden' },
    );

    for (const path of ['/projects', '/database', `/project/${pid}/settings`, '/dashboard']) {
      await driver.ui.goto(path);
      await driver.ui.waitUntil(
        `() => location.pathname === '/agent'`,
        { timeout: 15000, label: `旧入口 ${path} 回到 app 主界面` },
      );
      assert.eq(await driver.ui.exists('#Sidebar'), false, `${path} 不应显示旧侧边栏`, { criterion: 'shell.legacy-hidden' });
      assert.eq(await driver.ui.exists('[data-testid="database-page"]'), false, `${path} 不应显示旧数据库页`, { criterion: 'shell.legacy-hidden' });
      assert.eq(await driver.ui.exists('[data-testid="project-page"]'), false, `${path} 不应显示旧项目页`, { criterion: 'shell.legacy-hidden' });
    }
  },
};
