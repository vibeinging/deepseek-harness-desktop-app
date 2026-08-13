export const MAX_WORKTREE_BRANCH_LENGTH = 120

export type WorktreeBranchValidationError = 'tooLong' | 'invalid'

/**
 * Fast client-side validation for Git branch names. The server still runs
 * `git check-ref-format --branch`, which remains the source of truth.
 */
export function validateWorktreeBranchName(value: string): WorktreeBranchValidationError | null {
  const branch = String(value || '').trim()
  if (!branch) return null
  if (branch.length > MAX_WORKTREE_BRANCH_LENGTH) return 'tooLong'
  if (
    branch === '@'
    || branch.startsWith('-')
    || branch.startsWith('/')
    || branch.endsWith('/')
    || branch.endsWith('.')
    || branch.includes('..')
    || branch.includes('@{')
    || branch.includes('//')
    || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(branch)
  ) return 'invalid'

  const segments = branch.split('/')
  if (segments.some((segment) => !segment || segment.startsWith('.') || segment.endsWith('.lock'))) {
    return 'invalid'
  }
  return null
}
