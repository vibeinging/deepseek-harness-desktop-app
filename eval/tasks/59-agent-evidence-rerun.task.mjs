export default {
  id: 'agent-evidence-rerun',
  desc: '同一来源、SQL、参数和检查可真实复跑，并明确报告数据快照差异',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord(`agent-evidence-rerun-${Date.now()}`);
    let sid = '';
    try {
      const session = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'agent-evidence-rerun-eval',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      sid = session.json?.data?.id || session.json?.data?.session_id || '';
      const fixture = writeFixture(
        'agent_evidence_rerun_sales.csv',
        ['order_id,amount,region', 'o1,100,华东', 'o2,200,华北', 'o3,150,华南'].join('\n'),
      );
      const imported = await driver.importTable(pid, fixture, { dsName: `rerun-${Date.now()}` });
      const tablesResponse = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables?per_page=100`);
      const table = (tablesResponse.json?.data?.items || []).find((item) =>
        (item.table_name || item.name) === imported.table);
      assert.ok(Boolean(sid && table?.id), '真实 DuckDB、会话和元数据已准备');
      if (!(sid && table?.id)) return;

      const prepared = await api('POST', '/api/agents/query-evidence/diagnostics', {
        project_id: pid,
        session_id: sid,
        table_id: table.id,
        query_limit: 100,
        create_bundle: true,
        validation: {
          require_non_empty: true,
          required_columns: ['order_id', 'amount', 'region'],
          non_null_columns: ['order_id', 'amount'],
          key_columns: ['order_id'],
          numeric_ranges: [{ column: 'amount', min: 0, max: 1000 }],
        },
      });
      assert.status(prepared, 200, '真实查询生成复跑基线证据包');
      const baseline = prepared.json?.data?.diagnostic_bundle?.bundle || {};
      assert.ok(Boolean(baseline.id && baseline.snapshot_hash), '基线证据快照可定位');
      assert.eq(baseline.evidence?.[0]?.result?.row_count, 3, '基线记录三行真实结果');
      assert.ok(/^sha256:[a-f0-9]{64}$/.test(String(baseline.evidence?.[0]?.result?.data_hash || '')), '基线记录数据指纹');

      const sameResponse = await api('POST', `/api/agents/evidence-bundles/${encodeURIComponent(baseline.id)}/rerun`, {});
      assert.status(sameResponse, 200, '可直接复跑同一证据快照');
      const same = sameResponse.json?.data || {};
      assert.eq(same.comparison?.version, 'agent_evidence_rerun.v1', '复跑差异合同有稳定版本');
      assert.eq(same.comparison?.summary?.identical, true, '数据未变化时复跑结果一致');
      assert.eq(same.comparison?.summary?.fully_reproducible, true, '数据和环境都未变化时可完整复现');
      assert.eq(same.comparison?.summary?.environment_changed, false, '复跑确认运行环境未变化');
      assert.eq(same.comparison?.queries?.[0]?.source_changed, false, '复跑绑定同一来源');
      assert.eq(same.comparison?.queries?.[0]?.statement_changed, false, '复跑使用同一 SQL 和参数');
      assert.eq(same.comparison?.queries?.[0]?.schema_changed, false, '复跑使用同一 Schema 版本');
      assert.eq(same.comparison?.queries?.[0]?.data_changed, false, '复跑数据指纹一致');
      assert.eq(same.comparison?.queries?.[0]?.row_count?.delta, 0, '复跑行数一致');
      assert.eq(same.rerun_bundle?.status, 'verified', '复跑重新执行确定性检查');
      assert.ok(Boolean(same.run_id && same.rerun_bundle?.id), '复跑创建独立可审查运行和证据包');
      assert.eq(same.rerun_bundle?.metadata?.rerun_of_bundle_id, baseline.id, '新证据包反向绑定基线');

      const replaced = await api('POST', '/api/agents/query-evidence/diagnostics/replace-rows', {
        project_id: pid,
        table_id: table.id,
        rows: [
          { order_id: 'o1', amount: 100, region: '华东' },
          { order_id: 'o2', amount: 260, region: '华北' },
          { order_id: 'o3', amount: 150, region: '华南' },
          { order_id: 'o4', amount: 90, region: '华东' },
        ],
      });
      assert.status(replaced, 200, 'Eval 在同一真实数据源中替换数据');
      assert.eq(replaced.json?.data?.row_count, 4, '真实表已写入四行');

      const changedResponse = await api('POST', `/api/agents/evidence-bundles/${encodeURIComponent(baseline.id)}/rerun`, {});
      assert.status(changedResponse, 200, '数据变化后仍可复跑原基线');
      const changed = changedResponse.json?.data || {};
      const query = changed.comparison?.queries?.[0] || {};
      assert.eq(changed.comparison?.summary?.identical, false, '数据变化不会被误报为一致');
      assert.eq(changed.comparison?.summary?.data_changed, true, '差异摘要明确数据已变化');
      assert.eq(changed.comparison?.summary?.schema_changed, false, '只改数据时 Schema 保持一致');
      assert.eq(changed.comparison?.summary?.environment_changed, false, '只改数据时运行环境快照保持一致');
      assert.eq(query.source_changed, false, '变化对比仍来自同一数据源');
      assert.eq(query.statement_changed, false, '变化对比仍执行同一 SQL 和参数');
      assert.eq(query.row_count?.delta, 1, '差异报告新增一行');
      assert.eq(query.numeric_summary?.amount?.sum_delta, 150, '差异报告数值合计变化');
      assert.ok(query.data_hash?.before !== query.data_hash?.after, '差异报告保留前后数据指纹');
      assert.ok(changed.rerun_bundle?.snapshot_hash !== baseline.snapshot_hash, '变化后生成新的不可变证据快照');
      assert.eq(changed.rerun_bundle?.metadata?.rerun_of_snapshot_hash, baseline.snapshot_hash, '新快照保留基线快照链路');
    } finally {
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
