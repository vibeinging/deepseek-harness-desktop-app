import axiosReq from '@/utils/axios-req'

// ============ Project APIs ============

export const getMyProjectsReq = (params: any = {}) => axiosReq({ url: '/api/projects', method: 'get', params })

export const getProjectDetailReq = (projectId: any) => axiosReq({ url: `/api/projects/${projectId}`, method: 'get' })

export const createProjectReq = (data: any) => axiosReq({ url: '/api/projects', data, method: 'post' })

export const updateProjectReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}`, data, method: 'put' })

export const deleteProjectReq = (projectId: any) => axiosReq({ url: `/api/projects/${projectId}`, method: 'delete' })

export interface ProjectSourceFolder {
  id?: string
  project_id?: string
  path: string
  name?: string
  local_path?: string
  display_name?: string
  available?: boolean
  access_mode?: 'read' | 'write'
  write_target?: boolean
}

export const getProjectSourceFoldersReq = (projectId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/source-folders`, method: 'get' })

export const replaceProjectSourceFoldersReq = (projectId: any, folders: ProjectSourceFolder[]) =>
  axiosReq({ url: `/api/projects/${projectId}/source-folders`, method: 'put', data: { folders } })

export interface ProjectWorktree {
  id: string
  project_id: string
  source_folder_path: string
  branch: string
  path: string
  base_commit?: string | null
  active: boolean
  available: boolean
  created_at?: string
}

export interface ProjectWorktreeList {
  items: ProjectWorktree[]
  write_target_path: string
  git_repository: boolean
}

export const getProjectWorktreesReq = (projectId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/worktrees`, method: 'get', ignoreMsg: true })

export const createProjectWorktreeReq = (projectId: any, data: { branchName?: string; baseBranch?: string }) =>
  axiosReq({ url: `/api/projects/${projectId}/worktrees`, method: 'post', data, ignoreMsg: true })

export const activateProjectWorktreeReq = (projectId: any, worktreeId: string) =>
  axiosReq({ url: `/api/projects/${projectId}/worktrees/${worktreeId}/activate`, method: 'post', ignoreMsg: true })

export const deactivateProjectWorktreesReq = (projectId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/worktrees/deactivate`, method: 'post', ignoreMsg: true })

export const removeProjectWorktreeReq = (projectId: any, worktreeId: string) =>
  axiosReq({ url: `/api/projects/${projectId}/worktrees/${worktreeId}`, method: 'delete', ignoreMsg: true })

export const getAllProjectsReq = (params: any) => axiosReq({ url: '/api/projects/all', method: 'get', params })

// ============ Project custom model APIs ============

export const getProjectModelsReq = (projectId: any, params: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models`, method: 'get', params })

export const getProjectAgentSettingsReq = (projectId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/agent-settings`, method: 'get' })

export const updateProjectAgentSettingsReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/agent-settings`, method: 'put', data })

export const getProjectModelDetailReq = (projectId: any, modelId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models/${modelId}`, method: 'get' })

export const createProjectModelReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models`, method: 'post', data })

export const updateProjectModelReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models`, method: 'put', data })

export const deleteProjectModelReq = (projectId: any, modelId: any) =>
  axiosReq({ url: `/api/projects/${projectId}/models/${modelId}`, method: 'delete' })

// ============ Project public access APIs ============

export const setProjectOpenReq = (projectId: any, data: any) =>
  axiosReq({ url: `/api/projects/${projectId}/open`, method: 'put', data })

export const getOpenProjectsReq = (params: any) => axiosReq({ url: '/api/projects/open', method: 'get', params })
