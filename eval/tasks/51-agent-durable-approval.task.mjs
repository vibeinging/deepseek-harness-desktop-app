export default {
  id: 'agent-durable-approval',
  desc: 'Agent 审批暂停释放执行槽并通过原 run 恢复',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const streamBlocks = driver.raw.streamBlocks;
    const pid = await driver.ensureProjectRecord('agent-durable-approval-eval');
    const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
    if (!model?.json?.data?.model_name) {
      assert.blocked('未配置真实模型，无法执行持久化审批 E2E');
    }

    const marker = `durable-approval-${Date.now().toString(36)}`;
    const fileName = `${marker}.txt`;
    let sid = '';
    try {
      const session = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'agent-durable-approval-eval',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      sid = session.json?.data?.id || session.json?.data?.session_id || '';
      assert.ok(Boolean(sid), '可创建真实审批会话');
      if (!sid) return;

      const first = await streamBlocks(
        `/api/agent/projects/${pid}/threads/${sid}/turns`,
        {
          approvalMode: 'ask',
          mode: 'workspace',
          input: [{ type: 'text', text: [
            '这是持久化审批 E2E，必须调用 write 工具，不能只口头回答。',
            `请把 ${fileName} 的内容精确写成 ${marker}。`,
            `写入成功后只回答 ${marker}。不要调用 bash，不要修改其他文件。`,
          ].join('\n') }],
        },
        { timeoutMs: 180_000 },
      );
      const confirm = (first.blocks || []).find((block) => block.type === 'confirm');
      const request = confirm?.metadata?.approval_request || {};
      assert.ok(Boolean(confirm), 'Agent 写入前返回审批卡');
      assert.ok(request.deferred === true, '审批卡使用持久化暂停而不是进程内 Promise');
      assert.ok(Boolean(request.request_id && request.run_id && request.resume_handle), '审批卡包含稳定恢复句柄');
      if (!(request.request_id && request.run_id)) return;

      const waiting = await api('GET', `/api/agents/runs/${encodeURIComponent(request.run_id)}`);
      assert.status(waiting, 200, '审批暂停后可读取运行事实');
      assert.eq(waiting.json?.data?.run?.status, 'waiting_approval', '运行进入 waiting_approval');
      assert.eq(waiting.json?.data?.run?.lease_owner, null, '等待审批时已释放 Server lease');
      assert.ok(
        !(waiting.json?.data?.tools || []).some((tool) => tool.tool_name === 'write'),
        '用户批准前没有开始真实 write 调用',
      );

      const restart = await driver.raw.ev('return await window.electronAPI.evalRestartBackend()');
      assert.ok(Number(restart?.pid) > 0, '等待审批时真实终止当前 Server 子进程');
      const afterRestart = await driver.raw.ev(`
        const runId = ${JSON.stringify(request.run_id)};
        const deadline = Date.now() + 60000;
        let last = null;
        while (Date.now() < deadline) {
          try {
            last = await window.electronAPI.apiRequest({
              method: 'GET',
              url: '/api/agents/runs/' + encodeURIComponent(runId),
              headers: { 'Content-Type': 'application/json' },
              body: null,
            });
            if (last?.status === 200) return last;
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error('等待审批期间 Server 重启超时: ' + JSON.stringify(last));
      `, { timeoutMs: 65000 });
      assert.eq(
        afterRestart.json?.data?.run?.status,
        'waiting_approval',
        'Server 重启后仍等待人工审批，不会自动绕过',
      );
      assert.eq(afterRestart.json?.data?.run?.lease_owner, null, '重启后待审批运行仍不占执行槽');

      const resumed = await streamBlocks(
        `/api/agent/projects/${pid}/sessions/${sid}/pending-actions/${encodeURIComponent(request.request_id)}/resolve`,
        {
          action_type: 'approval',
          approved: true,
          value: 'approved',
          run_id: request.run_id,
          resume_handle: request.resume_handle,
          approval: 'ask',
          mode: 'workspace',
        },
        { timeoutMs: 180_000 },
      );
      const visible = (resumed.blocks || [])
        .filter((block) => block.type === 'markdown' || block.type === 'final_answer')
        .map((block) => String(block.content || ''))
        .join('\n');
      assert.ok(visible.includes(marker), '审批后 Agent 在同一 Thread 继续并返回最终标记');

      const facts = await api('GET', `/api/agents/runs/${encodeURIComponent(request.run_id)}`);
      assert.status(facts, 200, '恢复后仍使用原 run_id');
      assert.eq(facts.json?.data?.run?.status, 'completed', '审批恢复后的运行正常完成');
      const writeCall = (facts.json?.data?.tools || []).find((tool) =>
        tool.tool_name === 'write' && tool.status === 'completed');
      assert.ok(Number(writeCall?.attempt_count) === 1, '真实 write 只执行一次并保存完成事实');
      const writtenPath = String(writeCall?.input?.path || '');
      const writtenName = writtenPath.split(/[\\/]/).filter(Boolean).pop() || fileName;
      const file = await api(
        'GET',
        `/api/agent/projects/${pid}/file?path=${encodeURIComponent(writtenName)}`,
      );
      assert.status(file, 200, '审批后可按运行事实读取真实 Runner 产物');
      assert.eq(file.json?.data?.content, marker, '审批后的文件内容精确匹配');
      const eventTypes = new Set((facts.json?.data?.events || []).map((event) => event.event_type));
      assert.ok(eventTypes.has('run_approval_grant_consumed'), '一次性审批授权已被恢复调用消费');

      const duplicate = await streamBlocks(
        `/api/agent/projects/${pid}/sessions/${sid}/pending-actions/${encodeURIComponent(request.request_id)}/resolve`,
        {
          action_type: 'approval',
          approved: true,
          value: 'approved',
          run_id: request.run_id,
          resume_handle: request.resume_handle,
          approval: 'ask',
          mode: 'workspace',
        },
        { timeoutMs: 30_000 },
      );
      assert.ok(
        (duplicate.blocks || []).some((block) =>
          block.type === 'confirm' && block.title === 'approved'),
        '重复点击只返回已处理确认',
      );
      const afterDuplicate = await api('GET', `/api/agents/runs/${encodeURIComponent(request.run_id)}`);
      const duplicateWrite = (afterDuplicate.json?.data?.tools || []).find((tool) =>
        tool.tool_name === 'write' && tool.status === 'completed');
      assert.eq(Number(duplicateWrite?.attempt_count), 1, '重复点击审批不会再次执行 write');
    } finally {
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
    }
  },
};
