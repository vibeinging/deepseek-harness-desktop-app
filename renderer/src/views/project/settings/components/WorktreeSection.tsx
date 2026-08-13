import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Alert, Button, Modal, TextInput } from '@mantine/core'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import { IconAlertCircle, IconGitBranch, IconPlus, IconRefresh, IconTrash } from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import {
  activateProjectWorktreeReq,
  createProjectWorktreeReq,
  deactivateProjectWorktreesReq,
  getProjectWorktreesReq,
  removeProjectWorktreeReq,
  type ProjectWorktree,
  type ProjectWorktreeList,
  type ProjectSourceFolder,
} from '@/api/project'
import {
  MAX_WORKTREE_BRANCH_LENGTH,
  validateWorktreeBranchName,
  type WorktreeBranchValidationError,
} from './worktreeModel'
import styles from './WorktreeSection.module.scss'

interface WorktreeSectionProps {
  projectId: string
  folders: ProjectSourceFolder[]
  canManage?: boolean
}

type PendingAction =
  | { kind: 'activate' | 'remove'; worktreeId: string }
  | { kind: 'deactivate'; worktreeId: '' }

function requestErrorMessage(error: unknown, fallback: string): string {
  const candidate = error as any
  return String(
    candidate?.response?.data?.message
    || candidate?.response?.data?.msg
    || candidate?.message
    || candidate?.msg
    || fallback
  )
}

