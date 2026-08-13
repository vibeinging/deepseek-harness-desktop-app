import request from '@/utils/axios-req'

// ==================== Business Management API ====================

// Get business list (paginated)
export function getBusinessListReq(projectId: any, page: any = 1, pageSize: any = 20) {
  return request({
    url: `/api/projects/${projectId}/businesses`,
    method: 'get',
    params: {
      page,
      page_size: pageSize
    }
  })
}

// Create business
export function createBusinessReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/businesses`,
    method: 'post',
    data
  })
}

// Get business details
export function getBusinessDetailReq(projectId: any, businessId: any) {
  return request({
    url: `/api/projects/${projectId}/business`,
    method: 'get'
  })
}

// Update business
export function updateBusinessReq(projectId: any, businessId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/business`,
    method: 'put',
    data
  })
}

// Delete business
export function deleteBusinessReq(projectId: any, businessId: any) {
  return request({
    url: `/api/projects/${projectId}/business`,
    method: 'delete'
  })
}

// ==================== Data Source Management API ====================

// Get business-linked data source list
export function getBusinessDataSourcesReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/data-sources`,
    method: 'get'
  })
}

// Add data source to business
export function addDataSourceToBusinessReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/data-sources`,
    method: 'post',
    data
  })
}

// Remove data source from business
export function removeDataSourceFromBusinessReq(projectId: any, data: any) {
  return request({
    url: `/api/projects/${projectId}/data-sources`,
    method: 'delete',
    data
  })
}

// ==================== Entity Config Reference Management API ====================

// Get referenced entity config list
export function getEntityRefsReq(projectId: any, params: any = {}) {
  return request({
    url: `/api/projects/${projectId}/entity_refs`,
    method: 'get',
    params
  })
}

// Get available entity configs for reference (from linked data sources)
export function getAvailableEntityConfigsReq(projectId: any) {
  return request({
    url: `/api/projects/${projectId}/entity_refs/available`,
    method: 'get'
  })
}

// Add entity config reference
export function addEntityRefsReq(projectId: any, entityConfigIds: any) {
  return request({
    url: `/api/projects/${projectId}/entity_refs`,
    method: 'post',
    data: { entity_config_ids: entityConfigIds }
  })
}

// Remove entity config reference
export function removeEntityRefReq(projectId: any, refId: any) {
  return request({
    url: `/api/projects/${projectId}/entity_refs/${refId}`,
    method: 'delete'
  })
}

// Toggle entity reference active state
export function toggleEntityRefActiveReq(projectId: any, refId: any, isActive: any) {
  return request({
    url: `/api/projects/${projectId}/entity_refs/${refId}/active`,
    method: 'patch',
    data: { is_active: isActive }
  })
}
