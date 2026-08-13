// datasource 域路由表(数据源 CRUD,抽自 routes/datasource_crud.js,28 端点)。
// 按聚合拆 3 个用例文件:connections / tables / datasources。一域一 registry,避免多 agent 扇出冲突。
import * as connections from '../app/datasource/connections.js';
import * as tables from '../app/datasource/tables.js';
import * as datasources from '../app/datasource/datasources.js';
import * as syncSettings from '../app/datasource/sync_settings.js';
import * as dataPreparation from '../app/datasource/data_preparation.js';

export const datasourceRoutes = [
  // ── 项目级离线数据准备（Agent Skill、UI 与 Eval 共用同一能力）──
  { m: 'GET', p: '/api/projects/:pid/data-preparation/preview', fn: dataPreparation.previewDataPreparation, auth: true },
  { m: 'POST', p: '/api/projects/:pid/data-preparation/run', fn: dataPreparation.runDataPreparation, auth: true },
  { m: 'GET', p: '/api/projects/:pid/data-preparation/status', fn: dataPreparation.getDataPreparationStatus, auth: true },

  // ── 数据库连接 CRUD ──
  { m: 'POST', p: '/api/projects/:pid/databases', fn: connections.createDatabase, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/databases/:cid', fn: connections.updateDatabase, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/databases/:cid', fn: connections.deleteDatabase, auth: true },

  // ── 外部库连接 / Schema 内省 ──
  { m: 'POST', p: '/api/projects/:pid/databases/meta/test-connection', fn: connections.testConnection, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/meta/schemas/discover', fn: connections.discoverSchemas, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/sync-schema', fn: connections.syncSchema, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/sync-tables', fn: connections.syncTables, auth: true },
  { m: 'GET', p: '/api/projects/:pid/databases/:cid/source-tables', fn: connections.listSourceTables, auth: true },
  { m: 'GET', p: '/api/projects/:pid/databases/:cid/sync-config', fn: syncSettings.getSyncConfig, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/databases/:cid/sync-config', fn: syncSettings.updateSyncConfig, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/metadata-sync', fn: syncSettings.triggerMetadataSync, auth: true },
  { m: 'GET', p: '/api/projects/:pid/databases/:cid/metadata-sync/audits', fn: syncSettings.listSyncAudits, auth: true },
  { m: 'GET', p: '/api/projects/:pid/databases/:cid/sync-audits', fn: syncSettings.listSyncAudits, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/databases/:cid/sync_pending', fn: tables.clearSyncPending, auth: true },

  // ── 上传本地 DB 文件(本地路径 / base64,无 multer)──
  { m: 'POST', p: '/api/projects/:pid/databases/upload-db-file', fn: connections.uploadDbFile, auth: true },

  // ── 表/列元数据维护 ──
  { m: 'DELETE', p: '/api/projects/:pid/databases/:cid/tables/:tid', fn: tables.deleteTable, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/databases/:cid/tables/:tid', fn: tables.updateTable, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/databases/:cid/tables/:tid/high-recall', fn: tables.updateTableHighRecall, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/tables/:tid/sync_example_values', fn: tables.syncTableExampleValues, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/databases/:cid/columns/:colid', fn: tables.updateColumn, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/databases/:cid/tables/:tid/columns', fn: tables.updateColumnsBatch, auth: true },

  // ── 语义富化:向量 / 示例值 / 描述生成 / 关系 / 实体映射 ──
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/tables/store-vectors', fn: tables.storeVectors, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/tables/store-vector', fn: tables.storeSingleTableVector, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/tables/store-columns-vector', fn: tables.storeTableColumnsVector, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/tables/batch_sync_example_values', fn: tables.batchSyncExampleValues, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/semantic-retrieval', fn: tables.searchRelevantTables, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/execute-metadata-query', fn: tables.executeMetadataQuery, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/generate-description', fn: tables.generateDatabaseDescription, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/generate-table-description', fn: tables.generateTableDescriptionUseCase, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/generate-columns-descriptions', fn: tables.generateColumnsDescriptionsUseCase, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/relationships/discover', fn: tables.discoverRelationships, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/relationships/batch-create', fn: tables.batchCreateRelationships, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/relationships/ai-suggest', fn: tables.aiSuggestRelationships, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/relationships', fn: tables.createRelationship, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/databases/:cid/relationships/:rid', fn: tables.updateRelationship, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/databases/:cid/relationships/:rid', fn: tables.deleteRelationship, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/entity_configs/suggest', fn: tables.suggestEntityColumns, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/entity_configs/batch_create', fn: tables.batchCreateEntityConfigs, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/entity_configs/generate_embeddings', fn: tables.generateEntityEmbeddings, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/entities/search', fn: tables.searchEntities, auth: true },
  { m: 'GET', p: '/api/projects/:pid/databases/:cid/entity_mapping_configs', fn: tables.listEntityMappingConfigs, auth: true },
  { m: 'POST', p: '/api/projects/:pid/databases/:cid/entity_mapping_configs', fn: tables.createEntityMappingConfig, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/databases/:cid/entity_mapping_configs/:configId', fn: tables.updateEntityMappingConfig, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/databases/:cid/entity_mapping_configs/:configId', fn: tables.deleteEntityMappingConfig, auth: true },

  // ── 结构化数据源 CRUD ──
  { m: 'GET', p: '/api/projects/:pid/structured-datasources/:dsid', fn: datasources.getStructuredDatasource, auth: true },
  { m: 'POST', p: '/api/projects/:pid/structured-datasources', fn: datasources.createStructuredDatasource, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/structured-datasources/:dsid', fn: datasources.updateStructuredDatasource, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/structured-datasources/:dsid', fn: datasources.deleteStructuredDatasource, auth: true },

  // ── 非结构化数据源 CRUD ──
  { m: 'GET', p: '/api/projects/:pid/unstructured-datasources/:dsid', fn: datasources.getUnstructuredDatasource, auth: true },
  { m: 'POST', p: '/api/projects/:pid/unstructured-datasources', fn: datasources.createUnstructuredDatasource, auth: true },
  { m: 'PUT', p: '/api/projects/:pid/unstructured-datasources/:dsid', fn: datasources.updateUnstructuredDatasource, auth: true },
  { m: 'DELETE', p: '/api/projects/:pid/unstructured-datasources/:dsid', fn: datasources.deleteUnstructuredDatasource, auth: true },
];
