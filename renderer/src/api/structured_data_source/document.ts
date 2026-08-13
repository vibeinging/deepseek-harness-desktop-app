import axiosReq from '@/utils/axios-req'

/**
 * Structured document management APIs
 * Path: /api/projects/{projectId}/structured-documents
 */

const BASE_PATH = '/api/projects'

const formDataToObject = (data: any) => {
  if (typeof FormData === 'undefined' || !(data instanceof FormData)) return data
  const out: Record<string, any> = {}
  data.forEach((value, key) => {
    out[key] = value
  })
  return out
}

const localFilePathsFromForm = (data: any) => {
  if (typeof FormData === 'undefined' || !(data instanceof FormData)) return []
  const files = data.getAll('files')
  return files
    .map((file: any) => file?.path || file?.webkitRelativePath || '')
    .filter(Boolean)
}

export const listDocumentsReq = (projectId: any, dataSourceId: any, page: any, pageSize: any) =>
  axiosReq({
    url: `${BASE_PATH}/${projectId}/structured-documents/list`,
    params: { data_source_id: dataSourceId, page, page_size: pageSize },
    method: 'get'
  })

export const getDataSourceItemsReq = (kbName: any, page: any, pageSize: any) =>
  axiosReq({ url: '/api/data_sources/structured/items', params: { name: kbName, page, page_size: pageSize }, method: 'get' })

export const uploadDocumentsReq = (_projectId: any, formData: any) => {
  const localPaths = localFilePathsFromForm(formData)
  if (localPaths.length) {
    return Promise.resolve({
      success: true,
      data: { uploaded_files: localPaths },
      message: '已选择本地文件'
    })
  }
  return Promise.resolve({
    success: false,
    data: { uploaded_files: [] },
    message: '当前环境无法读取本地文件路径，请在桌面端选择文件'
  })
}

export const createDocumentsReq = (projectId: any, formData: any) =>
  axiosReq({ url: `${BASE_PATH}/${projectId}/structured-documents/create`, method: 'post', data: formDataToObject(formData) })

export const processDocumentsReq = (projectId: any, formData: any) =>
  axiosReq({ url: `${BASE_PATH}/${projectId}/structured-documents/process`, method: 'post', data: formDataToObject(formData) })

export const deleteDocumentReq = (projectId: any, formData: any) =>
  axiosReq({ url: `${BASE_PATH}/${projectId}/structured-documents/delete`, method: 'post', data: formData })

export const deleteDocumentsBatchReq = (projectId: any, formData: any) =>
  axiosReq({ url: `${BASE_PATH}/${projectId}/structured-documents/delete_batch`, method: 'post', data: formData })

export const cancelDocumentProcessingReq = (projectId: any, formData: any) =>
  axiosReq({ url: `${BASE_PATH}/${projectId}/structured-documents/cancel`, method: 'post', data: formData })

export const deleteUploadedFilesReq = (kbName: any, relativePaths: any) =>
  axiosReq({
    url: `${BASE_PATH}/uploaded/delete`,
    method: 'post',
    data: { name: kbName || '', relative_paths: Array.isArray(relativePaths) ? relativePaths : [] },
    headers: { 'Content-Type': 'application/json' }
  })

export const deleteDocumentByPathReq = (kbName: any, relativePath: any) =>
  axiosReq({
    url: `${BASE_PATH}/delete_by_path`,
    method: 'post',
    data: { name: kbName || '', relative_path: relativePath || '' },
    headers: { 'Content-Type': 'application/json' }
  })

// Legacy endpoints below (deprecated)
export const addDataSourceItemsReq = (kbName: any, items: any) =>
  axiosReq({ url: '/api/data_sources/structured/add_items', data: { name: kbName, items }, method: 'post' })

export const deleteDataSourceItemsReq = (kbName: any, itemIds: any) =>
  axiosReq({ url: '/api/data_sources/structured/delete_items', data: { name: kbName, item_ids: itemIds }, method: 'post' })

export const vectorizeDataSourceItemsReq = (kbName: any, itemIds: any) =>
  axiosReq({ url: '/api/data_sources/structured/vectorize_items', data: { name: kbName, item_ids: itemIds }, method: 'post' })

// ==================== Table entry query API ====================
const TABLES_PATH = '/api/projects'

export const getDocumentTablesReq = (projectId: any, documentId: any) =>
  axiosReq({
    url: `${TABLES_PATH}/${projectId}/structured-tables/by-document`,
    params: { document_id: documentId },
    method: 'get'
  })

export const getDataSourceTablesReq = (projectId: any, dataSourceId: any) =>
  axiosReq({
    url: `${TABLES_PATH}/${projectId}/structured-tables`,
    params: { data_source_id: dataSourceId },
    method: 'get'
  })

export const searchRelevantTablesReq = (projectId: any, dataSourceId: any, question: any, strategy = 'column_first') =>
  axiosReq({
    url: `${TABLES_PATH}/${projectId}/structured-datasources/${dataSourceId}/semantic-retrieval`,
    method: 'post',
    data: { question, strategy }
  })
