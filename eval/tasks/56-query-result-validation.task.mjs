export default {
  id: 'query-result-validation',
  desc: '真实 DuckDB 结果执行确定性校验并明确暴露失败项',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord(`query-result-validation-${Date.now()}`);
    try {
      const fixture = writeFixture(
        'query_validation_sales.csv',
        ['order_id,amount,created_at', 'o1,100,2026-07-01', 'o2,200,2026-07-02', 'o3,150,2026-07-03'].join('\n'),
      );
      const imported = await driver.importTable(pid, fixture, { dsName: `validation-${Date.now()}` });
      const tablesResponse = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables?per_page=100`);
      const table = (tablesResponse.json?.data?.items || []).find((item) =>
        (item.table_name || item.name) === imported.table);
      assert.ok(Boolean(table?.id), '真实校验表已导入');
      if (!table?.id) return;

      const passedResponse = await api('POST', '/api/agents/query-evidence/diagnostics', {
        project_id: pid,
        table_id: table.id,
        validation: {
          require_non_empty: true,
          required_columns: ['order_id', 'amount', 'created_at'],
          non_null_columns: ['order_id', 'amount'],
          key_columns: ['order_id'],
          numeric_ranges: [{ column: 'amount', min: 0, max: 1000 }],
          time_range: { column: 'created_at', start: '2026-07-01', end: '2026-07-31' },
        },
      });
      assert.status(passedResponse, 200, '真实 DuckDB 结果可执行校验');
      const passed = passedResponse.json?.data?.validation || {};
      assert.eq(passed.version, 'query_validation.v1', '校验使用稳定版本合同');
      assert.eq(passed.status, 'passed', '满足要求的真实结果校验通过');
      assert.eq(Number(passed.summary?.failed), 0, '通过结果没有隐藏失败检查');
      assert.ok(
        ['executor_evidence', 'query_succeeded', 'sql_read_only', 'non_empty', 'required_columns', 'non_null', 'unique_keys', 'numeric_ranges', 'time_range']
          .every((name) => passed.checks?.some((item) => item.name === name && item.passed === true)),
        '来源、只读、非空、字段、空值、重复、数值和时间检查均通过',
      );

      const failedResponse = await api('POST', '/api/agents/query-evidence/diagnostics', {
        project_id: pid,
        table_id: table.id,
        validation: {
          required_columns: ['missing_business_field'],
          numeric_ranges: [{ column: 'amount', max: 50 }],
          required_sql_fragments: ['WHERE region'],
        },
      });
      assert.status(failedResponse, 200, '不满足要求的真实结果仍返回结构化校验');
      const failed = failedResponse.json?.data?.validation || {};
      assert.eq(failed.status, 'failed', '校验失败不会伪装成成功');
      const failedNames = new Set((failed.checks || []).filter((item) => !item.passed).map((item) => item.name));
      assert.ok(failedNames.has('required_columns'), '缺少用户要求字段被明确报告');
      assert.ok(failedNames.has('numeric_ranges'), '数值越界被明确报告');
      assert.ok(failedNames.has('critical_filters'), '缺少关键过滤条件被明确报告');
      assert.ok(Number(failed.summary?.failed) >= 3, '失败摘要保留全部关键失败项');
    } finally {
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
