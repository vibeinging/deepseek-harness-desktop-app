import axiosReq from '@/utils/axios-req'

/**
 * Get enabled skill list
 */
export function getEnabledSkillsReq(projectId: any) {
  return axiosReq({
    url: `/api/projects/${projectId}/skills/enabled/list`,
    method: 'get'
  })
}

export function getDshSkillsReq(projectId: string, sessionId: string) {
  return axiosReq({
    url: `/api/agent/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(sessionId)}/dsh-skills`,
    method: 'get'
  })
}

/**
 * App-level skill list
 */
export function listAppSkillsReq() {
  return axiosReq({
    url: '/api/agent/skills',
    method: 'get'
  })
}

export function deleteAppSkillReq(skillName: any) {
  return axiosReq({
    url: `/api/agent/skills/${encodeURIComponent(skillName)}`,
    method: 'delete'
  })
}

export function toggleAppSkillReq(skillName: any, data: any) {
  return axiosReq({
    url: `/api/agent/skills/${encodeURIComponent(skillName)}/toggle`,
    method: 'patch',
    data
  })
}

export function getEnabledAppSkillsReq() {
  return axiosReq({
    url: '/api/agent/skills/enabled/list',
    method: 'get'
  })
}
