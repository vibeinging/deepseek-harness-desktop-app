export default {
  id: 'agent-run-recovery-restart',
  desc: '真实杀掉 Server 后自动恢复运行且不重复写文件',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('agent-run-recovery-restart-eval');
    let sid = '';
    try {
      const session = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'agent-run-recovery-restart-eval',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      assert.status(session, 200, '可创建恢复诊断会话');
      sid = session.json?.data?.id || session.json?.data?.session_id || '';
      assert.ok(Boolean(sid), '恢复诊断会话包含 session id');
      if (!sid) return;

      const prepared = await api('POST', '/api/agents/recovery/diagnostics/prepare', {
        project_id: pid,
        session_id: sid,
      });
      assert.status(prepared, 200, 'Server 创建包含已完成写调用的恢复点');
      const diagnostic = prepared.json?.data || {};
      const runId = diagnostic.run_id || '';
      assert.ok(Boolean(runId && diagnostic.call_id && diagnostic.marker), '恢复点由 Server 生成稳定运行标识');
      if (!runId) return;

      const before = await api('GET', `/api/agents/runs/${encodeURIComponent(runId)}`);
      assert.status(before, 200, '重启前可读取运行事实');
      const beforeFacts = before.json?.data || {};
      assert.eq(beforeFacts.run?.status, 'recovering', '故障注入前运行停在可恢复状态');
      assert.ok(
        (beforeFacts.tools || []).some((tool) =>
          tool.call_id === diagnostic.call_id &&
          tool.tool_name === 'write' &&
          tool.status === 'completed' &&
          Number(tool.attempt_count) === 1),
        '故障前写调用已完成且只执行一次',
      );

      const restart = await driver.raw.ev('return await window.electronAPI.evalRestartBackend()');
      assert.ok(Number(restart?.pid) > 0, 'Electron 真实终止当前 Server 子进程');
      assert.eq(restart?.signal, 'SIGKILL', '故障注入使用不可被 Server 捕获的 SIGKILL');

      const recovered = await driver.raw.ev(`
        const runId = ${JSON.stringify(runId)};
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
            if (last?.status === 200 && last?.json?.data?.run?.status === 'completed') return last;
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error('等待 Server 重启并自动恢复运行超时: ' + JSON.stringify(last));
      `, { timeoutMs: 65000 });
      assert.status(recovered, 200, 'Electron 自动拉起的新 Server 可正常响应');

      const facts = recovered.json?.data || {};
      assert.eq(facts.run?.status, 'completed', '新 Server 自动将同一个 run_id 恢复到完成');
      const writeCall = (facts.tools || []).find((tool) => tool.call_id === diagnostic.call_id);
      assert.eq(Number(writeCall?.attempt_count), 1, '恢复后写调用次数仍为 1，没有重复执行');
      assert.eq(writeCall?.status, 'completed', '恢复后继续使用原写调用的完成结果');
      const eventTypes = new Set((facts.events || []).map((event) => event.event_type));
      assert.ok(eventTypes.has('run_recovery_ready'), '新 Server 启动时识别到可恢复运行');
      assert.ok(eventTypes.has('run_recovery_dispatched'), '新 Server 自动调度恢复任务');
      assert.ok(eventTypes.has('tool_call_replayed'), '恢复过程重放已保存的写调用结果');
      assert.ok(eventTypes.has('run_recovery_completed'), '恢复过程写入完成事实');

      const artifact = await api(
        'GET',
        `/api/agent/projects/${pid}/file?path=${encodeURIComponent(`${runId}.txt`)}`,
      );
      assert.status(artifact, 200, '恢复后仍可读取真实 Runner 产物');
      assert.eq(artifact.json?.data?.content, diagnostic.marker, '真实文件内容没有被重复恢复改写');
    } finally {
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
    }
  },
};
