import { writeRetailSqliteFixture } from '../lib/feature-fixtures.mjs';

function okOrExplicitModelError(resp) {
  const status = Number(resp?.status || 0);
  if (status === 200) return true;
  if (status === 404) return false;
  const text = JSON.stringify(resp?.json || {});
  return /embedding|EMBEDDING|模型|model|llm|LLM|api key|API key|描述生成失败|向量/i.test(text);
}

// App feature: SQLite file import, schema sync, sample value syncing, table/column metadata maintenance, and vectorization endpoints.
export default {
  id: 'app-database-import-offline',
  desc: '数据库文件导入与离线处理',
  async run({ driver, assert }) {
    await driver.login();
    const api = driver.raw.api;
    const pid = await driver.ensureProjectRecord('app-feature-database-import-eval');
    const dbPath = writeRetailSqliteFixture('retail.sqlite');

    const imported = await driver.importDatabase(pid, dbPath, {
      name: `retail_eval_${Date.now()}`,
      extraNotes: 'customers.city 表示客户所在城市; orders.amount 表示订单金额。',
    });
    assert.ok(!!imported.connId, '数据库文件导入生成连接');
    assert.ok(imported.tables.length >= 2, '数据库导入同步出多张表');

    const dbList = await api('GET', `/api/projects/${pid}/databases`);
    const dbRow = (dbList.json?.data?.items || []).find((item) => item.id === imported.connId);
    assert.ok(!!dbRow, '数据库连接列表包含导入连接');
    assert.eq(dbRow?.db_type, 'SQLite', '导入连接类型为 SQLite');

    const tablesResp = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables?per_page=100`);
    const tables = tablesResp.json?.data?.items || [];
    const customers = tables.find((item) => item.table_name === 'customers');
    const orders = tables.find((item) => item.table_name === 'orders');
    assert.ok(!!customers?.id, '表元数据包含 customers');
    assert.ok(!!orders?.id, '表元数据包含 orders');
    assert.eq(Number(customers?.row_count), 3, 'customers row_count 正确');
    assert.eq(Number(orders?.row_count), 4, 'orders row_count 正确');

    const customersColumnsResp = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables/${customers.id}/columns`);
    const customerColumns = customersColumnsResp.json?.data?.items || [];
    const cityCol = customerColumns.find((item) => item.column_name === 'city');
    const tierCol = customerColumns.find((item) => item.column_name === 'tier');
    const nameCol = customerColumns.find((item) => item.column_name === 'name');
    assert.ok(!!cityCol?.id, 'customers 字段包含 city');
    assert.ok(!!tierCol?.id, 'customers 字段包含 tier');
    assert.ok(!!nameCol?.id, 'customers 字段包含 name');

    const ordersColumnsResp = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables/${orders.id}/columns`);
    const orderColumns = ordersColumnsResp.json?.data?.items || [];
    const customerIdCol = orderColumns.find((item) => item.column_name === 'customer_id');
    assert.ok(!!customerIdCol?.id, 'orders 字段包含 customer_id');

    const sampled = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/tables/batch_sync_example_values`, {
      table_ids: [customers.id, orders.id],
      limit: 3,
    });
    assert.status(sampled, 200, '离线处理:可同步列示例值');

    const sampledColumnsResp = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/tables/${customers.id}/columns`);
    const sampledColumns = sampledColumnsResp.json?.data?.items || [];
    const sampledCity = sampledColumns.find((item) => item.column_name === 'city');
    assert.ok(String(sampledCity?.example_values || '').includes('上海'), '离线处理:city 示例值包含上海');

    const singleSampled = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/tables/${customers.id}/sync_example_values`, {
      limit: 2,
    });
    assert.status(singleSampled, 200, '单表示例值同步接口可调用');

    const updatedTable = await api('PUT', `/api/projects/${pid}/databases/${imported.connId}/tables/${customers.id}`, {
      description: '客户主数据表,包含客户城市和等级',
      keywords: '客户,城市,等级',
    });
    assert.status(updatedTable, 200, '可更新表描述');
    assert.ok((updatedTable.json?.data?.description || '').includes('客户主数据'), '表描述更新成功');

    const highRecall = await api('PUT', `/api/projects/${pid}/databases/${imported.connId}/tables/${customers.id}/high-recall`, {
      is_high_recall: true,
    });
    assert.status(highRecall, 200, '可开启表高召回');
    assert.eq(highRecall.json?.data?.is_high_recall, true, '表高召回状态正确');

    const updatedColumn = await api('PUT', `/api/projects/${pid}/databases/${imported.connId}/columns/${cityCol.id}`, {
      description: '客户所在城市',
      is_high_recall: true,
      example_values: ['上海', '北京', '深圳'],
      enum_mappings: { SH: '上海', BJ: '北京', SZ: '深圳' },
    });
    assert.status(updatedColumn, 200, '可更新列描述/示例值/码值');
    assert.ok((updatedColumn.json?.data?.description || '').includes('客户所在城市'), '列描述更新成功');
    assert.eq(Boolean(updatedColumn.json?.data?.is_high_recall), true, '列高召回状态正确');

    const vectorResp = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/tables/store-vectors`, {
      table_ids: [customers.id, orders.id],
      only_pending: false,
    }).catch((e) => ({ status: 0, json: { message: e?.message || String(e) } }));
    const vectorText = JSON.stringify(vectorResp?.json || {});
    assert.ok(
      vectorResp?.status === 200 || /embedding|EMBEDDING|模型|model/i.test(vectorText),
      '离线处理:向量化端点可调用;未配置 embedding 时返回明确错误',
    );

    const singleVectorResp = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/tables/store-vector`, {
      table_id: customers.id,
      table_ids: [customers.id],
      only_pending: false,
    }).catch((e) => ({ status: 0, json: { message: e?.message || String(e) } }));
    assert.ok(okOrExplicitModelError(singleVectorResp), '单表向量化端点可调用;未配置 embedding 时返回明确错误');

    const columnVectorResp = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/tables/store-columns-vector`, {
      table_id: customers.id,
      table_ids: [customers.id],
      only_pending: false,
    }).catch((e) => ({ status: 0, json: { message: e?.message || String(e) } }));
    assert.ok(okOrExplicitModelError(columnVectorResp), '列向量化端点可调用;未配置 embedding 时返回明确错误');

    const semantic = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/semantic-retrieval`, {
      question: 'customer city order amount',
      limit: 5,
    });
    assert.status(semantic, 200, '数据库 Schema 召回接口可调用');
    const semanticItems = semantic.json?.data?.items || [];
    assert.ok(Array.isArray(semanticItems), '数据库 Schema 召回返回 items');
    assert.ok(semanticItems.length > 0, '数据库 Schema 召回返回候选表');

    const metadataQuery = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/execute-metadata-query`, {
      sql: 'SELECT COUNT(*) AS order_count FROM orders',
      limit: 10,
    });
    assert.status(metadataQuery, 200, 'SQL 查询页只读查询接口可调用');
    assert.eq(Boolean(metadataQuery.json?.data?.success), true, 'SQL 查询页只读查询成功');
    const queryRows = metadataQuery.json?.data?.rows || [];
    assert.eq(Number(queryRows[0]?.order_count), 4, 'SQL 查询返回正确结果');

    const forbiddenQuery = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/execute-metadata-query`, {
      sql: 'DELETE FROM orders',
    });
    assert.eq(Number(forbiddenQuery.status), 400, 'SQL 查询页拒绝写入语句');

    const dbDesc = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/generate-description`, {})
      .catch((e) => ({ status: 0, json: { message: e?.message || String(e) } }));
    assert.ok(okOrExplicitModelError(dbDesc), '数据库描述生成端点可调用;未配置模型时返回明确错误');
    if (dbDesc.status === 200) {
      assert.ok(Boolean(String(dbDesc.json?.data?.description || '').trim()), '数据库描述生成返回概要文本');
    }

    const tableDesc = await api('POST', `/api/projects/${pid}/databases/generate-table-description`, {
      connection_id: imported.connId,
      table_id: customers.id,
      only_pending: true,
    }).catch((e) => ({ status: 0, json: { message: e?.message || String(e) } }));
    assert.ok(okOrExplicitModelError(tableDesc), '单表描述生成端点可调用;未配置模型时返回明确错误');

    const syncPending = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/sync_pending`);
    assert.status(syncPending, 200, '同步待处理状态接口可读取');
    const clearPending = await api('DELETE', `/api/projects/${pid}/databases/${imported.connId}/sync_pending`);
    assert.status(clearPending, 200, '同步待处理状态接口可清理');
    assert.eq(Boolean(clearPending.json?.data?.cleared), true, '同步待处理清理返回 cleared');

    const relationshipsBefore = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/relationships`);
    assert.status(relationshipsBefore, 200, '表关系列表接口可读取');
    const existingRelationships = relationshipsBefore.json?.data?.items || [];
    const existingOrdersCustomers = existingRelationships.find(
      (item) => item.source_table_name === 'orders' && item.target_table_name === 'customers'
        && item.source_column === 'customer_id',
    );

    const discovered = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/relationships/discover`, {});
    assert.status(discovered, 200, '表关系发现接口可调用');
    const discoveredCandidates = discovered.json?.data?.candidates || [];
    assert.ok(Array.isArray(discoveredCandidates), '表关系发现返回候选数组');
    assert.ok(
      discoveredCandidates.length > 0 || !!existingOrdersCustomers,
      '表关系发现能返回候选，或导入时已存在外键关系',
    );

    const aiSuggested = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/relationships/ai-suggest`, {
      hint: 'orders customer',
    });
    assert.status(aiSuggested, 200, '表关系智能建议接口可调用');
    assert.ok(Array.isArray(aiSuggested.json?.data?.suggestions || []), '表关系智能建议返回 suggestions');

    const relationCandidate = discoveredCandidates.find(
      (item) => item.source_table_name === 'orders' && item.target_table_name === 'customers',
    ) || {
      source_table_id: orders.id,
      target_table_id: customers.id,
      source_column: 'customer_id',
      target_column: 'id',
      relationship_type: 'many_to_one',
      description: 'eval orders.customer_id -> customers.id',
    };
    const batchRelationship = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/relationships/batch-create`, {
      candidates: [relationCandidate],
    });
    assert.status(batchRelationship, 200, '表关系批量创建接口可调用');
    const createdRelationship = (batchRelationship.json?.data?.results || []).find((item) => item?.id);
    assert.ok(!!createdRelationship?.id, '表关系批量创建返回关系 id');

    const relationshipList = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/relationships`);
    const relationshipItems = relationshipList.json?.data?.items || [];
    assert.ok(relationshipItems.some((item) => item.id === createdRelationship.id), '表关系列表包含新建关系');

    const updatedRelationship = await api('PUT', `/api/projects/${pid}/databases/${imported.connId}/relationships/${createdRelationship.id}`, {
      description: 'eval 更新后的关系说明',
      relationship_type: 'many_to_one',
    });
    assert.status(updatedRelationship, 200, '表关系更新接口可调用');

    const deletedRelationship = await api('DELETE', `/api/projects/${pid}/databases/${imported.connId}/relationships/${createdRelationship.id}`);
    assert.status(deletedRelationship, 200, '表关系删除接口可调用');
    const relationshipsAfterDelete = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/relationships`);
    const afterRelationshipItems = relationshipsAfterDelete.json?.data?.items || [];
    assert.eq(afterRelationshipItems.some((item) => item.id === createdRelationship.id), false, '表关系删除后列表不再包含该关系');

    const entitySuggest = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/entity_configs/suggest`, {
      table_ids: [customers.id],
      min_score: 0.4,
    });
    assert.status(entitySuggest, 200, '实体列推荐接口可调用');
    const entityCandidates = entitySuggest.json?.data?.items || [];
    const entityCandidate = entityCandidates.find((item) => item.column_name === 'name')
      || entityCandidates.find((item) => item.column_name === 'city');
    assert.ok(!!entityCandidate, '实体列推荐包含 name 或 city 字段');

    const batchEntity = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/entity_configs/batch_create`, {
      columns: [{
        table_id: entityCandidate.table_id,
        column_name: entityCandidate.column_name,
        rule: 'eval 实体配置',
      }],
    });
    assert.status(batchEntity, 200, '实体配置批量创建接口可调用');
    const createdEntity = (batchEntity.json?.data?.results || []).find((item) => item?.success && item?.config_id);
    assert.ok(!!createdEntity?.config_id, '实体配置批量创建返回 config_id');

    const entityConfigs = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/entity_mapping_configs`);
    assert.status(entityConfigs, 200, '实体配置列表接口可读取');
    const entityConfigItems = entityConfigs.json?.data?.items || [];
    assert.ok(entityConfigItems.some((item) => item.id === createdEntity.config_id), '实体配置列表包含新配置');

    const updatedEntity = await api('PUT', `/api/projects/${pid}/databases/${imported.connId}/entity_mapping_configs/${createdEntity.config_id}`, {
      rule: 'eval 更新后的实体配置',
      is_active: true,
    });
    assert.status(updatedEntity, 200, '实体配置更新接口可调用');

    const entitySearchKeyword = entityCandidate.column_name === 'city' ? '上海' : 'Alpha';
    const entitySearch = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/entities/search`, {
      query: entitySearchKeyword,
      limit: 10,
    });
    assert.status(entitySearch, 200, '实体搜索接口可调用');
    assert.ok((entitySearch.json?.data?.items || []).length > 0, '实体搜索返回抽取的实体');

    const entityEmbeddings = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/entity_configs/generate_embeddings`, {
      config_id: createdEntity.config_id,
    });
    assert.status(entityEmbeddings, 200, '实体向量生成接口可调用');

    const deletedEntity = await api('DELETE', `/api/projects/${pid}/databases/${imported.connId}/entity_mapping_configs/${createdEntity.config_id}`);
    assert.status(deletedEntity, 200, '实体配置删除接口可调用');
    const entityConfigsAfterDelete = await api('GET', `/api/projects/${pid}/databases/${imported.connId}/entity_mapping_configs`);
    const afterEntityConfigItems = entityConfigsAfterDelete.json?.data?.items || [];
    assert.eq(afterEntityConfigItems.some((item) => item.id === createdEntity.config_id), false, '实体配置删除后列表不再包含该配置');

    const syncTables = await api('POST', `/api/projects/${pid}/databases/${imported.connId}/sync-tables`, {
      table_names: ['customers'],
    });
    assert.status(syncTables, 200, '可按表重新同步 schema');
  },
};
