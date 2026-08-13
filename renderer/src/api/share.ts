import request from '@/utils/axios-req'

// Get current share status for a session (owner)
export const getShareStatus = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/share`,
    method: 'get'
  })
}

// Create share link (owner)
// options.refresh=true refreshes the snapshot of an existing share; options.messageIds shares only selected messages if provided
export const createShareLink = (projectId: any, sessionId: any, { refresh = false, messageIds = null }: any = {}) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/share`,
    method: 'post',
    params: { refresh },
    data: messageIds ? { message_ids: messageIds } : {}
  })
}

// Revoke share link (owner)
export const revokeShareLink = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/share`,
    method: 'delete'
  })
}

// Get read-only shared session snapshot (public, no login required)
// ignoreMsg avoids a global error toast for expired links; share page handles expiration state itself
export const getSharedSession = (shareToken: any) => {
  return request({
    url: `/api/public/v1/shared-sessions/${shareToken}`,
    method: 'get',
    ignoreMsg: true
  })
}
