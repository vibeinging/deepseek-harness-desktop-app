import { memo, useEffect, useMemo, useState } from 'react'
import {
  IconBox,
  IconBrain,
  IconChevronRight,
  IconCopy,
  IconGitBranch,
  IconPencil,
  IconRefresh
} from '@tabler/icons-react'
import type { Attachment } from '../ComposerActions'
import type { AgentBlock as Block, AgentMessage as Msg } from '../stream/types'
import {
  AttachmentPreview,
  BlockView,
  type ApprovalDecision,
  parseUserInputPayload,
  webSourcesFromBlock
} from './AssistantContent'
import { assistantCopyText, attachmentFromBlock } from './messageState'
import type { FileReferenceOpenTarget } from './types'
import { generativeUiSummaryFromBlock } from '../generative-ui/schema'
import {
  partitionAssistantDisplayBlocks,
  processDetailBlocks,
  resolveProcessExpanded,
  summarizeAssistantProcess
} from '../thinking-state'
import styles from '../agent.module.scss'

export const UserTurn = memo(
  function UserTurn({
    id,
    message,
    busy,
    temporary,
    actionPending,
    onCopy,
    onEdit
  }: {
    id: string
    message: Msg
    busy: boolean
    temporary: boolean
    actionPending: boolean
    onCopy: (text: string) => void
    onEdit: (message: Msg, text: string) => Promise<boolean>
  }) {
    const attachments = useMemo(() => message.blocks.map(attachmentFromBlock).filter(Boolean) as Attachment[], [message.blocks])
    const content = useMemo(
      () => message.blocks.filter((b) => b.type !== 'attachment').map((b) => b.content).join(''),
      [message.blocks]
    )
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(content)
    useEffect(() => {
      if (!editing) setDraft(content)
    }, [content, editing])
    const canEdit = Boolean(message.id) && !busy && !temporary && !actionPending
    const submitEdit = async () => {
      if (!canEdit || (!draft.trim() && attachments.length === 0)) return
      if (await onEdit(message, draft.trim())) setEditing(false)
    }
    return (
      <div className={styles.turnUser} data-message-role="user">
        <div className={styles.userTurnContent}>
          <div className={styles.bubbleUser}>
            {Boolean(message.skillSelections?.length) && (
              <div className={styles.userSkillList} aria-label="本轮选择的技能">
                {message.skillSelections!.map((skill) => (
                  <span
                    key={skill.selectionKey}
                    className={styles.userSkillChip}
                    title={skill.qualifiedName || skill.name}
                    data-user-skill={skill.selectionKey}
                  >
                    <IconBox size={13} stroke={1.7} />
                    <span>{skill.displayName}</span>
                    {skill.pluginName && <small>{skill.pluginName}</small>}
                  </span>
                ))}
              </div>
            )}
            {attachments.length > 0 && (
              <div className={styles.userAttachList}>
                {attachments.map((attachment, index) => (
                  <div
                    key={`${attachment.path}-${index}`}
                    className={styles.userAttachChip}
                    title={attachment.path}
                    data-attachment-path={attachment.path}
                    data-attachment-name={attachment.name}
                  >
                    <AttachmentPreview attachment={attachment} />
                  </div>
                ))}
              </div>
            )}
            {editing ? (
              <div className={styles.messageEditPanel} data-message-edit-panel>
                <textarea
                  autoFocus
                  value={draft}
                  aria-label="编辑消息"
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submitEdit()
                    if (event.key === 'Escape') setEditing(false)
                  }}
                />
                <div className={styles.messageEditActions}>
                  <button type="button" onClick={() => setEditing(false)}>取消</button>
                  <button
                    type="button"
                    className={styles.messageEditSubmit}
                    data-message-edit-submit
                    disabled={!canEdit || (!draft.trim() && attachments.length === 0)}
                    onClick={() => void submitEdit()}
                  >
                    发送
                  </button>
                </div>
              </div>
            ) : content ? <div>{content}</div> : null}
          </div>
          {!editing && (
            <div className={styles.messageActions} aria-label="用户消息操作">
              <button
                type="button"
                data-message-action="copy-user"
                disabled={!content.trim()}
                title="复制"
                onClick={() => onCopy(content)}
              ><IconCopy size={14} stroke={1.7} /></button>
              <button
                type="button"
                data-message-action="edit-user"
                disabled={!canEdit}
                title={temporary ? '临时对话不能创建分支' : '编辑消息并创建分支'}
                onClick={() => setEditing(true)}
              ><IconPencil size={14} stroke={1.7} /></button>
            </div>
          )}
        </div>
      </div>
    )
  },
  (prev, next) =>
    prev.id === next.id &&
    prev.message === next.message &&
    prev.busy === next.busy &&
    prev.temporary === next.temporary &&
    prev.actionPending === next.actionPending &&
    prev.onCopy === next.onCopy &&
    prev.onEdit === next.onEdit
)

