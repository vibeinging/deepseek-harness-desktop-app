function rows(response) {
  const data = response?.json?.data;
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.messages)) return data.messages;
  return [];
}

function messageItems(message) {
  if (Array.isArray(message?.content_items)) return message.content_items;
  try { return JSON.parse(String(message?.content_items || '[]')); } catch { return []; }
}

function cleanSummary(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 2_000);
}

export default {
  id: 'agent-automation-execution',
  desc: '真实本地任务通过 Codex App Server 创建独立对话、普通 Agent Run、环境快照和结果收件箱',
  eval: {
    feature: 'dsh.automations.execution',
    layer: 'model_eval',
    risk: 'P0',
    interaction: 'app',
    model: 'real',
    data: 'synthetic',
    platforms: ['darwin', 'win32', 'linux'],
    timeoutMs: 900_000,
    repeats: 1,
    minPassRate: 1,
    requirements: ['automations.execute', 'automations.inbox'],
    tags: ['model-nightly', 'dsh-alignment'],
    criteria: [],
  },
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord(`agent-automation-execution-${Date.now()}`);
    let automationId = '';
    let sessionId = '';
    let runId = '';
    try {
      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      if (!model?.json?.data?.model_name) {
        assert.blocked('未配置真实模型，无法执行自动化模型 E2E');
      }

      const marker = `AUTOMATION_EVAL_OK_${Date.now().toString(36)}`;
      const created = await api('POST', `/api/agents/projects/${pid}/automations`, {
        name: '真实只读自动化',
        prompt: `这是自动化执行 Eval。不要调用任何工具，只回答 ${marker}，不要添加其他内容。`,
        destination: { type: 'standalone' },
        schedule: { type: 'manual' },
      });
      assert.status(created, 200, '真实应用创建手动自动化');
      automationId = created.json?.data?.id || '';
      if (!automationId) return;

      const executed = await api('POST', `/api/agents/automations/${automationId}/run`, {});
      assert.status(executed, 200, '真实后台自动化完成一次 Agent 执行');
      const item = executed.json?.data || {};
      runId = item.run_id || '';
      sessionId = item.session_id || '';
      assert.eq(item.status, 'completed', '自动化执行成功');
      assert.eq(item.inbox_status, 'unread', '完成结果进入未读收件箱');
      assert.ok(Boolean(runId && sessionId), '自动化运行绑定普通 run 和 session');
      if (!(runId && sessionId)) return;

      const messages = await api('GET', `/api/projects/${pid}/sessions/${sessionId}/messages`);
      assert.status(messages, 200, '可读取自动化独立对话');
      const finalNarrative = rows(messages)
        .filter((message) => message.role === 'assistant')
        .flatMap(messageItems)
        .filter((content) => ['markdown', 'text', 'error'].includes(content?.type))
        .map((content) => cleanSummary(content?.content))
        .filter(Boolean)
        .at(-1) || '';
      assert.ok(Boolean(finalNarrative), '自动化保存真实模型回答');
      assert.eq(item.summary, finalNarrative, '收件箱摘要来自真实模型回答');

      const facts = await api('GET', `/api/agents/runs/${encodeURIComponent(runId)}`);
      assert.status(facts, 200, '运行中心可读取自动化的普通运行事实');
      assert.eq(facts.json?.data?.run?.status, 'completed', '普通 Agent Run 状态为 completed');
      assert.eq(facts.json?.data?.run?.mode, 'automation', '普通 Agent Run 明确标记后台自动化模式');
      assert.eq(facts.json?.data?.run?.workspace_version, 'agent_run_workspace.v1', '自动化拥有独立运行工作区');
      assert.ok(String(facts.json?.data?.run?.environment_snapshot_version || '').startsWith('agent_run_environment.v'), '任务保存运行开始快照');

      const environment = await api('GET', `/api/agents/runs/${encodeURIComponent(runId)}/environment`);
      assert.status(environment, 200, '可读取自动化运行环境快照');
      const snapshot = environment.json?.data || {};
      assert.eq(snapshot.permissions?.approval_policy, 'never', '无人值守 Thread 使用 Codex 原生 never 策略');
      assert.eq(snapshot.permissions?.approvals_reviewer, 'auto_review', '无人值守运行使用底座自动审查');
      assert.eq(snapshot.permissions?.sandbox?.system_enforced, true, '后台运行使用系统沙箱');
      assert.eq(snapshot.automation?.id, automationId, '快照固定本次自动化定义');
      assert.ok(String(snapshot.automation?.prompt || '').includes(marker), '快照固定本次真实提示词');

      const inbox = await api('GET', `/api/agents/projects/${pid}/automation-runs`);
      assert.status(inbox, 200, '可读取自动化运行收件箱');
      assert.eq(inbox.json?.data?.items?.[0]?.run_id, runId, '收件箱链接同一普通运行');
      const read = await api('POST', `/api/agents/automation-runs/${item.id}/read`, {});
      assert.status(read, 200, '可把自动化结果标为已读');
      assert.eq(read.json?.data?.inbox_status, 'read', '已读状态真实持久化');
    } finally {
      if (automationId) await api('DELETE', `/api/agents/automations/${automationId}`).catch(() => {});
      if (runId) {
        const impact = await api('GET', `/api/agents/runs/${encodeURIComponent(runId)}/deletion-impact`).catch(() => null);
        const impactHash = impact?.json?.data?.impact_hash;
        if (impactHash) {
          await api('DELETE', `/api/agents/runs/${encodeURIComponent(runId)}`, { impact_hash: impactHash, force: true }).catch(() => {});
        }
      }
      if (sessionId) await api('DELETE', `/api/projects/${pid}/sessions/${sessionId}`).catch(() => {});
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
