import request from '@/utils/axios-req'

// ==================== Ambiguous Preference Memory API ====================

export function getMemoryListReq(projectId: any, { limit = 20, offset = 0, search = '' }: any = {}) {
  const params: any = { limit, offset }
  if (search) params.search = search
  return request({
    url: `/api/projects/${projectId}/memory`,
    method: 'get',
    params
  })
}

export function createMemoryReq(projectId: any, payload: any) {
  return request({
    url: `/api/projects/${projectId}/memory`,
    method: 'post',
    data: payload
  })
}

export function updateMemoryReq(projectId: any, resolutionId: any, payload: any) {
  return request({
    url: `/api/projects/${projectId}/memory/${resolutionId}`,
    method: 'put',
    data: payload
  })
}

export function deleteMemoryReq(projectId: any, resolutionId: any) {
  return request({
    url: `/api/projects/${projectId}/memory/${resolutionId}`,
    method: 'delete'
  })
}

export function bulkDeleteMemoryReq(projectId: any, ids: any) {
  return request({
    url: `/api/projects/${projectId}/memory/bulk_delete`,
    method: 'post',
    data: { ids }
  })
}

export function setSessionAutoApplyMemoryReq(projectId: any, sessionId: any, enabled: any) {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/memory/auto_apply`,
    method: 'post',
    data: { enabled }
  })
}

export function bulkImportMemoryReq(projectId: any, file: any, overwrite = true) {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('overwrite', overwrite ? 'true' : 'false')
  return request({
    url: `/api/projects/${projectId}/memory/bulk_import`,
    method: 'post',
    data: formData,
    headers: { 'Content-Type': 'multipart/form-data' }
  })
}
