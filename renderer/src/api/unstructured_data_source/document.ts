import axiosReq from '@/utils/axios-req'

/**
 * Unstructured document management APIs
 * Path: /api/projects/{projectId}/unstructured-documents
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

const parseArray = (value: any) => {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
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
    url: `${BASE_PATH}/${projectId}/unstructured-datasources/${dataSourceId}/documents`,
    params: { page, page_size: pageSize },
    method: 'get'
  })

export const getDataSourceItemsReq = (kbName: any, page: any, pageSize: any) =>
  axiosReq({ url: '/api/data_sources/unstructured/items', params: { name: kbName, page, page_size: pageSize }, method: 'get' })

export const uploadDocumentsReq = (projectId: any, formData: any) => {
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

export const createDocumentsReq = async (projectId: any, formData: any) => {
  const body = formDataToObject(formData)
  const dataSourceId = body?.data_source_id
  const filePaths = parseArray(body?.file_paths)
  if (!dataSourceId || filePaths.length === 0) {
    return { success: false, data: null, message: 'data_source_id 和 file_paths 为必填项' }
  }
  const createdDocuments = []
  for (const filePath of filePaths) {
    const res: any = await axiosReq({
      url: `${BASE_PATH}/${projectId}/unstructured-datasources/${dataSourceId}/documents`,
      method: 'post',
      data: { file_path: filePath }
    })
    const doc = res?.data?.document || res?.data
    if (doc?.id) {
      createdDocuments.push({ document_id: doc.id, ...doc })
    }
  }
  return {
    success: true,
    data: { created_documents: createdDocuments, count: createdDocuments.length },
    message: '文档已提交处理'
  }
}

export const processDocumentsReq = async (projectId: any, formData: any) => {
  const body = formDataToObject(formData)
  const dataSourceId = body?.data_source_id
  const documentIds = parseArray(body?.document_ids)
  if (!dataSourceId || documentIds.length === 0) {
    return { success: false, data: null, message: 'data_source_id 和 document_ids 为必填项' }
  }

  const submitted: any[] = []
  for (const documentId of documentIds) {
    const res: any = await axiosReq({
      url: `${BASE_PATH}/${projectId}/unstructured-datasources/${dataSourceId}/documents/${documentId}/reprocess`,
      method: 'post',
      data: {
        chunk_size: body?.chunk_size,
        chunk_overlap: body?.chunk_overlap,
        delimiter: body?.delimiter,
        split_strategy: body?.split_strategy,
        breakpoint_threshold_type: body?.breakpoint_threshold_type
      }
    })
    submitted.push(res?.data || { document_id: documentId })
  }
  return {
    success: true,
    data: { submitted: true, documents: submitted, count: submitted.length },
    message: '文档已提交处理'
  }
}

export const getDocumentChunksReq = (projectId: any, dataSourceId: any, documentId: any, page = 1, pageSize = 20) =>
  axiosReq({
    url: `${BASE_PATH}/${projectId}/unstructured-datasources/${dataSourceId}/documents/${documentId}/chunks`,
    params: { page, page_size: pageSize },
    method: 'get'
  })

export const deleteDocumentReq = (projectId: any, dataSourceId: any, documentId: any) =>
  axiosReq({
    url: `${BASE_PATH}/${projectId}/unstructured-datasources/${dataSourceId}/documents/${documentId}`,
    method: 'delete'
  })

export const deleteDocumentsBatchReq = (projectId: any, dataSourceId: any, formData: any) =>
  axiosReq({
    url: `${BASE_PATH}/${projectId}/unstructured-datasources/${dataSourceId}/documents/delete_batch`,
    method: 'post',
    data: formDataToObject(formData)
  })

export const cancelDocumentProcessingReq = (projectId: any, formData: any) =>
  Promise.resolve({
    success: false,
    data: formDataToObject(formData),
    message: '当前版本暂不支持取消非结构化文档处理'
  })

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

export const generateDocumentDescriptionsReq = (projectId: any, data: any) =>
  axiosReq({
    url: `${BASE_PATH}/${projectId}/unstructured-documents/generate-descriptions`,
    method: 'post',
    data,
    timeout: 120000
  })

export const updateDocumentDescriptionReq = (projectId: any, documentId: any, description: any) =>
  axiosReq({
    url: `${BASE_PATH}/${projectId}/unstructured-documents/${documentId}/description`,
    method: 'put',
    data: { description }
  })

// Legacy endpoints below (deprecated)
export const addDataSourceItemsReq = (kbName: any, items: any) =>
  axiosReq({ url: '/api/data_sources/unstructured/add_items', data: { name: kbName, items }, method: 'post' })

export const deleteDataSourceItemsReq = (kbName: any, itemIds: any) =>
  axiosReq({ url: '/api/data_sources/unstructured/delete_items', data: { name: kbName, item_ids: itemIds }, method: 'post' })

export const vectorizeDataSourceItemsReq = (kbName: any, itemIds: any) =>
  axiosReq({ url: '/api/data_sources/unstructured/vectorize_items', data: { name: kbName, item_ids: itemIds }, method: 'post' })
