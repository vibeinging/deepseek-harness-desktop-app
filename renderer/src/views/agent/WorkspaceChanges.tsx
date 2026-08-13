import { memo, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { notifications } from '@mantine/notifications'
import {
  IconArrowBackUp,
  IconCheck,
  IconChevronRight,
  IconClipboardCheck,
  IconEdit,
  IconExternalLink,
  IconFileDiff,
  IconFiles,
  IconMessagePlus,
  IconX
} from '@tabler/icons-react'
import type { AgentBlock, AgentWorkspaceAction } from './stream/types'
import { activityState, activityStateLabel } from './activityState'
import { fileChangeLabel, parseUnifiedDiff, type DiffSummary } from './stream/diffModel'
import styles from './agent.module.scss'

export interface TurnDiffSnapshot {
  threadId?: string | null
  turnId: string
  diff: string
  diffHash?: string | null
  updatedAt: number
  scope?: 'turn' | 'workspace'
}

export interface ReviewComment {
  id: string
  path: string
  comment: string
  side: 'old' | 'new'
  oldLine?: number | null
  newLine?: number | null
  lineText?: string
  hunkId?: string | null
  status?: 'open' | 'resolved'
}

function parseBlockPayload(block: AgentBlock) {
  try {
    const parsed = JSON.parse(String(block.content || '{}'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function shortPath(path: string) {
  const parts = String(path || '').split('/').filter(Boolean)
  return parts[parts.length - 1] || path || '文件'
}

function joinWorkspacePath(root: string | null | undefined, relativePath: string) {
  const rootPath = String(root || '').trim()
  const rel = String(relativePath || '').trim().replace(/^\/+/, '')
  if (!rootPath || !rel) return ''
  // Diff paths use forward slashes; normalize on the host.
  const separator = rootPath.includes(':') || rootPath.includes('\\') ? '\\' : '/'
  return [rootPath.replace(/[\\/]+$/, ''), ...rel.split('/').filter(Boolean)].join(separator)
}

function openFileExternally(absolutePath: string, line?: number, column?: number) {
  const api = (window as any)?.electronAPI
  if (!api?.openInEditor || !absolutePath) {
    api?.openLocalFile?.(absolutePath)
    return
  }
  void api.openInEditor({
    path: absolutePath,
    line: line || undefined,
    column: column || undefined,
  })
}

function openFileContextMenu(absolutePath: string, kind: string, x: number, y: number) {
  const showMenu = (window as any)?.electronAPI?.showArtifactContextMenu
  if (!showMenu || !absolutePath) return false
  void showMenu({ path: absolutePath, kind, x, y }).then((shown: boolean) => {
    if (!shown) openFileExternally(absolutePath)
  }).catch(() => openFileExternally(absolutePath))
  return true
}

export const FileChangeCard = memo(function FileChangeCard({
  block,
  turnRunning,
  action,
  canRevert,
  reverting,
  onReview,
  onRevert
}: {
  block: AgentBlock
  turnRunning: boolean
  action?: AgentWorkspaceAction
  canRevert: boolean
  reverting?: boolean
  onReview: () => void
  onRevert: () => void
}) {
  const payload = useMemo(() => parseBlockPayload(block), [block])
  const changes = Array.isArray(payload.changes) ? payload.changes : []
  const previews = useMemo<DiffSummary[]>(
    () => changes.map((change: any) => parseUnifiedDiff(String(change?.diff || ''))),
    [changes]
  )
  const added = previews.reduce((sum, preview) => sum + preview.added, 0)
  const deleted = previews.reduce((sum, preview) => sum + preview.deleted, 0)
  const primary = changes[0] || {}
  const state = activityState(payload.status || block.title, turnRunning)
  const running = state === 'running'
  const reviewable = payload.reviewable !== false && changes.some((change: any) => String(change?.diff || '').trim())
  const reversible = payload.reversible !== false
  const label = changes.length > 1 ? `已更改 ${changes.length} 个文件` : fileChangeLabel(primary.kind)
  const stateLabel = activityStateLabel(state)

  return (
    <section
      className={styles.fileChangeCard}
      data-running={running ? 'true' : 'false'}
      data-state={state}
      aria-label={`文件变更：${stateLabel}`}
    >
      <div className={styles.fileChangeIcon} aria-hidden="true">
        <IconFileDiff size={17} stroke={1.75} />
      </div>
      <div className={styles.fileChangeCopy}>
        <strong>
          {running
            ? '正在修改文件'
            : state === 'stopped'
              ? '文件修改已停止'
              : state === 'rejected'
                ? '文件修改已拒绝'
                : state === 'error'
                  ? '文件修改失败'
                  : label}
        </strong>
        {changes.length > 0 ? (
          <div className={styles.fileChangeFiles}>
            {changes.slice(0, 3).map((change: any, index: number) => (
              <span key={`${change?.path || 'file'}:${index}`} title={String(change?.path || '')}>
                {shortPath(String(change?.path || ''))}
              </span>
            ))}
            {changes.length > 3 && <span>另 {changes.length - 3} 个</span>}
          </div>
        ) : (
          <span className={styles.fileChangePending}>正在整理改动…</span>
        )}
      </div>
      <div className={styles.fileChangeActions}>
        {state !== 'done' && !running && <span className={styles.fileChangeState}>{stateLabel}</span>}
        {(added > 0 || deleted > 0) && (
          <span className={styles.diffStats} aria-label={`增加 ${added} 行，删除 ${deleted} 行`}>
            <b>+{added}</b>
            <em>-{deleted}</em>
          </span>
        )}
        {action?.status === 'succeeded' ? (
          <span className={styles.fileChangeReverted}>
            <IconCheck size={13} stroke={2} />
            已撤销
          </span>
        ) : canRevert && reversible ? (
          <button
            type="button"
            className={styles.fileChangeUndo}
            onClick={onRevert}
            disabled={running || reverting}
          >
            <IconArrowBackUp size={14} stroke={1.8} />
            {reverting ? '撤销中…' : '撤销'}
          </button>
        ) : null}
        {reviewable && (
          <button type="button" onClick={onReview} disabled={running}>
            查看更改
            <IconChevronRight size={14} stroke={1.8} />
          </button>
        )}
      </div>
    </section>
  )
})

export const ChangesButton = memo(function ChangesButton({
  snapshot,
  onClick
}: {
  snapshot: TurnDiffSnapshot
  onClick: () => void
}) {
  const summary = useMemo(() => parseUnifiedDiff(snapshot.diff), [snapshot.diff])
  if (!summary.files.length) return null
  return (
    <button
      type="button"
      className={styles.changesButton}
      onClick={onClick}
      aria-label={`查看 ${summary.files.length} 个文件的更改`}
      data-testid="workspace-changes-open"
    >
      <IconFiles size={14} stroke={1.8} />
      <span>更改 {summary.files.length}</span>
      <span className={styles.changesButtonStats}>
        <b>+{summary.added}</b>
        <em>-{summary.deleted}</em>
      </span>
    </button>
  )
})

const MAX_VISIBLE_LINES = 2000

export const ChangesReviewPanel = memo(function ChangesReviewPanel({
  snapshot,
  onClose,
  onAddComment,
  workspaceRoot,
  onApplyEdit,
  onReview
}: {
  snapshot: TurnDiffSnapshot
  onClose: () => void
  onAddComment?: (comment: ReviewComment) => void
  /** Absolute path of the project write target; used to open diff files in external editors. */
  workspaceRoot?: string | null
  /** Apply a line-level edit to the workspace file. Returns the updated diff or throws. */
  onApplyEdit?: (input: {
    path: string
    lineNumber: number
    newLineText: string
  }) => Promise<{ currentDiff?: string | null; contentHash?: string | null } | void>
  /** Trigger a codex-native code review of the current workspace diff. */
  onReview?: () => void
}) {
  const summary = useMemo(() => parseUnifiedDiff(snapshot.diff), [snapshot.diff])
  const [activePath, setActivePath] = useState(summary.files[0]?.path || '')
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [editingLineId, setEditingLineId] = useState<string | null>(null)
  const [editingValue, setEditingValue] = useState('')
  const [applying, setApplying] = useState(false)
  const activeFile = summary.files.find((file) => file.path === activePath) || summary.files[0]
  const selectedLine = activeFile?.lines.find((line) => line.id === selectedLineId) || null

  useEffect(() => {
    if (!summary.files.some((file) => file.path === activePath)) {
      setActivePath(summary.files[0]?.path || '')
    }
  }, [activePath, summary.files])

  useEffect(() => {
    setSelectedLineId(null)
    setComment('')
  }, [activePath])

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [onClose])

  const visibleLines = activeFile?.lines.slice(0, MAX_VISIBLE_LINES) || []
  const hiddenLineCount = Math.max(0, Number(activeFile?.lines.length || 0) - visibleLines.length)
  const addComment = () => {
    const value = comment.trim()
    if (!activeFile || !selectedLine || !value || !onAddComment) return
    onAddComment({
      id: `review:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`,
      path: activeFile.path,
      comment: value,
      side: selectedLine.kind === 'delete' ? 'old' : 'new',
      oldLine: selectedLine.oldLine,
      newLine: selectedLine.newLine,
      lineText: selectedLine.text.replace(/^[ +-]/, ''),
      hunkId: selectedLine.hunkId
    })
    setComment('')
    setSelectedLineId(null)
  }
  const startEdit = (lineId: string) => {
    const line = activeFile?.lines.find((item) => item.id === lineId)
    if (!line) return
    // Strip the leading diff marker (+/-/space) to get the raw line content.
    setEditingValue(line.text.replace(/^[ +-]/, ''))
    setEditingLineId(lineId)
    setSelectedLineId(null)
  }
  const cancelEdit = () => {
    setEditingLineId(null)
    setEditingValue('')
  }
  const saveEdit = async () => {
    if (!activeFile || !editingLineId || !onApplyEdit || applying) return
    const line = activeFile.lines.find((item) => item.id === editingLineId)
    if (!line || !line.newLine) return
    const lineNumber = line.newLine
    // Normalize: remove trailing newline so writeFile doesn't add an extra line.
    const newLineText = editingValue.replace(/\n$/, '')
    setApplying(true)
    try {
      await onApplyEdit({ path: activeFile.path, lineNumber, newLineText })
      setEditingLineId(null)
      setEditingValue('')
    } catch (error: any) {
      // Surface the failure but keep the editor open so the user can retry.
      notifications.show({
        color: 'orange',
        title: '无法保存这一行',
        message: error?.message || '文件可能已经变化，请重新打开审核面板。'
      })
    } finally {
      setApplying(false)
    }
  }

  return createPortal(
    <div className={styles.changesOverlay} role="presentation" data-testid="workspace-changes-overlay" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <aside
        className={styles.changesPanel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="changes-review-title"
        data-testid="workspace-changes-panel"
      >
        <header className={styles.changesPanelHeader}>
          <div>
            <strong id="changes-review-title">审核更改</strong>
            <span>{snapshot.scope === 'workspace' ? '当前工作区' : '本轮生成'} · {summary.files.length} 个文件</span>
          </div>
          <span className={styles.diffStats} aria-label={`增加 ${summary.added} 行，删除 ${summary.deleted} 行`}>
            <b>+{summary.added}</b>
            <em>-{summary.deleted}</em>
          </span>
          {onReview && summary.files.length > 0 && (
            <button
              type="button"
              className={styles.diffReviewBtn}
              onClick={() => { onClose(); onReview() }}
              title="让模型审查当前工作区改动"
              data-testid="workspace-changes-ai-review"
            >
              <IconClipboardCheck size={14} stroke={1.8} />
              AI 审查
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="关闭审核面板" data-testid="workspace-changes-close">
            <IconX size={17} stroke={1.8} />
          </button>
        </header>
        <div className={styles.changesPanelBody}>
          <nav className={styles.diffFileNav} aria-label="更改的文件">
            {summary.files.map((file) => (
              <button
                type="button"
                key={file.path}
                data-active={file.path === activeFile?.path ? 'true' : undefined}
                onClick={() => setActivePath(file.path)}
                title={file.path}
              >
                <IconFileDiff size={14} stroke={1.7} />
                <span>{file.path}</span>
                <small>
                  <b>+{file.added}</b>
                  <em>-{file.deleted}</em>
                </small>
              </button>
            ))}
          </nav>
          <section className={styles.diffViewer} aria-label={activeFile ? `${activeFile.path} 的更改` : '更改内容'}>
            {activeFile ? (
              <>
                <div
                  className={styles.diffViewerHeader}
                  title={activeFile.path}
                  tabIndex={workspaceRoot ? 0 : undefined}
                  onContextMenu={(event) => {
                    if (!workspaceRoot) return
                    const absolute = joinWorkspacePath(workspaceRoot, activeFile.path)
                    if (absolute) {
                      event.preventDefault()
                      openFileContextMenu(absolute, 'file', event.clientX, event.clientY)
                    }
                  }}
                  onKeyDown={(event) => {
                    if (!workspaceRoot) return
                    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    const absolute = joinWorkspacePath(workspaceRoot, activeFile.path)
                    if (absolute) openFileContextMenu(absolute, 'file', rect.left + 16, rect.top + 16)
                  }}
                >
                  <strong>{activeFile.path}</strong>
                  {activeFile.previousPath && <span>原路径：{activeFile.previousPath}</span>}
                  {workspaceRoot && (
                    <button
                      type="button"
                      className={styles.diffOpenEditor}
                      title="在外部编辑器打开"
                      data-testid="workspace-changes-open-editor"
                      onClick={(event) => {
                        event.stopPropagation()
                        const absolute = joinWorkspacePath(workspaceRoot, activeFile.path)
                        if (absolute) openFileExternally(absolute)
                      }}
                    >
                      <IconExternalLink size={13} stroke={1.8} />
                      打开
                    </button>
                  )}
                </div>
                <div className={styles.diffLines} role="table" aria-label="统一 Diff">
                  {visibleLines.map((line) => {
                    const selectable = line.kind !== 'meta' && Boolean(onAddComment)
                    const canOpenLine = Boolean(workspaceRoot) && line.kind !== 'meta'
                    const openLineInEditor = () => {
                      if (!workspaceRoot) return
                      const absolute = joinWorkspacePath(workspaceRoot, activeFile?.path || '')
                      if (!absolute) return
                      // Prefer new-line number for added/context; fall back to old-line for deletions.
                      const targetLine = line.newLine || line.oldLine || 0
                      openFileExternally(absolute, targetLine || undefined)
                    }
                    const onLineContextMenu = (event: React.MouseEvent | React.KeyboardEvent) => {
                      if (!canOpenLine) return
                      const absolute = joinWorkspacePath(workspaceRoot, activeFile?.path || '')
                      if (!absolute) return
                      const clientX = 'clientX' in event ? event.clientX : 0
                      const clientY = 'clientY' in event ? event.clientY : 0
                      event.preventDefault?.()
                      openFileContextMenu(absolute, 'file', clientX, clientY)
                    }
                    const content = (
                      <>
                        <span role="cell" aria-label={line.oldLine ? `旧文件第 ${line.oldLine} 行` : '旧文件无对应行'}>
                          {line.oldLine || ''}
                        </span>
                        <span role="cell" aria-label={line.newLine ? `新文件第 ${line.newLine} 行` : '新文件无对应行'}>
                          {line.newLine || ''}
                        </span>
                        <code role="cell">{line.text || ' '}</code>
                      </>
                    )
                    const canEditLine = Boolean(onApplyEdit) && line.kind !== 'meta' && line.kind !== 'delete' && Boolean(line.newLine)
                    const isEditingThisLine = editingLineId === line.id
                    const lineProps = canOpenLine
                      ? {
                          title: '右键打开操作；点击选择并添加审核意见',
                          onContextMenu: (e: React.MouseEvent) => onLineContextMenu(e),
                          onKeyDown: (e: React.KeyboardEvent) => {
                            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                              e.preventDefault()
                              onLineContextMenu(e)
                            }
                          },
                        }
                      : {}
                    if (isEditingThisLine) {
                      return (
                        <div key={line.id} className={styles.diffLineEdit} data-kind={line.kind} role="row">
                          <div className={styles.diffLineEditBar}>
                            <span>编辑第 {line.newLine} 行</span>
                            <div className={styles.diffLineEditActions}>
                              <button
                                type="button"
                                disabled={applying}
                                data-testid="workspace-line-edit-save"
                                onClick={() => void saveEdit()}
                              >
                                {applying ? '保存中…' : '保存'}
                              </button>
                              <button
                                type="button"
                                disabled={applying}
                                data-testid="workspace-line-edit-cancel"
                                onClick={cancelEdit}
                              >
                                取消
                              </button>
                            </div>
                          </div>
                          <textarea
                            rows={Math.min(8, Math.max(1, editingValue.split('\n').length))}
                            value={editingValue}
                            autoFocus
                            disabled={applying}
                            data-testid="workspace-line-edit-input"
                            onChange={(event) => setEditingValue(event.target.value)}
                            onKeyDown={(event) => {
                              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                                event.preventDefault()
                                void saveEdit()
                              }
                              if (event.key === 'Escape' && !applying) {
                                event.preventDefault()
                                cancelEdit()
                              }
                            }}
                          />
                        </div>
                      )
                    }
                    const editButton = canEditLine ? (
                      <button
                        type="button"
                        className={styles.diffLineEditBtn}
                        title="编辑这一行"
                        data-testid="workspace-line-edit-open"
                        onClick={(event) => {
                          event.stopPropagation()
                          startEdit(line.id)
                        }}
                      >
                        <IconEdit size={12} stroke={1.8} />
                      </button>
                    ) : null
                    const lineWithEdit = (
                      <>
                        {content}
                        {editButton}
                      </>
                    )
                    return selectable ? (
                      <div
                        key={line.id}
                        className={styles.diffLine}
                        role="row"
                        tabIndex={0}
                        data-selectable="true"
                        data-kind={line.kind}
                        data-selected={selectedLineId === line.id ? 'true' : undefined}
                        aria-selected={selectedLineId === line.id}
                        onClick={() => setSelectedLineId(line.id)}
                        onDoubleClick={canOpenLine ? openLineInEditor : undefined}
                        title={lineProps.title}
                        onContextMenu={lineProps.onContextMenu}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            if (event.target !== event.currentTarget) return
                            event.preventDefault()
                            setSelectedLineId(line.id)
                            return
                          }
                          lineProps.onKeyDown?.(event)
                        }}
                      >
                        {lineWithEdit}
                      </div>
                    ) : (
                      <div key={line.id} className={styles.diffLine} data-kind={line.kind} role="row" {...lineProps}>
                        {lineWithEdit}
                      </div>
                    )
                  })}
                </div>
                {hiddenLineCount > 0 && (
                  <div className={styles.diffTruncated}>Diff 较大，已先显示前 {MAX_VISIBLE_LINES} 行，另有 {hiddenLineCount} 行。</div>
                )}
                {onAddComment && (
                  <div className={styles.diffCommentBox} data-active={selectedLine ? 'true' : undefined}>
                    <div className={styles.diffCommentTitle}>
                      <IconMessagePlus size={14} stroke={1.8} />
                      {selectedLine
                        ? `给 ${activeFile.path}:${selectedLine.kind === 'delete' ? selectedLine.oldLine : selectedLine.newLine} 添加意见`
                        : '选择一行后添加审核意见'}
                    </div>
                    <textarea
                      rows={2}
                      value={comment}
                      disabled={!selectedLine}
                      placeholder="说明希望如何修改，这条意见会带入下一轮任务"
                      onChange={(event) => setComment(event.target.value)}
                      onKeyDown={(event) => {
                        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') addComment()
                      }}
                    />
                    <button type="button" disabled={!selectedLine || !comment.trim()} onClick={addComment}>
                      加入下一轮
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className={styles.diffEmpty}>当前轮次没有文件更改。</div>
            )}
          </section>
        </div>
      </aside>
    </div>,
    document.body
  )
})
