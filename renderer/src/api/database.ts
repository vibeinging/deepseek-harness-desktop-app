import request from '@/utils/axios-req'
import { apiStreamFetch } from '@/utils/api-stream'
import { useConfigStore } from '@/store/config'

// Get language header
function getLangHeader() {
  try {
    const language = useConfigStore.getState().language
    const langMap: any = { zh: 'zh-CN', en: 'en-US' }
    return langMap[language] || 'zh-CN'
  } catch {
    return 'zh-CN'
  }
}

// Get environment variables
const env = import.meta.env

// Get database list
export function databaseListReq(projectId: any, keyword?: any) {
  return request({
    url: `/api/projects/${projectId}/databases`,
    method: 'get',
    params: {
      keyword
    }
  })
}

// Create database config
export function createDatabaseReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases`,
    method: 'post',
    data
  })
}

// Update database config
export function updateDatabaseReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${data.id}`,
    method: 'put',
    data
  })
}

// Delete database config
export function deleteDatabaseReq(projectId: any, id: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${id}`,
    method: 'delete'
  })
}

// Get database details
export function getDatabaseDetailReq(projectId: any, id: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${id}`,
    method: 'get'
  })
}

// Test database connection
export function testDatabaseConnectionReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/meta/test-connection`,
    method: 'post',
    data
  })
}

// Get all columns for a specific table
export function getTableColumnsReq(projectId: any, connectionId: any, tableId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/columns`,
    method: 'get'
  })
}

// Sync database schema to business database
export function syncDatabaseSchemaReq(projectId: any, connectionId: any, data: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync-schema`,
    method: 'post',
    data,
    ignoreLoading: true,
    timeout: 600000 // 10 minutes (600 seconds), aligned with backend timeout settings
  })
}

// Sync by table
export function syncDatabaseTablesReq(projectId: any, connectionId: any, { tableIds = null, tableNames = null }: any = {}) {
  const data: any = {}
  if (tableIds) {
    data.table_ids = tableIds
  }
  if (tableNames) {
    data.table_names = tableNames
  }
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync-tables`,
    method: 'post',
    data,
    ignoreLoading: true,
    timeout: 600000
  })
}

// Get metadata sync config
export function getSyncConfigReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync-config`,
    method: 'get'
  })
}

// Save metadata sync config
export function updateSyncConfigReq(projectId: any, connectionId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync-config`,
    method: 'put',
    data
  })
}

// Manually trigger metadata sync and write sync records
export function triggerMetadataSyncReq(projectId: any, connectionId: any, data: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metadata-sync`,
    method: 'post',
    data,
    ignoreLoading: true,
    timeout: 600000
  })
}

// Get metadata sync logs
export function listSyncAuditsReq(projectId: any, connectionId: any, params: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync-audits`,
    method: 'get',
    params,
    ignoreMsg: true,
    validateStatus: (status: number) => status < 500
  })
}

// Get supported database type list
export function supportDatabaseReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/meta/supported-types`,
    method: 'get'
  })
}

// Get database info by ID
export function getDatabaseByIdReq(projectId: any, id: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${id}`,
    method: 'get'
  })
}

// Get cached table list
export function getCachedTablesReq(projectId: any, connectionId: any, params: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables`,
    method: 'get',
    params
  })
}

// Get raw source table list (for table-based sync)
export function getSourceTablesReq(projectId: any, connectionId: any, params: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/source-tables`,
    method: 'get',
    params
  })
}

// Update column info (description, high recall flag, example values)
export function updateColumnDescriptionReq(projectId: any, connectionId: any, columnId: any, description: any, isHighRecall: any = null, exampleValues: any = null, enumMappings: any = null) {
  const data: any = { description }
  if (isHighRecall !== null) {
    data.is_high_recall = isHighRecall
  }
  if (exampleValues !== null) {
    data.example_values = exampleValues
  }
  if (enumMappings !== null) {
    data.enum_mappings = enumMappings
  }
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/columns/${columnId}`,
    method: 'put',
    data
  })
}

// Delete cached table
export function deleteCachedTableReq(projectId: any, connectionId: any, tableId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}`,
    method: 'delete'
  })
}

