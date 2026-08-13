/**
 * Content block processing logic.
 */
import { t } from '@/lang'
import { isChartDisplayType } from '@/utils/chartRegistry'

// Content type mapping configuration
const CONTENT_TYPE_MAP: Record<string, { displayType: string; parser: string }> = {
  sql: { displayType: 'table', parser: 'sql' },
  text: { displayType: 'text', parser: 'text' },
  markdown: { displayType: 'text', parser: 'markdown' },
  json: { displayType: 'custom', parser: 'json' },
  chart: { displayType: 'bar', parser: 'json' },
  table: { displayType: 'table', parser: 'json' },
  result: { displayType: 'text', parser: 'text' }
}

// Map legacy block types to renderer content types
export const mapToContentType = (type: string): string => {
  const mapping: Record<string, string> = {
    sql: 'sql',
    text: 'text',
    markdown: 'markdown',
    result: 'text',
    chart: 'json',
    table: 'json',
    json: 'json',
    html: 'html',
    chat: 'chat',
    error: 'text'
  }
  return mapping[type] || 'text'
}

// Check whether the block is a chart type (delegated to chartRegistry)
export const isChartType = (block: any): boolean => {
  return block.type === 'chart' || (block.type === 'json' && isChartDisplayType(block.display_type))
}

// Check whether the block is a table type
export const isTableType = (block: any): boolean => {
  return block.type === 'table' || (block.type === 'json' && block.display_type === 'table')
}

// Check whether the block is a text type
export const isTextType = (block: any): boolean => {
  return (
    block.type === 'result' ||
    block.type === 'text' ||
    block.type === 'markdown' ||
    (block.type === 'json' && block.display_type === 'text')
  )
}

// Extract raw content
export const extractRawContent = (block: any): string => {
  if (typeof block.content === 'string') return block.content
  if (typeof block.content === 'object') return JSON.stringify(block.content)
  return String(block.content || '')
}

const normalizeBlockContent = (content: any): string => {
  if (typeof content === 'string') {
    return content.trim()
  }
  if (content && typeof content === 'object') {
    try {
      return JSON.stringify(content)
    } catch {
      return String(content)
    }
  }
  return String(content ?? '').trim()
}

const getFlattenedMetadata = (block: any): any => {
  const metadata = block?.metadata && typeof block.metadata === 'object'
    ? block.metadata
    : (block?.meta && typeof block.meta === 'object' ? block.meta : {})

  if (metadata.metadata && typeof metadata.metadata === 'object') {
    return {
      ...metadata,
      ...metadata.metadata
    }
  }

  return metadata
}

export const parseBlockContentObject = (content: any): any => {
  if (content && typeof content === 'object') {
    return content
  }

  if (typeof content === 'string') {
    try {
      return JSON.parse(content || '{}')
    } catch {
      return {}
    }
  }

  return {}
}

export const getReportCardData = (block: any, fallbackTitle = '正式报告'): any => {
  const content = parseBlockContentObject(block?.content)
  const metadata = getFlattenedMetadata(block)
  const viewerUrl = content.viewer_url || metadata.viewer_url || ''
  const reportId = content.report_id || metadata.report_id || ''
  const reportType = content.report_type || metadata.report_type || ''
  const fallbackSummary = typeof block?.content === 'string' && block?.type !== 'report'
    ? block.content
    : ''

  return {
    title: content.title || block?.title || fallbackTitle,
    summary: content.summary || fallbackSummary,
    viewerUrl,
    reportId,
    reportType
  }
}

export const isSessionReportCardBlock = (block: any): boolean => {
  if (!block || typeof block !== 'object') return false
  if (block.type === 'report') return true

  const metadata = getFlattenedMetadata(block)
  if (!metadata?.report_ready) return false

  const reportCard = getReportCardData(block)
  return Boolean(reportCard.viewerUrl || reportCard.reportId)
}

