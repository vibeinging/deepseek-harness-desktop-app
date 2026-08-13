import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { t as gt } from '@/lang'
import ElSvgIcon from '@/components/ElSvgIcon'
import ContentBlock from './ContentBlock'
import TaskDetailBlock from './TaskDetailBlock'
import styles from './TaskProgress.module.scss'

// Tool nodes prefer tool_name; condition/agent_condition fall back to node_type.
const TOOL_ICON: Record<string, string> = {
  agentic_search: 'Compass',          // search-check
  execute_readonly_sql: 'Coin',       // database
  format_result: 'Histogram',         // bar-chart
  rag_operator: 'Search',             // search
  semantic_scan_operator: 'Document', // document
  web_search_operator: 'Connection',  // globe
  condition: 'Switch',                // git-branch
  semantic_filter_operator: 'Filter', // filter
  semantic_extract_operator: 'Plus',  // plus-square
  semantic_join_operator: 'Link',     // link
  align_metric: 'Histogram',          // chart-bar
  execute_metric: 'Histogram',        // scalar metric or table view
  align_entity: 'Aim',                // target
  agent_condition: 'MagicStick',      // sparkles
  project_rules_get: 'Document',      // rules document
  project_rules_update: 'Edit',       // edit rules
}

// Return EP icon name for <ElSvgIcon name=...>, or null if not found.
const nodeTypeIcon = (task: any): string | null => {
  if (task.tool_name && TOOL_ICON[task.tool_name]) return TOOL_ICON[task.tool_name]
  if (task.node_type && TOOL_ICON[task.node_type]) return TOOL_ICON[task.node_type]
  return null
}

const DETAIL_CATEGORIES = new Set([
  'thought', 'tool_call', 'tool_detail', 'intermediate_result', 'status', 'orchestration',
  'tool_progress',
])
// Rich content types (table, chart, SQL, etc.) use full ContentBlock rendering.
const RICH_CONTENT_TYPES = new Set([
  'table', 'chart', 'json', 'sql', 'html',
])
const isDetailCategory = (block: any): boolean => {
  const cat = block.metadata?.msg_category
  if (!DETAIL_CATEGORIES.has(cat)) return false
  // Rich content always goes through ContentBlock to keep table/chart/SQL rendering support.
  if (RICH_CONTENT_TYPES.has(block.type)) return false
  return true
}

/* ─── Metric view summary visibility (inlined from composables/useContentBlock.js) ───
 * React useContentBlock migration is pending, so we inline the pure functions
 * getFlattenedMetadata / getMetricViewSummary / buildMetricViewSummaryVisibilityMap here.
 * Keep logic unchanged: for the same signature only the last block shows the metric view summary. */
const getFlattenedMetadata = (block: any): any => {
  const metadata = block?.metadata && typeof block.metadata === 'object'
    ? block.metadata
    : (block?.meta && typeof block.meta === 'object' ? block.meta : {})

  if (metadata.metadata && typeof metadata.metadata === 'object') {
    return { ...metadata, ...metadata.metadata }
  }
  return metadata
}

const getMetricViewSummary = (block: any): any => {
  if (!block || block.type === 'user_input') {
    return { show: false }
  }

  const metadata = getFlattenedMetadata(block)
  const metricView = metadata.metric_view || {}
  const status = metadata.metric_view_status || ''

  if (!metricView?.name && !metricView?.source_name && !metricView?.source_id) {
    return { show: false }
  }

  const sourceText = metricView.source_name || metricView.source_id || ''
  const statusTextMap: Record<string, string> = {
    confirmed_hit: gt('session.metricView.statusConfirmedHit'),
    need_param_clarification: gt('session.metricView.statusNeedParam'),
    fallback: gt('session.metricView.statusFallback'),
  }
  const badge = status === 'fallback'
    ? gt('session.metricView.summaryFallback')
    : gt('session.metricView.summaryHit')
  const parts: string[] = []
  if (statusTextMap[status]) parts.push(gt('session.metricView.statusLabel', { status: statusTextMap[status] }))
  if (sourceText) parts.push(gt('session.metricView.sourceLabel', { source: sourceText }))
  if (status === 'fallback' && metadata.fallback_to) parts.push(gt('session.metricView.fallbackLabel', { target: metadata.fallback_to }))

  const signature = JSON.stringify({
    badge,
    name: metricView.name || gt('session.metricView.unnamedView'),
    status,
    sourceText,
    fallbackTo: metadata.fallback_to || '',
  })

  return {
    show: true,
    signature,
    badge,
    main: metricView.name || gt('session.metricView.unnamedView'),
    sub: parts.join(' · '),
    statusClass: status === 'fallback' ? 'is-fallback' : 'is-hit',
  }
}

