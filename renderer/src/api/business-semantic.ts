import request from '@/utils/axios-req'
import * as XLSX from 'xlsx'

async function workbookRows(file: Blob): Promise<{ rows: any[]; columns: string[] }> {
  const bytes = await file.arrayBuffer()
  const workbook = XLSX.read(bytes, { type: 'array' })
  const firstSheet = workbook.SheetNames[0]
  if (!firstSheet) return { rows: [], columns: [] }
  const rows = XLSX.utils.sheet_to_json<any>(workbook.Sheets[firstSheet], { defval: null })
  const columns = rows.length ? [...new Set(rows.flatMap((row) => Object.keys(row)))] : []
  return { rows, columns }
}

// ==================== Metrics management API ====================

// Create metric
export function createMetricReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metrics`,
    method: 'post',
    data
  })
}

// Get metric list (paginated)
export function getMetricsReq(projectId: any, page = 1, pageSize = 20, activeOnly = false) {
  return request({
    url: `/api/projects/${projectId}/metrics`,
    method: 'get',
    params: { page, page_size: pageSize, active_only: activeOnly }
  })
}

// Update metric
export function updateMetricReq(projectId: any, metricId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metrics/${metricId}`,
    method: 'put',
    data
  })
}

// Delete metric
export function deleteMetricReq(projectId: any, metricId: any) {
  return request({
    url: `/api/projects/${projectId}/metrics/${metricId}`,
    method: 'delete'
  })
}

// Delete metrics in batch (deleteAll=true deletes all metrics under this business)
export function deleteMetricsReq(projectId: any, { metricIds = null, deleteAll = false }: any = {}) {
  const data = deleteAll ? { delete_all: true } : { metric_ids: metricIds }
  return request({
    url: `/api/projects/${projectId}/metrics`,
    method: 'delete',
    data
  })
}

export function getMetricEmbeddingPendingCountReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/metrics/embedding_pending_count`,
    method: 'get'
  })
}

// metricId omitted/null: batch embedding for all business metrics; timeout=0 removes browser limit (increase gateway read_timeout for large-scale runs)
export function generateMetricEmbeddingsReq(projectId: any, metricId: any = null) {
  const params = metricId ? { metric_id: metricId } : {}
  const cfg = !metricId ? { timeout: 0 } : {}
  return request({
    url: `/api/projects/${projectId}/metrics/generate_embeddings`,
    method: 'post',
    params,
    ...cfg
  })
}

export async function bulkImportMetricsReq(projectId: any, sourceId: any, sourceType: any, file: Blob, overwrite = false) {
  const parsed = await workbookRows(file)
  return request({
    url: `/api/projects/${projectId}/metrics/bulk_import`,
    method: 'post',
    params: {
      source_id: sourceId || '',
      source_type: sourceType || '',
      overwrite
    },
    data: parsed
  })
}

// Search metrics
export function searchMetricsReq(projectId: any, query: any, limit = 5) {
  return request({
    url: `/api/projects/${projectId}/metrics/search`,
    method: 'get',
    params: { query, limit }
  })
}

// ==================== Example data API ====================

// Create example
export function createExamplesReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/examples`,
    method: 'post',
    data
  })
}

// Get example list
export function getExamplesReq(projectId: any, page = 1, pageSize = 20, exampleType: any = null) {
  return request({
    url: `/api/projects/${projectId}/examples`,
    method: 'get',
    params: {
      page,
      page_size: pageSize,
      ...(exampleType ? { example_type: exampleType } : {})
    }
  })
}

// Get example stats
export function getExamplesStatsReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/examples/stats`,
    method: 'get'
  })
}

// Update example
export function updateExampleReq(projectId: any, exampleId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/examples/${exampleId}`,
    method: 'put',
    data
  })
}

// Delete example
export function deleteExamplesReq(projectId: any, exampleIds: any) {
  return request({
    url: `/api/projects/${projectId}/examples`,
    method: 'delete',
    data: { example_ids: exampleIds }
  })
}

