import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { marked } from 'marked'
import ContentBlockRaw from './ContentBlock'
import styles from './TaskDetailBlock.module.scss'

// ContentBlock is still a migration stub; we use any for temporary prop compatibility.
// After migration, it will receive block/messageId/readonly/blockIndex with the original contract.
const ContentBlock = ContentBlockRaw as any

// ── Markdown rendering ─────────────────────────────────
// The useMarkdown composable has not been migrated; inline marked options replicate original behavior.
marked.setOptions({
  breaks: true,
  gfm: true,
  // @ts-ignore legacy marked option
  sanitize: false,
  // @ts-ignore
  smartLists: true,
  // @ts-ignore
  smartypants: true,
})

function renderMarkdown(content: any): string {
  if (!content) return ''
  try {
    return marked(content) as string
  } catch (error) {
    console.error('Markdown 渲染失败:', error)
    return String(content).replace(/\n/g, '<br>')
  }
}

// ── SVG icons ──────────────────────────────────────
const ICONS: Record<string, string> = {
  thought: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  sparkles: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><defs><linearGradient id="sparkGrad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#6366f1"/><stop offset="100%" stop-color="#a855f7"/></linearGradient></defs><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" stroke="url(#sparkGrad)" fill="url(#sparkGrad)" fill-opacity="0.15"/></svg>',
  bolt: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
  gear: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  database: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>',
  list: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="9" y1="7" x2="20" y2="7"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="17" x2="20" y2="17"/><circle cx="5" cy="7" r="1"/><circle cx="5" cy="12" r="1"/><circle cx="5" cy="17" r="1"/></svg>',
  info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  warning: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  activity: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
}

// ── Category Config ────────────────────────────────
// Labels are computed dynamically for i18n
const getCategoryConfig = (cat: string): any => {
  const configs: Record<string, any> = {
    decomposition: {
      // Visually same as thought. After stream ends, backend renames thought block to analysis summary.
      // icon/label/color should stay stable; keep autoCollapseOnDone so collapse follows watcher behavior.
      icon: ICONS.thought,
      labelKey: 'session.taskDetail.thinking',
      colorClass: 'c-purple',
      collapsible: true,
      collapseLines: 2,
      defaultExpanded: true,
      autoCollapseOnDone: true,
    },
    orchestration: {
      icon: ICONS.list,
      labelKey: 'session.taskDetail.orchestration',
      colorClass: 'c-accent',
      collapsible: true,
      collapseLines: 3,
      defaultExpanded: false,
    },
    status: {
      icon: ICONS.info,
      labelKey: 'session.taskDetail.status',
      colorClass: 'c-gray',
      collapsible: false,
    },
    thought: {
      icon: ICONS.thought,
      labelKey: 'session.taskDetail.thinking',
      colorClass: 'c-purple',
      collapsible: true,
      collapseLines: 2,
      // Expand while streaming (so user sees token-level progress), auto-collapse once isActive becomes false.
      defaultExpanded: true,
      autoCollapseOnDone: true,
    },
    tool_call: {
      icon: ICONS.bolt,
      labelKey: 'session.taskDetail.calling',
      colorClass: 'c-blue',
      showToolBadge: true,
      hideBody: true,
    },
    tool_detail: {
      icon: ICONS.gear,
      labelKey: 'session.taskDetail.executing',
      colorClass: 'c-gray',
    },
    intermediate_result: {
      icon: ICONS.database,
      labelKey: 'session.taskDetail.result',
      colorClass: 'c-green',
    },
    tool_completed: {
      icon: ICONS.check,
      labelKey: 'session.taskDetail.completed',
      colorClass: 'c-green',
      showToolBadge: true,
      hideBody: true,
    },
    tool_failed: {
      icon: ICONS.warning,
      labelKey: 'session.taskDetail.failed',
      colorClass: 'c-red',
      showToolBadge: true,
      hideBody: true,
    },
    // Tool progress (NL2SQL stages, etc). Same (task, stage) entries are replaced by replace_content.
    // status running/done/error overrides icon/color again in getCategoryConfig(cat, status).
    tool_progress: {
      icon: ICONS.activity,
      labelKey: 'session.taskDetail.progress',
      colorClass: 'c-blue',
      collapsible: false,
    },
  }
  return configs[cat] || null
}

const DEFAULT_LABEL_KEY = 'session.taskDetail.details'

// Prefix cleaning helpers ─────────────────────────────
const PREFIX_PATTERNS: Array<{ re: RegExp; extractToolName: boolean }> = [
  { re: /^💭\s*\[[^\]]+\]\s*/, extractToolName: false },
  { re: /^\[[^\]]+\]\s*\*调用\s+([^*]+)\*\s*/, extractToolName: true },
  { re: /^\[中间结果\]\s*/, extractToolName: false },
  { re: /^\[[^\]]+\]\s*/, extractToolName: false },
]