// Unified schema enrichment API (supports streaming and non-streaming)
export function enrichSchema(projectId: any, data: any) {
  // Use streaming output based on the stream parameter
  const { stream = false, force_regenerate = false, user_requirements = null, ...requestData } = data

  if (stream) {
    // Streaming request - use fetch for SSE
    const baseUrl = env.VITE_APP_BASE_URL || ''
    return apiStreamFetch(baseUrl + `/api/projects/${projectId}/databases/enrich`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept-Language': getLangHeader()
      },
      body: JSON.stringify({ ...requestData, stream: true, force_regenerate, user_requirements })
    })
  } else {
    // Non-streaming request - use wrapped axios request
    return request({
      url: `/api/projects/${projectId}/databases/enrich`,
      method: 'post',
      data: { ...requestData, stream: false, force_regenerate, user_requirements }
    })
  }
}

// Save enrichment data
export function saveEnhancementReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/save-enhancement`,
    method: 'post',
    data
  })
}

// Auto-discover schema
export function discoverSchemasReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/meta/schemas/discover`,
    method: 'post',
    data
  })
}

// Get database example data stats
export function getExamplesReq(projectId: any, databaseId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples`,
    method: 'get'
  })
}

// Get paginated database example data list
export function getExamplesListReq(projectId: any, databaseId: any, page: any = 1, pageSize: any = 20) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples`,
    method: 'get',
    params: {
      list: 'true',
      page,
      page_size: pageSize
    }
  })
}

// Add example data
export function addExamplesReq(projectId: any, databaseId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples`,
    method: 'post',
    data
  })
}

// Update example data
export function updateExampleReq(projectId: any, databaseId: any, exampleId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples/${exampleId}`,
    method: 'put',
    data
  })
}

// Delete example data
export function deleteExamplesReq(projectId: any, databaseId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples`,
    method: 'delete',
    data
  })
}

// Search similar examples
export function searchExamplesReq(projectId: any, databaseId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/examples/search`,
    method: 'post',
    data
  })
}

// Generate table AI description
export function generateTableDescriptionReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/generate-table-description`,
    method: 'post',
    data,
  })
}

// Generate single-table AI description (reuses batch generation service)
export function generateSingleTableDescriptionReq(projectId: any, connectionId: any, tableId: any, limitExamples: any = 2, extraNotes: any = null) {
  const data: any = {
    connection_id: connectionId,
    table_id: tableId,
    limit_examples: limitExamples
  }
  // Add extra notes to request data when provided
  if (extraNotes && extraNotes.trim()) {
    data.extra_notes = extraNotes.trim()
  }
  return request({
    url: `/api/projects/${projectId}/databases/generate-table-description`,
    method: 'post',
    data,
  })
}

// Generate database AI description
export function generateDatabaseDescriptionReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/generate-description`,
    method: 'post',
  })
}

// Generate column and table descriptions in batch (AI-generated)
export function generateColumnsDescriptionsReq(projectId: any, connectionId: any, tableIds: any = null, limitExamples: any = 2, onlyPending: any = false) {
  return request({
    url: `/api/projects/${projectId}/databases/generate-columns-descriptions`,
    method: 'post',
    data: {
      connection_id: connectionId,
      table_ids: tableIds,
      limit_examples: limitExamples,
      only_pending: onlyPending
    }
  })
}


// Get pending table sync info
export function getSyncPendingReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync_pending`,
    method: 'get'
  })
}

// Clear pending table sync info
export function clearSyncPendingReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/sync_pending`,
    method: 'delete'
  })
}

