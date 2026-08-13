import axiosReq from '@/utils/axios-req'

/**
 * Unstructured data source APIs
 * Path: /api/projects/{projectId}/unstructured-datasources
 */

export const listDataSourcesReq = (projectId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/unstructured-datasources`, method: 'get' })

export const getDataSourceDetailReq = (projectId: any, dataSourceId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/unstructured-datasources/${dataSourceId}`, method: 'get' })

export const createDataSourceReq = (projectId: any, dataSourceName: any, info: any, embeddingModelName: any) =>
  axiosReq({
    url: `/api/projects/${projectId}/unstructured-datasources`,
    data: { name: dataSourceName, description: info, embedding_model_name: embeddingModelName },
    method: 'post'
  })

export const updateDataSourceReq = (projectId: any, dataSourceId: any, dataSourceName: any, info: any) =>
  axiosReq({
    url: `/api/projects/${projectId}/unstructured-datasources/${dataSourceId}`,
    data: { name: dataSourceName, description: info },
    method: 'put'
  })

export const deleteDataSourceReq = (projectId: any, dataSourceId: any, confirm = true) =>
  axiosReq({
    url: `/api/projects/${projectId}/unstructured-datasources/${dataSourceId}`,
    data: { confirm },
    method: 'delete'
  })

export const generateDatasourceDescriptionReq = (projectId: any, dataSourceId: any, language: any) =>
  axiosReq({
    url: `/api/projects/${projectId}/unstructured-datasources/${dataSourceId}/generate-description`,
    method: 'post',
    data: { language: language || 'zh' },
    timeout: 60000
  })

export const searchDataSourceReq = (projectId: any, dataSourceId: any, query: any, topK = 10) =>
  axiosReq({
    url: `/api/projects/${projectId}/unstructured-datasources/${dataSourceId}/search`,
    data: { query, top_k: topK },
    method: 'post'
  })