function cleanPrefix(text: any): { cleanText: string; toolName: string } {
  if (!text) return { cleanText: '', toolName: '' }
  for (const p of PREFIX_PATTERNS) {
    const m = text.match(p.re)
    if (m) {
      const cleanText = text.slice(m[0].length).trim()
      const toolName = p.extractToolName && m[1] ? m[1].trim() : ''
      return { cleanText, toolName }
    }
  }
  return { cleanText: text, toolName: '' }
}

// ── Props ──────────────────────────────────────────
export interface TaskDetailBlockProps {
  block: any
  messageId?: string | number
  isActive?: boolean
  readonly?: boolean
}

export default function TaskDetailBlock(props: TaskDetailBlockProps) {
  const { block, messageId = '', isActive = false, readonly = false } = props
  const { t } = useTranslation()

  // ── Computed values ───────────────────────────────
  const category = useMemo(() => block.metadata?.msg_category || '', [block.metadata])

  const config = useMemo(() => {
    const cat = category
    const catConfig = getCategoryConfig(cat)
    if (catConfig) {
      const merged: any = { ...catConfig, label: t(catConfig.labelKey) }
        // tool_progress switches icon/color by status (running=blue/active; done=green/check; error=red/warning).
      if (cat === 'tool_progress') {
        const status = block.metadata?.status
        if (status === 'done') {
          merged.icon = ICONS.check
          merged.colorClass = 'c-green'
        } else if (status === 'error') {
          merged.icon = ICONS.warning
          merged.colorClass = 'c-red'
        }
      }
      return merged
    }
    if (cat) return { icon: ICONS.info, label: t(DEFAULT_LABEL_KEY), colorClass: 'c-gray' }
    return null
  }, [category, block.metadata, t])

  const cleaned = useMemo(() => {
    const raw = typeof block.content === 'string' ? block.content : ''
    return cleanPrefix(raw)
  }, [block.content])

  const cleanedContent = cleaned.cleanText

  const displayToolName = useMemo(() => {
    return block.metadata?.tool_name || cleaned.toolName || ''
  }, [block.metadata, cleaned.toolName])

  // ── Inline tool_detail action label + result split ─────────
  const actionName = useMemo(() => {
    if (category !== 'tool_detail') return ''
    const text = cleanedContent
    if (!text) return ''
    const idx = text.indexOf('\n')
    return idx > 0 ? text.slice(0, idx).trim() : text.trim()
  }, [category, cleanedContent])

  const resultContent = useMemo(() => {
    if (category !== 'tool_detail') return ''
    const text = cleanedContent
    if (!text) return ''
    const idx = text.indexOf('\n')
    return idx > 0 ? text.slice(idx + 1).trim() : ''
  }, [category, cleanedContent])

  const renderedContent = useMemo(() => renderMarkdown(cleanedContent), [cleanedContent])

  const renderedResultContent = useMemo(
    () => (resultContent ? renderMarkdown(resultContent) : ''),
    [resultContent],
  )

  const displayLabel = useMemo(() => {
    if (!config) return ''
    if (category === 'tool_detail' && actionName) {
      return actionName
    }
    // tool_progress prefers server title (specific stage name, e.g. "search similar examples");
    // fallback to i18n generic label "progress" so the header states what is happening.
    if (category === 'tool_progress' && block.title) {
      return block.title
    }
    return config.label
  }, [config, category, actionName, block.title])

  // Body visibility: tool_detail shows only result part; all other categories show full content.
  const showBody = useMemo(() => {
    if (config?.hideBody) return false
    if (category === 'tool_detail') return !!resultContent
    return !!cleanedContent
  }, [config, category, resultContent, cleanedContent])

  const bodyHtml = useMemo(() => {
    if (category === 'tool_detail') return renderedResultContent
    return renderedContent
  }, [category, renderedResultContent, renderedContent])

  // ── Collapse Logic ─────────────────────────────────
  // Categories with autoCollapseOnDone (thought / decomposition):
  // - if not active (historical message or baton-passed block), default to collapsed
  // - while streaming (isActive=true), expand according to defaultExpanded so user can see typing
  // - other categories use config.defaultExpanded.
  const [expanded, setExpanded] = useState<boolean>(() => {
    const cfg = config
    if (!cfg) return false
    if (cfg.autoCollapseOnDone && !isActive) return false
    return cfg.defaultExpanded !== false
  })
  const [isOverflow, setIsOverflow] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)

  // Collapsed state max-height approximation: collapseLines * line-height.
  const collapseMaxHeight = useMemo(() => {
    const lines = config?.collapseLines || 3
  // 13px font-size with 1.6 line-height ≈ 20.8px per line, plus padding.
    return Math.round(lines * 20.8 + 8)
  }, [config])

  // measureOverflow: check if natural height exceeds collapsed max-height.
  const measureOverflow = () => {
    if (!contentRef.current || !config?.collapsible) return
    const el = contentRef.current
    setIsOverflow(el.scrollHeight > collapseMaxHeight)
  }

  // Run measureOverflow once on mount.
  useEffect(() => {
    queueMicrotask(measureOverflow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-measure after block.content changes when not streaming.
  useEffect(() => {
    if (block.is_streaming) return
    queueMicrotask(measureOverflow)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.content])

  // Re-measure when streaming ends.
  useEffect(() => {
    if (!block.is_streaming) {
      queueMicrotask(measureOverflow)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [block.is_streaming])

  // autoCollapseOnDone: auto-collapse when isActive changes from true to false
  // (block stopped receiving incremental updates). Manual expand state is intentionally reset to keep compact after completion.
  const prevActiveRef = useRef<boolean>(isActive)
  useEffect(() => {
    const wasActive = prevActiveRef.current
    if (!isActive && wasActive && config?.autoCollapseOnDone) {
      setExpanded(false)
    }
    prevActiveRef.current = isActive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  // ── Render ─────────────────────────────────────────
  // Fallback for unknown categories.
  if (!config) {
    return (
      <ContentBlock
        block={block}
        messageId={messageId}
        readonly={readonly}
        blockIndex={`detail-fallback-${block.metadata?.msg_category || 'unknown'}`}
      />
    )
  }

  const collapsedActive = config.collapsible && !expanded && isOverflow

  return (
    <div className={`${styles.tdb} ${styles[config.colorClass] || ''}`}>
      {/* header: icon + label + tool badge */}
      <div className={styles['tdb-header']}>
        <span
          className={styles['tdb-icon']}
          dangerouslySetInnerHTML={{ __html: config.icon }}
        />
        <span className={styles['tdb-label']}>{displayLabel}</span>
        {config.showToolBadge && displayToolName && (
          <span className={styles['tdb-badge']}>{displayToolName}</span>
        )}
        {category !== 'tool_detail' && actionName && (
          <span className={styles['tdb-action']}>{actionName}</span>
        )}
        {isActive && (
          <span className={styles['tdb-loading']}>
            <span /><span /><span />
          </span>
        )}
      </div>

      {/* body */}
      {showBody && (
        <div
          className={`${styles['tdb-body']} ${collapsedActive ? styles.collapsed : ''}`}
        >
          <div
            ref={contentRef}
            className={`${styles['tdb-text']} markdown-content ${
              collapsedActive ? styles['height-clamp'] : ''
            }`}
            style={collapsedActive ? { maxHeight: collapseMaxHeight + 'px' } : undefined}
            dangerouslySetInnerHTML={{ __html: bodyHtml }}
          />
          {collapsedActive && <div className={styles['tdb-fade']} />}
        </div>
      )}

      {/* collapse toggle */}
      {config.collapsible && isOverflow && (
        <button
          className={styles['tdb-more']}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? t('session.taskDetail.collapse') : t('session.taskDetail.expandMore')}
        </button>
      )}
    </div>
  )
}
