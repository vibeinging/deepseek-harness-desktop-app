// TODO(migration): session/composables/useContentBlock.js and useMarkdown.js have not been
//   migrated separately in app/renderer yet.
//   Their pure helper implementations are inlined here (isChartType/isTableType/isTextType/buildPanelData/getMetricViewSummary/
//   getReportCardData/isSessionReportCardBlock, etc.), and the logic stays consistent with the original composable.
//   Replace with direct imports once the composable migration is complete.
import { useContext, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@mantine/core'
import { notifications } from '@mantine/notifications'
import axios from 'axios'
import html2pdf from 'html2pdf.js'
import marked from '@/utils/markdownConfig'
import { sanitizePluginHtmlDocument } from '@/utils/markdownConfig'
import { isChartDisplayType } from '@/utils/chartRegistry'
import { createAPIURL } from '@/utils/url-helper'
import { useProjectStore, projectGetters } from '@/store/project'
import { deleteMemoryReq } from '@/api/memory'
import ElSvgIcon from '@/components/ElSvgIcon'
import AppSelect from '@/components/AppSelect'
import { ShareReadonlyContext } from '@/views/share/index'
import QuestionOptions from './QuestionOptions'
import PanelCard from '@/views/dashboard-management/components/PanelCard'
import styles from './ContentBlock.module.scss'

// ───────────────────────────────────────────────────────────────
// useMarkdown: renderMarkdown (aligned with composables/useMarkdown.js and shared marked instance)
// ───────────────────────────────────────────────────────────────
const renderMarkdown = (content: any): string => {
  if (!content) return ''
  try {
    return marked.parse(content) as string
  } catch (error) {
    console.error('Markdown 渲染失败:', error)
    return String(content).replace(/\n/g, '<br>')
  }
}

// ───────────────────────────────────────────────────────────────
// useClipboard: copySQL (vue-clipboard3 -> navigator.clipboard + notifications)
// ───────────────────────────────────────────────────────────────
const copyToClipboard = async (text: any): Promise<boolean> => {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (err) {
      console.warn('Clipboard API 失败，使用 fallback:', err)
    }
  }
  try {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const success = document.execCommand('copy')
    document.body.removeChild(textarea)
    return success
  } catch (err) {
    console.error('复制失败（两种方法都失败）:', err)
    return false
  }
}

// ───────────────────────────────────────────────────────────────
// useContentBlock inline: content type detection + PanelCard data construction + metric view summary
// ───────────────────────────────────────────────────────────────
const CONTENT_TYPE_MAP: any = {
  sql: { displayType: 'table', parser: 'sql' },
  text: { displayType: 'text', parser: 'text' },
  markdown: { displayType: 'text', parser: 'markdown' },
  json: { displayType: 'custom', parser: 'json' },
  chart: { displayType: 'bar', parser: 'json' },
  table: { displayType: 'table', parser: 'json' },
  result: { displayType: 'text', parser: 'text' },
}

const mapToContentType = (type: any) => {
  const mapping: any = {
    sql: 'sql',
    text: 'text',
    markdown: 'markdown',
    result: 'text',
    chart: 'json',
    table: 'json',
    json: 'json',
    html: 'html',
    chat: 'chat',
    error: 'text',
  }
  return mapping[type] || 'text'
}

const isChartType = (block: any) =>
  block.type === 'chart' || (block.type === 'json' && isChartDisplayType(block.display_type))

const isTableType = (block: any) =>
  block.type === 'table' || (block.type === 'json' && block.display_type === 'table')

const isTextType = (block: any) =>
  block.type === 'result' ||
  block.type === 'text' ||
  block.type === 'markdown' ||
  (block.type === 'json' && block.display_type === 'text')

const extractRawContent = (block: any) => {
  if (typeof block.content === 'string') return block.content
  if (typeof block.content === 'object') return JSON.stringify(block.content)
  return String(block.content || '')
}

const getFlattenedMetadata = (block: any) => {
  const metadata =
    block?.metadata && typeof block.metadata === 'object'
      ? block.metadata
      : block?.meta && typeof block.meta === 'object'
        ? block.meta
        : {}

  if (metadata.metadata && typeof metadata.metadata === 'object') {
    return { ...metadata, ...metadata.metadata }
  }
  return metadata
}

const parseBlockContentObject = (content: any) => {
  if (content && typeof content === 'object') return content
  if (typeof content === 'string') {
    try {
      return JSON.parse(content || '{}')
    } catch {
      return {}
    }
  }
  return {}
}

const getReportCardData = (block: any, fallbackTitle = '正式报告') => {
  const content = parseBlockContentObject(block?.content)
  const metadata = getFlattenedMetadata(block)
  const viewerUrl = content.viewer_url || metadata.viewer_url || ''
  const reportId = content.report_id || metadata.report_id || ''
  const reportType = content.report_type || metadata.report_type || ''
  const fallbackSummary =
    typeof block?.content === 'string' && block?.type !== 'report' ? block.content : ''

  return {
    title: content.title || block?.title || fallbackTitle,
    summary: content.summary || fallbackSummary,
    viewerUrl,
    reportId,
    reportType,
  }
}

const isSessionReportCardBlockHelper = (block: any) => {
  if (!block || typeof block !== 'object') return false
  if (block.type === 'report') return true

  const metadata = getFlattenedMetadata(block)
  if (!metadata?.report_ready) return false

  const reportCard = getReportCardData(block)
  return Boolean(reportCard.viewerUrl || reportCard.reportId)
}

