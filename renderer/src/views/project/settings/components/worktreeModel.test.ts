import { describe, expect, it } from 'vitest'

import { MAX_WORKTREE_BRANCH_LENGTH, validateWorktreeBranchName } from './worktreeModel'

describe('Worktree branch-name validation', () => {
  it('allows blank auto-generation, nested names, CJK, and the full supported length', () => {
    expect(validateWorktreeBranchName('')).toBeNull()
    expect(validateWorktreeBranchName('feature/data-export')).toBeNull()
    expect(validateWorktreeBranchName('feature/数据导出')).toBeNull()
    expect(validateWorktreeBranchName(`feature/${'a'.repeat(MAX_WORKTREE_BRANCH_LENGTH - 8)}`)).toBeNull()
  })

  it('rejects overlong and unsafe Git ref forms', () => {
    expect(validateWorktreeBranchName('a'.repeat(MAX_WORKTREE_BRANCH_LENGTH + 1))).toBe('tooLong')
    for (const branch of ['--detach', 'feature bad', 'feature..bad', 'feature/@{bad', 'feature//bad', '.hidden', 'feature/x.lock']) {
      expect(validateWorktreeBranchName(branch), branch).toBe('invalid')
    }
  })
})
