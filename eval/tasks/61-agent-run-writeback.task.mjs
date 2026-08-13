export default {
  id: 'agent-run-writeback',
  desc: '项目规则先保存在运行草稿，批准前不改项目，批准后保存前后值和写回回执',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord(`agent-run-writeback-${Date.now()}`);
    let sid = '';
    let runId = '';
    try {
      const session = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'agent-run-writeback-eval',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      sid = session.json?.data?.id || session.json?.data?.session_id || '';
      const marker = `WRITEBACK_RULE_${Date.now()}`;
      const response = await api('POST', '/api/agents/run-writeback/diagnostics', {
        project_id: pid,
        session_id: sid,
        rule_type: 'sql',
        operation: 'append',
        content: `${marker}：城市名称必须保留中文原值。`,
      });
      assert.status(response, 200, '真实应用完成一次带确认的项目规则写回');
      const data = response.json?.data || {};
      runId = data.run_id || '';
      assert.eq(data.version, 'agent_run_writeback_diagnostic.v1', '写回诊断合同有稳定版本');
      assert.ok(Boolean(runId && data.call_id), '写回绑定真实 run 和工具调用');
      assert.eq(data.after_stage?.rules, data.before?.rules, '批准前项目规则完全未变化');
      assert.eq(data.pending?.status, 'pending', '草稿保存后运行进入真实待确认状态');
      assert.eq(data.pending?.payload?.writeback?.version, 'agent_run_writeback_proposal.v1', '确认请求绑定写回草稿合同');
      assert.eq(data.pending?.payload?.writeback?.proposal_hash, data.proposal?.proposal_hash, '确认请求绑定同一草稿指纹');
      assert.eq(data.proposal?.status, 'staged', '写回草稿保持待写回状态');
      assert.eq(data.proposal?.before?.rules, data.before?.rules, '草稿保存变更前规则');
      assert.ok(String(data.proposal?.proposed_after?.rules || '').includes(marker), '草稿保存计划写入的规则');
      assert.eq(data.resolved?.approved, true, '真实持久化确认已批准');
      assert.ok(String(data.after_apply?.rules || '').includes(marker), '批准后规则真实写入项目');
      assert.eq(data.receipt?.version, 'agent_run_writeback_receipt.v1', '写回回执使用稳定合同');
      assert.eq(data.receipt?.status, 'applied', '写回回执标记已应用');
      assert.eq(data.receipt?.proposal_hash, data.proposal?.proposal_hash, '回执反向绑定草稿');
      assert.eq(data.receipt?.before?.rules, data.before?.rules, '回执保留写回前内容');
      assert.ok(String(data.receipt?.actual_after?.rules || '').includes(marker), '回执保留真实写回后内容');
      assert.ok(/^sha256:[a-f0-9]{64}$/.test(String(data.receipt?.receipt_hash || '')), '写回回执有不可变指纹');
      const proposalArtifact = (data.artifacts || []).find((item) => item.kind === 'writeback_proposal');
      const receiptArtifact = (data.artifacts || []).find((item) => item.kind === 'writeback_receipt');
      assert.ok(String(proposalArtifact?.path || '').includes(`/${runId}/work/writebacks/`), '草稿只保存在本次运行 work 目录');
      assert.ok(String(receiptArtifact?.path || '').includes(`/${runId}/artifacts/writebacks/`), '已批准回执保存在本次运行 artifacts 目录');
    } finally {
      if (runId) {
        const cleanup = await api('POST', '/api/agents/run-writeback/diagnostics', { action: 'cleanup', run_ids: [runId] }).catch(() => null);
        if (cleanup) assert.ok((cleanup.json?.data?.removed || []).every((item) => item.removed || item.missing), 'Eval 写回运行目录已精确清理');
      }
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