const buildDuplicateSignature = (block: any): string => {
  const metadata = getFlattenedMetadata(block)
  const category = metadata.msg_category || ''
  if (!category || category === 'final_result' || category === 'decomposition' || block.savable_to_panel) {
    return ''
  }

  return [
    block.type || '',
    category,
    block.title || '',
    normalizeBlockContent(block.content)
  ].join('::')
}

export const getMetricViewSummary = (block: any): any => {
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
    confirmed_hit: t('session.metricView.statusConfirmedHit'),
    need_param_clarification: t('session.metricView.statusNeedParam'),
    fallback: t('session.metricView.statusFallback')
  }
  const badge = status === 'fallback'
    ? t('session.metricView.summaryFallback')
    : t('session.metricView.summaryHit')
  const parts: string[] = []
  if (statusTextMap[status]) parts.push(t('session.metricView.statusLabel', { status: statusTextMap[status] }))
  if (sourceText) parts.push(t('session.metricView.sourceLabel', { source: sourceText }))
  if (status === 'fallback' && metadata.fallback_to) parts.push(t('session.metricView.fallbackLabel', { target: metadata.fallback_to }))

  const signature = JSON.stringify({
    badge,
    name: metricView.name || t('session.metricView.unnamedView'),
    status,
    sourceText,
    fallbackTo: metadata.fallback_to || ''
  })

  return {
    show: true,
    signature,
    badge,
    main: metricView.name || t('session.metricView.unnamedView'),
    sub: parts.join(' · '),
    statusClass: status === 'fallback' ? 'is-fallback' : 'is-hit'
  }
}

export const buildMetricViewSummaryVisibilityMap = (
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

// Build display configuration
export const buildDisplayConfig = (block: any, sessionSourceInfo: any): any => {
  const config: any = {}
  const content = block.content
  const metadata = getFlattenedMetadata(block)

  if (content && typeof content === 'object') {
    if (content.fields && Array.isArray(content.fields)) {
      config.fields = content.fields
    }
    if (content.x_axis_field) {
      config.x_axis_field = content.x_axis_field
    }
    if (content.y_axis_fields && Array.isArray(content.y_axis_fields)) {
      config.y_axis_fields = content.y_axis_fields
    }
    if (content.group_field) {
      config.group_field = content.group_field
    }
  }

  if (metadata) {
    if (metadata.sql_query) {
      config.sql_query = metadata.sql_query
    }
    if (metadata.source_type) {
      config.source_type = metadata.source_type
    }
    if (metadata.source_id) {
      config.source_id = metadata.source_id
    }
    if (metadata.metric_view?.source_id) {
      config.source_id = metadata.metric_view.source_id
    }
    if (metadata.metric_view?.source_name) {
      config.source_name = metadata.metric_view.source_name
    }
    if (metadata.metric_view?.name) {
      config.metric_view_name = metadata.metric_view.name
    }
  }

  // Read source info from session when block fields are missing
  if (!config.source_type && sessionSourceInfo) {
    config.source_type = block.source_type || sessionSourceInfo.source_type
    config.source_id = block.source_id || sessionSourceInfo.source_id
  }

  return Object.keys(config).length > 0 ? config : null
}

// Build the data format expected by PanelCard
export const buildPanelData = (block: any, sessionSourceInfo: any): any => {
  const typeConfig = CONTENT_TYPE_MAP[block.type] || CONTENT_TYPE_MAP['text']

  return {
    id: block.id || '',
    title: block.title || 'Untitled',
    content_type: mapToContentType(block.type),
    content: extractRawContent(block),
    display_type: block.display_type || block.form_type || typeConfig.displayType,
    display_config: buildDisplayConfig(block, sessionSourceInfo),
    execute_type: block.execute_type || null,
    execute: block.execute || null,
    source_type: block.source_type || sessionSourceInfo?.source_type || '',
    source_id: block.source_id || sessionSourceInfo?.source_id || ''
  }
}

// Extract renderable content blocks from a message
export const getMessageBlocks = (message: any): any[] => {
  if (!message) {
    return []
  }

  if (Array.isArray(message.content_items) && message.content_items.length > 0) {
    return message.content_items.map((item: any) => {
      let displayType = item.display_type
      if (!displayType && item.content && typeof item.content === 'object') {
        displayType = item.content.display_type
      }
      if (!displayType) {
        displayType = item.type
      }

      const savableToPanel = item.savable_to_panel || item.metadata?.savable_to_panel || false
      const executeType = item.execute_type || item.metadata?.execute_type || null
      const execute = item.execute || item.metadata?.execute || null

      return {
        ...item,
        display_type: displayType,
        savable_to_panel: savableToPanel,
        execute_type: executeType,
        execute
      }
    })
  }

  return []
}

// Check whether the message contains executable code
export const hasExecutableCode = (message: any): boolean => {
  return getMessageBlocks(message).some(
    (block) =>
      (block.type === 'code' && block.metadata?.actions?.includes('execute')) ||
      (block.type === 'sql' && block.metadata?.executable)
  )
}

// Get the first executable code block
export const getFirstExecutableCode = (message: any): any => {
  return getMessageBlocks(message).find(
    (block) =>
      (block.type === 'code' && block.metadata?.actions?.includes('execute')) ||
      (block.type === 'sql' && block.metadata?.executable)
  )
}

const TASK_PLAN_STATUS_RE = /^\[[^\]]+\]\s*(全部任务完成|等待用户确认|恢复执行|任务进展|重新分解子任务|All tasks completed|Awaiting user confirmation|Resuming execution|Task progress|Re-decomposing subtasks)\s*$/
/** Duplicate prefixes may appear during Redis/stream merge issues and are treated as task_plan control lines only. */
const TASK_PLAN_STATUS_CORRUPT_RE = /^任务进展\s*\[[^\]]+\]\s*任务进展\s*$/