function compactDuration(durationMs?: number | null) {
  const ms = Number(durationMs || 0)
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`
}

function processState(message: Msg, fallbackRunning: boolean) {
  const status = message.status || (fallbackRunning ? 'inProgress' : 'completed')
  if (status === 'inProgress' || status === 'pending') return { running: true, label: '处理中' }
  if (status === 'failed') return { running: false, label: '处理失败' }
  if (status === 'interrupted') return { running: false, label: '已停止' }
  if (status === 'suspended') return { running: false, label: '等待补充' }
  if (status === 'expired') return { running: false, label: '已过期' }
  const duration = compactDuration(message.durationMs)
  return { running: false, label: duration ? `已处理 ${duration}` : '已处理' }
}

export const AssistantTurn = memo(
  function AssistantTurn({
    id,
    message,
    busy,
    isLast,
    temporary,
    actionPending,
    expanded,
    showThinking,
    showTodo,
    confirmDecided,
    onDecide,
    onToggleExpand,
    onReviewChanges,
    canMutateWorkspace,
    revertingItemIds,
    onRevertChange,
    onSubmitUserInput,
    onOpenConversation,
    onOpenFileReference,
    onGenerativeUiAction,
    onCopy,
    onRetry,
    onBranch
  }: {
    id: string
    message: Msg
    busy: boolean
    isLast: boolean
    temporary: boolean
    actionPending: boolean
    expanded: Record<string, boolean>
    showThinking: boolean
    showTodo: boolean
    confirmDecided: Record<string, 'approved' | 'rejected'>
    onDecide: (toolCallId: string, decision: ApprovalDecision, request?: any) => void
    onToggleExpand: (id: string, currentExpanded?: boolean) => void
    onReviewChanges: () => void
    canMutateWorkspace: boolean
    revertingItemIds: Record<string, boolean>
    onRevertChange: (block: Block) => void
    onSubmitUserInput: (
      payload: ReturnType<typeof parseUserInputPayload>,
      answers: Record<string, { answers: string[] }>
    ) => Promise<void>
    onOpenConversation?: (conversationId: string) => void
    onOpenFileReference?: (target: FileReferenceOpenTarget) => void | Promise<void>
    onGenerativeUiAction: (message: string) => Promise<void>
    onCopy: (text: string) => void
    onRetry: (message: Msg) => void
    onBranch: (message: Msg) => void
  }) {
    const completed = message.status === 'completed'
    const { processBlocks, resultBlocks } = useMemo(
      () => partitionAssistantDisplayBlocks(
        message.blocks,
        completed,
        message.answerStatus
          ? { status: message.answerStatus, itemId: message.answerItemId }
          : null
      ),
      [message.blocks, completed, message.answerStatus, message.answerItemId]
    )
    const webSources = useMemo(
      () => webSourcesFromBlock(resultBlocks.find((block) => block.type === 'web_sources')),
      [resultBlocks]
    )
    const visibleProcessBlocks = useMemo(
      () => processBlocks.filter((block) => (
        (showThinking || block.type !== 'thinking') && (showTodo || block.type !== 'plan')
      )),
      [processBlocks, showThinking, showTodo]
    )
    const visibleProcessDetails = useMemo(
      () => processDetailBlocks(visibleProcessBlocks),
      [visibleProcessBlocks]
    )
    const state = processState(message, busy && isLast)
    const isRunning = state.running
    const processSummary = useMemo(
      () => summarizeAssistantProcess([...visibleProcessBlocks, ...resultBlocks], isRunning),
      [visibleProcessBlocks, resultBlocks, isRunning]
    )
    const processSummaryLabel = isRunning ? processSummary.runningLabel : processSummary.completedLabel
    const processGroupId = `${id}:process`
    const processExpanded = resolveProcessExpanded(expanded[processGroupId], isRunning)
    const showProcessGroup = visibleProcessBlocks.length > 0 || isRunning
    const copyText = useMemo(() => resultBlocks
      .flatMap((block) => block.type === 'generative_ui'
        ? [generativeUiSummaryFromBlock(block)]
        : [assistantCopyText([block])])
      .map((value) => value.trim())
      .filter(Boolean)
      .join('\n\n'), [resultBlocks])
    const canRetry = Boolean(message.id && message.turnId) && !isRunning && !busy && !temporary && !actionPending
    const canBranch = canRetry && message.status === 'completed'
    const canInteractGenerativeUi = completed && !busy && !actionPending
    const answerPhase = message.answerItemId
      ? message.blocks.find((block) => block.id === message.answerItemId)?.metadata?.phase
        || (message.answerStatus === 'accepted' ? 'final_answer' : undefined)
      : undefined

    return (
      <div
        className={styles.turnAsst}
        data-message-role="assistant"
        data-agent-turn-status={message.status || undefined}
        data-agent-answer-status={message.answerStatus || undefined}
        data-agent-answer-phase={answerPhase || undefined}
      >
        {showProcessGroup && (
          <div
            className={styles.processGroup}
            data-agent-process
            data-expanded={processExpanded ? 'true' : 'false'}
            data-running={isRunning ? 'true' : 'false'}
          >
            <button
              type="button"
              className={styles.processHead}
              data-agent-process-toggle
              aria-expanded={processExpanded}
              onClick={() => onToggleExpand(processGroupId, processExpanded)}
            >
              <IconChevronRight
                size={13}
                className={processExpanded ? styles.trChevOpen : styles.trChev}
              />
              <IconBrain size={15} stroke={1.7} className={styles.processIcon} />
              <span className={styles.processTitle}>{state.label}</span>
              {isRunning && <span className={styles.processPulse} aria-hidden="true" />}
              {processSummaryLabel && (
                <span className={styles.processMeta} title={processSummaryLabel}>
                  {processSummaryLabel}
                </span>
              )}
              <span className={styles.processLine} />
            </button>
            {processExpanded && visibleProcessDetails.length > 0 && (
              <div className={styles.processBody}>
                {visibleProcessDetails.map((block) => (
                  <BlockView
                    key={block.id}
                    block={block}
                    busy={isRunning}
                    turnStatus={message.status}
                    expanded={expanded[block.id]}
                    groupedProcess
                    showThinking={showThinking}
                    showTodo={showTodo}
                    decision={confirmDecided[block.id.replace(/^confirm:/, '')]}
                    onDecide={onDecide}
                    onToggleExpand={onToggleExpand}
                    onReviewChanges={onReviewChanges}
                    threadId={message.threadId}
                    workspaceAction={message.workspaceActions?.[block.id]}
                    canMutateWorkspace={canMutateWorkspace}
                    reverting={Boolean(revertingItemIds[block.id])}
                    onRevertChange={() => onRevertChange(block)}
                    onSubmitUserInput={onSubmitUserInput}
                    onOpenConversation={onOpenConversation}
                    onOpenFileReference={onOpenFileReference}
                    canInteractGenerativeUi={canInteractGenerativeUi}
                    onGenerativeUiAction={onGenerativeUiAction}
                    webSources={webSources}
                  />
                ))}
              </div>
            )}
          </div>
        )}
        {resultBlocks.map((block) => (
          <BlockView
            key={block.id}
            block={block}
            busy={isRunning}
            turnStatus={message.status}
            expanded={expanded[block.id]}
            showThinking={showThinking}
            showTodo={showTodo}
            decision={confirmDecided[block.id.replace(/^confirm:/, '')]}
            onDecide={onDecide}
            onToggleExpand={onToggleExpand}
            onReviewChanges={onReviewChanges}
            threadId={message.threadId}
            workspaceAction={message.workspaceActions?.[block.id]}
            canMutateWorkspace={canMutateWorkspace}
            reverting={Boolean(revertingItemIds[block.id])}
            onRevertChange={() => onRevertChange(block)}
            onSubmitUserInput={onSubmitUserInput}
            onOpenConversation={onOpenConversation}
            onOpenFileReference={onOpenFileReference}
            canInteractGenerativeUi={canInteractGenerativeUi}
            onGenerativeUiAction={onGenerativeUiAction}
            webSources={webSources}
          />
        ))}
        {!isRunning && (
          <div className={styles.messageActions} aria-label="助手消息操作">
            <button
              type="button"
              data-message-action="copy-assistant"
              disabled={!copyText}
              title="复制"
              onClick={() => onCopy(copyText)}
            ><IconCopy size={14} stroke={1.7} /></button>
            <button
              type="button"
              data-message-action="retry-assistant"
              disabled={!canRetry}
              title={temporary ? '临时对话不能创建分支' : '重试回答并保留原对话'}
              onClick={() => onRetry(message)}
            ><IconRefresh size={14} stroke={1.7} /></button>
            <button
              type="button"
              data-message-action="branch-assistant"
              disabled={!canBranch}
              title={temporary ? '临时对话不能创建分支' : '从这里创建分支'}
              onClick={() => onBranch(message)}
            ><IconGitBranch size={14} stroke={1.7} /></button>
          </div>
        )}
      </div>
    )
  },
  (prev, next) =>
    prev.id === next.id &&
    prev.message === next.message &&
    prev.busy === next.busy &&
    prev.isLast === next.isLast &&
    prev.temporary === next.temporary &&
    prev.actionPending === next.actionPending &&
    prev.expanded === next.expanded &&
    prev.showThinking === next.showThinking &&
    prev.showTodo === next.showTodo &&
    prev.confirmDecided === next.confirmDecided &&
    prev.canMutateWorkspace === next.canMutateWorkspace &&
    prev.revertingItemIds === next.revertingItemIds
    && prev.onOpenFileReference === next.onOpenFileReference
    && prev.onGenerativeUiAction === next.onGenerativeUiAction
    && prev.onCopy === next.onCopy
    && prev.onRetry === next.onRetry
    && prev.onBranch === next.onBranch
)
