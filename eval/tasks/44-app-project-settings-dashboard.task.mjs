// App feature: project-level base settings, read-only member/role APIs, and Dashboard/Panel CRUD.
export default {
  id: 'app-project-settings-dashboard',
  desc: '项目配置与看板 Panel',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('app-feature-project-settings-eval');
    const suffix = Date.now();
    let dashboardId = '';
    let dashboardPanelId = '';
    let libraryPanelId = '';

    try {
      const projects = await api('GET', '/api/projects?search=app-feature-project-settings-eval');
      const projectItems = projects.json?.data?.items || [];
      assert.ok(projectItems.some((item) => item.id === pid), '项目列表可搜索到 eval 项目');

      const detail = await api('GET', `/api/projects/${pid}`);
      assert.status(detail, 200, '可读取项目详情');
      assert.eq(detail.json?.data?.id, pid, '项目详情 id 正确');

      const workspace = await api('GET', `/api/projects/${pid}/workspace-dir`);
      assert.status(workspace, 200, '可读取项目工作区目录');
      assert.ok(!!workspace.json?.data?.path, '工作区目录返回 path');

      const roles = await api('GET', '/api/projects/roles/list');
      assert.status(roles, 200, '可读取角色列表');
      assert.ok(Array.isArray(roles.json?.data), '角色列表返回数组');

      const members = await api('GET', `/api/projects/${pid}/members`);
      const memberItems = members.json?.data?.items || [];
      assert.status(members, 200, '可读取项目成员');
      assert.ok(memberItems.some((item) => Boolean(item.is_owner)), '成员列表包含 owner');

      const support = await api('GET', '/api/web-search-models/support');
      assert.status(support, 200, '可读取网络搜索模型支持列表');
      assert.ok((support.json?.data || []).some((item) => item.api === 'tavily'), '搜索模型支持 Tavily');

      const createdDashboard = await api('POST', `/api/projects/${pid}/dashboards`, {
        title: `eval-dashboard-${suffix}`,
        description: 'eval dashboard',
      });
      assert.status(createdDashboard, 200, '可创建 Dashboard');
      dashboardId = createdDashboard.json?.data?.id || '';
      assert.ok(!!dashboardId, '创建 Dashboard 返回 id');

      const updatedDashboard = await api('PUT', `/api/projects/${pid}/dashboards/${dashboardId}`, {
        title: `eval-dashboard-updated-${suffix}`,
        description: 'eval dashboard updated',
        layout: [{ i: 'main', x: 0, y: 0, w: 6, h: 4 }],
        refresh_interval: 30,
      });
      assert.status(updatedDashboard, 200, '可更新 Dashboard');
      assert.eq(updatedDashboard.json?.data?.title, `eval-dashboard-updated-${suffix}`, 'Dashboard 标题更新成功');

      const dashboardList = await api('GET', `/api/projects/${pid}/dashboards`);
      const dashboards = dashboardList.json?.data?.dashboards || [];
      assert.ok(dashboards.some((item) => item.id === dashboardId), 'Dashboard 列表包含新看板');

      const refreshedDashboard = await api('POST', `/api/projects/${pid}/dashboards/${dashboardId}/refresh`, {});
      assert.status(refreshedDashboard, 200, '可刷新 Dashboard');

      const createdDashboardPanel = await api('POST', `/api/projects/${pid}/dashboards/${dashboardId}/panels`, {
        title: `eval-dashboard-panel-${suffix}`,
        tags: ['eval'],
        content_type: 'text',
        content: 'dashboard panel content',
        display_type: 'text',
        display_config: { theme: 'light' },
        x: 0,
        y: 0,
        w: 6,
        h: 3,
      });
      assert.status(createdDashboardPanel, 200, '可创建 Dashboard Panel');
      dashboardPanelId = createdDashboardPanel.json?.data?.id || '';
      assert.ok(!!dashboardPanelId, '创建 Dashboard Panel 返回 id');

      const updatedPanel = await api('PUT', `/api/projects/${pid}/panels/${dashboardPanelId}`, {
        title: `eval-dashboard-panel-updated-${suffix}`,
        x: 1,
        y: 2,
        w: 5,
        h: 4,
      });
      assert.status(updatedPanel, 200, '可更新 Dashboard Panel');
      assert.eq(updatedPanel.json?.data?.title, `eval-dashboard-panel-updated-${suffix}`, 'Dashboard Panel 标题更新成功');

      const layoutUpdate = await api('PUT', `/api/projects/${pid}/dashboards/${dashboardId}/panels/layout`, {
        layouts: [{ panel_id: dashboardPanelId, x: 2, y: 3, w: 4, h: 4 }],
      });
      assert.status(layoutUpdate, 200, '可批量更新 Dashboard Panel 布局');
      assert.eq(Number(layoutUpdate.json?.data?.updated_count), 1, '布局更新数量正确');

      const refreshedPanel = await api('POST', `/api/projects/${pid}/dashboards/${dashboardId}/panels/${dashboardPanelId}/refresh`, {});
      assert.status(refreshedPanel, 200, '可刷新 Dashboard Panel');

      const dashboardPanels = await api('GET', `/api/projects/${pid}/dashboards/${dashboardId}/panels`);
      const dashboardPanelItems = dashboardPanels.json?.data || [];
      const currentDashboardPanel = dashboardPanelItems.find((item) => item.id === dashboardPanelId);
      assert.ok(!!currentDashboardPanel, 'Dashboard Panel 列表包含新 Panel');
      assert.eq(Number(currentDashboardPanel?.x), 2, 'Dashboard Panel 布局 x 已更新');

      const createdLibraryPanel = await api('POST', `/api/projects/${pid}/panels`, {
        title: `eval-library-panel-${suffix}`,
        tags: ['eval', 'library'],
        content_type: 'text',
        content: 'library panel content',
        display_type: 'text',
      });
      assert.status(createdLibraryPanel, 200, '可创建 Panel 库条目');
      libraryPanelId = createdLibraryPanel.json?.data?.id || '';
      assert.ok(!!libraryPanelId, '创建 Panel 库条目返回 id');

      const panelDetail = await api('GET', `/api/projects/${pid}/panels/${libraryPanelId}`);
      assert.status(panelDetail, 200, '可读取 Panel 库详情');
      assert.eq(panelDetail.json?.data?.id, libraryPanelId, 'Panel 库详情 id 正确');

      const updatedLibraryPanel = await api('PUT', `/api/projects/${pid}/panels/${libraryPanelId}`, {
        title: `eval-library-panel-updated-${suffix}`,
      });
      assert.status(updatedLibraryPanel, 200, '可更新 Panel 库条目');
      assert.eq(updatedLibraryPanel.json?.data?.title, `eval-library-panel-updated-${suffix}`, 'Panel 库标题更新成功');

      const generatedPanel = await api('POST', `/api/projects/${pid}/panels/generate`, {});
      assert.status(generatedPanel, 200, 'Panel 生成入口可调用');
    } finally {
      if (dashboardPanelId) await api('DELETE', `/api/projects/${pid}/dashboards/panels/${dashboardPanelId}`).catch(() => {});
      if (libraryPanelId) await api('DELETE', `/api/projects/${pid}/panels/${libraryPanelId}`).catch(() => {});
      if (dashboardId) await api('DELETE', `/api/projects/${pid}/dashboards/${dashboardId}`).catch(() => {});
    }
  },
};