const buildMetricViewSummaryVisibilityMap = (
  blocks: any[] = [],
  shouldIncludeBlock: (block: any, index: number) => boolean = () => true
): Record<number, boolean> => {
  const lastIndexBySignature = new Map<string, number>()
  const visibilityMap: Record<number, boolean> = {}

  blocks.forEach((block, index) => {
    if (!shouldIncludeBlock(block, index)) return
    const summary = getMetricViewSummary(block)
    if (!summary.show) return
    lastIndexBySignature.set(summary.signature, index)
  })

  blocks.forEach((block, index) => {
    if (!shouldIncludeBlock(block, index)) {
      visibilityMap[index] = false
      return
    }

    const summary = getMetricViewSummary(block)
    visibilityMap[index] = Boolean(summary.show && lastIndexBySignature.get(summary.signature) === index)
  })

  return visibilityMap
}

export interface TaskProgressProps {
  taskPlan?: any[]
  taskGroups?: Record<string, any[]>
  isStreaming?: boolean
  messageId?: string | number
  databaseId?: string | number | null
  sessionId?: string
  dismissedUserInputs?: Set<any>
  readonly?: boolean
  // defineEmits equivalent callback props.
  onSavePanel?: (payload: any) => void
  onPageChange?: (msgId: any, blkIdx: any, page: any) => void
  onSizeChange?: (msgId: any, blkIdx: any, size: any) => void
  onUserInputSubmitted?: (payload: any) => void
  onReviewIntermediate?: () => void
}

