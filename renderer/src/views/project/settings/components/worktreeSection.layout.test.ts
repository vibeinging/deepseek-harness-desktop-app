import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./WorktreeSection.tsx', import.meta.url), 'utf8')
const basicInfo = readFileSync(new URL('./BasicInfo.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./WorktreeSection.module.scss', import.meta.url), 'utf8')
const conversation = readFileSync(new URL('../../../agent/AgentConversation.tsx', import.meta.url), 'utf8')

describe('Worktree settings interaction contract', () => {
  it('uses Mantine form and confirmation flows instead of unavailable browser dialogs', () => {
    expect(source).toContain('<Modal')
    expect(source).toContain('<TextInput')
    expect(source).toContain('modals.openConfirmModal')
    expect(source).not.toMatch(/\bwindow\.prompt\b|\bprompt\(/)
    expect(source).not.toMatch(/\bwindow\.confirm\b|(?<!open)Confirm\(/)
  })

  it('supports keyboard submission, cancellation, validation, and duplicate-submit protection', () => {
    expect(source).toContain('<form onSubmit={handleCreate}>')
    expect(source).toContain('type="submit"')
    expect(source).toContain('data-autofocus')
    expect(source).toContain('validateWorktreeBranchName(branchName)')
    expect(source).toContain('if (!projectId || !canManage || mutationLockedRef.current || creating || pendingAction) return')
    expect(source).toContain('mutationLockedRef.current = true')
    expect(source).toContain('closeOnEscape={!creating}')
    expect(source).toContain('data-testid="worktree-create-cancel"')
  })

  it('has stable model:none hooks for the full lifecycle and visible failure states', () => {
    for (const testId of [
      'worktree-section',
      'worktree-create-open',
      'worktree-create-modal',
      'worktree-branch-input',
      'worktree-create-submit',
      'worktree-load-error',
      'worktree-retry',
      'worktree-list',
      'worktree-active',
    ]) expect(source).toContain(`data-testid="${testId}"`)
    expect(source).toContain('data-testid={`worktree-activate-${worktree.id}`}')
    expect(source).toContain('data-testid={`worktree-deactivate-${worktree.id}`}')
    expect(source).toContain('data-testid={`worktree-remove-${worktree.id}`}')
    expect(source).toContain("'data-testid': `worktree-remove-confirm-${worktree.id}`")
  })

  it('enforces owner-only mutations while keeping the member list readable', () => {
    expect(basicInfo).toContain('canManage={canManage}')
    expect(source).toContain('{canManage && (')
    expect(source).toContain('data-testid="worktree-readonly"')
  })

  it('localizes visible text and protects long paths, branches, and narrow layouts', () => {
    expect(source).toContain('useTranslation()')
    expect(source).toContain("t('project.worktrees.title')")
    expect(source).not.toContain('输入新分支名称')
    expect(styles).toContain('text-overflow: ellipsis')
    expect(styles).toContain('overflow-wrap: anywhere')
    expect(styles).toContain('@media (max-width: 640px)')
  })

  it('uses the authoritative Diff response root for edit and external-editor actions', () => {
    expect(conversation).toContain("String(response?.data?.workspaceRoot || '').trim()")
    expect(conversation).toContain('if (!workspaceRootAuthoritativeRef.current) setWorkspaceRoot(writeTarget?.path || null)')
    expect(conversation).toContain('if (sessionIdRef.current !== threadId) return')
    expect(conversation).toContain('setWorkspaceRoot(responseWorkspaceRoot)')
    expect(conversation).toContain("typeof action.workspaceRoot === 'string'")
    expect(conversation).toContain('setWorkspaceRoot(action.workspaceRoot.trim())')
  })
})
