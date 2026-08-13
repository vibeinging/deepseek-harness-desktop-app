import { createContext, useContext, useMemo, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { notifications } from '@mantine/notifications'
import { modals } from '@mantine/modals'
import ElSvgIcon from '@/components/ElSvgIcon'
import { submitFeedback } from '@/api/feedback'
import { useProjectStore, projectGetters } from '@/store/project'
import ContentBlockRaw from './ContentBlock'
import TaskDetailBlockRaw from './TaskDetailBlock'
import TaskProgressRaw from './TaskProgress'
import {
  copySQL,
  buildMetricViewSummaryVisibilityMap,
  getFirstExecutableCode,
  getMessageBlocks,
  groupBlocksByTask,
  hasExecutableCode,
} from '../composables'
import styles from './MessageItem.module.scss'

// Sub-component prop contracts may still differ in each migrated file, so use any here.
// This matches the `ContentBlockRaw as any` approach used in TaskDetailBlock.tsx.
const ContentBlock = ContentBlockRaw as any
const TaskDetailBlock = TaskDetailBlockRaw as any
const TaskProgress = TaskProgressRaw as any

// Feedback context mapping mirrors Vue's inject('feedbackMap', ref({})).
// Parent provides it through <FeedbackMapContext.Provider value={{ map, setMap }}> (equivalent to provide('feedbackMap', feedbackMap)).
// When no Provider is found, fall back to an empty map and no-op setter so rendering still works.
type FeedbackMap = Record<string, string>
interface FeedbackMapContextValue {
  map: FeedbackMap
  setMap: Dispatch<SetStateAction<FeedbackMap>>
}
export const FeedbackMapContext = createContext<FeedbackMapContextValue>({
  map: {},
  setMap: () => {},
})

export interface MessageItemProps {
  message: any
  databaseId?: string | number | null
  sessionId?: string
  dismissedUserInputs?: Set<any>
  readonly?: boolean
  // defineEmits(['save-panel', 'page-change', 'size-change', 'user-input-submitted', 'delete-message', 'review-intermediate'])
  onSavePanel?: (payload: any) => void
  onPageChange?: (msgId: any, blkIdx: any, page: any) => void
  onSizeChange?: (msgId: any, blkIdx: any, size: any) => void
  onUserInputSubmitted?: (payload: any) => void
  onDeleteMessage?: (messageId: any) => void
  onReviewIntermediate?: () => void
}

export default function MessageItem({
  message,
  databaseId = null,
  sessionId = '',
  dismissedUserInputs = new Set(),
  readonly = false,
  onSavePanel,
  onPageChange,
  onSizeChange,
  onUserInputSubmitted,
  onDeleteMessage,
  onReviewIntermediate,
}: MessageItemProps) {
  const { t } = useTranslation()
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  // Feedback state injected from parent component
  const { map: feedbackMap, setMap: setFeedbackMap } = useContext(FeedbackMapContext)

  // Feedback state for the current message
  const currentFeedback = feedbackMap[message.id] || null

  const doSubmitFeedback = async (type: string, reason?: string) => {
    try {
      const res: any = await submitFeedback(
        currentProjectId,
        sessionId,
        message.id,
        { feedback_type: type, feedback_reason: reason }
      )
      if (res.success) {
        // Update local state
        setFeedbackMap((prev) => ({
          ...prev,
          [message.id]: res.data.feedback_type,
        }))
      }
    } catch (error) {
      console.error('Submit feedback failed:', error)
      notifications.show({ color: 'red', message: t('session.message.feedbackFailed') })
    }
  }

  // Handle feedback
  const handleFeedback = async (type: string) => {
    if (type === 'dislike' && currentFeedback !== 'dislike') {
      // On dislike, open a textarea input and collect a reason before submitting
      let reason = ''
      modals.openConfirmModal({
        title: t('session.message.feedback'),
        children: (
          <FeedbackReasonInput
            prompt={t('session.message.feedbackPrompt')}
            placeholder={t('session.message.feedbackPlaceholder')}
            onChange={(v) => {
              reason = v
            }}
          />
        ),
        labels: {
          confirm: t('session.message.submit'),
          cancel: t('common.cancel'),
        },
        onConfirm: () => {
          doSubmitFeedback(type, reason || '')
        },
        // onCancel: do nothing if the user closes without submitting
      })
    } else {
      await doSubmitFeedback(type)
    }
  }

  const messageBlocks = useMemo(() => getMessageBlocks(message), [message])
  const executableCode = useMemo(
    () => (hasExecutableCode(message) ? getFirstExecutableCode(message) : null),
    [message]
  )

  // Task group data (used when task metadata exists)
  const taskGroupData = useMemo(() => groupBlocksByTask(message), [message])

  const isTaskDetailFinalBlock = (block: any) => {
    return Boolean(
      block?.metadata?.msg_category &&
        !['final_result', 'decomposition'].includes(block.metadata.msg_category)
    )
  }

  const messageBlockMetricViewVisibility = useMemo(
    () => buildMetricViewSummaryVisibilityMap(messageBlocks),
    [messageBlocks]
  )

  const finalResultMetricViewVisibility = useMemo(
    () =>
      buildMetricViewSummaryVisibilityMap(
        taskGroupData?.finalResults || [],
        (block: any) => !isTaskDetailFinalBlock(block)
      ),
    [taskGroupData]
  )

  // :class="[message.role, { streaming: message.is_streaming }]"
  const rootClass = [
    styles.messageItem,
    styles[message.role as keyof typeof styles],
    message.is_streaming ? styles.streaming : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rootClass}>
      {/* AI avatar */}
      {message.role !== 'user' && (
        <div className={styles.messageAvatar}>
          <div className={styles.aiAvatar}>
            <svg viewBox="0 0 1024 1024" width="36" height="36">
              <path
                d="M106.4 860a38.4 38.4 0 0 1-38.4-38.4V266.4a38.4 38.4 0 0 1 38.4-38.4h811.2a38.4 38.4 0 0 1 38.4 38.4v554.4a38.4 38.4 0 0 1-38.4 38.4z m0-583.2a25.6 25.6 0 0 0-25.6 25.6v519.2a25.6 25.6 0 0 0 25.6 25.6h811.2a25.6 25.6 0 0 0 25.6-25.6V302.4a25.6 25.6 0 0 0-25.6-25.6z m113.6-42.4a18.4 18.4 0 1 0 18.4 18.4 18.4 18.4 0 0 0-17.6-18.4z m-42.4 0a18.4 18.4 0 1 0 18.4 18.4 18.4 18.4 0 0 0-18.4-18.4z m-42.4 0a18.4 18.4 0 1 0 18.4 18.4 18.4 18.4 0 0 0-18.4-18.4z"
                fill="#1B9DFF"
              />
              <path
                d="M917.6 232a34.4 34.4 0 0 1 34.4 34.4v554.4a34.4 34.4 0 0 1-34.4 34.4H106.4a34.4 34.4 0 0 1-34.4-33.6V266.4a34.4 34.4 0 0 1 34.4-34.4h20a22.4 22.4 0 0 0 0 40.8h-20a29.6 29.6 0 0 0-29.6 29.6v519.2a29.6 29.6 0 0 0 29.6 29.6h811.2a29.6 29.6 0 0 0 29.6-29.6V302.4a29.6 29.6 0 0 0-29.6-29.6h-688a22.4 22.4 0 0 0 0-40.8h688m-705.6 0a22.4 22.4 0 0 0-12.8 14.4 22.4 22.4 0 0 0-12.8-14.4h25.6m-42.4 0a22.4 22.4 0 0 0-12.8 14.4A22.4 22.4 0 0 0 144 232h25.6m30.4 26.4a22.4 22.4 0 0 0 12.8 14.4h-26.4a22.4 22.4 0 0 0 12.8-14.4m-42.4 0a22.4 22.4 0 0 0 12.8 14.4H144a22.4 22.4 0 0 0 12.8-14.4m760.8-34.4H106.4A42.4 42.4 0 0 0 64 266.4v554.4a42.4 42.4 0 0 0 42.4 42.4h811.2a42.4 42.4 0 0 0 42.4-42.4V266.4a42.4 42.4 0 0 0-42.4-42.4z m-696.8 42.4a14.4 14.4 0 1 1 14.4-14.4 14.4 14.4 0 0 1-14.4 14.4z m-42.4 0a14.4 14.4 0 1 1 13.6-13.6 14.4 14.4 0 0 1-14.4 14.4z m-42.4 0a14.4 14.4 0 1 1 14.4-14.4 14.4 14.4 0 0 1-14.4 14.4z m-28.8 576a21.6 21.6 0 0 1-21.6-21.6V302.4a21.6 21.6 0 0 1 21.6-21.6h810.4a21.6 21.6 0 0 1 21.6 21.6v519.2a21.6 21.6 0 0 1-21.6 21.6z"
                fill="#1B9DFF"
              />
              <path
                d="M241.6 840.8c-6.4 0-10.4-2.4-10.4-9.6a70.4 70.4 0 0 1 22.4-52 103.2 103.2 0 0 1 57.6-26.4 12.8 12.8 0 0 0 7.2-3.2 8.8 8.8 0 0 0 2.4-4 79.2 79.2 0 0 1-21.6-34.4 77.6 77.6 0 0 0-5.6-11.2h-0.8a67.2 67.2 0 0 1-16.8-24 36 36 0 0 1 0.8-32 96.8 96.8 0 0 1-4.8-30.4 120.8 120.8 0 0 1 6.4-40h1.6a75.2 75.2 0 0 1 29.6-39.2 92.8 92.8 0 0 1 51.2-14.4 133.6 133.6 0 0 1 27.2 1.6 41.6 41.6 0 0 1 28 13.6 40 40 0 0 1 33.6 16.8 98.4 98.4 0 0 1 20.8 42.4 83.2 83.2 0 0 1 0 25.6 148.8 148.8 0 0 1-4.8 22.4 36 36 0 0 1 1.6 32.8 66.4 66.4 0 0 1-16.8 24 48.8 48.8 0 0 0-5.6 11.2 77.6 77.6 0 0 1-20.8 34.4 8.8 8.8 0 0 0 2.4 4.8 12.8 12.8 0 0 0 7.2 3.2 103.2 103.2 0 0 1 57.6 26.4 71.2 71.2 0 0 1 22.4 52.8c0 7.2-2.4 9.6-8.8 9.6"
                fill="#FCE3CD"
              />
              <path
                d="M519.2 840.8c-6.4 0-12.8-2.4-12.8-9.6a70.4 70.4 0 0 1 22.4-52 103.2 103.2 0 0 1 57.6-26.4 12.8 12.8 0 0 0 7.2-3.2 8.8 8.8 0 0 0 2.4-4 79.2 79.2 0 0 1-21.6-34.4 77.6 77.6 0 0 0-5.6-11.2H568a67.2 67.2 0 0 1-16.8-24 36 36 0 0 1 0.8-32 96.8 96.8 0 0 1-4.8-30.4 120.8 120.8 0 0 1 6.4-40h0.8a75.2 75.2 0 0 1 29.6-39.2 92.8 92.8 0 0 1 51.2-14.4 133.6 133.6 0 0 1 27.2 1.6 41.6 41.6 0 0 1 28 15.2 40 40 0 0 1 34.4 15.2 98.4 98.4 0 0 1 20.8 42.4 83.2 83.2 0 0 1 0 25.6 148.8 148.8 0 0 1-4.8 22.4 36 36 0 0 1 1.6 32.8 66.4 66.4 0 0 1-16.8 24 48.8 48.8 0 0 0-5.6 11.2 77.6 77.6 0 0 1-20.8 33.6 8.8 8.8 0 0 0 2.4 4.8 12.8 12.8 0 0 0 7.2 3.2 103.2 103.2 0 0 1 57.6 26.4 71.2 71.2 0 0 1 22.4 52.8c0 7.2-7.2 9.6-14.4 9.6"
                fill="#FCE3CD"
              />
              <path
                d="M672.8 840.8a16 16 0 0 0 16-16 88.8 88.8 0 0 0-28-65.6 129.6 129.6 0 0 0-72.8-32.8 16 16 0 0 1-9.6-4 11.2 11.2 0 0 1-3.2-5.6 96.8 96.8 0 0 0 26.4-42.4 61.6 61.6 0 0 1 7.2-14.4h0.8a83.2 83.2 0 0 0 20.8-30.4 45.6 45.6 0 0 0-2.4-41.6 186.4 186.4 0 0 0 5.6-28 104.8 104.8 0 0 0 0-32 123.2 123.2 0 0 0-25.6-53.6c-11.2-13.6-25.6-22.4-42.4-20.8a52 52 0 0 0-35.2-19.2 168 168 0 0 0-33.6-1.6 116 116 0 0 0-64 18.4 94.4 94.4 0 0 0-36.8 49.6v1.6a152 152 0 0 0-8 50.4 121.6 121.6 0 0 0 5.6 38.4 45.6 45.6 0 0 0-1.6 40 84 84 0 0 0 20.8 30.4h0.8a96.8 96.8 0 0 1 6.4 14.4 100 100 0 0 0 27.2 43.2 11.2 11.2 0 0 1-2.4 4.8 16 16 0 0 1-9.6 4 129.6 129.6 0 0 0-72.8 32.8 88.8 88.8 0 0 0-28 65.6 16 16 0 0 0 16 16zM120.8 336h35.2v14.24h-35.2zM120.8 364.8h42.4v14.24h-42.4zM120.8 392.8h56.8v14.24h-56.8zM888.8 414.4v-48.8h14.24v48.8zM860.8 414.4v-35.2h14.24v35.2zM888.8 356v-13.6h14.24v13.6z"
                fill="#B1DDFF"
              />
            </svg>
          </div>
        </div>
      )}

      <div className={styles.messageContent}>
        {/* New mode: render grouped by task when task metadata exists */}
        {message.role === 'assistant' && taskGroupData ? (
          <>
            {/* Top content: problem-splitting analysis rendered above timeline steps */}
            {/* is-active is true for the last top block while streaming to trigger
                autoCollapseOnDone watcher when streaming ends and collapse thought/decomposition blocks */}
            {taskGroupData.topResults.map((block: any, bIdx: number) => (
              <TaskDetailBlock
                key={`${message.id}-top-${bIdx}`}
                block={block}
                messageId={message.id}
                readonly={readonly}
                isActive={
                  message.is_streaming && bIdx === taskGroupData.topResults.length - 1
                }
              />
            ))}

            {/* Task progress timeline */}
            {taskGroupData.taskPlan.length > 0 && (
              <TaskProgress
                taskPlan={taskGroupData.taskPlan}
                taskGroups={taskGroupData.taskGroups}
                isStreaming={message.is_streaming}
                messageId={message.id}
                readonly={readonly}
                databaseId={databaseId}
                sessionId={sessionId}
                dismissedUserInputs={dismissedUserInputs}
                onSavePanel={(e: any) => onSavePanel?.(e)}
                onPageChange={(msgId: any, blkIdx: any, page: any) =>
                  onPageChange?.(msgId, blkIdx, page)
                }
                onSizeChange={(msgId: any, blkIdx: any, size: any) =>
                  onSizeChange?.(msgId, blkIdx, size)
                }
                onUserInputSubmitted={(e: any) => onUserInputSubmitted?.(e)}
                onReviewIntermediate={() => onReviewIntermediate?.()}
              />
            )}

            {/* Final result (always visible) */}
            {taskGroupData.finalResults.map((block: any, bIdx: number) => {
              // Step blocks with msg_category use TaskDetailBlock for icon/styling.
              // Includes thought / decomposition / tool_call / tool_detail / orchestration / tool_progress, etc.
              // Exclude only final_result, since final answer uses ContentBlock with full markdown rendering.
              if (
                block.metadata?.msg_category &&
                block.metadata.msg_category !== 'final_result'
              ) {
                return (
                  <TaskDetailBlock
                    key={`${message.id}-final-${bIdx}`}
                    block={block}
                    messageId={message.id}
                    readonly={readonly}
                    isActive={
                      message.is_streaming &&
                      bIdx === taskGroupData.finalResults.length - 1
                    }
                  />
                )
              }
              // Final result and untyped content are fully rendered with ContentBlock
              return (
                <ContentBlock
                  key={`${message.id}-final-${bIdx}`}
                  block={block}
                  messageId={message.id}
                  blockIndex={`final-${bIdx}`}
                  showMetricViewSummary={finalResultMetricViewVisibility[bIdx]}
                  readonly={readonly}
                  databaseId={databaseId}
                  sessionId={sessionId}
                  dismissedUserInputs={dismissedUserInputs}
                  onSavePanel={(e: any) => onSavePanel?.(e)}
                  onPageChange={(msgId: any, blkIdx: any, page: any) =>
                    onPageChange?.(msgId, blkIdx, page)
                  }
                  onSizeChange={(msgId: any, blkIdx: any, size: any) =>
                    onSizeChange?.(msgId, blkIdx, size)
                  }
                  onUserInputSubmitted={(e: any) => onUserInputSubmitted?.(e)}
                />
              )
            })}
          </>
        ) : (
          /* Non-task mode: render all blocks normally */
          messageBlocks.map((block: any, bIdx: number) => (
            <ContentBlock
              key={`${message.id}-block-${bIdx}`}
              block={block}
              messageId={message.id}
              blockIndex={bIdx}
              showMetricViewSummary={messageBlockMetricViewVisibility[bIdx]}
              readonly={readonly}
              databaseId={databaseId}
              sessionId={sessionId}
              dismissedUserInputs={dismissedUserInputs}
              onSavePanel={(e: any) => onSavePanel?.(e)}
              onPageChange={(msgId: any, blkIdx: any, page: any) =>
                onPageChange?.(msgId, blkIdx, page)
              }
              onSizeChange={(msgId: any, blkIdx: any, size: any) =>
                onSizeChange?.(msgId, blkIdx, size)
              }
              onUserInputSubmitted={(e: any) => onUserInputSubmitted?.(e)}
            />
          ))
        )}

        {/* Streaming loading dots shown while streaming to indicate the AI is still working */}
        {message.role === 'assistant' && message.is_streaming && (
          <div className={styles.streamingLoading}>
            <span className={styles.loadingDots}>
              <span />
              <span />
              <span />
            </span>
          </div>
        )}

        {/* Executable code block */}
        {executableCode && (
          <div className={styles.sqlBlock}>
            <div className={styles.sqlHeader}>
              <ElSvgIcon name="Document" size={16} />
              <span>{t('session.message.executableCode')}</span>
              <button
                type="button"
                className="ep-link-btn"
                onClick={() => copySQL(executableCode.content)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: 2,
                  color: 'inherit',
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
              >
                <ElSvgIcon name="CopyDocument" size={16} />
              </button>
            </div>
            <pre className={styles.sqlCode}>{executableCode.content}</pre>
          </div>
        )}

        {/* Message metadata and actions */}
        <div className={styles.messageFooter}>
          <div className={styles.messageMeta}>
            {message.tokens_used && (
              <span className={styles.messageTokens}>
                {t('session.message.tokensUsed', { count: message.tokens_used })}
              </span>
            )}
            {message.latency && (
              <span className={styles.messageLatency}>
                {t('session.message.latency', {
                  time: (message.latency / 1000).toFixed(2),
                })}
              </span>
            )}
          </div>
          {!message.is_streaming && !readonly && (
            <div className={styles.messageActions}>
              {/* Like / dislike actions (AI messages only) */}
              {message.role === 'assistant' && (
                <>
                  <span
                    className={`${styles.feedbackIcon} ${
                      currentFeedback === 'like' ? styles.active : ''
                    }`}
                    title={t('session.message.helpful')}
                    onClick={() => handleFeedback('like')}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                      <path d="M2 20h2V8H2v12zm20-11a2 2 0 0 0-2-2h-6.31l.95-4.57.03-.32a1.5 1.5 0 0 0-.44-1.06L13.17 0 6.59 6.59A2 2 0 0 0 6 8v10a2 2 0 0 0 2 2h9a2 2 0 0 0 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73V9z" />
                    </svg>
                  </span>
                  <span
                    className={`${styles.feedbackIcon} ${
                      currentFeedback === 'dislike'
                        ? `${styles.active} ${styles.dislike}`
                        : ''
                    }`}
                    title={t('session.message.needsImprovement')}
                    onClick={() => handleFeedback('dislike')}
                  >
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                      <path d="M22 4h-2v12h2V4zm-4 12a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H9a2 2 0 0 0-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2a2 2 0 0 0 2 2h6.31l-.95 4.57-.03.32a1.5 1.5 0 0 0 .44 1.06L12.83 22l6.59-6.59A2 2 0 0 0 18 14z" />
                    </svg>
                  </span>
                </>
              )}
              <span
                className={styles.deleteIcon}
                onClick={() => onDeleteMessage?.(message.id)}
              >
                <ElSvgIcon name="Delete" size={18} />
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Feedback reason input used inside modals.openConfirmModal,
// replacing ElMessageBox.prompt inputType=textarea
function FeedbackReasonInput({
  prompt,
  placeholder,
  onChange,
}: {
  prompt: string
  placeholder: string
  onChange: (v: string) => void
}) {
  return (
    <div>
      <p style={{ marginTop: 0, marginBottom: 8 }}>{prompt}</p>
      <textarea
        placeholder={placeholder}
        rows={4}
        style={{
          width: '100%',
          padding: 8,
          borderRadius: 6,
          border: '1px solid #dcdfe6',
          fontFamily: 'inherit',
          fontSize: 14,
          resize: 'vertical',
          boxSizing: 'border-box',
        }}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </div>
  )
}
