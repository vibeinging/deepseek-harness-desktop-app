import request from '@/utils/axios-req'

// Get web search model config list
export function listWebSearchModelsReq(projectId: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models`,
        method: 'get'
    })
}

// Create web search model config
export function createWebSearchModelReq(projectId: any, data: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models`,
        method: 'post',
        data
    })
}

// Get specific web search model config
export function getWebSearchModelReq(projectId: any, modelId: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/${modelId}`,
        method: 'get'
    })
}

// Update web search model config
export function updateWebSearchModelReq(projectId: any, modelId: any, data: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/${modelId}`,
        method: 'put',
        data
    })
}

// Test web search model
export function testWebSearchModelReq(projectId: any, data: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/test-connection`,
        method: 'post',
        data
    })
}

// Delete web search model config
export function deleteWebSearchModelReq(projectId: any, modelId: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/${modelId}`,
        method: 'delete'
    })
}

// Get supported web search model type list
export function getWebSearchModelTypesReq() {
    return request({
        url: '/api/web-search-models/support',
        method: 'get'
    })
}

// QA test web search model
export function qaTestWebSearchModelReq(projectId: any, data: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/qa-test`,
        method: 'post',
        data
    })
}

// Infer response parsing from raw response (LLM)
export function inferWebSearchResponseMappingsReq(projectId: any, data: any) {
    return request({
        url: `/api/projects/${projectId}/web-search-models/infer-response-mappings`,
        method: 'post',
        data
    })
}