// Build display configuration
const buildDisplayConfig = (block: any, sessionSourceInfo: any) => {
  const config: any = {}
  const content = block.content
  const metadata = getFlattenedMetadata(block)

  if (content && typeof content === 'object') {
    if (content.fields && Array.isArray(content.fields)) config.fields = content.fields
    if (content.x_axis_field) config.x_axis_field = content.x_axis_field
    if (content.y_axis_fields && Array.isArray(content.y_axis_fields))
      config.y_axis_fields = content.y_axis_fields
    if (content.group_field) config.group_field = content.group_field
  }

  if (metadata) {
    if (metadata.sql_query) config.sql_query = metadata.sql_query
    if (metadata.source_type) config.source_type = metadata.source_type
    if (metadata.source_id) config.source_id = metadata.source_id
    if (metadata.metric_view?.source_id) config.source_id = metadata.metric_view.source_id
    if (metadata.metric_view?.source_name) config.source_name = metadata.metric_view.source_name
    if (metadata.metric_view?.name) config.metric_view_name = metadata.metric_view.name
  }

  if (!config.source_type && sessionSourceInfo) {
    config.source_type = block.source_type || sessionSourceInfo.source_type
    config.source_id = block.source_id || sessionSourceInfo.source_id
  }

  return Object.keys(config).length > 0 ? config : null
}

// Build data format required by PanelCard
const buildPanelData = (block: any, sessionSourceInfo: any) => {
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
    source_id: block.source_id || sessionSourceInfo?.source_id || '',
  }
}

// Metric view summary (reuse original i18n keys)
const buildGetMetricViewSummary =
  (t: any) =>
  (block: any): any => {
    if (!block || block.type === 'user_input') return { show: false }

    const metadata = getFlattenedMetadata(block)
    const metricView = metadata.metric_view || {}
    const status = metadata.metric_view_status || ''

    if (!metricView?.name && !metricView?.source_name && !metricView?.source_id) {
      return { show: false }
    }

    const sourceText = metricView.source_name || metricView.source_id || ''
    const statusTextMap: any = {
      confirmed_hit: t('session.metricView.statusConfirmedHit'),
      need_param_clarification: t('session.metricView.statusNeedParam'),
      fallback: t('session.metricView.statusFallback'),
    }
    const badge =
      status === 'fallback'
        ? t('session.metricView.summaryFallback')
        : t('session.metricView.summaryHit')
    const parts: string[] = []
    if (statusTextMap[status])
      parts.push(t('session.metricView.statusLabel', { status: statusTextMap[status] }))
    if (sourceText) parts.push(t('session.metricView.sourceLabel', { source: sourceText }))
    if (status === 'fallback' && metadata.fallback_to)
      parts.push(t('session.metricView.fallbackLabel', { target: metadata.fallback_to }))

    const signature = JSON.stringify({
      badge,
      name: metricView.name || t('session.metricView.unnamedView'),
      status,
      sourceText,
      fallbackTo: metadata.fallback_to || '',
    })

    return {
      show: true,
      signature,
      badge,
      main: metricView.name || t('session.metricView.unnamedView'),
      sub: parts.join(' · '),
      statusClass: status === 'fallback' ? 'isFallback' : 'isHit',
    }
  }

// ───────────────────────────────────────────────────────────────
// Props (aligned with defineProps + defineEmits)
// ───────────────────────────────────────────────────────────────
export interface ContentBlockProps {
  block: any
  messageId: string | number
  blockIndex: string | number
  databaseId?: string | null
  sessionId?: string
  showMetricViewSummary?: boolean
  dismissedUserInputs?: Set<any>
  readonly?: boolean
  // defineEmits(['save-panel', 'page-change', 'size-change', 'user-input-submitted'])
  onSavePanel?: (block: any) => void
  onPageChange?: (messageId: any, blockIndex: any, page: any) => void
  onSizeChange?: (messageId: any, blockIndex: any, size: any) => void
  onUserInputSubmitted?: (...args: any[]) => void
}

