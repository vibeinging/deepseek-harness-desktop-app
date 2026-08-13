// App feature: unstructured document import, background parsing, description update, reprocess, and delete.
export default {
  id: 'app-unstructured-import',
  desc: '非结构化文档导入与后台解析',
  async run({ driver, assert, writeFixture }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('app-feature-unstructured-import-eval');
    const filePath = writeFixture(
      'customer_policy.md',
      [
        '# 客户分层政策',
        '',
        'gold 客户指年度消费超过 500 元的客户。',
        'silver 客户指年度消费在 100 到 500 元之间的客户。',
        '城市字段用于识别客户所属区域。',
      ].join('\n'),
    );
    const archivePath = writeFixture(
      'service_archive.md',
      [
        '# 客服知识库归档',
        '',
        '客户来电时需要先确认城市和客户等级。',
        'gold 客户支持优先回访。',
      ].join('\n'),
    );
    const dsName = `unstructured-feature-${Date.now()}`;

    const imported = await driver.importUnstructured(pid, [filePath, archivePath], { name: dsName });
    assert.ok(!!imported.dsid, '非结构化数据源创建成功');

    const docs = await api('GET', `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/documents?per_page=100`);
    const docItems = docs.json?.data?.items || docs.json?.data || [];
    const doc = docItems.find((item) => String(item.title || '').endsWith('customer_policy.md'));
    const archiveDoc = docItems.find((item) => String(item.title || '').endsWith('service_archive.md'));
    assert.ok(!!doc?.id, '文档列表包含导入文件');
    assert.ok(!!archiveDoc?.id, '文档列表包含第二个导入文件');
    assert.eq(doc?.status, 'completed', '文档后台解析完成');
    assert.eq(Number(doc?.progress), 100, '文档处理进度为 100');
    assert.ok(Number(doc?.chunk_count) > 0, '文档产生切片');

    const chunks = await api(
      'GET',
      `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/documents/${doc.id}/chunks?page=1&page_size=10`,
    );
    assert.status(chunks, 200, '可按数据源路径查看文档切片');
    const chunkItems = chunks.json?.data?.chunks || chunks.json?.data?.items || [];
    assert.ok(chunkItems.length > 0, '文档切片接口返回内容');
    assert.ok(
      chunkItems.some((item) => String(item.chunk_content || item.content_info?.content || '').includes('gold')),
      '文档切片包含原始文档内容',
    );

    const search = await api('POST', `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/search`, {
      query: 'gold',
      top_k: 5,
    });
    assert.status(search, 200, '非结构化数据源搜索接口可调用');
    const searchItems = Array.isArray(search.json?.data) ? search.json.data : [];
    assert.ok(searchItems.length > 0, '非结构化搜索返回匹配内容');
    assert.ok(searchItems.some((item) => String(item.content || '').includes('gold')), '非结构化搜索命中关键词');

    const bindings = await api('GET', `/api/projects/${pid}/data-sources`);
    const data = bindings.json?.data || {};
    const unstructuredBindings = data.unstructured_data_sources || data.items || [];
    assert.ok(
      unstructuredBindings.some((item) => item.id === imported.dsid || item.source_id === imported.dsid),
      '非结构化数据源自动绑定到项目',
    );

    const docDesc = await api('PUT', `/api/projects/${pid}/unstructured-documents/${doc.id}/description`, {
      description: 'eval 文档描述:客户分层政策',
    });
    assert.status(docDesc, 200, '可手动更新文档描述');
    assert.ok((docDesc.json?.data?.description || '').includes('客户分层政策'), '文档描述更新成功');

    const dsDesc = await api('PUT', `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/description`, {
      description: 'eval 数据源描述:客户政策知识库',
    });
    assert.status(dsDesc, 200, '可手动更新数据源描述');
    assert.ok((dsDesc.json?.data?.description || '').includes('客户政策知识库'), '数据源描述更新成功');

    const reprocess = await api('POST', `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/documents/${doc.id}/reprocess`, {});
    assert.status(reprocess, 200, '可提交文档重新处理');

    const deadline = Date.now() + 60000;
    let currentDoc = null;
    while (Date.now() < deadline) {
      const r = await api('GET', `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/documents?per_page=100`);
      const items = r.json?.data?.items || r.json?.data || [];
      currentDoc = items.find((item) => item.id === doc.id);
      if (currentDoc && ['completed', 'failed'].includes(String(currentDoc.status || ''))) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const afterReprocess = await api('GET', `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/documents?per_page=100`);
    currentDoc = (afterReprocess.json?.data?.items || afterReprocess.json?.data || []).find((item) => item.id === doc.id);
    assert.eq(currentDoc?.status, 'completed', '重新处理后文档仍完成');

    const deleted = await api('DELETE', `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/documents/${doc.id}`);
    assert.status(deleted, 200, '可删除非结构化文档');
    const afterDelete = await api('GET', `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/documents?per_page=100`);
    const afterDeleteItems = afterDelete.json?.data?.items || afterDelete.json?.data || [];
    assert.eq(afterDeleteItems.some((item) => item.id === doc.id), false, '删除后文档列表不再包含该文档');

    const batchDeleted = await api('POST', `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/documents/delete_batch`, {
      document_ids: [archiveDoc.id],
    });
    assert.status(batchDeleted, 200, '可批量删除非结构化文档');
    assert.eq(Number(batchDeleted.json?.data?.deleted_count), 1, '批量删除返回删除数量');
    const afterBatchDelete = await api('GET', `/api/projects/${pid}/unstructured-datasources/${imported.dsid}/documents?per_page=100`);
    const afterBatchItems = afterBatchDelete.json?.data?.items || afterBatchDelete.json?.data || [];
    assert.eq(afterBatchItems.some((item) => item.id === archiveDoc.id), false, '批量删除后文档列表不再包含该文档');
  },
};