// Sync table sample data into column fields
export function syncTableExampleValuesReq(projectId: any, connectionId: any, tableId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/sync_example_values`,
    method: 'post',
  })
}

// Batch sync sample data of multiple tables into column fields
export function batchSyncTableExampleValuesReq(projectId: any, connectionId: any, tableIds: any, limit: any = 2) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/batch_sync_example_values`,
    method: 'post',
    data: {
      table_ids: tableIds,
      limit: limit
    }
  })
}

// Update table description
export function updateTableDescriptionReq(projectId: any, connectionId: any, tableId: any, description: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}`,
    method: 'put',
    data: {
      description
    }
  })
}

// Update table high-recall priority state
export function updateTableHighRecallReq(projectId: any, connectionId: any, tableId: any, isHighRecall: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/high-recall`,
    method: 'put',
    data: {
      is_high_recall: isHighRecall
    }
  })
}

// Batch update column info (description, keywords, high-recall state)
export function batchUpdateColumnsReq(projectId: any, connectionId: any, tableId: any, columns: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/columns`,
    method: 'put',
    data: {
      columns: columns.map((col: any) => {
        const item: any = {
          column_id: col.column_id,
          description: col.description || ''
        }
        if (col.keywords !== null && col.keywords !== undefined) {
          item.keywords = col.keywords
        }
        if (col.is_high_recall !== null && col.is_high_recall !== undefined) {
          item.is_high_recall = col.is_high_recall
        }
        return item
      })
    }
  })
}

// Get sample data for a table
export function getTableSampleReq(projectId: any, connectionId: any, tableId: any, limit: any = 10) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/sample`,
    method: 'get',
    params: { limit }
  })
}

// ==================== Table Vector Storage and RAG Retrieval API ====================

// Store table and column descriptions into vector store in one batch.
export function storeTableVectorsReq(
  projectId: any,
  databaseId: any,
  tableIds: any,
  onlyPending: boolean = true
) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/tables/store-vectors`,
    method: 'post',
    data: {
      table_ids: tableIds,
      only_pending: onlyPending,
      scope: 'all'
    },
  })
}

// Store a single table description into vector store
export function storeSingleTableVectorReq(projectId: any, databaseId: any, tableId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/tables/store-vector`,
    method: 'post',
    data: {
      table_id: tableId,
      database_id: databaseId
    },
  })
}

// Batch store all column descriptions for a table into vector store
export function storeTableColumnsVectorReq(projectId: any, databaseId: any, tableId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/tables/store-columns-vector`,
    method: 'post',
    data: {
      table_id: tableId,
      database_id: databaseId
    },
  })
}

// Retrieve semantically relevant tables via RAG
export function searchRelevantTablesReq(projectId: any, databaseId: any, question: any, similarityThreshold: any = 0.5) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/semantic-retrieval`,
    method: 'post',
    data: {
      question: question
    }
  })
}

// Clear table vector data
export function clearTableVectorsReq(projectId: any, databaseId: any, tableIds: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/tables/clear-vectors`,
    method: 'post',
    data: {
      table_ids: tableIds
    }
  })
}

// Get vector store collection statistics
export function getCollectionStatsReq(projectId: any, databaseId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${databaseId}/collection-stats`,
    method: 'get'
  })
}

// Refresh database schema (re-fetch from the target database)
export function refreshSchemaReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/refresh-schema`,
    method: 'post',
    timeout: 60000
  })
}

// ==================== Entity Mapping API ====================

// Create entity mapping
export function createEntityMappingsReq(projectId: any, connectionId: any, tableId: any, columnName: any, metadataFields: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/tables/${tableId}/entity_mappings`,
    method: 'post',
    data: {
      column_name: columnName,
      metadata_fields: metadataFields
    },
    timeout: 300000 // 5-minute timeout because it may process large amounts of data
  })
}

// Get entity mapping list (deprecated, use mapping config list instead)
export function getEntityMappingsReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings`,
    method: 'get'
  })
}

// ==================== Entity Mapping Config Management API ====================

// Get entity mapping config list
export function getEntityMappingConfigsReq(projectId: any, connectionId: any, tableName: any = null) {
  const params = tableName ? { table_name: tableName } : {}
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mapping_configs`,
    method: 'get',
    params: params,
  })
}

