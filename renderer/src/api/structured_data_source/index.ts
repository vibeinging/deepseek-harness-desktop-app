import axiosReq from '@/utils/axios-req'

/**
 * Structured data source APIs
 * Path: /api/projects/{projectId}/structured-datasources
 */

export const listDataSourcesReq = (projectId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/structured-datasources`, method: 'get' })

export const getDataSourceDetailReq = (projectId: any, dataSourceId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/structured-datasources/${dataSourceId}`, method: 'get' })

export const createDataSourceReq = (projectId: any, dataSourceName: any, info: any, embeddingModelName: any) =>
  axiosReq({
    url: `/api/projects/${projectId}/structured-datasources`,
    data: { name: dataSourceName, description: info, embedding_model_name: embeddingModelName },
    method: 'post'
  })

export const updateDataSourceReq = (projectId: any, dataSourceId: any, dataSourceName: any, info: any) =>
  axiosReq({
    url: `/api/projects/${projectId}/structured-datasources/${dataSourceId}`,
    data: { name: dataSourceName, description: info },
    method: 'put'
  })

export const deleteDataSourceReq = (projectId: any, dataSourceId: any, confirm = true) =>
  axiosReq({
    url: `/api/projects/${projectId}/structured-datasources/${dataSourceId}`,
    data: { confirm },
    method: 'delete'
  })