export default function ContentBlock(props: ContentBlockProps) {
  const {
    block,
    messageId,
    blockIndex,
    databaseId = null,
    showMetricViewSummary = true,
    dismissedUserInputs = new Set(),
    readonly = false,
    onSavePanel,
    onPageChange,
    onSizeChange,
  } = props

  const { t } = useTranslation()

  // provide/inject -> Context: shared readonly context fallback (readonly/projectId/table pagination functions)
  const ctx = useContext(ShareReadonlyContext) || {}
  const ctxReadonly = ctx.readonly
  const memoryProjectIdInjected = ctx.projectId

  // Parent-injected pagination functions (inject('getTable*'))
  const getTablePagination = ctx.getTablePagination
  const getTableData = ctx.getTableData
  const getTableColumns = ctx.getTableColumns
  const getPaginatedTableData = ctx.getPaginatedTableData

  // Readonly check: prop takes priority, then inject('readonly') as fallback
  const isReadonly = useMemo(
    () => readonly || ctxReadonly === true,
    [readonly, ctxReadonly],
  )

  // store
  const currentProjectId = useProjectStore(projectGetters.currentProjectId)

  const getMetricViewSummary = useMemo(() => buildGetMetricViewSummary(t), [t])

  // Memory applied banner
  const memoryApplied = useMemo(() => {
    if (block.type !== 'memory_applied') return null
    const c = block.content
    if (!c) return null
    try {
      const payload = typeof c === 'string' ? JSON.parse(c) : c
      if (!payload?.memory_id) return null
      return {
        memory_id: payload.memory_id,
        keyword: payload.keyword || '',
        value: payload.value || '',
        hit_count: payload.hit_count,
      }
    } catch {
      return null
    }
  }, [block])

  const [memoryDisputed, setMemoryDisputed] = useState(false)
  const [undoingMemory, setUndoingMemory] = useState(false)

  const handleUndoMemory = async () => {
    if (!memoryApplied || undoingMemory) return
    // Project ID from business scope: prefer store currentProjectId, fallback to injected projectId
    const projectId = currentProjectId || memoryProjectIdInjected?.value || memoryProjectIdInjected
    if (!projectId) {
      notifications.show({
        color: 'yellow',
        message: t('session.memoryApplied.missingContext', '无法识别当前项目，请到「记忆管理」页删除'),
      })
      return
    }
    setUndoingMemory(true)
    try {
      await deleteMemoryReq(projectId, memoryApplied.memory_id)
      setMemoryDisputed(true)
      notifications.show({
        color: 'green',
        message: t('session.memoryApplied.undoSuccess', '已撤销，下次会重新询问'),
      })
    } catch (e) {
      notifications.show({
        color: 'red',
        message: t('session.memoryApplied.undoFailed', '撤销失败'),
      })
    } finally {
      setUndoingMemory(false)
    }
  }

  // Check whether this is a computation process message
  const isComputationProcess = useMemo(
    () =>
      block.title === t('session.content.computationProcess') ||
      (typeof block.content === 'string' && block.content.includes('✅ 计算过程')),
    [block, t],
  )

  // Parse tool-type content blocks
  const toolInfo = useMemo(() => {
    if (block.type !== 'tool') return null
    try {
      const content = typeof block.content === 'string' ? JSON.parse(block.content) : block.content
      return {
        name: content.name || '',
        summary: content.summary || '',
        status: content.status || 'success',
      }
    } catch {
      return null
    }
  }, [block])

  const blockMetadata = useMemo(() => {
    let metadata: any = {}
    if (block.metadata && typeof block.metadata === 'object') {
      metadata = block.metadata
      // Backward-compatible metadata extraction for double-wrapped payloads
      if (metadata.metadata && typeof metadata.metadata === 'object') {
        metadata = { ...metadata, ...metadata.metadata }
      }
    } else if (block.meta && typeof block.meta === 'object') {
      metadata = block.meta
    }
    return metadata
  }, [block])

  const htmlDocumentContent = useMemo(() => {
    if (blockMetadata?.plugin_renderer !== 'html-document') return block.content
    return sanitizePluginHtmlDocument(block.content)
  }, [block.content, blockMetadata?.plugin_renderer])

  const sqlSummaryText = useMemo(() => {
    if (block.type !== 'sql') return ''
    if (block.summary) return block.summary
    return ''
  }, [block])

  const isTaskInlineSql = useMemo(() => {
    if (block.type !== 'sql') return false
    return Boolean(blockMetadata?.metric_view_sql_block || blockMetadata?.task_group)
  }, [block, blockMetadata])

  const reportCard = useMemo(
    () => getReportCardData(block, t('session.content.reportGenerated')),
    [block, t],
  )

  const isSessionReportCardBlock = useMemo(
    () => isSessionReportCardBlockHelper(block),
    [block],
  )

  const metricViewSummary = useMemo(() => {
    if (!showMetricViewSummary) return { show: false } as any
    return getMetricViewSummary(block)
  }, [showMetricViewSummary, getMetricViewSummary, block])

  // Execution environment info (sandbox status)
  const executorInfo = useMemo(() => blockMetadata?.executor_info || null, [blockMetadata])

  const getEnvChipLabel = (info: any) => {
    if (!info) return ''
    if (info.sandbox_enabled) {
      const tool = info.sandbox_tool
      if (tool && tool !== 'none') return `Sandbox·${tool}`
      return 'Sandbox(未激活)'
    }
    if (info.executor_type === 'LocalPythonExecutor') return 'Conda'
    return info.executor_type || ''
  }

  const getEnvChipClass = (info: any) => {
    if (!info) return ''
    if (info.sandbox_enabled) {
      const tool = info.sandbox_tool
      if (tool && tool !== 'none') return styles.envSandbox
      return styles.envSandboxPending
    }
    return styles.envLocal
  }

  // DeepResearch report metadata
  const reportMeta = blockMetadata

  // Check whether this is a report-ready block
  const isReportReadyBlock = useMemo(() => {
    if (block.type !== 'html') return false
    if (reportMeta && reportMeta.report_ready === true) return true
    if (reportMeta.task_id) return true
    return false
  }, [block, reportMeta])

  // Report expand state (track expanded/loading/html state per task_id)
  const [reportState, setReportState] = useState<any>({})

  const reportTaskId = reportMeta?.task_id
  const isReportExpanded = reportTaskId ? reportState[reportTaskId]?.expanded || false : false
  const reportLoading = reportTaskId ? reportState[reportTaskId]?.loading || false : false
  const reportHtml = reportTaskId ? reportState[reportTaskId]?.html || '' : ''

  const patchReportState = (taskId: any, patch: any) => {
    if (!taskId) return
    setReportState((prev: any) => ({
      ...prev,
      [taskId]: { ...(prev[taskId] || {}), ...patch },
    }))
  }

  // Toggle report expand/collapse
  const toggleReportExpand = async () => {
    const taskId = reportMeta?.task_id
    if (isReportExpanded) {
      // Collapse report
      patchReportState(taskId, { expanded: false, html: '', size: '' })
    } else {
      // Expand report and load its content
      await loadReportContent()
    }
  }

  // Load report content
  const loadReportContent = async () => {
    const meta = reportMeta || {}
    const taskId = meta.task_id || meta.report_task_id || meta.deepresearch_task_id

    if (!taskId) {
      notifications.show({ color: 'yellow', message: t('session.content.loadReportNoTaskId') })
      return
    }

    // Immediately mark as expanded and show loading
    patchReportState(taskId, { expanded: true, loading: true })

    // Get current project ID
    const projectId = useProjectStore.getState().currentProject?.id || null
    if (!projectId) {
      notifications.show({ color: 'yellow', message: t('session.content.loadReportNoProject') })
      return
    }
    try {
      const url = createAPIURL(`/api/projects/${projectId}/reports/${taskId}`)
      const response = await axios.get(url)

      if (!response.data || !response.data.html) {
        throw new Error('Invalid API response: missing html field')
      }

      const sizeKb =
        response.data.metadata?.size_kb || Math.floor((response.data.html?.length || 0) / 1024)
      patchReportState(taskId, { html: response.data.html, size: `${sizeKb}k` })

      // Force reactive update
      await new Promise((resolve) => setTimeout(resolve, 0))
    } catch (error: any) {
      notifications.show({
        color: 'red',
        message:
          t('session.content.loadReportFailed') +
          (error.response?.data?.detail || error.message),
      })
      patchReportState(taskId, { expanded: false }) // Collapse on failure
    } finally {
      patchReportState(taskId, { loading: false })
    }
  }

  // HTML report zoom helpers (standalone report block)
  const [zoomLevel, setZoomLevel] = useState(100)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [customHeight, setCustomHeight] = useState(600)
  const minHeight = 200
  const maxHeight = 1200

  const containerHeight = useMemo(
    () => customHeight * (zoomLevel / 100),
    [customHeight, zoomLevel],
  )

  const zoomIn = () => {
    setZoomLevel((v) => (v < 200 ? Math.min(200, v + 25) : v))
  }
  const zoomOut = () => {
    setZoomLevel((v) => (v > 50 ? Math.max(50, v - 25) : v))
  }
  const resetZoom = () => setZoomLevel(100)

  // Zoom controls for expanded report
  const [reportZoomLevel, setReportZoomLevel] = useState(100)
  const [reportPdfLoading, setReportPdfLoading] = useState(false)

  const zoomInReport = () => {
    setReportZoomLevel((v) => (v < 200 ? Math.min(200, v + 25) : v))
  }
  const zoomOutReport = () => {
    setReportZoomLevel((v) => (v > 50 ? Math.max(50, v - 25) : v))
  }
  const resetReportZoom = () => setReportZoomLevel(100)

  // Open report in a new tab
  const openReportInNewTab = () => {
    if (reportHtml) {
      const newWindow = window.open('', '_blank')
      if (newWindow) {
        newWindow.document.write(reportHtml)
        newWindow.document.close()
      }
    }
  }

  // Download report as PDF (expanded report block)
  const downloadReportPdf = async () => {
    setReportPdfLoading(true)
    try {
      if (!reportHtml) {
        notifications.show({ color: 'yellow', message: t('session.content.reportEmptyNoPdf') })
        return
      }

      const styleMatch = reportHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/gi)
      const stylesText = styleMatch ? styleMatch.join('\n') : ''
      const bodyMatch = reportHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
      const bodyContent = bodyMatch ? bodyMatch[1] : reportHtml

      // Create a temporary container (no Shadow DOM to avoid html2pdf limitations)
      const container = document.createElement('div')
      container.style.position = 'absolute'
      container.style.left = '-9999px'
      container.style.top = '0'
      container.style.width = '1200px'
      container.style.background = '#fff'
      container.style.zIndex = '-1'
      document.body.appendChild(container)

      container.innerHTML = `
        ${stylesText}
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 0; }
          .report { max-width: 100% !important; padding: 32px !important; background: #fff; }
          details[open] > summary { display: none; }
          details > *:not(summary) { display: block !important; }
          .conclusion-card, .analysis-section, .notes-section, .stat-card, .data-table,
          details, table, thead, tr { page-break-inside: avoid !important; break-inside: avoid !important; }
          h2, h3, h4 { page-break-after: avoid !important; break-after: avoid !important; }
        </style>
        ${bodyContent}
      `

      // Expand all <details> elements
      container.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''))

      // Wait for fonts and images to load
      await (document as any).fonts.ready
      await new Promise((resolve) => setTimeout(resolve, 1000))

      const reportElement = (container.querySelector('.report') as HTMLElement | null) || container

      const opt: any = {
        margin: [10, 10, 10, 10],
        filename: `${block.title || t('session.content.researchReport')}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          letterRendering: true,
          backgroundColor: '#ffffff',
          logging: false,
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'landscape' },
        pagebreak: {
          mode: ['css', 'legacy'],
          avoid: [
            'tr', 'td', 'thead', 'table',
            '.stat-card', '.conclusion-card', '.analysis-section',
            '.notes-section', '.data-table', 'details', 'h2', 'h3', 'h4',
          ],
        },
      }

      await html2pdf().set(opt).from(reportElement).save()

      setTimeout(() => {
        document.body.removeChild(container)
      }, 100)
    } catch (error: any) {
      console.error('PDF generation failed:', error)
      notifications.show({
        color: 'red',
        message: t('session.content.pdfFailed') + (error.message || ''),
      })
    } finally {
      setReportPdfLoading(false)
    }
  }

  // Drag-to-resize height support
  const isResizingRef = useRef(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(0)

  const onResize = (e: MouseEvent) => {
    if (!isResizingRef.current) return
    const delta = e.clientY - startYRef.current
    const newHeight = Math.min(maxHeight, Math.max(minHeight, startHeightRef.current + delta))
    setCustomHeight(newHeight)
  }

  const stopResize = () => {
    isResizingRef.current = false
    document.removeEventListener('mousemove', onResize)
    document.removeEventListener('mouseup', stopResize)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }

  const startResize = (e: React.MouseEvent) => {
    isResizingRef.current = true
    startYRef.current = e.clientY
    startHeightRef.current = customHeight
    document.addEventListener('mousemove', onResize)
    document.addEventListener('mouseup', stopResize)
    document.body.style.cursor = 'ns-resize'
    document.body.style.userSelect = 'none'
  }

  const isUserInputDismissed = (b: any) => {
    // Check if already submitted: either present in dismissedUserInputs set or flagged in block content
    let content: any
    try {
      content = typeof b.content === 'string' ? JSON.parse(b.content) : b.content
    } catch {
      content = b.content
    }
    const requestId = content?.request_id
    if (requestId && dismissedUserInputs.has(requestId)) {
      return true
    }
    return b.dismissed || content?.dismissed || false
  }

  // Get content hint (reason for content type change)
  const getContentHint = (b: any) => {
    try {
      const content = typeof b.content === 'string' ? JSON.parse(b.content) : b.content
      return content?.fallback_hint || content?.content || ''
    } catch {
      return ''
    }
  }

  // Get truncate hint
  const getTruncateHint = (b: any) => {
    try {
      const content = typeof b.content === 'string' ? JSON.parse(b.content) : b.content
      return content?.truncate_hint || ''
    } catch {
      return ''
    }
  }

  // HTML report helpers
  const openInNewTab = (htmlContent: any) => {
    const newWindow = window.open('', '_blank')
    if (newWindow) {
      newWindow.document.write(htmlContent)
      newWindow.document.close()
    }
  }

  const downloadHtml = (htmlContent: any, title: any) => {
    const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${title || t('session.content.researchReport')}.html`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const openSessionReport = (viewerUrl: any) => {
    if (!viewerUrl) return
    const normalizedUrl = viewerUrl.startsWith('/')
      ? `${window.location.origin}${viewerUrl}`
      : viewerUrl
    window.open(normalizedUrl, '_blank')
  }

  // Strip the computation-process prefix ("✅ Computation Process") from content
  const stripComputationPrefix = (content: any) => {
    if (!content) return ''
    return content.replace(/^✅\s*计算过程\s*\n\n?/, '')
  }

  const copySQL = async (sql: any) => {
    const success = await copyToClipboard(sql)
    if (success) {
      notifications.show({ color: 'green', message: t('common.sqlCopied') })
    } else {
      notifications.show({ color: 'red', message: t('common.copyFailedPermission') })
    }
  }

  const downloadPdf = async (htmlContent: any, title: any) => {
    setPdfLoading(true)
    try {
      // Extract styles and body content from HTML
      const styleMatch = htmlContent.match(/<style[^>]*>([\s\S]*?)<\/style>/gi)
      const stylesText = styleMatch ? styleMatch.join('\n') : ''

      // Extract body content
      const bodyMatch = htmlContent.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
      const bodyContent = bodyMatch ? bodyMatch[1] : htmlContent

      // Create temporary container
      const container = document.createElement('div')
      container.style.position = 'absolute'
      container.style.left = '-9999px'
      container.style.top = '0'
      container.style.width = '1200px'
      container.style.background = '#fff'
      document.body.appendChild(container)

      // Create shadow DOM to isolate styles
      const shadow = container.attachShadow({ mode: 'open' })

      shadow.innerHTML = `
        ${stylesText}
        <style>
          * { box-sizing: border-box; }
          :host { display: block; width: 1200px; background: #fff; }
          .report { max-width: 100% !important; padding: 32px !important; }
          details[open] > summary { display: none; }
          details > *:not(summary) { display: block !important; }

          /* PDF page break controls to prevent element truncation */
          .conclusion-card,
          .analysis-section,
          .notes-section,
          .stat-card,
          .data-table,
          details,
          table,
          thead,
          tr {
            page-break-inside: avoid !important;
            break-inside: avoid !important;
          }

          /* Keep headings with the following content */
          h2, h3, h4 {
            page-break-after: avoid !important;
            break-after: avoid !important;
          }
        </style>
        ${bodyContent}
      `

      // Expand all <details> elements
      shadow.querySelectorAll('details').forEach((d) => d.setAttribute('open', ''))

      // Wait for fonts and content to load
      await (document as any).fonts.ready
      await new Promise((resolve) => setTimeout(resolve, 800))

      // Get the report element
      const reportElement = shadow.querySelector('.report') || (shadow as any)

      const opt: any = {
        margin: [10, 10, 10, 10],
        filename: `${title || t('session.content.researchReport')}.pdf`,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          allowTaint: true,
          letterRendering: true,
          backgroundColor: '#ffffff',
          logging: false,
        },
        jsPDF: {
          unit: 'mm',
          format: 'a4',
          orientation: blockMetadata?.plugin_options?.orientation === 'portrait' ? 'portrait' : 'landscape',
        },
        pagebreak: {
          mode: ['css', 'legacy'],
          avoid: [
            'tr', 'td', 'thead', 'table',
            '.stat-card', '.conclusion-card', '.analysis-section',
            '.notes-section', '.data-table', 'details',
            'h2', 'h3', 'h4',
          ],
        },
      }

      // Generate and download PDF
      await html2pdf().set(opt).from(reportElement).save()

      // Clean up temporary container
      document.body.removeChild(container)
    } catch {
      notifications.show({ color: 'red', message: t('session.content.pdfFailedRetry') })
    } finally {
      setPdfLoading(false)
    }
  }

  // Metric view summary sub-block (reused in multiple places)
  const renderMetricViewSummary = () =>
    (metricViewSummary as any).show ? (
      <div
        className={`${styles.metricViewSummary} ${
          (metricViewSummary as any).statusClass === 'isFallback' ? styles.isFallback : ''
        }`}
      >
        <span className={styles.metricViewSummaryBadge}>{(metricViewSummary as any).badge}</span>
        <span className={styles.metricViewSummaryMain}>{(metricViewSummary as any).main}</span>
        {(metricViewSummary as any).sub && (
          <span className={styles.metricViewSummarySub}>{(metricViewSummary as any).sub}</span>
        )}
      </div>
    ) : null

  // Save to panel button (reused in multiple places; inline style kept to align source behavior)
  const renderSavePanelButton = (extraStyle?: any) =>
    block.savable_to_panel && !isReadonly ? (
      <Button
        variant="filled"
        size="xs"
        style={extraStyle}
        leftSection={<ElSvgIcon name="Document" size={14} />}
        onClick={() => onSavePanel?.(block)}
      >
        {t('session.content.saveToPanel')}
      </Button>
    ) : null

  // ───────────────────────────────────────────────────────────────
  // Render branches (keep the same v-if/v-else-if order as the original template)
  // ───────────────────────────────────────────────────────────────

  // Tool call result (new style)
  if (toolInfo) {
    return (
      <div className={`tool-result-block ${toolInfo.status}`}>
        <span className="tool-label">{t('session.content.useTool')}</span>
        <span className="tool-badge">{toolInfo.name}</span>
        {toolInfo.summary && <span className="tool-detail">{toolInfo.summary}</span>}
      </div>
    )
  }

  // Memory applied banner
  if (block.type === 'memory_applied' && memoryApplied) {
    return (
      <div className={`${styles.memoryAppliedBanner} ${memoryDisputed ? styles.isDisputed : ''}`}>
        <span className={styles.memoryAppliedIcon}>💡</span>
        <span className={styles.memoryAppliedText}>
          {memoryDisputed ? (
            t('session.memoryApplied.disputed', '已撤销记忆，下次相同字面量会重新询问')
          ) : (
            <>
              {t('session.memoryApplied.message', '检测到您之前为「{keyword}」明确过「{value}」', {
                keyword: memoryApplied.keyword,
                value: memoryApplied.value,
              })}
              {memoryApplied.hit_count ? (
                <span className={styles.memoryAppliedHit}>
                  {t('session.memoryApplied.hitCount', '· 命中 {n} 次', { n: memoryApplied.hit_count })}
                </span>
              ) : null}
            </>
          )}
        </span>
        {!memoryDisputed && !isReadonly && (
          <Button
            className={styles.memoryAppliedUndo}
            size="xs"
            color="orange"
            variant="subtle"
            loading={undoingMemory}
            onClick={handleUndoMemory}
          >
            {t('session.memoryApplied.undo', '撤销')}
          </Button>
        )}
      </div>
    )
  }

  // Computation process content (special styling)
  if (isComputationProcess) {
    return (
      <div className="computation-process-block">
        <div className="computation-process-header">
          <ElSvgIcon name="CircleCheck" size={16} />
          <span>{t('session.content.computationProcess')}</span>
        </div>
        <div
          className="computation-process-content"
          dangerouslySetInnerHTML={{
            __html: renderMarkdown(stripComputationPrefix(block.content || '')),
          }}
        />
      </div>
    )
  }

  // Markdown/Text content (excluding computation process block)
  if ((!block.type || block.type === 'text' || block.type === 'markdown') && !isComputationProcess) {
    return (
      <div className="message-text markdown-content">
        {executorInfo && (
          <div className={`${styles.executorEnvBadge} ${getEnvChipClass(executorInfo)}`}>
            {getEnvChipLabel(executorInfo)}
          </div>
        )}
        {block.savable_to_panel && !isReadonly && (
          <div className="text-header">
            <Button
              variant="filled"
              size="xs"
              style={{
                marginLeft: 'auto',
                display: 'block',
                width: 'fit-content',
                marginBottom: 8,
              }}
              leftSection={<ElSvgIcon name="Document" size={14} />}
              onClick={() => onSavePanel?.(block)}
            >
              {t('session.content.saveToPanel')}
            </Button>
          </div>
        )}
        {renderMetricViewSummary()}
        <div dangerouslySetInnerHTML={{ __html: renderMarkdown(block.content || '') }} />
      </div>
    )
  }

  // Table content
  if (isTableType(block)) {
    const tableRows = getTableData ? getTableData(block.content) : []
    const tableColumns = getTableColumns ? getTableColumns(block.content) : []
    const pagedData = getPaginatedTableData
      ? getPaginatedTableData(block.content, messageId, blockIndex)
      : []
    const pagination = getTablePagination
      ? getTablePagination(messageId, blockIndex)
      : { currentPage: 1, pageSize: 10 }
    const contentHint = getContentHint(block)
    const truncateHint = getTruncateHint(block)

    return (
      <div className="result-block">
        <div className="result-header">
          <ElSvgIcon name="DataAnalysis" size={16} />
          <span>{block.title || t('session.content.queryResult')}</span>
          {renderSavePanelButton({ marginLeft: 'auto' })}
        </div>
        {renderMetricViewSummary()}
            {/* Display type change hint */}
        {contentHint && (
          <div className="content-hint">
            <ElSvgIcon name="InfoFilled" size={16} />
            {contentHint}
          </div>
        )}
        <div className="result-table">
          <table className="el-table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {tableColumns.map((column: any, index: number) => (
                  <th key={index}>{column}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {pagedData.map((row: any, rIdx: number) => (
                <tr key={rIdx}>
                  {tableColumns.map((column: any, cIdx: number) => (
                    <td key={cIdx} title={String(row?.[column] ?? '')}>
                      {String(row?.[column] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {tableRows.length >= 10 && (
            <div className="result-pagination">
              {/* Lightweight pagination controls, preserving page-change/size-change event contracts */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                <span>{t('session.content.queryResult')}: {tableRows.length}</span>
                <AppSelect
                  value={String(pagination?.pageSize ?? 10)}
                  onChange={(value) => onSizeChange?.(messageId, blockIndex, Number(value))}
                  options={[10, 20, 50, 100].map((size) => ({
                    value: String(size),
                    label: `${size}/page`
                  }))}
                  size="xs"
                  aria-label="每页显示条数"
                  style={{ width: 112, minWidth: 112 }}
                />
                <Button
                  size="xs"
                  variant="default"
                  disabled={(pagination?.currentPage ?? 1) <= 1}
                  onClick={() =>
                    onPageChange?.(messageId, blockIndex, (pagination?.currentPage ?? 1) - 1)
                  }
                >
                  ‹
                </Button>
                <span>{pagination?.currentPage ?? 1}</span>
                <Button
                  size="xs"
                  variant="default"
                  disabled={
                    (pagination?.currentPage ?? 1) * (pagination?.pageSize ?? 10) >= tableRows.length
                  }
                  onClick={() =>
                    onPageChange?.(messageId, blockIndex, (pagination?.currentPage ?? 1) + 1)
                  }
                >
                  ›
                </Button>
              </div>
            </div>
          )}
          {truncateHint && <div className="truncate-hint">{truncateHint}</div>}
        </div>
      </div>
    )
  }

  // user_input: render prompt text only
  if (block.type === 'user_input') {
    return (
      <div className="user-input-block">
        <QuestionOptions content={block.content} dismissed={isUserInputDismissed(block)} />
      </div>
    )
  }

  // Chart content
  if (isChartType(block)) {
    const contentHint = getContentHint(block)
    const truncateHint = getTruncateHint(block)
    return (
      <div className="chart-block">
        <div className="chart-header">
          <ElSvgIcon name="TrendCharts" size={16} />
          <span>{block.title || t('session.content.dataVisualization')}</span>
          {renderSavePanelButton({ marginLeft: 'auto' })}
        </div>
        {renderMetricViewSummary()}
        {/* Display type change hint */}
        {contentHint && (
          <div className="content-hint">
            <ElSvgIcon name="InfoFilled" size={16} />
            {contentHint}
          </div>
        )}
        <div className="chart-container">
          <PanelCard panel={buildPanelData(block, databaseId)} contentHeight={300} showHeader={false} />
        </div>
        {truncateHint && <div className="truncate-hint">{truncateHint}</div>}
      </div>
    )
  }

  // Text result content
  if (isTextType(block)) {
    return (
      <div className="result-answer-block">
        <div className="result-answer-header">
          <span>{block.title || t('session.content.smartFeedbackComplete')}</span>
          {renderSavePanelButton({ marginLeft: 'auto' })}
        </div>
        {renderMetricViewSummary()}
        <div className="result-answer-content">
          {typeof block.content === 'string' ? (
            block.content
          ) : typeof block.content === 'object' ? (
            <pre>{JSON.stringify(block.content, null, 2)}</pre>
          ) : (
            String(block.content)
          )}
        </div>
      </div>
    )
  }

  // Raw JSON data
  if (block.type === 'json' && !block.display_type) {
    return (
      <div className="json-block">
        <div className="json-header">
          <ElSvgIcon name="Document" size={16} />
          <span>{block.title || t('session.content.jsonData')}</span>
        </div>
        {renderMetricViewSummary()}
        <div className="json-content">
          <pre>{JSON.stringify(block.content, null, 2)}</pre>
        </div>
      </div>
    )
  }

  // SQL block
  if (block.type === 'sql') {
    return (
      <div className={`${styles.sqlBlock} ${isTaskInlineSql ? styles.taskInlineSql : ''}`}>
        <div className={styles.sqlHeader}>
          <ElSvgIcon name="Document" size={16} />
          <span>{block.title || t('session.content.sqlQuery')}</span>
          <div className={styles.sqlActions}>
            <Button variant="subtle" size="xs" onClick={() => copySQL(block.content)}>
              <ElSvgIcon name="CopyDocument" size={16} />
            </Button>
          </div>
        </div>
        {renderMetricViewSummary()}
        {sqlSummaryText && <div className={styles.sqlSummary}>{sqlSummaryText}</div>}
        <pre className={styles.sqlCode}>{block.content}</pre>
      </div>
    )
  }

  // Lightweight report card block
  if (isSessionReportCardBlock) {
    return (
      <div className={styles.sessionReportBlock}>
        <div className={styles.sessionReportMain}>
          <span className={styles.sessionReportIcon}>
            <ElSvgIcon name="Document" size={22} />
          </span>
          <div className={styles.sessionReportCopy}>
            <div className={styles.sessionReportTitle}>{reportCard.title}</div>
            <div className={styles.sessionReportSummary}>
              {reportCard.summary || t('session.content.reportGenerated')}
            </div>
            {(reportCard.reportType || reportCard.reportId) && (
              <div className={styles.sessionReportMeta}>
                {reportCard.reportType && <span>{reportCard.reportType}</span>}
                {reportCard.reportId && <span>ID: {reportCard.reportId}</span>}
              </div>
            )}
          </div>
          {!isReadonly && (
            <div className={styles.sessionReportActions}>
              <Button variant="filled" size="xs" onClick={() => openSessionReport(reportCard.viewerUrl)}>
                {t('session.content.viewReport')}
              </Button>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Report ready block
  if (isReportReadyBlock) {
    return (
      <div className={`${styles.reportReadyBlock} ${isReportExpanded ? styles.expanded : ''}`}>
        <div className={styles.reportReadyMain}>
          <span className={styles.reportIcon}>
            <ElSvgIcon name="Document" size={40} />
          </span>
          <div className={styles.reportText}>
            <div className={styles.reportTitle}>
              {block.title || reportMeta.title || t('session.content.reportGenerated')}
            </div>
            <div className={styles.reportSubtitle}>
              {reportMeta.section_count && (
                <span>{t('session.content.sectionCount', { count: reportMeta.section_count })}</span>
              )}
              {reportMeta.paper_count && (
                <span> {t('session.content.paperCount', { count: reportMeta.paper_count })}</span>
              )}
              {reportMeta.size_kb && (
                <span> {t('session.content.sizeKb', { size: reportMeta.size_kb })}</span>
              )}
            </div>
          </div>
          {!isReadonly && (
            <div className={styles.reportMainActions}>
              <Button
                variant="filled"
                size="xs"
                className={styles.reportToggleBtn}
                leftSection={<ElSvgIcon name={isReportExpanded ? 'ArrowUp' : 'ArrowDown'} size={16} />}
                onClick={toggleReportExpand}
              >
                {isReportExpanded
                  ? t('session.content.collapseReport')
                  : t('session.content.viewReport')}
              </Button>
            </div>
          )}
          {reportMeta.generated_at && (
            <span className={styles.reportMetaTime}>
              {t('session.content.generatedAt', { time: reportMeta.generated_at })}
            </span>
          )}
        </div>

            {/* Full expanded report content in chat stream */}
        {isReportExpanded && (
          <div className={styles.reportExpandedContent}>
              {/* Toolbar */}
            <div className={styles.reportToolbar}>
              <div className={styles.reportToolbarActions}>
                <div className={styles.zoomControls}>
                  <Button
                    disabled={reportZoomLevel <= 50}
                    variant="subtle"
                    size="xs"
                    title={t('session.content.zoomOut')}
                    onClick={zoomOutReport}
                  >
                    <ElSvgIcon name="ZoomOut" size={16} />
                  </Button>
                  <span className={styles.zoomLevel}>{reportZoomLevel}%</span>
                  <Button
                    disabled={reportZoomLevel >= 200}
                    variant="subtle"
                    size="xs"
                    title={t('session.content.zoomIn')}
                    onClick={zoomInReport}
                  >
                    <ElSvgIcon name="ZoomIn" size={16} />
                  </Button>
                  <Button
                    disabled={reportZoomLevel === 100}
                    variant="subtle"
                    size="xs"
                    title={t('session.content.reset')}
                    onClick={resetReportZoom}
                  >
                    <ElSvgIcon name="RefreshRight" size={16} />
                  </Button>
                </div>
                <Button
                  variant="subtle"
                  size="xs"
                  title={t('session.content.openInNewTab')}
                  onClick={openReportInNewTab}
                >
                  <ElSvgIcon name="FullScreen" size={16} />
                </Button>
                <Button
                  variant="subtle"
                  size="xs"
                  title={t('session.content.downloadPdf')}
                  loading={reportPdfLoading}
                  onClick={downloadReportPdf}
                >
                  {!reportPdfLoading && (
                    <span style={{ fontWeight: 600, fontSize: 11 }}>PDF</span>
                  )}
                </Button>
              </div>
            </div>

              {/* Report content */}
            <div
              className={styles.reportContentWrapper}
              style={{ position: 'relative' }}
            >
              {reportLoading && (
                <div
                  style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'rgba(255,255,255,0.6)',
                    zIndex: 1,
                  }}
                >
                  {t('common.loading', '加载中...')}
                </div>
              )}
              {reportHtml ? (
                <div
                  className={styles.reportInnerWrapper}
                  style={{
                    transform: `scale(${reportZoomLevel / 100})`,
                    transformOrigin: 'top left',
                  }}
                >
                  <iframe
                    srcDoc={reportHtml}
                    sandbox="allow-same-origin allow-scripts"
                    className={styles.reportIframe}
                    style={{
                      width: `${10000 / reportZoomLevel}%`,
                      height: `${10000 / reportZoomLevel}%`,
                    }}
                  />
                </div>
              ) : (
                !reportLoading && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      minHeight: 200,
                      color: '#94a3b8',
                    }}
                  >
                    {t('session.content.noReportContent')}
                  </div>
                )
              )}
            </div>
          </div>
        )}
      </div>
    )
  }

  // Full HTML document (academic report and similar)
  if (block.type === 'html') {
    return (
      <div className="html-report-block">
        <div className="html-report-header">
          <ElSvgIcon name="Document" size={16} />
          <span>{block.title || t('session.content.researchReport')}</span>
          <div className="html-report-actions">
            <div className={styles.zoomControls}>
              <Button
                disabled={zoomLevel <= 50}
                variant="subtle"
                size="xs"
                title={t('session.content.zoomOut')}
                onClick={zoomOut}
              >
                <ElSvgIcon name="ZoomOut" size={16} />
              </Button>
              <span className={styles.zoomLevel}>{zoomLevel}%</span>
              <Button
                disabled={zoomLevel >= 200}
                variant="subtle"
                size="xs"
                title={t('session.content.zoomIn')}
                onClick={zoomIn}
              >
                <ElSvgIcon name="ZoomIn" size={16} />
              </Button>
              <Button
                disabled={zoomLevel === 100}
                variant="subtle"
                size="xs"
                title={t('session.content.reset')}
                onClick={resetZoom}
              >
                <ElSvgIcon name="RefreshRight" size={16} />
              </Button>
            </div>
            <Button
              variant="subtle"
              size="xs"
              title={t('session.content.openInNewTab')}
              onClick={() => openInNewTab(htmlDocumentContent)}
            >
              <ElSvgIcon name="FullScreen" size={16} />
            </Button>
            <Button
              variant="subtle"
              size="xs"
              title={t('session.content.downloadHtml')}
              onClick={() => downloadHtml(htmlDocumentContent, block.title)}
            >
              <ElSvgIcon name="Download" size={16} />
            </Button>
            <Button
              variant="subtle"
              size="xs"
              title={t('session.content.downloadPdf')}
              loading={pdfLoading}
              onClick={() => downloadPdf(htmlDocumentContent, block.title)}
            >
              {!pdfLoading && <span style={{ fontWeight: 600, fontSize: 11 }}>PDF</span>}
            </Button>
          </div>
        </div>
        <div className="html-report-container" style={{ height: `${containerHeight}px` }}>
          <iframe
            srcDoc={htmlDocumentContent}
            className="html-report-iframe"
            style={{
              transform: `scale(${zoomLevel / 100})`,
              transformOrigin: 'top left',
              width: `${10000 / zoomLevel}%`,
              height: `${10000 / zoomLevel}%`,
            }}
            sandbox="allow-same-origin"
            frameBorder={0}
          />
        </div>
        <div className="html-report-resizer" onMouseDown={startResize}>
          <span className="resizer-handle" />
        </div>
      </div>
    )
  }

  // Error block
  if (block.type === 'error') {
    return (
      <div className="error-block">
        <div className="error-header">
          <ElSvgIcon name="Warning" size={16} />
          <span>{t('session.content.errorInfo')}</span>
        </div>
        <div className="error-content">
          <p className="error-message">{block.content}</p>
          {block.details && Object.keys(block.details).length > 0 && (
            <div className="error-details">
              {/* Convert el-collapse to <details>/<summary> while keeping header/content behavior */}
              <details>
                <summary>{t('session.content.errorDetails')}</summary>
                <pre>{JSON.stringify(block.details, null, 2)}</pre>
              </details>
            </div>
          )}
        </div>
      </div>
    )
  }

  // Fallback rendering for unknown block types
  return (
    <div className="message-text">
      {typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}
    </div>
  )
}