// Create entity mapping config
export function createEntityMappingConfigReq(projectId: any, connectionId: any, tableId: any, columnName: any, metadataFields: any = null, rule: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mapping_configs`,
    method: 'post',
    data: {
      table_id: tableId,
      column_name: columnName,
      metadata_fields: metadataFields,
      rule: rule
    },
    timeout: 300000 // 5-minute timeout because it may process large amounts of data
  })
}

// Delete entity mapping config by ID
export function deleteEntityMappingConfigReq(projectId: any, connectionId: any, configId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mapping_configs/${configId}`,
    method: 'delete'
  })
}

// Delete entity mapping config by table and column (deprecated)
export function deleteEntityMappingConfigByNameReq(projectId: any, connectionId: any, tableName: any, columnName: any, confirmation: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mapping_configs`,
    method: 'delete',
    data: {
      table_name: tableName,
      column_name: columnName,
      confirmation: confirmation
    }
  })
}

// Update entity mapping config (for example, the rule field)
export function updateEntityMappingConfigReq(projectId: any, connectionId: any, configId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mapping_configs/${configId}`,
    method: 'put',
    data
  })
}

// Delete entity mappings
export function deleteEntityMappingsReq(projectId: any, connectionId: any, entityIds: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings`,
    method: 'delete',
    data: {
      entity_ids: entityIds
    },
  })
}

// Delete entity config by table and column
export function deleteEntityConfigReq(projectId: any, connectionId: any, tableName: any, columnName: any, confirmation: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity-config`,
    method: 'delete',
    data: {
      table_name: tableName,
      column_name: columnName,
      confirmation: confirmation
    },
  })
}

// Search similar entities
export function searchSimilarEntitiesReq(projectId: any, connectionId: any, entityName: any, limit: any = 10) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings/search`,
    method: 'post',
    data: {
      entity_name: entityName,
      limit: limit
    }
  })
}

// Generate entity embeddings
export function generateEntityEmbeddingsReq(projectId: any, connectionId: any, tableName: any = null, columnName: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings/generate_embeddings`,
    method: 'post',
    data: {
      table_name: tableName,
      column_name: columnName
    },
    timeout: 1800000 // 30-minute timeout
  })
}

// Create column-name entities
export function createColumnNameEntitiesReq(projectId: any, connectionId: any, tableId: any, columnNames: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings/column_names`,
    method: 'post',
    data: {
      table_id: tableId,
      column_names: columnNames
    },
    ignoreLoading: true,
    timeout: 300000 // 5-minute timeout
  })
}

// Test entity agent replacement (simulates full EntityProcessorAgent flow)
export function testEntityAgentReq(projectId: any, connectionId: any, question: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_mappings/test_agent`,
    method: 'post',
    data: {
      question: question
    },
    timeout: 300000 // 5-minute timeout due to LLM calls
  })
}

// ========== Metrics Management API ==========

// Get metric list
export function getMetricsReq(projectId: any, connectionId: any, category: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics`,
    method: 'get',
    params: {
      category
    }
  })
}

// Create metric
export function createMetricReq(projectId: any, connectionId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics`,
    method: 'post',
    data
  })
}

// Update metric
export function updateMetricReq(projectId: any, connectionId: any, metricId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics/${metricId}`,
    method: 'put',
    data
  })
}

// Delete metric
export function deleteMetricReq(projectId: any, connectionId: any, metricId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics/${metricId}`,
    method: 'delete'
  })
}

// Generate metric embeddings
export function generateMetricEmbeddingsReq(projectId: any, connectionId: any, metricId: any = null) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics/generate_embeddings`,
    method: 'post',
    params: {
      metric_id: metricId
    },
    timeout: 300000 // 5-minute timeout
  })
}

// Search metrics
export function searchMetricsReq(projectId: any, connectionId: any, query: any, limit: any = 5) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics/search`,
    method: 'get',
    params: {
      query,
      limit
    }
  })
}

