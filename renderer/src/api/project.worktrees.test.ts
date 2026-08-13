import { beforeEach, describe, expect, it, vi } from 'vitest'

const request = vi.hoisted(() => vi.fn())
vi.mock('@/utils/axios-req', () => ({ default: request }))

import {
  activateProjectWorktreeReq,
  createProjectWorktreeReq,
  deactivateProjectWorktreesReq,
  getProjectWorktreesReq,
  removeProjectWorktreeReq,
} from './project'

describe('Project Worktree API client', () => {
  beforeEach(() => request.mockReset())

  it('uses the five project-scoped lifecycle endpoints without duplicate global error toasts', () => {
    getProjectWorktreesReq('project one')
    createProjectWorktreeReq('project one', { branchName: 'feature/test' })
    activateProjectWorktreeReq('project one', 'wt-1')
    deactivateProjectWorktreesReq('project one')
    removeProjectWorktreeReq('project one', 'wt-1')

    expect(request.mock.calls.map(([config]) => config)).toEqual([
      { url: '/api/projects/project one/worktrees', method: 'get', ignoreMsg: true },
      { url: '/api/projects/project one/worktrees', method: 'post', data: { branchName: 'feature/test' }, ignoreMsg: true },
      { url: '/api/projects/project one/worktrees/wt-1/activate', method: 'post', ignoreMsg: true },
      { url: '/api/projects/project one/worktrees/deactivate', method: 'post', ignoreMsg: true },
      { url: '/api/projects/project one/worktrees/wt-1', method: 'delete', ignoreMsg: true },
    ])
  })
})
