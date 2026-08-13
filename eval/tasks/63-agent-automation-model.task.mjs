export default {
  id: 'agent-automation-model',
  desc: '真实应用可创建、暂停、更新和删除基于 Codex 宿主合同的 v2 本地任务',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord(`agent-automation-model-${Date.now()}`);
    let automationId = '';
    try {
      const created = await api('POST', `/api/agents/projects/${pid}/automations`, {
        name: '每日经营简报',
        prompt: '汇总昨日经营指标，生成带证据的经营简报。',
        destination: { type: 'standalone' },
        schedule: { type: 'daily', time: '09:00', timezone: 'Asia/Shanghai' },
        missed_policy: { mode: 'run_once', grace_minutes: 60 },
        monitor_policy: { mode: 'change_only' },
        max_consecutive_failures: 3,
      });
      assert.status(created, 200, '真实应用创建通用自动化定义');
      const automation = created.json?.data || {};
      automationId = automation.id || '';
      assert.eq(automation.version, 'agent_automation.v2', '定时任务定义使用 v2 合同');
      assert.eq(automation.project_id, pid, '自动化绑定真实项目');
      assert.eq(automation.status, 'enabled', '新自动化默认启用');
      assert.eq(automation.schedule?.type, 'daily', '任务保存运行计划');
      assert.eq(automation.schedule?.timezone, 'Asia/Shanghai', '任务保存显式 IANA 时区');
      assert.ok(Boolean(automation.next_run_at), '启用的周期自动化计算下次运行时间');
      assert.eq(automation.sandbox_policy?.source, 'codex', '任务权限以 Codex 底座为准');
      assert.eq(automation.sandbox_policy?.network, 'managed', '网络由原生沙箱和实际工具权限管理');
      assert.eq(automation.snapshot_policy?.strategy, 'run_start', '自动化每次运行开始保存快照');
      assert.eq(automation.permission_policy?.approval_policy, 'never', '无人值守 Thread 使用原生 never 策略');
      assert.eq(automation.permission_policy?.approvals_reviewer, 'auto_review', '无人值守运行使用底座自动审查');
      assert.eq(automation.destination?.type, 'standalone', '普通任务每次创建独立对话');
      assert.eq(automation.missed_policy?.mode, 'run_once', '任务保存重启补跑策略');
      assert.eq(automation.monitor_policy?.mode, 'change_only', '任务保存变化通知策略');
      assert.eq(automation.notification_policy?.inbox, true, '自动化结果进入运行收件箱');

      const listed = await api('GET', `/api/agents/projects/${pid}/automations`);
      assert.status(listed, 200, '可读取项目自动化列表');
      assert.eq(listed.json?.data?.items?.[0]?.id, automationId, '列表返回同一自动化');

      const paused = await api('POST', `/api/agents/automations/${automationId}/status`, { status: 'paused' });
      assert.status(paused, 200, '可暂停自动化');
      assert.eq(paused.json?.data?.status, 'paused', '暂停状态真实持久化');
      assert.eq(paused.json?.data?.next_run_at, null, '暂停后不再排期');

      const updated = await api('PUT', `/api/agents/automations/${automationId}`, {
        name: '经营简报',
        schedule: { type: 'manual' },
        status: 'enabled',
      });
      assert.status(updated, 200, '可更新自动化');
      assert.eq(updated.json?.data?.name, '经营简报', '名称真实更新');
      assert.eq(updated.json?.data?.schedule?.type, 'manual', '运行计划真实更新');

      const blocked = await api('PUT', `/api/agents/automations/${automationId}`, {
        tool_scope: 'allowlist',
        allowed_tools: ['../../shell'],
      });
      assert.eq(blocked.status, 400, '拒绝无效工具名，不能绕过原生工具范围');

      const removed = await api('DELETE', `/api/agents/automations/${automationId}`);
      assert.status(removed, 200, '可删除自动化');
      assert.eq(removed.json?.data?.deleted, true, '自动化软删除成功');
      automationId = '';
    } finally {
      if (automationId) await api('DELETE', `/api/agents/automations/${automationId}`).catch(() => {});
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
