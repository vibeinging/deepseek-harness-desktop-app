export default {
  id: 'agent-run-retention',
  desc: '真实沙箱运行过期后只清理运行目录和事实，保留工作区产物',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('agent-run-retention-eval');
    let sid = '';
    try {
      const session = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'agent-run-retention-eval',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      assert.status(session, 200, '可创建保留期诊断会话');
      sid = session.json?.data?.id || session.json?.data?.session_id || '';
      assert.ok(Boolean(sid), '保留期诊断会话包含 session id');
      if (!sid) return;

      const prepared = await api('POST', '/api/agents/retention/diagnostics/prepare', {
        project_id: pid,
        session_id: sid,
      });
      assert.status(prepared, 200, 'Server 通过真实沙箱准备过期运行');
      const diagnostic = prepared.json?.data || {};
      const runId = String(diagnostic.run_id || '');
      assert.ok(Boolean(runId && diagnostic.marker && diagnostic.run_temp_path), '诊断返回稳定运行和文件标识');
      if (!runId) return;

      const beforeFacts = await api('GET', `/api/agents/runs/${encodeURIComponent(runId)}`);
      assert.status(beforeFacts, 200, '清理前可读取完整运行事实');
      assert.eq(beforeFacts.json?.data?.run?.status, 'completed', '待清理运行已经完成');
      assert.ok((beforeFacts.json?.data?.tools || []).length > 0, '清理前保存了真实工具调用');
      assert.ok((beforeFacts.json?.data?.artifacts || []).length > 0, '清理前保存了真实产物事实');

      const cleanupResponse = await api('POST', '/api/agents/retention/diagnostics/cleanup', {
        run_id: runId,
      });
      assert.status(cleanupResponse, 200, 'Server 执行真实运行目录和事实清理');
      const result = cleanupResponse.json?.data || {};
      assert.eq(result.cleanup?.scanned_runs, 1, '本次只扫描目标过期运行');
      assert.eq(result.cleanup?.cleaned_runs, 1, '目标过期运行清理成功');
      assert.ok((result.cleanup?.cleaned_run_ids || []).includes(runId), '清理结果包含目标 run id');
      assert.eq((result.cleanup?.failed_runs || []).length, 0, '真实文件清理没有失败');
      assert.eq(result.before?.run_temp_exists, true, '清理前运行私有临时文件真实存在');
      assert.eq(result.before?.artifact_exists, true, '清理前工作区产物真实存在');
      assert.eq(result.before?.artifact_content, diagnostic.marker, '清理前工作区产物内容正确');
      assert.eq(result.after?.run_temp_exists, false, '清理后运行私有目录已删除');
      assert.eq(result.after?.artifact_exists, true, '清理后工作区产物仍保留');
      assert.eq(result.after?.artifact_content, diagnostic.marker, '清理没有改写工作区产物');
      assert.eq(result.after?.facts?.events, 0, '运行事件已清理');
      assert.eq(result.after?.facts?.tools, 0, '工具调用事实已清理');
      assert.eq(result.after?.facts?.artifacts, 0, '产物索引事实已清理');
      assert.eq(result.after?.facts?.pending_inputs, 0, '待输入事实已清理');
      assert.eq(result.after?.facts?.evidence_bundles, 0, '证据包事实已清理');
      assert.ok(Boolean(result.run?.deleted_at), '运行主记录已软删除');
      assert.eq(result.run?.deleted_by, 'retention', '运行主记录标明由保留期清理');
      assert.eq(result.run?.checkpoint_json, null, '恢复点内容已经清空');

      const afterFacts = await api('GET', `/api/agents/runs/${encodeURIComponent(runId)}`);
      assert.status(afterFacts, 404, '清理后的运行不再出现在运行审查接口');

      const artifact = await api(
        'GET',
        `/api/agent/projects/${pid}/file?path=${encodeURIComponent(`${runId}-retained.txt`)}`,
      );
      assert.status(artifact, 200, '清理后仍可通过产品接口读取工作区产物');
      assert.eq(artifact.json?.data?.content, diagnostic.marker, '产品接口读取到的产物内容不变');
    } finally {
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
    }
  },
};
