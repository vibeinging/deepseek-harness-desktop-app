export default {
  id: 'agent-evidence-bundle',
  desc: '真实 DuckDB 查询、校验、工具事实和最终答案形成可追溯的统一证据包',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord(`agent-evidence-bundle-${Date.now()}`);
    let sid = '';
    try {
      const session = await api('POST', `/api/projects/${pid}/sessions`, {
        title: 'agent-evidence-bundle-eval',
        source_type: 'agent',
        source_id: pid,
        action_type: 'agentic_chat',
      });
      assert.status(session, 200, '可创建证据包诊断会话');
      sid = session.json?.data?.id || session.json?.data?.session_id || '';
      const fixture = writeFixture(
        'agent_evidence_bundle_sales.csv',
        ['order_id,amount,region', 'o1,100,华东', 'o2,200,华北', 'o3,150,华南'].join('\n'),
      );
      const imported = await driver.importTable(pid, fixture, { dsName: `bundle-${Date.now()}` });
      const tablesResponse = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables?per_page=100`);
      const table = (tablesResponse.json?.data?.items || []).find((item) =>
        (item.table_name || item.name) === imported.table);
      assert.ok(Boolean(sid && table?.id), '真实数据和诊断会话已准备');
      if (!(sid && table?.id)) return;

      const response = await api('POST', '/api/agents/query-evidence/diagnostics', {
        project_id: pid,
        session_id: sid,
        table_id: table.id,
        create_bundle: true,
        validation: {
          require_non_empty: true,
          required_columns: ['order_id', 'amount', 'region'],
          non_null_columns: ['order_id', 'amount'],
          key_columns: ['order_id'],
          numeric_ranges: [{ column: 'amount', min: 0, max: 1000 }],
        },
      });
      assert.status(response, 200, '真实查询和校验生成统一证据包');
      const diagnostic = response.json?.data?.diagnostic_bundle || {};
      const bundle = diagnostic.bundle || {};
      assert.ok(Boolean(diagnostic.run_id && bundle.id), '证据包绑定稳定 run id 和 bundle id');
      assert.eq(bundle.version, 'agent_evidence_bundle.v1', '证据包使用稳定版本合同');
      assert.eq(bundle.status, 'verified', '通过校验的真实结果标记为已验证');
      assert.eq(bundle.run_id, diagnostic.run_id, '证据包绑定真实运行');
      assert.eq(bundle.project_id, pid, '证据包绑定真实项目');
      assert.eq(bundle.session_id, sid, '证据包绑定真实会话');
      assert.eq(bundle.final_item_id, diagnostic.final_item_id, '证据包绑定最终答案 item');
      assert.ok(String(bundle.answer?.text || '').includes('真实查询返回 2 行'), '证据包保存最终答案快照');
      assert.ok(/^sha256:[a-f0-9]{64}$/.test(String(bundle.answer?.text_hash || '')), '最终答案有不可变指纹');
      assert.ok(/^sha256:[a-f0-9]{64}$/.test(String(bundle.snapshot_hash || '')), '完整证据包有不可变指纹');
      assert.eq(bundle.metadata?.environment_snapshot_ref?.version, 'agent_run_environment.v2', '证据包绑定运行环境快照合同');
      assert.ok(/^sha256:[a-f0-9]{64}$/.test(String(bundle.metadata?.environment_snapshot_ref?.snapshot_hash || '')), '证据包绑定运行环境指纹');
      assert.eq(bundle.evidence?.[0]?.produced_by, 'data_source_executor', '证据包保留真实执行器证据');
      assert.ok(String(bundle.evidence?.[0]?.statement?.text || '').includes(imported.table), '证据包保留实际执行 SQL');
      assert.eq(bundle.validations?.[0]?.status, 'passed', '证据包保留确定性校验结果');
      assert.ok((bundle.tool_calls || []).some((item) => item.tool_name === 'execute_readonly_sql' && item.status === 'completed'), '证据包绑定查询工具事实');
      assert.ok((bundle.tool_calls || []).some((item) => item.tool_name === 'validate_query_result' && item.status === 'completed'), '证据包绑定校验工具事实');
      assert.eq(bundle.uncertainty?.has_uncertainty, false, '已验证结果没有隐藏不确定项');

      const listResponse = await api('GET', `/api/agents/runs/${encodeURIComponent(diagnostic.run_id)}/evidence-bundles`);
      assert.status(listResponse, 200, '可按运行读取证据包');
      assert.eq(listResponse.json?.data?.items?.[0]?.id, bundle.id, '运行证据包列表返回同一不可变快照');
      const detailResponse = await api('GET', `/api/agents/evidence-bundles/${encodeURIComponent(bundle.id)}`);
      assert.status(detailResponse, 200, '可按证据包 ID 读取详情');
      assert.eq(detailResponse.json?.data?.snapshot_hash, bundle.snapshot_hash, '详情接口未改写证据快照');
      const runResponse = await api('GET', `/api/agents/runs/${encodeURIComponent(diagnostic.run_id)}`);
      assert.status(runResponse, 200, '运行中心可读取证据包摘要');
      assert.eq(runResponse.json?.data?.evidence_bundles?.[0]?.id, bundle.id, '运行详情包含证据包索引');
      assert.eq(runResponse.json?.data?.run?.environment_snapshot_hash, bundle.metadata?.environment_snapshot_ref?.snapshot_hash, '运行事实和证据包引用同一环境快照');
    } finally {
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