export default function TaskProgress({
  taskPlan = [],
  taskGroups = {},
  isStreaming = false,
  messageId = '',
  databaseId = null,
  sessionId = '',
  dismissedUserInputs = new Set(),
  readonly = false,
  onSavePanel,
  onPageChange,
  onSizeChange,
  onUserInputSubmitted,
  onReviewIntermediate,
}: TaskProgressProps) {
  const { t } = useTranslation()
  const [expandedTasks, setExpandedTasks] = useState<Set<any>>(new Set())

  const getTaskBlocks = (taskId: any): any[] => {
    return taskGroups[taskId] || []
  }

  const hasContent = (taskId: any): boolean => {
    return Boolean(taskGroups[taskId] && taskGroups[taskId].length > 0)
  }

  // Effective task plan: after stream end, fallback converts leftover running status to completed.
  // Backend pushes final task_plan on format_result; this is just defensive handling.
  const effectiveTaskPlan = useMemo(() => {
    if (isStreaming) {
      // Defensive case: pending status with detail blocks means it is actually running (SSE reconnect/history replay may downgrade status).
      // Correct to running so the active indicator and details keep updating.
      return taskPlan.map((task) =>
        (task.status === 'pending' && hasContent(task.id))
          ? { ...task, status: 'running' }
          : task
      )
    }
    return taskPlan.map((task) => {
      if (task.status === 'running') {
        return { ...task, status: 'completed' }
      }
      return task
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskPlan, taskGroups, isStreaming])

  const allCompleted = useMemo(
    () => effectiveTaskPlan.length > 0 && effectiveTaskPlan.every((task) => ['completed', 'skipped'].includes(task.status)),
    [effectiveTaskPlan]
  )

  const taskMetricViewVisibilityMap = useMemo<Record<string, Record<number, boolean>>>(() => {
    const visibilityByTask: Record<string, Record<number, boolean>> = {}

    Object.entries(taskGroups || {}).forEach(([taskId, blocks]) => {
      visibilityByTask[taskId] = buildMetricViewSummaryVisibilityMap(
        blocks,
        (block) => !isDetailCategory(block)
      )
    })

    return visibilityByTask
  }, [taskGroups])

  // Expand logic: waiting_input, running+streaming, or manual expand.
  const isDetailOpen = (task: any): boolean => {
    if (task.status === 'waiting_input') return true
    if (task.status === 'running' && isStreaming) return true
    if (!hasContent(task.id)) return false
    return expandedTasks.has(task.id)
  }

  // Determine whether this is the last block of a running task (show loading animation).
  const isLastActiveBlock = (task: any, bIdx: number): boolean => {
    if (task.status !== 'running' || !isStreaming) return false
    return bIdx === getTaskBlocks(task.id).length - 1
  }

  const toggleTask = (taskId: any): void => {
    if (!hasContent(taskId)) return
    setExpandedTasks((prev) => {
      const newSet = new Set(prev)
      if (newSet.has(taskId)) {
        newSet.delete(taskId)
      } else {
        newSet.add(taskId)
      }
      return newSet
    })
  }

  // Map status to CSS module class (original: :class="`s-${task.status}`").
  const statusClass = (status: string): string => {
    const map: Record<string, string | undefined> = {
      pending: styles.sPending,
      running: styles.sRunning,
      completed: styles.sCompleted,
      failed: styles.sFailed,
      waiting_input: styles.sWaitingInput,
      skipped: styles.sSkipped,
    }
    return map[status] || ''
  }

  if (effectiveTaskPlan.length === 0) return null

  return (
    <div className={styles.taskProgress}>
      {effectiveTaskPlan.map((task, idx) => (
        <div key={task.id} className={`${styles.taskStep} ${statusClass(task.status)}`}>
          {/* Track column: node + connector line */}
          <div className={styles.stepTrack}>
            <div className={styles.stepNode}>
              {/* waiting_input: exclamation mark */}
              {task.status === 'waiting_input' && <span className={styles.nodeWarn}>!</span>}
              {/* pending: step number */}
              {task.status === 'pending' && <span className={styles.nodeNum}>{idx + 1}</span>}
              {/* running: rotating spinner */}
              {task.status === 'running' && <span className={styles.nodeSpinner} />}
              {/* completed: checkmark SVG */}
              {task.status === 'completed' && (
                <svg
                  className={styles.nodeCheck}
                  width="10"
                  height="8"
                  viewBox="0 0 10 8"
                  fill="none"
                >
                  <path d="M1 4L3.8 7L9 1" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
              {/* failed: X */}
              {task.status === 'failed' && <span className={styles.nodeFail}>✕</span>}
              {/* skipped: pruned/short-circuited branch */}
              {task.status === 'skipped' && <span className={styles.nodeSkip}>⋯</span>}
            </div>
          </div>

          {/* Content column: title + details */}
          <div className={styles.stepBody}>
            <div className={styles.stepRow}>
              <span className={styles.stepTitle}>
                {nodeTypeIcon(task) && (
                  <span className={styles.stepTypeIcon}>
                    <ElSvgIcon name={nodeTypeIcon(task)!} size={13} />
                  </span>
                )}
                {task.title}
              </span>
              {/* L2-7: skipped node reason shown in muted text, e.g., "xx branch not taken". */}
              {task.status === 'skipped' && task.skip_reason && (
                <span className={styles.stepSkipReason}>{task.skip_reason}</span>
              )}
              {/* L1-6: yellow node hint for system corrections (fallback when view miss / best candidate selection). */}
              {task.hint && <span className={styles.stepHint}>{task.hint}</span>}
              {/* Detail chip: shown when completed/failed and content exists (running/waiting_input auto-expand, no chip needed). */}
              {task.status !== 'running' &&
                task.status !== 'pending' &&
                task.status !== 'waiting_input' &&
                hasContent(task.id) && (
                <span
                  className={`${styles.chipDone} ${expandedTasks.has(task.id) ? styles.open : ''}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    toggleTask(task.id)
                  }}
                >
                  {t('session.taskProgress.details')}
                  <span className={styles.chipChevron}>›</span>
                </span>
              )}
            </div>

            {/* Expandable detail panel: running auto-expands; other states are manual. */}
            <div className={`${styles.stepDetail} ${isDetailOpen(task) ? styles.open : ''}`}>
              <div className={styles.stepDetailWrap}>
                <div className={styles.stepDetailInner}>
                  {getTaskBlocks(task.id).map((block, bIdx) =>
                    isDetailCategory(block) ? (
                      <TaskDetailBlock
                        key={`${task.id}-${bIdx}`}
                        block={block}
                        messageId={messageId}
                        readonly={readonly}
                        isActive={isLastActiveBlock(task, bIdx)}
                      />
                    ) : (
                      <ContentBlock
                        key={`${task.id}-${bIdx}`}
                        block={block}
                        messageId={messageId}
                        blockIndex={`task-${task.id}-${bIdx}`}
                        readonly={readonly}
                        showMetricViewSummary={taskMetricViewVisibilityMap[task.id]?.[bIdx]}
                        databaseId={databaseId == null ? null : String(databaseId)}
                        sessionId={sessionId}
                        dismissedUserInputs={dismissedUserInputs}
                        onSavePanel={(payload: any) => onSavePanel?.(payload)}
                        onPageChange={(msgId: any, blkIdx: any, page: any) => onPageChange?.(msgId, blkIdx, page)}
                        onSizeChange={(msgId: any, blkIdx: any, size: any) => onSizeChange?.(msgId, blkIdx, size)}
                        onUserInputSubmitted={(payload: any) => onUserInputSubmitted?.(payload)}
                      />
                    )
                  )}
                  {/* Loading indicator for running tasks */}
                  {task.status === 'running' && isStreaming && (
                    <div className={styles.stepLoading}>
                      <span className={styles.stepLoadingDot} />
                      <span className={styles.stepLoadingText}>{t('session.taskProgress.processing')}</span>
                      <span className={styles.stepLoadingBounce}>
                        <span /><span /><span />
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Completion summary row */}
      {allCompleted && (
        <div className={styles.taskRailFooter}>
          <div className={styles.trfDot} />
          <span className={styles.trfText}>
            <strong>{t('session.taskProgress.allStepsCompleted', { count: effectiveTaskPlan.length })}</strong>
          </span>
          {!readonly && (
            <button className={styles.trfReviewBtn} onClick={() => onReviewIntermediate?.()}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <ellipse cx="12" cy="5" rx="9" ry="3" />
                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
              </svg>
              {t('session.taskProgress.reviewIntermediate')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