// Search examples
export function searchExamplesReq(projectId: any, query: any, exampleType: any = null, limit = 5) {
  return request({
    url: `/api/projects/${projectId}/examples/search`,
    method: 'post',
    params: {
      query,  // query is a string
      limit,
      ...(exampleType ? { example_type: exampleType } : {})
    }
  })
}

// Generate example embeddings (single example or all)
export function generateExampleEmbeddingsReq(projectId: any, exampleId: any = null, exampleType: any = null) {
  return request({
    url: `/api/projects/${projectId}/examples/generate_embeddings`,
    method: 'post',
    params: {
      ...(exampleId ? { example_id: exampleId } : {}),
      ...(exampleType ? { example_type: exampleType } : {})
    }
  })
}

// ==================== Entity config API ====================

// Get entity config list (paginated)
export function getEntityConfigsReq(projectId: any, page = 1, pageSize = 20, tableName: any = null) {
  return request({
    url: `/api/projects/${projectId}/entity_configs`,
    method: 'get',
    params: {
      page,
      page_size: pageSize,
      ...(tableName ? { table_name: tableName } : {})
    }
  })
}

// Create entity config (extracted from database)
export function createEntityConfigReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/entity_configs`,
    method: 'post',
    data
  })
}

// Update entity config
export function updateEntityConfigReq(projectId: any, configId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/entity_configs/${configId}`,
    method: 'put',
    data
  })
}

// Delete entity config
export function deleteEntityConfigReq(projectId: any, configId: any) {
  return request({
    url: `/api/projects/${projectId}/entity_configs/${configId}`,
    method: 'delete'
  })
}

// Generate entity embeddings
export function generateEntityEmbeddingsReq(projectId: any, configId: any = null) {
  return request({
    url: `/api/projects/${projectId}/entity_configs/generate_embeddings`,
    method: 'post',
    params: configId ? { config_id: configId } : {}
  })
}

// ==================== Entity API ====================

// Get entity list (paginated)
export function getEntitiesReq(projectId: any, page = 1, pageSize = 20, configId: any = null) {
  return request({
    url: `/api/projects/${projectId}/entities`,
    method: 'get',
    params: {
      page,
      page_size: pageSize,
      ...(configId ? { config_id: configId } : {})
    }
  })
}

// Delete entities
export function deleteEntitiesReq(projectId: any, entityIds: any) {
  return request({
    url: `/api/projects/${projectId}/entities`,
    method: 'delete',
    data: { entity_ids: entityIds }
  })
}

// Search entities
export function searchEntitiesReq(projectId: any, query: any, limit = 10) {
  return request({
    url: `/api/projects/${projectId}/entities/search`,
    method: 'post',
    params: { query, limit }
  })
}

// Import entities from Excel/JSON
export function importEntitiesFromExcelReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/entities/import_excel`,
    method: 'post',
    data
  })
}

// Create field entities
// columns: [{ column_name: string, description?: string }]
// sourceType: 'database' or 'structured'
export function createColumnNameEntitiesReq(projectId: any, tableId: any, sourceType: any, columns: any) {
  return request({
    url: `/api/projects/${projectId}/entity_mappings/column_names`,
    method: 'post',
    data: {
      table_id: tableId,
      source_type: sourceType,
      columns
    },
    timeout: 300000 // 5-minute timeout
  })
}

// Test entity agent replacement
export function testEntityAgentReq(projectId: any, question: any) {
  return request({
    url: `/api/projects/${projectId}/entity_mappings/test_agent`,
    method: 'post',
    data: {
      question
    },
    timeout: 300000 // 5-minute timeout
  })
}

// Revert auto-generated entity configs in batch (created by AgenticSearch fb_search fallback promotion)
// D.3 on 2026-05-31 — pending backend EntityMappingConfig.auto_promoted field and API updates from PR1-5 rollout
// Frontend calls the real endpoint first and gracefully degrades when backend returns 404 ("feature in development")
export function batchRevertAutoPromotedEntitiesReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/entity_mappings/revert_auto_promoted`,
    method: 'post',
    timeout: 60000
  })
}

// ==================== Metric view definition API ====================

