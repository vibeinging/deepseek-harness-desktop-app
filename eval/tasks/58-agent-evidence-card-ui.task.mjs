export default {
  id: 'agent-evidence-card-ui',
  desc: '最终答案旁的依据卡默认收起并按需展示真实来源、SQL、检查、过程和快照',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const api = driver.raw.api;
    const ui = driver.ui;
    const pid = await driver.ensureProjectRecord(`agent-evidence-card-${Date.now()}`);
    let sid = '';
    try {
      await driver.raw.ev(`
        localStorage.setItem('dsh:onboarding:completed:v1', 'true');
        document.querySelector('[aria-label="关闭引导"]')?.click();
      `);
      await ui.goto('/agent');
      await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 15000 });
      const session = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'agent-evidence-card-ui',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      sid = session.json?.data?.id || session.json?.data?.session_id || '';
      const fixture = writeFixture(
        'agent_evidence_card_sales.csv',
        ['order_id,amount,region', 'o1,100,华东', 'o2,200,华北', 'o3,150,华南'].join('\n'),
      );
      const imported = await driver.importTable(pid, fixture, { dsName: `evidence-card-${Date.now()}` });
      const tablesResponse = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables?per_page=100`);
      const table = (tablesResponse.json?.data?.items || []).find((item) =>
        (item.table_name || item.name) === imported.table);
      assert.ok(Boolean(sid && table?.id), '真实数据、会话和表已准备');
      if (!(sid && table?.id)) return;

      const prepared = await api('POST', '/api/agents/query-evidence/diagnostics', {
        project_id: pid,
        session_id: sid,
        table_id: table.id,
        create_bundle: true,
        attach_to_session: true,
        validation: {
          require_non_empty: true,
          required_columns: ['order_id', 'amount', 'region'],
          non_null_columns: ['order_id', 'amount'],
          numeric_ranges: [{ column: 'amount', min: 0, max: 1000 }],
        },
      });
      assert.status(prepared, 200, '真实证据答案已写入会话');
      const diagnostic = prepared.json?.data?.diagnostic_bundle || {};
      const bundle = diagnostic.bundle || {};

      const activation = await driver.raw.ev(`
        const pid = ${JSON.stringify(pid)};
        const sid = ${JSON.stringify(sid)};
        const detail = await window.electronAPI.apiRequest({
          method: 'GET', url: '/api/projects/' + encodeURIComponent(pid),
          headers: { 'Content-Type': 'application/json' }, body: null,
        });
        const project = detail?.json?.data || { id: pid, name: 'agent-evidence-card-ui' };
        const { useProjectStore } = await import('/src/store/project.ts');
        const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts');
        useProjectStore.getState().setCurrentProject(project);
        eventBus.emit(EVENT_TYPES.NEW_session_CREATED, { sessionId: sid, workspaceId: pid, projectId: pid });
        return { currentProjectId: useProjectStore.getState().currentProject?.id || '' };
      `);
      assert.eq(activation.currentProjectId, pid, '真实主窗口切换到证据项目');
      const conversationSelector = `[data-agent-conv-id="${sid}"]`;
      await ui.waitFor(conversationSelector, { timeout: 15000 });
      await ui.click(conversationSelector, { timeout: 10000 });
      const cardSelector = `[data-evidence-bundle-id="${bundle.id}"]`;
      await ui.waitFor(cardSelector, { timeout: 15000 });

      const collapsed = await driver.raw.ev(`
        const card = document.querySelector(${JSON.stringify(cardSelector)});
        const toggle = card?.querySelector('[data-evidence-toggle]');
        const reveal = card?.querySelector('[data-evidence-reveal]');
        return {
          text: card?.textContent || '',
          expanded: toggle?.getAttribute('aria-expanded'),
          bodyHeight: reveal?.getBoundingClientRect().height || 0,
          status: card?.getAttribute('data-evidence-status') || '',
        };
      `);
      assert.eq(collapsed.expanded, 'false', '依据卡默认收起');
      assert.eq(collapsed.status, 'verified', '收起态展示已验证状态');
      assert.ok(collapsed.text.includes('查看依据') && collapsed.text.includes('已验证'), '收起摘要简洁展示入口和状态');
      assert.eq(collapsed.bodyHeight, 0, '默认不把完整依据铺在聊天区');

      const hitTarget = await driver.raw.ev(`
        const button = document.querySelector(${JSON.stringify(`${cardSelector} [data-evidence-toggle]`)});
        const rect = button?.getBoundingClientRect();
        const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
        return {
          buttonTag: button?.tagName || '',
          hitTag: hit?.tagName || '',
          hitEvidenceToggle: !!hit?.closest?.('[data-evidence-toggle]'),
          hitText: String(hit?.textContent || '').slice(0, 80),
          rect: rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null,
        };
      `);
      assert.eq(hitTarget.hitEvidenceToggle, true, `依据卡按钮中心没有被其他界面遮挡(${JSON.stringify(hitTarget)})`);
      await ui.click(`${cardSelector} [data-evidence-toggle]`, { timeout: 10000 });
      const coordinateClick = await driver.raw.ev(`
        await new Promise((resolve) => setTimeout(resolve, 300));
        return document.querySelector(${JSON.stringify(cardSelector)})?.querySelector('[data-evidence-toggle]')?.getAttribute('aria-expanded') || '';
      `);
      assert.eq(coordinateClick, 'true', '真实鼠标点击可展开依据卡');
      if (coordinateClick !== 'true') {
        await driver.raw.ev(`document.querySelector(${JSON.stringify(`${cardSelector} [data-evidence-toggle]`)})?.click()`);
      }
      const clickedState = await driver.raw.ev(`
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const card = document.querySelector(${JSON.stringify(cardSelector)});
        return {
          present: !!card,
          expanded: card?.querySelector('[data-evidence-toggle]')?.getAttribute('aria-expanded') || '',
          loading: card?.getAttribute('data-evidence-loading') || '',
          error: card?.getAttribute('data-evidence-error') || '',
          text: String(card?.textContent || ''),
          sourceCount: card?.querySelectorAll('[data-evidence-source]').length || 0,
        };
      `);
      assert.eq(clickedState.expanded, 'true', `依据卡点击后保持展开(${JSON.stringify(clickedState)})`);
      const expanded = await ui.waitUntil(
        `async () => {
          const card = document.querySelector(${JSON.stringify(cardSelector)});
          const text = String(card?.textContent || '');
          return card?.querySelector('[data-evidence-toggle]')?.getAttribute('aria-expanded') === 'true'
            && card?.getAttribute('data-evidence-loading') === 'false'
            ? {
                text,
                expanded: card.querySelector('[data-evidence-toggle]')?.getAttribute('aria-expanded'),
                error: card.getAttribute('data-evidence-error') || '',
                sourceCount: card.querySelectorAll('[data-evidence-source]').length,
                sqlCount: card.querySelectorAll('[data-evidence-sql]').length,
                checkCount: card.querySelectorAll('[data-evidence-check]').length,
              }
            : false;
        }`,
        { timeout: 15000, interval: 100, label: '依据卡加载真实快照' },
      );
      assert.eq(expanded.expanded, 'true', '点击后展开依据卡');
      assert.eq(expanded.error, '', '依据详情接口没有返回错误');
      assert.ok(expanded.sourceCount > 0, '展开态展示真实数据来源');
      assert.ok(expanded.sqlCount > 0, '展开态提供实际 SQL');
      assert.ok(expanded.checkCount > 0, '展开态展示确定性检查');
      assert.ok(expanded.text.includes('数据来自哪里') && expanded.text.includes('实际算了什么') && expanded.text.includes('检查了什么'), '依据按用户问题组织而非铺工具日志');
      assert.ok(expanded.text.includes(String(bundle.snapshot_hash).replace(/^sha256:/, '').slice(0, 12)), '界面展示同一证据快照短指纹');

      await ui.click(`${cardSelector} [data-evidence-action="rerun"]`, { timeout: 10000 });
      const identicalRerun = await ui.waitUntil(
        `async () => {
          const card = document.querySelector(${JSON.stringify(cardSelector)});
          const result = card?.querySelector('[data-evidence-rerun-result="ok"]');
          return card?.getAttribute('data-evidence-rerunning') === 'false' && result
            ? { text: result.textContent || '', error: card.getAttribute('data-evidence-rerun-error') || '' }
            : false;
        }`,
        { timeout: 20000, interval: 100, label: '证据卡完成同一查询复跑' },
      );
      assert.eq(identicalRerun.error, '', '同一查询复跑没有接口错误');
      assert.ok(identicalRerun.text.includes('复跑一致') && identicalRerun.text.includes('数据、Schema 和检查均未变化'), '复跑一致时给出直接结论');

      const replaced = await api('POST', '/api/agents/query-evidence/diagnostics/replace-rows', {
        project_id: pid,
        table_id: table.id,
        rows: [
          { order_id: 'o1', amount: 110, region: '华东' },
          { order_id: 'o2', amount: 200, region: '华北' },
          { order_id: 'o3', amount: 150, region: '华南' },
        ],
      });
      assert.status(replaced, 200, '真实数据变化已写入同一 DuckDB 表');
      await ui.click(`${cardSelector} [data-evidence-action="rerun"]`, { timeout: 10000 });
      const changedRerun = await ui.waitUntil(
        `async () => {
          const card = document.querySelector(${JSON.stringify(cardSelector)});
          const result = card?.querySelector('[data-evidence-rerun-result="warn"]');
          return card?.getAttribute('data-evidence-rerunning') === 'false' && result
            ? { text: result.textContent || '', hasRunLink: !!result.querySelector('[data-evidence-action="rerun-run"]') }
            : false;
        }`,
        { timeout: 20000, interval: 100, label: '证据卡显示复跑数据差异' },
      );
      assert.ok(changedRerun.text.includes('发现变化') && changedRerun.text.includes('amount 合计 +10'), '真实数据变化在答案旁显示数值差异');
      assert.eq(changedRerun.hasRunLink, true, '复跑结果可打开新的运行记录');

      await ui.click(`${cardSelector} [data-evidence-action="trace"]`, { timeout: 10000 });
      const review = await ui.waitUntil(
        `async () => {
          const traceButton = document.querySelector('[data-workstation-view="trace"][data-active="true"]');
          return traceButton ? { traceActive: traceButton.getAttribute('data-active') === 'true', cardStillVisible: !!document.querySelector(${JSON.stringify(cardSelector)}) } : false;
        }`,
        { timeout: 10000, interval: 100, label: '证据卡打开右侧过程审查' },
      );
      assert.eq(review.traceActive, true, '证据卡可打开右侧过程审查');
      assert.eq(review.cardStillVisible, true, '打开审查不会离开最终答案');
    } finally {
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