// ==================== Table Relationship Management ====================

// Get table relationship list
export function getRelationshipsReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships`,
    method: 'get'
  })
}

// Create table relationship
export function createRelationshipReq(projectId: any, connectionId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships`,
    method: 'post',
    data
  })
}

// Update table relationship
export function updateRelationshipReq(projectId: any, connectionId: any, relationshipId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships/${relationshipId}`,
    method: 'put',
    data
  })
}

// Delete table relationship
export function deleteRelationshipReq(projectId: any, connectionId: any, relationshipId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships/${relationshipId}`,
    method: 'delete'
  })
}

// Auto-discover table relationships
export function discoverRelationshipsReq(projectId: any, connectionId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships/discover`,
    method: 'post',
    timeout: 300000 // 5-minute timeout (includes multi-batch LLM analysis)
  })
}

// Batch create candidate relationships after user confirmation
export function batchCreateRelationshipsReq(projectId: any, connectionId: any, candidates: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships/batch-create`,
    method: 'post',
    data: { candidates },
    timeout: 30000
  })
}

// AI-assisted relationship suggestions
export function aiSuggestRelationshipsReq(projectId: any, connectionId: any, hint: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/relationships/ai-suggest`,
    method: 'post',
    data: { hint },
    timeout: 60000
  })
}

// Upload embedded database file (SQLite/DuckDB)
export function uploadDatabaseFileReq(projectId: any, file: any) {
  const localPath = file?.path || file?.webkitRelativePath
  if (localPath) {
    return request({
      url: `/api/projects/${projectId}/databases/upload-db-file`,
      method: 'post',
      data: { file_path: localPath },
      timeout: 300000
    })
  }

  const formData = new FormData()
  formData.append('file', file)

  return request({
    url: `/api/projects/${projectId}/databases/upload-db-file`,
    method: 'post',
    data: formData,
    headers: {
      'Content-Type': 'multipart/form-data'
    },
    timeout: 300000 // 5-minute timeout; database files may be large
  })
}

// ==================== Data Source-Level Entity Management ====================

// Auto-suggest entity columns
export function suggestEntityColumnsReq(projectId: any, connectionId: any, params: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_configs/suggest`,
    method: 'post',
    data: params,
    timeout: 300000
  })
}

// Batch create suggested entity configs
export function batchCreateEntityConfigsReq(projectId: any, connectionId: any, columns: any, rule: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_configs/batch_create`,
    method: 'post',
    data: { columns, rule },
    timeout: 300000
  })
}

// Data source-level embedding generation
export function generateDatasourceEntityEmbeddingsReq(projectId: any, connectionId: any, configId: any) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entity_configs/generate_embeddings`,
    method: 'post',
    params: configId ? { config_id: configId } : {},
    timeout: 300000
  })
}

// Data source-level entity vector search
export function searchDatasourceEntitiesReq(projectId: any, connectionId: any, query: any, limit: any = 10) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/entities/search`,
    method: 'post',
    params: { query, limit }
  })
}

// Bulk import metrics
export function bulkImportMetricsReq(projectId: any, connectionId: any, file: any) {
  const formData = new FormData()
  formData.append('file', file)

  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/metrics/bulk_import`,
    method: 'post',
    data: formData,
    headers: {
      'Content-Type': 'multipart/form-data'
    },
    timeout: 300000 // 5-minute timeout
  })
}

// ==================== Metadata Query ====================

// Execute metadata query
export function executeMetadataQueryReq(projectId: any, connectionId: any, data: any, { signal }: any = {}) {
  return request({
    url: `/api/projects/${projectId}/databases/${connectionId}/execute-metadata-query`,
    method: 'post',
    data,
    timeout: 60000,
    signal
  })
}