const isTaskPlanControlStatus = (block: any): boolean => {
  const metadata = getFlattenedMetadata(block)
  if (metadata.msg_category !== 'status') return false
  if (!Array.isArray(metadata.task_plan) || metadata.task_plan.length === 0) return false
  const content = extractRawContent(block).trim()
  return TASK_PLAN_STATUS_RE.test(content) || TASK_PLAN_STATUS_CORRUPT_RE.test(content)
}

/**
 * Group message content blocks by task.
 *
 * @param {Object} message - Message object.
 * @returns {Object|null} Grouping result. Returns null when no task metadata is available and UI falls back to legacy rendering.
 *
 * Return structure:
 * {
 *   taskPlan: [{id, title, status}, ...],  // Task list
 *   taskGroups: { task_id: ContentBlock[] },  // Detailed blocks per task
 *   finalResults: ContentBlock[],  // Always visible final results
 * }
 */
export const groupBlocksByTask = (message: any): any => {
  const blocks = getMessageBlocks(message)
  const taskPlan = message.task_plan

  // If any structured category appears, switch to the new mode and avoid falling back to legacy
  // flat rendering while streaming (e.g., only thought exists before decomposition/orchestration),
  // which causes thought to lose card style during stream and then "jump out" to the analysis card later.
  const STRUCTURED_CATEGORIES = new Set([
    'thought', 'decomposition', 'orchestration',
    'tool_call', 'tool_detail', 'tool_progress',
    'intermediate_result', 'tool_completed', 'tool_failed',
  ])
  const hasTaskFlowMetadata = blocks.some((block) => {
    const metadata = getFlattenedMetadata(block)
    const category = metadata.msg_category

    if (metadata.task_group) return true
    if (STRUCTURED_CATEGORIES.has(category)) return true
    if (category === 'status' && Array.isArray(metadata.task_plan) && metadata.task_plan.length > 0) return true
    return false
  })

  // No task flow metadata -> return null to trigger legacy rendering.
  if (!taskPlan && !hasTaskFlowMetadata) return null

  const result: any = {
    taskPlan: taskPlan || [],
    taskGroups: {},
    topResults: [],
    finalResults: [],
  }

  const appendTaskBlock = (taskId: string, block: any) => {
    if (!result.taskGroups[taskId]) {
      result.taskGroups[taskId] = []
    }
    result.taskGroups[taskId].push(block)
  }

  // After orchestration/task_group appears, status blocks without task_group are treated as end-of-flow status.
  let hasEnteredTaskFlow = false

  for (const block of blocks) {
    const metadata = getFlattenedMetadata(block)
    const category = metadata.msg_category
    const taskId = metadata.task_group

    // Task plan control status lines only drive TaskProgress and are not rendered as standalone status text.
    if (isTaskPlanControlStatus(block)) {
      continue
    }

    // Decomposition: problem-breakdown thinking, shown above the step area.
    if (category === 'decomposition') {
      result.topResults.push(block)
      continue
    }

    // Thought without task_group: first streaming thought during generation; aligned with decomposition so
    // replacing thought with decomposition later does not shift position.
    // Thoughts with task_group still go through the task-grouping path below and are grouped into the matching step.
    if (category === 'thought' && !taskId) {
      result.topResults.push(block)
      continue
    }

    // Orchestration: render before timeline, keeping the workflow explanation.
    // If message.task_plan exists, both the top orchestration text and TaskProgress timeline come
    // from the same source (LLM-generated task list), so the text card is duplicate for humans.
    // Skip it to avoid visual redundancy (items with task_group still go to the corresponding step and are
    // shown in TaskProgress detail).
    if (category === 'orchestration') {
      if (taskId) {
        appendTaskBlock(taskId, block)
        hasEnteredTaskFlow = true
      } else if (!taskPlan || taskPlan.length === 0) {
        // Keep top-level text as a fallback when task_plan is not available during streaming.
        result.topResults.push(block)
        hasEnteredTaskFlow = true
      } else {
        // task_plan already exists; skip duplicate top-level text card.
        hasEnteredTaskFlow = true
      }
      continue
    }

    // Status: show pre-flow statuses at the top, in-flow statuses in the related step, and
    // post-flow statuses before final results.
    if (category === 'status') {
      if (taskId) {
        appendTaskBlock(taskId, block)
        hasEnteredTaskFlow = true
      } else if (!hasEnteredTaskFlow) {
        result.topResults.push(block)
      } else {
        result.finalResults.push(block)
      }
      continue
    }

    // user_input / error / memory_applied: send to task step when task_group exists, otherwise keep always visible.
    if (block.type === 'user_input' || block.type === 'error' || block.type === 'memory_applied') {
      if (taskId) {
        appendTaskBlock(taskId, block)
        hasEnteredTaskFlow = true
      } else {
        result.finalResults.push(block)
      }
      continue
    }

    // No category or final_result/savable content: always visible.
    if (!category || category === 'final_result' || block.savable_to_panel) {
      result.finalResults.push(block)
      continue
    }

    // thought / tool_call / tool_detail / intermediate_result: grouped by task_group.
    if (!taskId) {
      // Un-grouped category blocks go to finalResults to avoid being silently dropped.
      result.finalResults.push(block)
      continue
    }
    appendTaskBlock(taskId, block)
    hasEnteredTaskFlow = true
  }

  // Deduplicate defensively: if the same detail block is placed in both task groups and final results,
  // prefer the task-group placement; remove duplicates within finalResults too to prevent repeated rendering.
  const taskGroupSignatures = new Set<string>()
  Object.values(result.taskGroups).forEach((groupBlocks: any) => {
    groupBlocks.forEach((block: any) => {
      const signature = buildDuplicateSignature(block)
      if (signature) {
        taskGroupSignatures.add(signature)
      }
    })
  })

  const seenFinalSignatures = new Set<string>()
  result.finalResults = result.finalResults.filter((block: any) => {
    const signature = buildDuplicateSignature(block)
    if (!signature) {
      return true
    }
    if (taskGroupSignatures.has(signature)) {
      return false
    }
    if (seenFinalSignatures.has(signature)) {
      return false
    }
    seenFinalSignatures.add(signature)
    return true
  })

  return result
}
