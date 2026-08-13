import request from '@/utils/axios-req'

// Submit message feedback (like/dislike)
export const submitFeedback = (projectId: any, sessionId: any, messageId: any, data: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/messages/${messageId}/feedback`,
    method: 'post',
    data
  })
}

// Batch get feedback status for a session
export const getSessionFeedbacks = (projectId: any, sessionId: any) => {
  return request({
    url: `/api/projects/${projectId}/sessions/${sessionId}/feedback-status`,
    method: 'get'
  })
}

// Admin: get feedback list
export const getAdminFeedbacks = (params: any) => {
  return request({
    url: '/api/admin/feedbacks',
    method: 'get',
    params
  })
}

// Admin: get message context (user question + raw AI message)
export const getAdminFeedbackContext = (messageId: any, sessionId: any) => {
  return request({
    url: `/api/admin/feedbacks/${messageId}/context`,
    method: 'get',
    params: { session_id: sessionId }
  })
}

// Admin: delete feedback in batch
export const deleteAdminFeedbacks = (ids: any) => {
  return request({
    url: '/api/admin/feedbacks/delete',
    method: 'post',
    data: { ids }
  })
}
