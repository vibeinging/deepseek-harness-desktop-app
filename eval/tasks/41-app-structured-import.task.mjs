// App feature: structured file import (CSV → DuckDB) and project data-source binding.
export default {
  id: 'app-structured-import',
  desc: '结构化 CSV 导入生成表/字段元数据',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('app-feature-structured-import-eval');
    const dsName = `structured-feature-${Date.now()}`;
    const csv = [
      'region,amount,channel',
      '华东,100,online',
      '华北,200,offline',
      '华南,150,online',
    ].join('\n');
    const filePath = writeFixture('structured_sales.csv', csv);

    const imported = await driver.importTable(pid, filePath, { dsName });
    assert.ok(!!imported.dsid, '结构化数据源创建成功');
    assert.ok(!!imported.connId, '结构化导入生成 DuckDB 连接');
    assert.ok(imported.tables.length > 0, '结构化导入生成至少一张表');

    const dsList = await api('GET', `/api/projects/${pid}/structured-datasources`);
    const ds = (dsList.json?.data?.items || []).find((item) => item.id === imported.dsid);
    assert.ok(!!ds, '结构化数据源列表包含新数据源');
    assert.eq(ds?.database_connection_id, imported.connId, '结构化数据源绑定 DuckDB 连接');

    const docs = await api('GET', `/api/projects/${pid}/structured-documents/list?data_source_id=${imported.dsid}`);
    const docItems = docs.json?.data?.items || [];
    const currentDoc = docItems.find((item) => item.file_path === filePath || item.title === 'structured_sales.csv');
    assert.ok(!!currentDoc, '结构化文档列表包含导入文件');
    assert.eq(currentDoc?.status, 'completed', '结构化文档处理完成');
    assert.eq(Number(currentDoc?.chunk_count), 3, '结构化文档记录导入行数');

    const structuredTables = await api('GET', `/api/projects/${pid}/structured-tables?data_source_id=${imported.dsid}`);
    assert.status(structuredTables, 200, '结构化数据源表列表接口可调用');
    const structuredTableItems = structuredTables.json?.data?.items || [];
    assert.ok(structuredTableItems.length > 0, '结构化数据源表列表返回表');
    assert.ok(
      structuredTableItems.some((item) => imported.tables.includes(item.table_name || item.name)),
      '结构化数据源表列表包含导入表',
    );

    const tablesByDocument = await api('GET', `/api/projects/${pid}/structured-tables/by-document?document_id=${currentDoc.id || currentDoc.document_id}`);
    assert.status(tablesByDocument, 200, '结构化文档表列表接口可调用');
    assert.ok((tablesByDocument.json?.data?.items || []).length > 0, '结构化文档表列表返回表');

    const retrieval = await api('POST', `/api/projects/${pid}/structured-datasources/${imported.dsid}/semantic-retrieval`, {
      question: 'region amount channel',
      limit: 5,
    });
    assert.status(retrieval, 200, '结构化数据源语义召回接口可调用');
    assert.ok(Array.isArray(retrieval.json?.data?.items), '结构化数据源语义召回返回 items');

    const tablesResp = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables?per_page=100`);
    const tables = tablesResp.json?.data?.items || [];
    const table = tables.find((item) => imported.tables.includes(item.table_name || item.name)) || tables[0];
    assert.ok(!!table?.id, 'DuckDB 连接可读取表元数据');
    assert.eq(Number(table?.row_count), 3, '表元数据 row_count 正确');

    const columnsResp = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables/${table.id}/columns`);
    const columns = columnsResp.json?.data?.items || [];
    const columnNames = columns.map((col) => col.column_name);
    assert.ok(columnNames.includes('region'), '字段元数据包含 region');
    assert.ok(columnNames.includes('amount'), '字段元数据包含 amount');
    assert.ok(columnNames.includes('channel'), '字段元数据包含 channel');

    const bindings = await api('GET', `/api/projects/${pid}/data-sources`);
    const data = bindings.json?.data || {};
    const structuredBindings = data.structured_data_sources || data.items || [];
    assert.ok(
      structuredBindings.some((item) => item.id === imported.dsid || item.source_id === imported.dsid),
      '结构化数据源自动绑定到项目',
    );

    const deleted = await api('POST', `/api/projects/${pid}/structured-documents/delete_batch`, {
      document_ids: [currentDoc.id || currentDoc.document_id],
    });
    assert.status(deleted, 200, '结构化文档批量删除接口可调用');
    assert.eq(Number(deleted.json?.data?.deleted_count), 1, '结构化文档批量删除返回删除数量');
    const afterDelete = await api('GET', `/api/projects/${pid}/structured-documents/list?data_source_id=${imported.dsid}`);
    const afterDeleteItems = afterDelete.json?.data?.items || [];
    assert.eq(
      afterDeleteItems.some((item) => (item.id || item.document_id) === (currentDoc.id || currentDoc.document_id)),
      false,
      '结构化文档批量删除后列表不再包含该文档',
    );
  },
};
