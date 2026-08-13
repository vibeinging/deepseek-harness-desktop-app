import { cleanupProjectAgentRuns } from '../lib/agent-run-cleanup.mjs';

function calledTools(output) {
  return new Set((output?.events || [])
    .filter((event) => event.item_type === 'dynamicToolCall' && event.tool_name)
    .map((event) => event.tool_name));
}

export default {
  id: 'agent_runtime-unstructured-many-extract',
  desc: '真实模型把一个文档切片里的多条业务记录展开为多行结果',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord(`agent_runtime-unstructured-many-extract-${Date.now()}`);
    const dsName = `风险登记知识库-${Date.now()}`;
    const filePath = writeFixture('risk_register.md', [
      '# 风险登记',
      '| customer_id | risk_level |',
      '| --- | --- |',
      '| C001 | high |',
      '| C002 | low |',
      '| C003 | high |',
    ].join('\n'));
    let sid = '';
    const runIds = [];
    try {
      const model = await api('GET', `/api/agent/projects/${pid}/model`).catch(() => null);
      assert.ok(Boolean(model?.json?.data?.model_name), '已配置真实 PRIMARY 模型');
      if (!model?.json?.data?.model_name) return;
      const imported = await driver.importUnstructured(pid, filePath, { name: dsName });
      assert.ok(Boolean(imported.dsid), '真实应用导入包含多条记录的 Markdown');

      const output = await driver.askAgent(pid, [
        '读取 risk_register.md，返回全部 customer_id 和 risk_level。',
        '先用 semantic_scan_operator 全量读取。',
        '一个文档切片里有多条记录，必须用 semantic_extract_operator 且 cardinality=many，把每条记录展开为独立中间表行。',
        '不要改用 semantic_filter，也不要凭预览手工抄写。',
      ].join('\n'), { title: 'agent_runtime-unstructured-many-extract', timeoutMs: 240000 });
      sid = output.sid || '';
      const answer = (output.blocks || []).map((block) => String(block.content || '')).join('\n');
      assert.ok(['C001', 'C002', 'C003'].every((id) => answer.includes(id)), '真实答案包含文档中的全部客户');
      const tools = calledTools(output);
      assert.ok(tools.has('semantic_scan_operator'), '真实请求全量读取文档');
      assert.ok(tools.has('semantic_extract_operator'), '真实请求调用一对多语义抽取');

      const listed = await api('GET', `/api/agents/projects/${pid}/runs?session_id=${encodeURIComponent(sid)}`);
      runIds.push(...(listed.json?.data?.items || []).map((run) => run.id).filter(Boolean));
    } finally {
      await cleanupProjectAgentRuns(api, pid, runIds);
      if (sid) await api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
      await api('DELETE', `/api/projects/${pid}`).catch(() => {});
    }
  },
};