export function createMetricViewReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views`,
    method: 'post',
    data
  })
}

export function previewMetricViewReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/preview`,
    method: 'post',
    data
  })
}

export function getMetricViewsReq(projectId: any, page = 1, pageSize = 20, activeOnly = false, sourceId: any = null, status: any = null) {
  return request({
    url: `/api/projects/${projectId}/metric-views`,
    method: 'get',
    params: {
      page,
      page_size: pageSize,
      active_only: activeOnly,
      ...(sourceId ? { source_id: sourceId } : {}),
      ...(status ? { status } : {})
    }
  })
}

export function getMetricViewDetailReq(projectId: any, metricViewId: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/${metricViewId}`,
    method: 'get'
  })
}

export function updateMetricViewReq(projectId: any, metricViewId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/${metricViewId}`,
    method: 'put',
    data
  })
}

export function deleteMetricViewReq(projectId: any, metricViewId: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/${metricViewId}`,
    method: 'delete'
  })
}

export function generateMetricViewEmbeddingsReq(projectId: any, metricViewId: any = null) {
  return request({
    url: `/api/projects/${projectId}/metric-views/embeddings`,
    method: 'post',
    params: metricViewId ? { metric_view_id: metricViewId } : {}
  })
}

// Query DISTINCT values for a column (supports fuzzy search)
export function getColumnDistinctValuesReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/column-distinct-values`,
    method: 'post',
    data
  })
}

// ==================== Metric status management API ====================

// Update enable/disable status for a single metric
export function updateMetricStatusReq(projectId: any, metricId: any, isActive: any) {
  return request({
    url: `/api/projects/${projectId}/metrics/${metricId}/status`,
    method: 'patch',
    data: { is_active: isActive }
  })
}

// Batch update enable/disable status for metrics
export function batchUpdateMetricsStatusReq(projectId: any, metricIds: any, isActive: any) {
  return request({
    url: `/api/projects/${projectId}/metrics/batch_update_status`,
    method: 'patch',
    data: { metric_ids: metricIds, is_active: isActive }
  })
}

// ==================== Metric code values API ====================

// Import metric code values from Excel
export async function importCodeValuesReq(projectId: any, sourceId: any, sourceType: any, file: Blob, importFormat = 'by-metric') {
  const parsed = await workbookRows(file)
  return request({
    url: `/api/projects/${projectId}/metrics/code_values/import`,
    method: 'post',
    params: {
      source_id: sourceId,
      source_type: sourceType,
      import_format: importFormat
    },
    data: parsed
  })
}

// Export metric code values (Excel or JSON)
export function exportCodeValuesReq(projectId: any, sourceId: any = null, sourceType: any = null, exportType = 'excel', exportFormat = 'by-metric') {
  return request({
    url: `/api/projects/${projectId}/metrics/code_values/export`,
    method: 'get',
    params: {
      source_id: sourceId,
      source_type: sourceType,
      export_type: exportType,
      export_format: exportFormat
    },
    responseType: 'blob'
  })
}


// ==================== Business view recommendation API ====================

// Toggle business view status: draft / active / inactive
export function updateMetricViewStatusReq(projectId: any, metricViewId: any, status: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/${metricViewId}/status`,
    method: 'patch',
    data: { status }
  })
}

// Start recommendation (returns task_id immediately; LLM analysis continues in background, frontend polls by task_id)
export function runMetricViewRecommendationReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/recommendations`,
    method: 'post',
    data
  })
}

// Get the latest recommendation task result for current user
export function getLatestMetricViewRecommendationReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/recommendations/latest`,
    method: 'get'
  })
}

// Get specified recommendation task details
export function getMetricViewRecommendationTaskReq(projectId: any, taskId: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/recommendations/${taskId}`,
    method: 'get'
  })
}

// Apply recommendation candidates in batch
export function applyMetricViewRecommendationReq(projectId: any, taskId: any, selections: any) {
  return request({
    url: `/api/projects/${projectId}/metric-views/recommendations/${taskId}/apply`,
    method: 'post',
    data: { selections }
  })
}