export default function WorktreeSection({ projectId, folders, canManage = true }: WorktreeSectionProps) {
  const { t } = useTranslation()
  const [worktrees, setWorktrees] = useState<ProjectWorktree[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [gitRepository, setGitRepository] = useState<boolean | null>(null)
  const [creating, setCreating] = useState(false)
  const [createOpened, setCreateOpened] = useState(false)
  const [branchName, setBranchName] = useState('')
  const [branchError, setBranchError] = useState<WorktreeBranchValidationError | null>(null)
  const [createError, setCreateError] = useState('')
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null)
  const [confirmingRemoveId, setConfirmingRemoveId] = useState<string | null>(null)
  const refreshRequestRef = useRef(0)
  const mutationLockedRef = useRef(false)

  const selectedWriteTarget = folders.find((folder) => folder.write_target === true || folder.access_mode === 'write')
  const writeTarget = selectedWriteTarget || folders.find((folder) => folder.available !== false)
  const writeTargetPath = writeTarget?.path || writeTarget?.local_path || ''
  const busy = creating || pendingAction !== null || confirmingRemoveId !== null

  const refresh = useCallback(async () => {
    if (!projectId) return
    const requestId = ++refreshRequestRef.current
    setLoading(true)
    setLoadError('')
    try {
      const res: any = await getProjectWorktreesReq(projectId)
      if (requestId !== refreshRequestRef.current) return
      const payload = res?.data as ProjectWorktreeList | ProjectWorktree[] | undefined
      if (Array.isArray(payload)) {
        setWorktrees(payload)
        setGitRepository(null)
      } else {
        setWorktrees(Array.isArray(payload?.items) ? payload.items : [])
        setGitRepository(typeof payload?.git_repository === 'boolean' ? payload.git_repository : null)
      }
    } catch (error) {
      if (requestId !== refreshRequestRef.current) return
      setLoadError(requestErrorMessage(error, t('project.worktrees.loadFailed')))
    } finally {
      if (requestId === refreshRequestRef.current) setLoading(false)
    }
  }, [projectId, t])

  useEffect(() => {
    setWorktrees([])
    setGitRepository(null)
    setLoadError('')
    void refresh()
    return () => { refreshRequestRef.current += 1 }
  }, [refresh])

  const openCreate = () => {
    if (!canManage || busy || gitRepository === false) return
    setBranchName('')
    setBranchError(null)
    setCreateError('')
    setCreateOpened(true)
  }

  const closeCreate = () => {
    if (creating) return
    setCreateOpened(false)
    setCreateError('')
  }

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!projectId || !canManage || mutationLockedRef.current || creating || pendingAction) return
    const validation = validateWorktreeBranchName(branchName)
    setBranchError(validation)
    if (validation) return

    mutationLockedRef.current = true
    setCreating(true)
    setCreateError('')
    try {
      await createProjectWorktreeReq(projectId, {
        branchName: branchName.trim() || undefined,
      })
      notifications.show({ color: 'green', message: t('project.worktrees.createSuccess') })
      setCreateOpened(false)
      setBranchName('')
      await refresh()
    } catch (error) {
      setCreateError(requestErrorMessage(error, t('project.worktrees.createFailed')))
    } finally {
      mutationLockedRef.current = false
      setCreating(false)
    }
  }

  const handleActivate = async (worktreeId: string) => {
    if (!canManage || mutationLockedRef.current || busy) return
    mutationLockedRef.current = true
    setPendingAction({ kind: 'activate', worktreeId })
    try {
      await activateProjectWorktreeReq(projectId, worktreeId)
      notifications.show({ color: 'green', message: t('project.worktrees.activateSuccess') })
      await refresh()
    } catch (error) {
      notifications.show({ color: 'red', message: requestErrorMessage(error, t('project.worktrees.activateFailed')) })
    } finally {
      mutationLockedRef.current = false
      setPendingAction(null)
    }
  }

  const handleDeactivate = async () => {
    if (!canManage || mutationLockedRef.current || busy) return
    mutationLockedRef.current = true
    setPendingAction({ kind: 'deactivate', worktreeId: '' })
    try {
      await deactivateProjectWorktreesReq(projectId)
      notifications.show({ color: 'green', message: t('project.worktrees.deactivateSuccess') })
      await refresh()
    } catch (error) {
      notifications.show({ color: 'red', message: requestErrorMessage(error, t('project.worktrees.deactivateFailed')) })
    } finally {
      mutationLockedRef.current = false
      setPendingAction(null)
    }
  }

  const handleRemove = async (worktreeId: string) => {
    if (!canManage || mutationLockedRef.current) return
    mutationLockedRef.current = true
    setPendingAction({ kind: 'remove', worktreeId })
    try {
      await removeProjectWorktreeReq(projectId, worktreeId)
      notifications.show({ color: 'green', message: t('project.worktrees.removeSuccess') })
      await refresh()
    } catch (error) {
      notifications.show({ color: 'red', message: requestErrorMessage(error, t('project.worktrees.removeFailed')) })
    } finally {
      mutationLockedRef.current = false
      setPendingAction(null)
    }
  }

  const confirmRemove = (worktree: ProjectWorktree) => {
    if (!canManage || busy) return
    setConfirmingRemoveId(worktree.id)
    modals.openConfirmModal({
      title: t('project.worktrees.removeTitle'),
      children: t('project.worktrees.removeConfirm', { branch: worktree.branch }),
      labels: { confirm: t('project.worktrees.remove'), cancel: t('common.cancel') },
      confirmProps: { color: 'red', 'data-testid': `worktree-remove-confirm-${worktree.id}` },
      onCancel: () => setConfirmingRemoveId(null),
      onClose: () => setConfirmingRemoveId(null),
      onConfirm: () => {
        setConfirmingRemoveId(null)
        void handleRemove(worktree.id)
      },
    })
  }

  if (!writeTargetPath) return null

  const branchErrorMessage = branchError
    ? t(`project.worktrees.branchErrors.${branchError}`)
    : undefined

  return (
    <section className={styles.worktreeSection} data-testid="worktree-section" aria-labelledby="worktree-heading">
      <header className={styles.sectionHeader}>
        <div className={styles.sectionIntro}>
          <strong id="worktree-heading">
            <IconGitBranch size={14} stroke={1.8} aria-hidden="true" />
            {t('project.worktrees.title')}
          </strong>
          <span>{t('project.worktrees.description')}</span>
        </div>
        {canManage && (
          <Button
            size="xs"
            variant="light"
            leftSection={<IconPlus size={14} aria-hidden="true" />}
            disabled={busy || loading || gitRepository === false}
            onClick={openCreate}
            data-testid="worktree-create-open"
          >
            {t('project.worktrees.create')}
          </Button>
        )}
      </header>

      {loadError && (
        <Alert
          color="red"
          icon={<IconAlertCircle size={16} aria-hidden="true" />}
          title={t('project.worktrees.loadErrorTitle')}
          className={styles.worktreeAlert}
          data-testid="worktree-load-error"
        >
          <span>{loadError}</span>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            leftSection={<IconRefresh size={13} aria-hidden="true" />}
            onClick={() => { void refresh() }}
            disabled={loading}
            data-testid="worktree-retry"
          >
            {t('common.retry')}
          </Button>
        </Alert>
      )}

      {!loadError && gitRepository === false && (
        <Alert color="yellow" title={t('project.worktrees.notGitTitle')} data-testid="worktree-not-git">
          {t('project.worktrees.notGitDescription')}
        </Alert>
      )}

      {!canManage && (
        <div className={styles.ownerHint} data-testid="worktree-readonly">
          {t('project.worktrees.ownerOnly')}
        </div>
      )}

      <div className={styles.worktreeList} aria-busy={loading} data-testid="worktree-list">
        {loading && worktrees.length === 0 ? (
          <div className={styles.worktreeEmpty} data-testid="worktree-loading">{t('project.worktrees.loading')}</div>
        ) : worktrees.length === 0 && !loadError ? (
          <div className={styles.worktreeEmpty} data-testid="worktree-empty">{t('project.worktrees.empty')}</div>
        ) : (
          worktrees.map((worktree) => {
            const activating = pendingAction?.kind === 'activate' && pendingAction.worktreeId === worktree.id
            const removing = pendingAction?.kind === 'remove' && pendingAction.worktreeId === worktree.id
            const deactivating = pendingAction?.kind === 'deactivate' && worktree.active
            return (
              <div
                key={worktree.id}
                className={styles.worktreeItem}
                data-active={worktree.active ? 'true' : undefined}
                data-available={worktree.available ? 'true' : 'false'}
                data-testid={`worktree-item-${worktree.id}`}
              >
                <div className={styles.worktreeInfo}>
                  <strong title={worktree.branch}>{worktree.branch}</strong>
                  <code title={worktree.path}>{worktree.path}</code>
                  <div className={styles.worktreeBadges}>
                    {!worktree.available && (
                      <small className={styles.worktreeStale} data-testid={`worktree-unavailable-${worktree.id}`}>
                        {t('project.worktrees.unavailable')}
                      </small>
                    )}
                    {worktree.active && (
                      <small className={styles.worktreeActiveBadge} data-testid="worktree-active">
                        {t('project.worktrees.active')}
                      </small>
                    )}
                  </div>
                </div>
                {canManage && (
                  <div className={styles.worktreeActions}>
                    {worktree.active ? (
                      <Button
                        size="xs"
                        variant="subtle"
                        loading={deactivating}
                        disabled={busy && !deactivating}
                        onClick={() => { void handleDeactivate() }}
                        data-testid={`worktree-deactivate-${worktree.id}`}
                      >
                        {t('project.worktrees.deactivate')}
                      </Button>
                    ) : (
                      <Button
                        size="xs"
                        variant="light"
                        loading={activating}
                        disabled={!worktree.available || (busy && !activating)}
                        onClick={() => { void handleActivate(worktree.id) }}
                        data-testid={`worktree-activate-${worktree.id}`}
                      >
                        {t('project.worktrees.activate')}
                      </Button>
                    )}
                    <Button
                      size="xs"
                      variant="subtle"
                      color="red"
                      leftSection={<IconTrash size={13} aria-hidden="true" />}
                      loading={removing}
                      disabled={worktree.active || (busy && !removing)}
                      title={worktree.active ? t('project.worktrees.removeActiveHint') : undefined}
                      onClick={() => confirmRemove(worktree)}
                      data-testid={`worktree-remove-${worktree.id}`}
                    >
                      {t('project.worktrees.remove')}
                    </Button>
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>

      <Modal
        opened={createOpened}
        onClose={closeCreate}
        title={t('project.worktrees.createTitle')}
        centered
        closeOnClickOutside={!creating}
        closeOnEscape={!creating}
        withCloseButton={!creating}
        data-testid="worktree-create-modal"
      >
        <form onSubmit={handleCreate}>
          <TextInput
            data-autofocus
            label={t('project.worktrees.branchLabel')}
            description={t('project.worktrees.branchDescription', { max: MAX_WORKTREE_BRANCH_LENGTH })}
            placeholder={t('project.worktrees.branchPlaceholder')}
            value={branchName}
            error={branchErrorMessage}
            disabled={creating}
            maxLength={MAX_WORKTREE_BRANCH_LENGTH + 1}
            onChange={(event) => {
              const value = event.currentTarget.value
              setBranchName(value)
              setBranchError(validateWorktreeBranchName(value))
              setCreateError('')
            }}
            data-testid="worktree-branch-input"
          />
          {createError && (
            <Alert
              color="red"
              icon={<IconAlertCircle size={16} aria-hidden="true" />}
              className={styles.createError}
              data-testid="worktree-create-error"
            >
              {createError}
            </Alert>
          )}
          <div className={styles.modalActions}>
            <Button type="button" variant="default" disabled={creating} onClick={closeCreate} data-testid="worktree-create-cancel">
              {t('common.cancel')}
            </Button>
            <Button type="submit" loading={creating} disabled={Boolean(branchError)} data-testid="worktree-create-submit">
              {t('project.worktrees.create')}
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  )
}
