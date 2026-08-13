// App feature: IM Gateway integration for connector and worker lifecycle.
export default {
  id: 'app-integrations',
  desc: 'IM Gateway 集成配置',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('app-feature-integrations-eval');
    const suffix = Date.now();
    const connectorIds = [];

    const legacyFeishu = await api('GET', `/api/feishu/v1/projects/${pid}/configs`);
    assert.status(legacyFeishu, 404, '旧飞书配置路由不在 app 注册');
    const legacyWecom = await api('GET', `/api/wechat/projects/${pid}/wecom/configs`);
    assert.status(legacyWecom, 404, '旧企业微信配置路由不在 app 注册');

    const createConnector = async (payload, message) => {
      const created = await api('POST', '/api/im/connectors', payload);
      assert.status(created, 200, message);
      const id = created.json?.data?.id || '';
      assert.ok(!!id, `${message}:返回 id`);
      connectorIds.push(id);
      assert.eq(created.json?.data?.default_workspace_id, pid, `${message}:默认工作区正确`);
      assert.ok((created.json?.data?.allowed_workspace_ids || []).includes(pid), `${message}:允许当前工作区`);
      return { id, data: created.json?.data };
    };

    const assertWorkerLifecycle = async (connectorId, label) => {
      const started = await api('POST', `/api/im/connectors/${connectorId}/worker/start`, {});
      assert.status(started, 200, `${label}:worker start 可调用`);
      assert.eq(started.json?.data?.status, 'connecting', `${label}:start 后状态为 connecting`);

      const statusAfterStart = await api('GET', `/api/im/connectors/${connectorId}/worker/status`);
      assert.status(statusAfterStart, 200, `${label}:worker status 可读取`);
      assert.eq(statusAfterStart.json?.data?.status, 'connecting', `${label}:status 返回 connecting`);

      const heartbeat = await api('POST', `/api/im/connectors/${connectorId}/worker/heartbeat`, { status: 'connected' });
      assert.status(heartbeat, 200, `${label}:worker heartbeat 可记录`);
      assert.eq(heartbeat.json?.data?.status, 'connected', `${label}:heartbeat 后状态为 connected`);

      const stopped = await api('POST', `/api/im/connectors/${connectorId}/worker/stop`, {});
      assert.status(stopped, 200, `${label}:worker stop 可调用`);
      assert.eq(stopped.json?.data?.status, 'disconnected', `${label}:stop 后状态为 disconnected`);
    };

    try {
      const feishu = await createConnector({
        provider: 'feishu',
        name: `eval-feishu-${suffix}`,
        default_workspace_id: pid,
        allowed_workspace_ids: [pid],
        session_policy: 'per_user',
        credentials: {
          app_id: `cli_a_${suffix}`,
          app_secret: 'eval-feishu-secret',
        },
        settings: { execution_mode: 'record_only' },
      }, '可创建飞书 IM connector');
      assert.eq(feishu.data.provider, 'feishu', '飞书 provider 正确');
      assert.eq(feishu.data.enabled, true, '飞书 connector 默认启用');

      const disabledFeishu = await api('PUT', `/api/im/connectors/${feishu.id}`, { enabled: false });
      assert.status(disabledFeishu, 200, '可禁用飞书 connector');
      assert.eq(disabledFeishu.json?.data?.enabled, false, '飞书 connector enabled=false');
      const disabledStart = await api('POST', `/api/im/connectors/${feishu.id}/worker/start`, {});
      assert.status(disabledStart, 400, '禁用后的飞书 worker 不允许启动');

      const enabledFeishu = await api('PUT', `/api/im/connectors/${feishu.id}`, { enabled: true });
      assert.status(enabledFeishu, 200, '可重新启用飞书 connector');
      await assertWorkerLifecycle(feishu.id, '飞书');

      const wecomBot = await createConnector({
        provider: 'wecom_bot',
        name: `eval-wecom-bot-${suffix}`,
        default_workspace_id: pid,
        allowed_workspace_ids: [pid],
        session_policy: 'per_user',
        credentials: {
          bot_id: `bot_${suffix}`,
          bot_secret: 'eval-wecom-bot-secret',
        },
        settings: { execution_mode: 'record_only' },
      }, '可创建企业微信智能机器人 IM connector');
      assert.eq(wecomBot.data.provider, 'wecom_bot', '企微智能机器人 provider 正确');
      await assertWorkerLifecycle(wecomBot.id, '企微智能机器人');

      const wecomApp = await createConnector({
        provider: 'wecom_app',
        name: `eval-wecom-app-${suffix}`,
        default_workspace_id: pid,
        allowed_workspace_ids: [pid],
        session_policy: 'shared_chat',
        credentials: {
          corp_id: `corp_${suffix}`,
          agent_id: `agent_${suffix}`,
          app_secret: 'eval-wecom-app-secret',
          token: 'eval-token',
          aes_key: 'eval-aes-key',
        },
        settings: { execution_mode: 'record_only' },
      }, '可创建企业微信应用 IM connector');
      assert.eq(wecomApp.data.provider, 'wecom_app', '企微应用 provider 正确');
      assert.eq(wecomApp.data.session_policy, 'shared_chat', '企微应用 session policy 正确');
      await assertWorkerLifecycle(wecomApp.id, '企微应用');

      const listed = await api('GET', '/api/im/connectors');
      assert.status(listed, 200, '可列出 IM connectors');
      const items = listed.json?.data?.items || [];
      assert.ok(items.some((item) => item.id === feishu.id), '列表包含飞书 connector');
      assert.ok(items.some((item) => item.id === wecomBot.id), '列表包含企微智能机器人 connector');
      assert.ok(items.some((item) => item.id === wecomApp.id), '列表包含企微应用 connector');
    } finally {
      for (const id of connectorIds.reverse()) {
        await api('DELETE', `/api/im/connectors/${id}`).catch(() => {});
      }
    }
  },
};
