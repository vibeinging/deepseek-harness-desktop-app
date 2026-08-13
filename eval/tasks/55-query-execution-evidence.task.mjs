export default {
  id: 'query-execution-evidence',
  desc: '真实 DuckDB 查询由执行器生成数据源、SQL、Schema、结果和耗时证据',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const api = driver.raw.api;
    const projectName = `query-execution-evidence-${Date.now()}`;
    const pid = await driver.ensureProjectRecord(projectName);
    try {
      const fixture = writeFixture(
        'query_evidence_sales.csv',
        ['region,amount,channel', '华东,100,online', '华北,200,offline', '华南,150,online'].join('\n'),
      );
      const imported = await driver.importTable(pid, fixture, { dsName: `evidence-${Date.now()}` });
      assert.ok(Boolean(imported.dsid && imported.connId && imported.table), '真实 CSV 已导入 DuckDB');

      const tablesResponse = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables?per_page=100`);
      const table = (tablesResponse.json?.data?.items || []).find((item) =>
        (item.table_name || item.name) === imported.table);
      assert.ok(Boolean(table?.id), '真实表包含稳定元数据 ID');
      if (!table?.id) return;

      const response = await api('POST', '/api/agents/query-evidence/diagnostics', {
        project_id: pid,
        table_id: table.id,
      });
      assert.status(response, 200, 'Server 通过真实数据执行器生成证据');
      const data = response.json?.data || {};
      const evidence = data.evidence || {};
      assert.eq(evidence.version, 'query_execution.v1', '证据使用稳定版本合同');
      assert.eq(evidence.produced_by, 'data_source_executor', '证据明确由数据执行器产生');
      assert.eq(evidence.source?.binding_id, data.target?.binding_id, '证据绑定真实项目数据源关系');
      assert.eq(evidence.source?.source_type, 'structured_data_source', '证据保留原始结构化数据源类型');
      assert.eq(evidence.source?.source_id, imported.dsid, '证据绑定真实结构化数据源 ID');
      assert.eq(evidence.source?.connection_id, imported.connId, '证据绑定真实 DuckDB 连接 ID');
      assert.ok(String(evidence.statement?.text || '').includes(imported.table), '证据保存实际执行 SQL');
      assert.eq(Array.isArray(evidence.statement?.parameters), true, '证据保存实际绑定参数数组');
      assert.ok(
        (evidence.schema?.referenced_tables || []).some((item) => item.id === table.id),
        '证据把 SQL 表名解析到真实表元数据 ID',
      );
      assert.ok(
        (evidence.schema?.referenced_columns || []).length >= 2 &&
          (evidence.schema?.referenced_columns || []).every((item) => data.target.column_ids.includes(item.id)),
        '证据把 SQL 字段解析到真实字段元数据 ID',
      );
      assert.ok(/^sha256:[a-f0-9]{64}$/.test(String(evidence.schema?.version || '')), '证据包含真实 Schema 版本指纹');
      assert.eq(evidence.result?.status, 'completed', '真实查询状态为完成');
      assert.eq(evidence.result?.row_count, 2, '证据行数来自真实 LIMIT 2 查询结果');
      assert.eq(evidence.result?.empty, false, '证据明确结果非空');
      assert.eq(evidence.result?.truncated, false, '证据明确结果未截断');
      assert.ok((evidence.result?.columns || []).length >= 2, '证据包含真实结果列');
      assert.ok(Number(evidence.timing?.duration_ms) >= 0, '证据包含执行器测得耗时');
      assert.ok(Boolean(evidence.timing?.started_at && evidence.timing?.finished_at), '证据包含查询开始和结束时间');
      assert.eq((data.rows || []).length, 2, '诊断返回的真实数据与证据行数一致');
    } finally {
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
