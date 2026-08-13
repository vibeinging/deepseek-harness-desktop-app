// IM Gateway greenfield core: connector, identity, workspace/session binding, commands, and idempotency.
export default {
  id: 'im-gateway-core',
  desc: '统一 IM Gateway 远程控制核心',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const workspaceA = await driver.ensureProjectRecord('im-gateway-workspace-a-eval');
    const workspaceB = await driver.ensureProjectRecord('im-gateway-workspace-b-eval');
    let connectorId = '';
    let sharedConnectorId = '';

    try {
      const created = await api('POST', '/api/im/connectors', {
        provider: 'fake',
        name: `fake-im-${Date.now()}`,
        default_workspace_id: workspaceA,
        allowed_workspace_ids: [workspaceA, workspaceB],
        session_policy: 'per_user',
        settings: { execution_mode: 'record_only' },
      });
      assert.status(created, 200, '可创建 IM connector');
      connectorId = created.json?.data?.id || '';
      assert.ok(!!connectorId, 'connector 返回 id');
      assert.eq(created.json?.data?.default_workspace_id, workspaceA, 'connector 默认工作区正确');

      const unpaired = await api('POST', '/api/im/fake/events', {
        connector_id: connectorId,
        event_id: 'im-eval-unpaired',
        message_id: 'im-eval-unpaired',
        external_user_id: 'remote-user-1',
        text: 'hello before pairing',
      });
      assert.status(unpaired, 200, '未绑定用户事件可被 gateway 接收');
      assert.eq(unpaired.json?.data?.status, 'pairing_required', '未绑定用户需要 pairing');
      assert.ok(!!unpaired.json?.data?.identity?.pairing_code, '返回 pairing code');

      const identity1 = await api('POST', `/api/im/connectors/${connectorId}/identities`, {
        external_user_id: 'remote-user-1',
        display_name: 'Remote User 1',
        status: 'trusted',
      });
      assert.status(identity1, 200, '可绑定远程用户身份');
      assert.eq(identity1.json?.data?.status, 'trusted', '远程身份为 trusted');

      const first = await api('POST', '/api/im/fake/events', {
        connector_id: connectorId,
        event_id: 'im-eval-msg-1',
        message_id: 'im-eval-msg-1',
        external_user_id: 'remote-user-1',
        text: '第一条远程消息',
      });
      assert.status(first, 200, '已绑定用户消息可路由');
      assert.eq(first.json?.data?.status, 'routed', '普通消息路由成功');
      assert.eq(first.json?.data?.workspace?.id, workspaceA, '默认工作区被使用');
      assert.eq(first.json?.data?.execution_mode, 'record_only', '核心路由 eval 使用 record_only 模式');
      const firstSession = first.json?.data?.session_id || '';
      assert.ok(!!firstSession, '普通消息自动创建 session');

      const deduped = await api('POST', '/api/im/fake/events', {
        connector_id: connectorId,
        event_id: 'im-eval-msg-1',
        message_id: 'im-eval-msg-1',
        external_user_id: 'remote-user-1',
        text: '重复消息不应重复处理',
      });
      assert.status(deduped, 200, '重复 event 可被幂等处理');
      assert.eq(deduped.json?.data?.deduplicated, true, '重复 event 标记 deduplicated');
      assert.eq(deduped.json?.data?.session_id, firstSession, '重复 event 返回原 session');

      const switchWorkspace = await api('POST', '/api/im/fake/events', {
        connector_id: connectorId,
        event_id: 'im-eval-switch-workspace',
        message_id: 'im-eval-switch-workspace',
        external_user_id: 'remote-user-1',
        text: '/workspace im-gateway-workspace-b-eval',
      });
      assert.status(switchWorkspace, 200, '可通过命令切换工作区');
      assert.eq(switchWorkspace.json?.data?.status, 'workspace_switched', '工作区切换命令成功');
      assert.eq(switchWorkspace.json?.data?.workspace?.id, workspaceB, '切换到目标工作区');

      const second = await api('POST', '/api/im/fake/events', {
        connector_id: connectorId,
        event_id: 'im-eval-msg-2',
        message_id: 'im-eval-msg-2',
        external_user_id: 'remote-user-1',
        text: '切换工作区后的消息',
      });
      assert.status(second, 200, '切换后消息可路由');
      assert.eq(second.json?.data?.workspace?.id, workspaceB, '切换后的消息使用新工作区');
      assert.ok(second.json?.data?.session_id !== firstSession, '切换工作区后创建新的 session');

      const identity2 = await api('POST', `/api/im/connectors/${connectorId}/identities`, {
        external_user_id: 'remote-user-2',
        display_name: 'Remote User 2',
        status: 'trusted',
      });
      assert.status(identity2, 200, '可绑定第二个远程用户');

      const groupUser1 = await api('POST', '/api/im/fake/events', {
        connector_id: connectorId,
        event_id: 'im-eval-group-u1',
        message_id: 'im-eval-group-u1',
        external_user_id: 'remote-user-1',
        chat_id: 'group-a',
        chat_type: 'group',
        text: '群里用户1',
      });
      const groupUser2 = await api('POST', '/api/im/fake/events', {
        connector_id: connectorId,
        event_id: 'im-eval-group-u2',
        message_id: 'im-eval-group-u2',
        external_user_id: 'remote-user-2',
        chat_id: 'group-a',
        chat_type: 'group',
        text: '群里用户2',
      });
      assert.status(groupUser1, 200, '群聊用户1消息可路由');
      assert.status(groupUser2, 200, '群聊用户2消息可路由');
      assert.ok(groupUser1.json?.data?.session_id !== groupUser2.json?.data?.session_id, '默认 per_user 群聊不同用户隔离 session');

      const contexts = await api('GET', `/api/im/connectors/${connectorId}/contexts`);
      const contextItems = contexts.json?.data?.items || [];
      assert.ok(contextItems.some((item) => item.external_conversation_key === 'chat:group-a:user:remote-user-1'), 'context 记录群聊用户1 key');
      assert.ok(contextItems.some((item) => item.external_conversation_key === 'chat:group-a:user:remote-user-2'), 'context 记录群聊用户2 key');

      await api('POST', `/api/im/connectors/${connectorId}/identities`, {
        external_user_id: 'ou-feishu-raw',
        status: 'trusted',
      });
      const feishuRaw = await api('POST', `/api/im/connectors/${connectorId}/feishu/events`, {
        header: { event_id: 'im-eval-feishu-raw' },
        event: {
          sender: { sender_id: { open_id: 'ou-feishu-raw', union_id: 'onion-feishu-raw' } },
          message: {
            message_id: 'im-eval-feishu-raw-msg',
            chat_id: 'feishu-chat-raw',
            chat_type: 'group',
            content: JSON.stringify({ text: '飞书原始消息' }),
          },
        },
      });
      assert.status(feishuRaw, 200, '飞书 raw adapter 入口可路由');
      assert.eq(feishuRaw.json?.data?.status, 'routed', '飞书 raw adapter 标准化后进入 Gateway');

      await api('POST', `/api/im/connectors/${connectorId}/identities`, {
        external_user_id: 'wecom-user-raw',
        status: 'trusted',
      });
      const wecomRaw = await api('POST', `/api/im/connectors/${connectorId}/wecom/events`, {
        MsgId: 'im-eval-wecom-raw-msg',
        FromUserName: 'wecom-user-raw',
        ChatId: 'wecom-chat-raw',
        Content: '企微原始消息',
      });
      assert.status(wecomRaw, 200, '企微 raw adapter 入口可路由');
      assert.eq(wecomRaw.json?.data?.status, 'routed', '企微 raw adapter 标准化后进入 Gateway');

      const shared = await api('POST', '/api/im/connectors', {
        provider: 'fake',
        name: `fake-im-shared-${Date.now()}`,
        default_workspace_id: workspaceA,
        allowed_workspace_ids: [workspaceA],
        session_policy: 'shared_chat',
        settings: { execution_mode: 'record_only' },
      });
      assert.status(shared, 200, '可创建 shared_chat connector');
      sharedConnectorId = shared.json?.data?.id || '';
      assert.ok(!!sharedConnectorId, 'shared connector 返回 id');

      await api('POST', `/api/im/connectors/${sharedConnectorId}/identities`, {
        external_user_id: 'shared-user-1',
        status: 'trusted',
      });
      await api('POST', `/api/im/connectors/${sharedConnectorId}/identities`, {
        external_user_id: 'shared-user-2',
        status: 'trusted',
      });
      const shared1 = await api('POST', '/api/im/fake/events', {
        connector_id: sharedConnectorId,
        event_id: 'im-eval-shared-1',
        message_id: 'im-eval-shared-1',
        external_user_id: 'shared-user-1',
        chat_id: 'shared-group',
        chat_type: 'group',
        text: '共享群会话消息1',
      });
      const shared2 = await api('POST', '/api/im/fake/events', {
        connector_id: sharedConnectorId,
        event_id: 'im-eval-shared-2',
        message_id: 'im-eval-shared-2',
        external_user_id: 'shared-user-2',
        chat_id: 'shared-group',
        chat_type: 'group',
        text: '共享群会话消息2',
      });
      assert.status(shared1, 200, 'shared 用户1消息可路由');
      assert.status(shared2, 200, 'shared 用户2消息可路由');
      assert.eq(shared2.json?.data?.session_id, shared1.json?.data?.session_id, 'shared_chat 群聊不同用户复用同一 session');
    } finally {
      if (connectorId) await api('DELETE', `/api/im/connectors/${connectorId}`).catch(() => {});
      if (sharedConnectorId) await api('DELETE', `/api/im/connectors/${sharedConnectorId}`).catch(() => {});
    }
  },
};
