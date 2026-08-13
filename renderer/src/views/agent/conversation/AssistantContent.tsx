import { memo, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconAlertTriangle,
  IconBrain,
  IconChartBar,
  IconCheck,
  IconChevronRight,
  IconDownload,
  IconFile,
  IconFolder,
  IconHistory,
  IconMovie,
  IconMusic,
  IconPhoto,
  IconPlayerPlay,
  IconTable,
  IconTerminal2,
  IconWorldSearch,
  IconX
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import ReactECharts from 'echarts-for-react'
import { renderSafeMarkdown, sanitizePluginHtmlDocument } from '@/utils/markdownConfig'
import { buildChartOption, isChartDisplayType } from '@/utils/chartRegistry'
import { readDshSessionAttachment, resolveAgentFileReference } from '@/api/agent'
import CodeView from '../CodeView'
import EvidenceCard from '../EvidenceCard'
import { FileChangeCard } from '../WorkspaceChanges'
import type { Attachment } from '../ComposerActions'
import { openLocalFile, revealInFinder } from '../folders'
import type {
  AgentBlock as Block,
  AgentFileReferenceAnnotation,
  AgentMessage as Msg
} from '../stream/types'
import {
  IMAGE_MARKDOWN_RE,
  attachmentPreviewKind,
  imageSrcFromPath,
  isRenderableImageSrc,
  isRenderableMediaSrc,
  localMediaKindForPath,
  mediaSrcFromPath,
  type LocalMediaKind
} from '../stream/uiCapabilities'
import { resolveAgentAction } from '../actionBlock'
import {
  activityState,
  activityStateLabel,
  approvalInteractionState,
  userInputInteractionState,
  type UserInputInteractionState
} from '../activityState'
import { resolveThinkingExpanded } from '../thinking-state'
import { queryValidationPresentation, toolCallPresentation } from '../processBlockModel'
import {
  ArtifactActionSurface,
  artifactActionTarget,
  executeArtifactAction
} from './ArtifactActions'
import type { FileReferenceOpenTarget } from './types'
import { GenerativeUiBlock } from '../generative-ui/GenerativeUiBlock'
import styles from '../agent.module.scss'

type StructuredField = { key: string; label: string }

/** Keep stale runtime identifiers and local paths out of the conversation surface. */
export function visibleAgentError(content: unknown): string {
  const message = String(content || '').trim()
  if (/DSH session .+ 与工作目录 .+ 冲突，已停止以避免产生断裂历史/u.test(message)) {
    return '会话已切换到新的 DSH 运行环境，请重新发送这条消息。'
  }
  return message
}

export function AttachmentPreview({ attachment, compact = false }: { attachment: Attachment; compact?: boolean }) {
  const [failed, setFailed] = useState(false)
  const [dshImageSrc, setDshImageSrc] = useState('')
  const [duration, setDuration] = useState<number | null>(null)
  const kind = attachmentPreviewKind(attachment)
  const mediaKind = kind === 'video' || kind === 'audio' ? kind : null
  const mediaSrc = mediaKind ? mediaSrcFromPath(attachment.path) : ''
  const canRenderMedia = mediaKind ? isRenderableMediaSrc(mediaSrc, mediaKind) : false
  const durationLabel = duration && Number.isFinite(duration) ? formatMediaDuration(duration) : ''

  useEffect(() => {
    const ref = attachment.dshAttachment
    if (!ref) {
      setFailed(false)
      setDshImageSrc('')
      return
    }
    let disposed = false
    let objectUrl = ''
    setFailed(false)
    setDshImageSrc('')
    void readDshSessionAttachment(ref.appSessionId, ref.attachmentId)
      .then((blob) => {
        if (disposed) return
        objectUrl = URL.createObjectURL(blob)
        setDshImageSrc(objectUrl)
      })
      .catch(() => {
        if (!disposed) setFailed(true)
      })
    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [attachment.dshAttachment?.appSessionId, attachment.dshAttachment?.attachmentId])

  if (kind === 'image' && !failed) {
    const src = attachment.dshAttachment ? dshImageSrc : imageSrcFromPath(attachment.path)
    return (
      <span
        className={compact ? styles.attachImagePreviewCompact : styles.attachImagePreview}
        title={attachment.path}
        data-attachment-preview="image"
        data-attachment-preview-state={src ? 'ready' : 'loading'}
      >
        {src ? (
          <img
            src={src}
            alt={attachment.name}
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        ) : null}
        {!compact && <span>{attachment.name}</span>}
      </span>
    )
  }

  if (kind === 'video' && canRenderMedia && !failed) {
    return (
      <span
        className={compact ? styles.attachVideoPreviewCompact : styles.attachVideoPreview}
        title={attachment.path}
        data-attachment-preview="video"
        data-attachment-preview-state="ready"
      >
        <span className={styles.attachVideoFrame}>
          <video
            src={mediaSrc}
            controls={!compact}
            muted={compact}
            playsInline
            preload="metadata"
            aria-label={compact ? undefined : `播放 ${attachment.name}`}
            aria-hidden={compact ? true : undefined}
            tabIndex={compact ? -1 : undefined}
            onLoadedMetadata={(event) => {
              const seconds = event.currentTarget.duration
              setDuration(Number.isFinite(seconds) ? seconds : null)
              if (compact && seconds > 0) event.currentTarget.currentTime = Math.min(0.08, seconds / 2)
            }}
            onError={() => setFailed(true)}
          />
          {compact && (
            <span className={styles.attachVideoPlay} aria-hidden="true">
              <IconPlayerPlay size={13} stroke={2.2} />
            </span>
          )}
          {compact && durationLabel && <small className={styles.attachMediaDuration}>{durationLabel}</small>}
        </span>
        {!compact && (
          <span className={styles.attachPreviewCopy}>
            <span>{attachment.name}</span>
            <small>{durationLabel ? `视频 · ${durationLabel}` : '视频'}</small>
          </span>
        )}
      </span>
    )
  }

  if (kind === 'audio' && canRenderMedia && !failed) {
    if (compact) {
      return (
        <span
          className={styles.attachAudioPreviewCompact}
          title={attachment.path}
          data-attachment-preview="audio"
          data-attachment-preview-state="ready"
        >
          <IconMusic size={17} stroke={1.8} aria-hidden="true" />
          <audio
            src={mediaSrc}
            preload="metadata"
            aria-hidden="true"
            onLoadedMetadata={(event) => {
              const seconds = event.currentTarget.duration
              setDuration(Number.isFinite(seconds) ? seconds : null)
            }}
            onError={() => setFailed(true)}
          />
          {durationLabel && <small>{durationLabel}</small>}
        </span>
      )
    }
    return (
      <span
        className={styles.attachAudioPreview}
        title={attachment.path}
        data-attachment-preview="audio"
        data-attachment-preview-state="ready"
      >
        <span className={styles.attachPreviewCopy}>
          <span>{attachment.name}</span>
          <small>{durationLabel ? `音频 · ${durationLabel}` : '音频'}</small>
        </span>
        <audio
          controls
          src={mediaSrc}
          preload="metadata"
          aria-label={`播放 ${attachment.name}`}
          onLoadedMetadata={(event) => {
            const seconds = event.currentTarget.duration
            setDuration(Number.isFinite(seconds) ? seconds : null)
          }}
          onError={() => setFailed(true)}
        />
      </span>
    )
  }

  if (kind === 'pdf') {
    return (
      <span
        className={compact ? styles.attachPdfPreviewCompact : styles.attachPdfPreview}
        title={attachment.path}
        data-attachment-preview="pdf"
        data-attachment-preview-state="identified"
      >
        <span className={styles.attachPdfMark} aria-hidden="true">PDF</span>
        {!compact && (
          <span className={styles.attachPreviewCopy}>
            <span>{attachment.name}</span>
            <small>PDF 文档</small>
          </span>
        )}
      </span>
    )
  }

  const FallbackIcon = kind === 'folder'
    ? IconFolder
    : kind === 'image'
      ? IconPhoto
      : kind === 'video'
        ? IconMovie
        : kind === 'audio'
          ? IconMusic
          : IconFile
  return (
    <span
      className={compact ? styles.attachFileFallbackCompact : styles.attachFileFallback}
      title={failed ? `${attachment.path}\n无法预览，附件仍可正常发送` : attachment.path}
      data-attachment-preview={kind}
      data-attachment-preview-state={failed ? 'unavailable' : 'identified'}
    >
      {failed ? <IconAlertTriangle size={14} stroke={1.7} /> : <FallbackIcon size={14} stroke={1.7} />}
      <span>
        <span>{attachment.name}</span>
        {failed && <small>无法预览，仍可正常发送</small>}
      </span>
    </span>
  )
}

function formatMediaDuration(rawSeconds: number) {
  const seconds = Math.max(0, Math.floor(rawSeconds))
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return `${minutes}:${String(remaining).padStart(2, '0')}`
}


export function clipText(text: string, max = 116) {
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}…`
}

function normalizeMarkdownImageSources(text: string) {
  IMAGE_MARKDOWN_RE.lastIndex = 0
  return text.replace(IMAGE_MARKDOWN_RE, (raw, alt: string, src: string) => {
    const nextSrc = imageSrcFromPath(src || '')
    if (!isRenderableImageSrc(nextSrc)) return raw
    return `![${String(alt || '').replace(/]/g, '\\]')}](${nextSrc})`
  })
}

function prettifyStandaloneJsonLines(text: string) {
  const lines = text.split('\n')
  let inFence = false
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence
        return line
      }
      if (inFence) return line
      const trimmed = line.trim()
      if (!/^\{[\s\S]*\}$/.test(trimmed)) return line
      try {
        return `\`\`\`json\n${JSON.stringify(JSON.parse(trimmed), null, 2)}\n\`\`\``
      } catch {
        return line
      }
    })
    .join('\n')
}

function markdownLinkText(value: string) {
  return String(value || '').replace(/([\\\[\]])/g, '\\$1').replace(/\n/g, ' ')
}

interface WebSource {
  source_id: string
  url: string
  title: string
  site_name?: string
  published_at?: string | null
  accessed_at?: string | null
  excerpt?: string
}

interface ProjectMemorySource {
  session_id: string
  title: string
  updated_at?: string | null
  snippet?: string
}

interface GlobalMemoryEntry {
  id: string
  content: string
  updated_at?: string | null
}

interface GlobalMemoryBlockData {
  entries: GlobalMemoryEntry[]
  conversations: ProjectMemorySource[]
}

function globalMemoryFromBlock(block?: Block | null): GlobalMemoryBlockData {
  if (!block) return { entries: [], conversations: [] }
  const parsed = parseJsonObject(block.content)
  const entries = Array.isArray(parsed?.entries)
    ? parsed.entries.filter((entry: any) => entry?.id && String(entry?.content || '').trim())
    : []
  const conversations = Array.isArray(parsed?.conversations)
    ? parsed.conversations.filter((source: any) => source?.session_id && source?.title)
    : []
  return { entries, conversations }
}

export function webSourcesFromBlock(block?: Block | null): WebSource[] {
  if (!block) return []
  const parsed = parseJsonObject(block.content)
  return Array.isArray(parsed?.sources)
    ? parsed.sources.filter((source: any) => source?.source_id && /^https?:\/\//i.test(String(source?.url || '')))
    : []
}

function annotateWebCitations(content: string, sources: WebSource[]) {
  if (!sources.length) return content
  const byId = new Map(sources.map((source) => [source.source_id, source]))
  return String(content || '').replace(/【(S\d+)】/g, (marker, sourceId) => {
    const source = byId.get(sourceId)
    if (!source) return marker
    const title = String(source.title || source.site_name || source.url).replace(/[\r\n]+/g, ' ').replace(/"/g, '&quot;')
    return `[${marker}](#dsh-web-source-${sourceId} "${title}")`
  })
}

function annotateMarkdownSource(
  content: string,
  annotations: AgentFileReferenceAnnotation[],
  resolved: Record<string, { absolutePath: string; lineStart?: number; locationStatus?: string }>,
  interactive: boolean
) {
  const codePoints = Array.from(content)
  const replacements = annotations
    .filter((item) => item?.type === 'fileReference' && item.sourceRange)
    .map((item) => ({
      item,
      start: Math.max(0, Number(item.sourceRange?.start || 0)),
      end: Math.max(0, Number(item.sourceRange?.end || 0))
    }))
    .filter((entry) => entry.end > entry.start && entry.end <= codePoints.length)
    .sort((a, b) => b.start - a.start)
  for (const { item, start, end } of replacements) {
    const label = markdownLinkText(item.displayText || codePoints.slice(start, end).join('').replace(/^`|`$/g, ''))
    const location = item.target.lineStart ? `${item.target.path}:${item.target.lineStart}` : item.target.path
    const resolvedTarget = resolved[item.id]
    const resolvedTitle = resolvedTarget?.absolutePath
      ? `${resolvedTarget.absolutePath}${resolvedTarget.lineStart ? `:${resolvedTarget.lineStart}` : ''}`
      : location
    const title = String(resolvedTitle).replace(/"/g, '&quot;')
    const replacement = interactive
      ? `[${label}](#dsh-file-reference-${encodeURIComponent(item.id)} "${title}")`
      : `\`${label}\``
    codePoints.splice(start, end - start, ...Array.from(replacement))
  }
  return codePoints.join('')
}

const EMPTY_FILE_ANNOTATIONS: AgentFileReferenceAnnotation[] = []

type ResolvedFileReference = {
  absolutePath: string
  path?: string
  lineStart?: number
  lineEnd?: number
  locationStatus?: string
}

function localMediaName(path: string) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
}

const LocalMediaPreview = memo(function LocalMediaPreview({
  kind,
  target,
  onOpenFileReference
}: {
  kind: LocalMediaKind
  target: ResolvedFileReference
  onOpenFileReference?: (target: FileReferenceOpenTarget) => void | Promise<void>
}) {
  const [failed, setFailed] = useState(false)
  const src = mediaSrcFromPath(target.absolutePath)
  const name = localMediaName(target.absolutePath)
  const open = async () => {
    if (onOpenFileReference) {
      await onOpenFileReference({
        absolutePath: target.absolutePath,
        path: target.path || target.absolutePath,
        locationStatus: target.locationStatus
      })
      return
    }
    const opened = await openLocalFile(target.absolutePath)
    if (!opened) await revealInFinder(target.absolutePath)
  }

  return (
    <figure className={styles.localMediaCard} data-inline-media={kind}>
      {failed ? (
        <div className={styles.localMediaError} role="status">
          <IconAlertTriangle size={18} stroke={1.7} />
          <span>无法在页面内播放这个{kind === 'video' ? '视频' : '音频'}，可以用本机应用打开。</span>
        </div>
      ) : kind === 'video' ? (
        <video
          controls
          playsInline
          preload="metadata"
          src={src}
          aria-label={`播放 ${name}`}
          onError={() => setFailed(true)}
        />
      ) : (
        <audio controls preload="metadata" src={src} aria-label={`播放 ${name}`} onError={() => setFailed(true)} />
      )}
      <figcaption>
        <span className={styles.localMediaName} title={target.absolutePath}>
          {kind === 'video' ? <IconMovie size={15} stroke={1.7} /> : <IconMusic size={15} stroke={1.7} />}
          <span>{name}</span>
        </span>
        <button type="button" onClick={() => void open()}>用本机打开</button>
      </figcaption>
    </figure>
  )
})

const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  annotations = EMPTY_FILE_ANNOTATIONS,
  webSources = [],
  threadId,
  canOpenLocalFile = false,
  onOpenFileReference
}: {
  content: string
  annotations?: AgentFileReferenceAnnotation[]
  webSources?: WebSource[]
  threadId?: string | null
  canOpenLocalFile?: boolean
  onOpenFileReference?: (target: FileReferenceOpenTarget) => void | Promise<void>
}) {
  const [resolved, setResolved] = useState<Record<string, ResolvedFileReference>>({})

  useEffect(() => {
    let alive = true
    if (!canOpenLocalFile || !threadId || annotations.length === 0) {
      setResolved((current) => Object.keys(current).length ? {} : current)
      return () => { alive = false }
    }
    void Promise.all(annotations.map(async (annotation) => {
      try {
        const response: any = await resolveAgentFileReference(threadId, annotation.target)
        return response?.data?.absolutePath
          ? [annotation.id, {
              absolutePath: String(response.data.absolutePath),
              path: String(response.data.path || annotation.target.path || ''),
              lineStart: Number(response.data.lineStart || 1),
              lineEnd: Number(response.data.lineEnd || response.data.lineStart || 1),
              locationStatus: String(response.data.locationStatus || 'exact')
            }] as const
          : null
      } catch {
        return null
      }
    })).then((items) => {
      if (alive) setResolved(Object.fromEntries(items.filter(Boolean) as Array<readonly [string, ResolvedFileReference]>))
    })
    return () => { alive = false }
  }, [annotations, canOpenLocalFile, threadId])

  const html = useMemo(() => {
    const annotated = annotateMarkdownSource(String(content || ''), annotations, resolved, canOpenLocalFile)
    const cited = annotateWebCitations(annotated, webSources)
    const normalized = normalizeMarkdownImageSources(prettifyStandaloneJsonLines(cited))
    try {
      return renderSafeMarkdown(normalized)
    } catch {
      return renderSafeMarkdown(String(content || ''))
    }
  }, [annotations, canOpenLocalFile, content, resolved, webSources])

  const localMedia = useMemo(() => {
    const seen = new Set<string>()
    return annotations.flatMap((annotation) => {
      const target = resolved[annotation.id]
      if (!target?.absolutePath || seen.has(target.absolutePath)) return []
      const kind = annotation.target.mediaKind || localMediaKindForPath(target.absolutePath)
      if (!kind) return []
      seen.add(target.absolutePath)
      return [{ kind, target }]
    })
  }, [annotations, resolved])

  const onClick = async (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a')
    const href = anchor?.getAttribute('href') || ''
    if (/^https?:\/\//i.test(href)) {
      event.preventDefault()
      window.open(href, '_blank', 'noopener,noreferrer')
      return
    }
    const webPrefix = '#dsh-web-source-'
    if (href.startsWith(webPrefix)) {
      event.preventDefault()
      const source = webSources.find((item) => item.source_id === href.slice(webPrefix.length))
      if (source?.url) window.open(source.url, '_blank', 'noopener,noreferrer')
      return
    }
    const prefix = '#dsh-file-reference-'
    if (!href.startsWith(prefix)) return
    event.preventDefault()
    const id = decodeURIComponent(href.slice(prefix.length))
    const target = resolved[id]
    if (!target?.absolutePath) {
      notifications.show({ color: 'gray', message: '引用的文件已经移动或删除' })
      return
    }
    if (onOpenFileReference) {
      await onOpenFileReference({
        absolutePath: target.absolutePath,
        path: target.path || target.absolutePath,
        lineStart: target.lineStart,
        lineEnd: target.lineEnd,
        locationStatus: target.locationStatus
      })
    } else {
      const opened = await openLocalFile(target.absolutePath)
      if (!opened) await revealInFinder(target.absolutePath)
    }
    if (target.locationStatus === 'moved') {
      notifications.show({ color: 'blue', message: '文件已移动，已按内容定位到新位置' })
    } else if (target.locationStatus === 'anchored') {
      notifications.show({ color: 'blue', message: `文件内容已变化，引用位置已定位到第 ${target.lineStart || 1} 行` })
    }
  }

  const onContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    const anchor = (event.target as HTMLElement | null)?.closest?.('a')
    const href = anchor?.getAttribute('href') || ''
    const prefix = '#dsh-file-reference-'
    if (!href.startsWith(prefix)) return
    const id = decodeURIComponent(href.slice(prefix.length))
    const target = resolved[id]
    const showMenu = (window as any)?.electronAPI?.showArtifactContextMenu
    if (!target?.absolutePath || typeof showMenu !== 'function') return
    event.preventDefault()
    void showMenu({
      path: target.absolutePath,
      kind: 'file',
      x: event.clientX,
      y: event.clientY
    }).then((shown: boolean) => {
      if (!shown) notifications.show({ color: 'gray', message: '无法打开这个文件的系统菜单' })
    }).catch(() => notifications.show({ color: 'gray', message: '无法打开这个文件的系统菜单' }))
  }

  return (
    <>
      {localMedia.length > 0 && (
        <div className={styles.localMediaList} aria-label="媒体产物">
          {localMedia.map(({ kind, target }) => (
            <LocalMediaPreview
              key={target.absolutePath}
              kind={kind}
              target={target}
              onOpenFileReference={onOpenFileReference}
            />
          ))}
        </div>
      )}
      <div
        className={styles.blkText}
        onClick={onClick}
        onContextMenu={onContextMenu}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </>
  )
})

function parseJsonObject(value: unknown): any | null {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Build a minimal unified-diff string from a DSH FileDiff ({ path, oldText,
 * newText }). The renderer has no `diff` dependency, so this is a simple
 * line-by-line replacement hunk — enough for FileChangeCard's parseUnifiedDiff
 * to produce an add/delete tally and a reviewable preview. Context lines and
 * minimal-diff algorithms are out of scope for this slice.
 */
function fileDiffToUnifiedDiff(path: string, oldText: string | null, newText: string): string {
  const oldLines = (oldText ?? '').split('\n')
  const newLines = newText.split('\n')
  // '@@ -oldStart,oldLen +newStart,newLen @@' — single hunk from line 1.
  const oldLen = oldLines.length
  const newLen = newLines.length
  const header = `@@ -1,${oldLen} +1,${newLen} @@`
  const body = [
    ...oldLines.filter(l => l !== '').map(l => `-${l}`),
    ...newLines.filter(l => l !== '').map(l => `+${l}`)
  ]
  return `--- ${oldText === null ? '/dev/null' : path}\n+++ ${path}\n${header}\n${body.join('\n')}\n`
}

/**
 * Adapt a DSH DiffCallView's FileDiff[] into the { changes } payload shape
 * FileChangeCard reads from block.content, and return a synthetic AgentBlock
 * the diff card can render. Used when a tool's dshView is a `diff` call card.
 */
function diffViewToolBlock(block: Block, diffs: { path: string; oldText: string | null; newText: string }[], status: string): Block {
  const changes = diffs.map(d => ({ path: d.path, diff: fileDiffToUnifiedDiff(d.path, d.oldText, d.newText) }))
  return {
    ...block,
    type: 'file_change',
    content: JSON.stringify({ changes, status })
  }
}

function dshResultBody(view: any, fallback = ''): { kind: 'code' | 'text'; text: string } | null {
  if (!view || typeof view !== 'object') return fallback ? { kind: 'text', text: fallback } : null
  if (view.card === 'terminal') return { kind: 'code', text: String(view.output || fallback || '') }
  if (view.card === 'read') {
    const lines = Array.isArray(view.lines)
      ? view.lines.map((line: any) => `${String(line.number).padStart(5, ' ')}  ${String(line.text || '')}`).join('\n')
      : ''
    return { kind: 'code', text: lines || fallback }
  }
  if (view.card === 'search') {
    const text = view.shape === 'paths'
      ? (Array.isArray(view.paths) ? view.paths.join('\n') : '')
      : (Array.isArray(view.files)
          ? view.files.flatMap((file: any) => [
              String(file.path || ''),
              ...(Array.isArray(file.matches)
                ? file.matches.map((match: any) => `${match.lineNumber}: ${match.line}`)
                : [])
            ]).join('\n')
          : '')
    const capped = view.truncated ? `\n共 ${view.total} 条，当前只显示部分结果` : ''
    return { kind: 'code', text: `${text}${capped}`.trim() || fallback }
  }
  if (view.card === 'web') {
    if (view.kind === 'fetch') {
      const status = `${view.statusCode || ''} ${view.url || ''}`.trim()
      return { kind: 'text', text: [status, view.truncated ? '内容已截断' : '', fallback].filter(Boolean).join('\n') }
    }
    const sources = Array.isArray(view.sources)
      ? view.sources.map((source: any, index: number) => `${index + 1}. ${source.title || source.url}\n${source.url}${source.snippet ? `\n${source.snippet}` : ''}`).join('\n\n')
      : ''
    return { kind: 'text', text: [view.answer, sources, view.truncated ? '来源列表已截断' : '', fallback].filter(Boolean).join('\n\n') }
  }
  if (view.card === 'generic' && Array.isArray(view.content)) {
    return { kind: 'text', text: view.content.map((block: any) => block?.type === 'text' ? String(block.text || '') : JSON.stringify(block)).join('\n') || fallback }
  }
  return fallback ? { kind: 'text', text: fallback } : null
}

export function parseUserInputPayload(content: unknown) {
  const payload = parseJsonObject(content) || {}
  const context = payload.disambiguation_context || {}
  const memoryValues = new Set(
    (Array.isArray(context.memory_values) ? context.memory_values : [])
      .map((item: any) => String(item?.value || item || '').trim())
      .filter(Boolean)
  )
  const optionItems = [
    ...(Array.isArray(payload.options) ? payload.options : []),
    ...(Array.isArray(context.memory_values) ? context.memory_values : []),
    ...(Array.isArray(context.candidates) ? context.candidates : [])
  ]
  const seenOptions = new Set<string>()
  const options = optionItems
    .map((item: any) => {
      const label = String(item?.label || item?.value || item || '').trim()
      return label ? { label, isMemory: memoryValues.has(label) } : null
    })
    .filter((item): item is { label: string; isMemory: boolean } => {
      if (!item || seenOptions.has(item.label)) return false
      seenOptions.add(item.label)
      return true
    })
  const nativeQuestions = (Array.isArray(payload.questions) ? payload.questions : [])
    .map((question: any, index: number) => ({
      id: String(question?.id || `question_${index + 1}`),
      header: String(question?.header || '').trim(),
      question: String(question?.question || '').trim(),
      isOther: Boolean(question?.isOther ?? question?.is_other),
      isSecret: Boolean(question?.isSecret ?? question?.is_secret),
      required: question?.required !== false,
      allowMultiple: Boolean(question?.allowMultiple ?? question?.allow_multiple),
      defaultValue: question?.defaultValue ?? question?.default_value ?? null,
      options: (Array.isArray(question?.options) ? question.options : [])
        .map((option: any) => ({
          label: String(option?.label || option || '').trim(),
          description: String(option?.description || '').trim()
        }))
        .filter((option: any) => option.label)
    }))
    .filter((question: any) => question.question || question.options.length)
  const questions = nativeQuestions.length
    ? nativeQuestions
    : [{
        id: 'answer',
        header: '',
        question: String(payload.prompt || ''),
        isOther: false,
        isSecret: false,
        required: true,
        allowMultiple: Boolean(payload.allow_multiple),
        defaultValue: null,
        options: options.map((option) => ({ label: option.label, description: '' }))
      }]
  return {
    requestId: String(payload.request_id || ''),
    runId: String(payload.run_id || payload.resume_handle?.run_id || ''),
    resumeHandle: payload.resume_handle && typeof payload.resume_handle === 'object' ? payload.resume_handle : null,
    prompt: String(payload.prompt || ''),
    options,
    allowMultiple: Boolean(payload.allow_multiple),
    native: nativeQuestions.length > 0,
    threadId: String(payload.threadId || payload.thread_id || ''),
    turnId: String(payload.turnId || payload.turn_id || ''),
    itemId: String(payload.itemId || payload.item_id || payload.request_id || ''),
    questions,
    answers: payload.answers && typeof payload.answers === 'object' ? payload.answers : {}
  }
}

function resolvedUserInputLabel(
  payload: ReturnType<typeof parseUserInputPayload>,
  response: unknown
): string {
  if (typeof response === 'string') return response
  const answers = response && typeof response === 'object' && !Array.isArray(response)
    ? response as Record<string, any>
    : payload.answers && typeof payload.answers === 'object'
      ? payload.answers as Record<string, any>
      : {}
  return payload.questions.map((question: any) => {
    const answer = answers[question.id]
    if (question.isSecret || answer?.secret === true) {
      return answer?.answered === true || Array.isArray(answer?.answers) ? `${question.header || question.question}：已回答` : ''
    }
    const values = Array.isArray(answer?.answers) ? answer.answers.map(String).filter(Boolean) : []
    if (!values.length) return ''
    return payload.questions.length > 1
      ? `${question.header || question.question}：${values.join('、')}`
      : values.join('、')
  }).filter(Boolean).join('；')
}

const UserInputBlock = memo(function UserInputBlock({
  block,
  interactionState,
  selectedValue,
  onSubmit
}: {
  block: Block
  interactionState: UserInputInteractionState
  selectedValue?: string
  onSubmit: (
    payload: ReturnType<typeof parseUserInputPayload>,
    answers: Record<string, { answers: string[] }>
  ) => Promise<void>
}) {
  const payload = useMemo(() => parseUserInputPayload(block.content), [block.content])
  const disabled = interactionState !== 'requested'
  const resolved = interactionState === 'resolved'
  const [answers, setAnswers] = useState<Record<string, string[]>>(() => Object.fromEntries(
    payload.questions
      .filter((question: any) => question.defaultValue != null)
      .map((question: any) => [
        question.id,
        (Array.isArray(question.defaultValue) ? question.defaultValue : [question.defaultValue]).map(String)
      ])
  ))
  const [submitting, setSubmitting] = useState(false)
  const promptHtml = useMemo(() => {
    try {
      return renderSafeMarkdown(payload.prompt || '需要您确认')
    } catch {
      return renderSafeMarkdown(payload.prompt || '需要您确认')
    }
  }, [payload.prompt])

  return (
    <div
      className={styles.userInputCard}
      data-agent-user-input="true"
      data-state={interactionState}
    >
      <div className={styles.userInputTitle}>
        <IconAlertTriangle size={15} stroke={1.8} />
        需要确认
      </div>
      {!payload.native && (
        <div className={styles.userInputPrompt} dangerouslySetInnerHTML={{ __html: promptHtml }} />
      )}
      {payload.questions.map((question: any) => {
        const values = answers[question.id] || []
        const value = values[0] || ''
        return (
          <div className={styles.userInputQuestion} key={question.id}>
            {question.header && <div className={styles.userInputHeader}>{question.header}</div>}
            {payload.native && <div className={styles.userInputPrompt}>{question.question}</div>}
            {question.options.length > 0 && (
              <div className={styles.userInputOptions}>
                {question.options.map((option: any) => (
                  <button
                    key={option.label}
                    type="button"
                    className={styles.userInputOption}
                    data-selected={values.includes(option.label) ? 'true' : undefined}
                    disabled={disabled}
                    onClick={() => setAnswers((current) => {
                      const selected = current[question.id] || []
                      return {
                        ...current,
                        [question.id]: question.allowMultiple
                          ? (selected.includes(option.label)
                              ? selected.filter((entry) => entry !== option.label)
                              : [...selected, option.label])
                          : [option.label]
                      }
                    })}
                  >
                    <span>{option.label}</span>
                    {option.description && <small>{option.description}</small>}
                  </button>
                ))}
              </div>
            )}
            {(question.options.length === 0 || question.isOther) && (
              <input
                className={styles.userInputText}
                type={question.isSecret ? 'password' : 'text'}
                value={value}
                disabled={disabled}
                placeholder={question.options.length ? '其他答案' : '输入答案'}
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: [event.target.value] }))}
              />
            )}
          </div>
        )
      })}
      {interactionState === 'requested' && (
        <button
          type="button"
          className={styles.userInputSubmit}
          disabled={disabled || submitting || payload.questions.some((question: any) => (
            question.required && !(answers[question.id] || []).some((value) => String(value).trim())
          ))}
          onClick={async () => {
            const normalized = Object.fromEntries(
              Object.entries(answers)
                .map(([id, values]) => [id, { answers: values.map((value) => String(value).trim()).filter(Boolean) }])
                .filter(([, answer]) => (answer as { answers: string[] }).answers.length > 0)
            )
            setSubmitting(true)
            try {
              await onSubmit(payload, normalized)
            } catch {
              setSubmitting(false)
            }
          }}
        >
          提交
        </button>
      )}
      {resolved && (
        <div className={styles.userInputDone}>
          {selectedValue ? `已选择「${selectedValue}」` : '已选择'}
        </div>
      )}
      {interactionState === 'stopped' && (
        <div className={styles.userInputTerminal}>问题已停止，不再接受回答</div>
      )}
      {interactionState === 'error' && (
        <div className={styles.userInputTerminal}>问题已失效，不能继续回答</div>
      )}
    </div>
  )
})

function fieldKey(field: any) {
  return String(field?.expression || field?.name || field?.key || field?.field || '').trim()
}

function formatArtifactSize(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

function fieldLabel(field: any) {
  return String(field?.alias || field?.label || field?.title || fieldKey(field)).trim()
}

function tableRowsFromPayload(payload: any): any[] {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.data)) return payload.data
  if (Array.isArray(payload?.rows)) return payload.rows
  if (Array.isArray(payload?.records)) return payload.records
  return []
}

function tableFieldsFromPayload(payload: any, rows: any[]): StructuredField[] {
  const fields = Array.isArray(payload?.fields) ? payload.fields : Array.isArray(payload?.columns) ? payload.columns : []
  if (fields.length) return fields.map((field: any) => ({ key: fieldKey(field), label: fieldLabel(field) })).filter((field: any) => field.key)
  const first = rows.find((row) => row && typeof row === 'object' && !Array.isArray(row))
  return first ? Object.keys(first).map((key) => ({ key, label: key })) : []
}

function numericFields(rows: any[], fields: StructuredField[], exclude: string[] = []) {
  return fields
    .map((field) => field.key)
    .filter((key) => !exclude.includes(key))
    .filter((key) => rows.some((row) => typeof row?.[key] === 'number' || (row?.[key] !== '' && Number.isFinite(Number(row?.[key])))))
}

function inferXAxisField(rows: any[], fields: StructuredField[], yFields: string[]) {
  const firstRow = rows[0] || {}
  return (
    fields.find((field) => !yFields.includes(field.key) && typeof firstRow[field.key] !== 'number')?.key ||
    fields.find((field) => !yFields.includes(field.key))?.key ||
    fields[0]?.key ||
    ''
  )
}

function structuredDisplayType(block: Block, payload: any) {
  return String(
    payload?.display_type ||
      payload?.chart_type ||
      block.metadata?.display_type ||
      (block as any).display_type ||
      (block.type === 'table' ? 'table' : block.type === 'chart' ? 'bar' : block.type)
  )
}

function imageSourceFromStructuredBlock(block: Block, payload: any) {
  const raw =
    payload?.src ||
    payload?.url ||
    payload?.path ||
    payload?.image ||
    (typeof block.content === 'string' ? block.content.trim() : '')
  const markdownMatch = typeof raw === 'string' ? raw.match(/^!\[[^\]]*]\(([^)]+)\)$/) : null
  const src = imageSrcFromPath(markdownMatch?.[1] || String(raw || ''))
  return isRenderableImageSrc(src) ? src : ''
}

function imageCaption(block: Block, payload: any) {
  const explicit = String(payload?.title || '').trim()
  if (explicit) return explicit
  const title = String(block.title || '').trim()
  return /^(?:生成的图片|.+\s生成的图片)$/.test(title) ? '' : title
}

function canRenderStructuredBlock(block: Block) {
  const payload = parseJsonObject(block.content)
  const displayType = structuredDisplayType(block, payload)
  return block.type === 'table' || block.type === 'image' || block.type === 'audio' || block.type === 'video' || block.type === 'chart' || block.type === 'json' || isChartDisplayType(displayType)
}

const StructuredResultBlock = memo(function StructuredResultBlock({ block }: { block: Block }) {
  const payload = useMemo(() => parseJsonObject(block.content) || {}, [block.content])
  const displayType = structuredDisplayType(block, payload)
  const rows = useMemo(() => tableRowsFromPayload(payload), [payload])
  const fields = useMemo(() => tableFieldsFromPayload(payload, rows), [payload, rows])
  const [page, setPage] = useState(1)
  const pageSize = 10
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const visibleRows = rows.slice((Math.min(page, totalPages) - 1) * pageSize, Math.min(page, totalPages) * pageSize)

  const chartOption = useMemo(() => {
    if (!isChartDisplayType(displayType) || !rows.length || !fields.length) return null
    const payloadYFields = Array.isArray(payload?.y_axis_fields) ? payload.y_axis_fields.filter(Boolean) : []
    const yFields = payloadYFields.length ? payloadYFields : numericFields(rows, fields, [payload?.x_axis_field, payload?.group_field].filter(Boolean))
    const xField = payload?.x_axis_field || inferXAxisField(rows, fields, yFields)
    if (!xField || !yFields.length) return null
    return buildChartOption(
      displayType,
      {
        data: rows,
        x_axis_field: xField,
        y_axis_fields: yFields,
        group_field: payload?.group_field || null,
        title: payload?.title || block.title || ''
      },
      block.id
    )
  }, [block.id, block.title, displayType, fields, payload, rows])

  if (block.type === 'image' || displayType === 'image') {
    const src = imageSourceFromStructuredBlock(block, payload)
    if (!src) return <AssistantMarkdown content={block.content} />
    const target = artifactActionTarget(block, {
      kind: 'image',
      path: payload?.path || payload?.file_path,
      dataUrl: src
    })
    const caption = imageCaption(block, payload)
    return (
      <ArtifactActionSurface as="figure" className={styles.structuredImage} data-image-result target={target}>
        <img src={src} alt={payload?.alt || block.title || '图片'} />
        {caption && <figcaption>{caption}</figcaption>}
      </ArtifactActionSurface>
    )
  }

  if (block.type === 'audio' || displayType === 'audio') {
    const raw = String(payload?.src || payload?.url || payload?.path || payload?.file_path || block.content || '').trim()
    const src = mediaSrcFromPath(raw)
    if (!isRenderableMediaSrc(src, 'audio')) return <AssistantMarkdown content="音频地址不安全，已停止加载。" />
    const target = artifactActionTarget(block, { kind: 'audio', path: payload?.path || payload?.file_path })
    return (
      <ArtifactActionSurface as="figure" className={styles.structuredMedia} target={target}>
        <audio controls preload="metadata" src={src} />
        {(block.title || payload?.title) && <figcaption>{payload?.title || block.title}</figcaption>}
      </ArtifactActionSurface>
    )
  }

  if (block.type === 'video' || displayType === 'video') {
    const raw = String(payload?.src || payload?.url || payload?.path || payload?.file_path || block.content || '').trim()
    const src = mediaSrcFromPath(raw)
    if (!isRenderableMediaSrc(src, 'video')) return <AssistantMarkdown content="视频地址不安全，已停止加载。" />
    const target = artifactActionTarget(block, { kind: 'video', path: payload?.path || payload?.file_path })
    return (
      <ArtifactActionSurface as="figure" className={styles.structuredMedia} target={target}>
        <video controls playsInline preload="metadata" src={src} />
        {(block.title || payload?.title) && <figcaption>{payload?.title || block.title}</figcaption>}
      </ArtifactActionSurface>
    )
  }

  if (isChartDisplayType(displayType) && chartOption) {
    const target = artifactActionTarget(block, { kind: 'chart', copyText: JSON.stringify(payload, null, 2) })
    return (
      <ArtifactActionSurface className={styles.structuredBlock} target={target}>
        <div className={styles.structuredHeader}>
          <IconChartBar size={15} stroke={1.8} />
          <span>{payload?.title || block.title || '图表'}</span>
        </div>
        {payload?.fallback_hint && <div className={styles.structuredHint}>{payload.fallback_hint}</div>}
        <div className={styles.structuredChart}>
          <ReactECharts option={chartOption} notMerge lazyUpdate style={{ width: '100%', height: '100%' }} opts={{ renderer: 'canvas' }} />
        </div>
      </ArtifactActionSurface>
    )
  }

  if ((displayType === 'table' || block.type === 'table' || block.type === 'json') && rows.length && fields.length) {
    const target = artifactActionTarget(block, {
      kind: block.type === 'json' ? 'json' : 'table',
      copyText: JSON.stringify(payload, null, 2)
    })
    return (
      <ArtifactActionSurface
        className={styles.structuredBlock}
        data-scrollable={rows.length > 6 ? 'true' : 'false'}
        target={target}
      >
        <div className={styles.structuredHeader}>
          <IconTable size={15} stroke={1.8} />
          <span>{payload?.title || block.title || '表格'}</span>
          <small>{payload?.total_row_count || rows.length} 行</small>
        </div>
        {payload?.truncate_hint && <div className={styles.structuredHint}>{payload.truncate_hint}</div>}
        <div className={styles.structuredTableWrap}>
          <table className={styles.structuredTable}>
            <thead>
              <tr>
                {fields.map((field) => (
                  <th key={field.key}>{field.label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {fields.map((field) => (
                    <td key={field.key} title={String(row?.[field.key] ?? '')}>
                      {String(row?.[field.key] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {totalPages > 1 && (
          <div className={styles.structuredPager}>
            <button type="button" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1}>
              上一页
            </button>
            <span>
              {Math.min(page, totalPages)} / {totalPages}
            </span>
            <button type="button" onClick={() => setPage((value) => Math.min(totalPages, value + 1))} disabled={page >= totalPages}>
              下一页
            </button>
          </div>
        )}
      </ArtifactActionSurface>
    )
  }

  if (block.type === 'chart' || isChartDisplayType(displayType)) {
    const copyText = JSON.stringify(payload || block.content, null, 2)
    const target = artifactActionTarget(block, { kind: 'chart', copyText })
    return (
      <ArtifactActionSurface className={styles.structuredBlock} target={target}>
        <div className={styles.structuredHeader}>
          <IconPhoto size={15} stroke={1.8} />
          <span>{payload?.title || block.title || '结果'}</span>
        </div>
        <AssistantMarkdown content={`\`\`\`json\n${copyText}\n\`\`\``} />
      </ArtifactActionSurface>
    )
  }

  return <AssistantMarkdown content={block.content} />
})

const ArtifactResultBlock = memo(function ArtifactResultBlock({ block }: { block: Block }) {
  const payload = useMemo(() => parseJsonObject(block.content) || {}, [block.content])
  const path = String(payload.path || block.content || '').trim()
  const name = String(payload.name || block.title || path.split('/').pop() || '产物')
  const attachment: Attachment = {
    path,
    name,
    mimeType: String(payload.mime_type || ''),
    size: Number(payload.size_bytes || 0) || undefined,
    artifactId: String(payload.artifact_id || block.metadata?.artifact_id || '') || undefined,
    artifactVersionId: String(payload.artifact_version_id || block.metadata?.artifact_version_id || '') || undefined,
    artifactVersionNumber: Number(payload.artifact_version_number || 0) || undefined
  }
  const target = artifactActionTarget(block, { kind: String(payload.kind || 'file'), path })
  return (
    <ArtifactActionSurface className={styles.artifactResultCard} data-deliverable-file={attachment.artifactId || name} target={target}>
      <AttachmentPreview attachment={attachment} />
      <div className={styles.artifactResultMeta}>
        <span>{payload.kind || '文件'}</span>
        {attachment.size ? <span>{formatArtifactSize(attachment.size)}</span> : null}
        {attachment.artifactVersionNumber ? <span>v{attachment.artifactVersionNumber}</span> : null}
      </div>
      <div className={styles.artifactResultActions}>
        {target.actions.includes('open') && (
          <button type="button" onClick={() => void executeArtifactAction(target, 'open')}>打开</button>
        )}
        {target.actions.includes('reveal') && (
          <button type="button" onClick={() => void executeArtifactAction(target, 'reveal')}>显示</button>
        )}
      </div>
    </ArtifactActionSurface>
  )
})

const PluginHtmlResultBlock = memo(function PluginHtmlResultBlock({ block }: { block: Block }) {
  const html = useMemo(() => sanitizePluginHtmlDocument(block.content), [block.content])
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [downloading, setDownloading] = useState(false)
  const outputArtifact = block.metadata?.output_artifact
  const downloadablePdf = outputArtifact?.materialization === 'client-download'
    && outputArtifact?.format === 'application/pdf'
  const target = artifactActionTarget(block, {
    kind: 'pdf',
    materialization: outputArtifact?.materialization
  })

  const downloadPdf = async () => {
    if (!downloadablePdf || downloading) return
    const body = iframeRef.current?.contentDocument?.body
    if (!body) {
      notifications.show({ color: 'red', message: 'PDF 预览尚未准备好，请稍后重试' })
      return
    }
    setDownloading(true)
    try {
      await iframeRef.current?.contentDocument?.fonts?.ready
      const { default: html2pdf } = await import('html2pdf.js')
      const title = String(outputArtifact?.title || block.title || '文档')
      const filename = `${title.replace(/[\\/:*?"<>|]+/g, '-').trim() || '文档'}.pdf`
      await html2pdf().set({
        margin: [10, 10, 10, 10],
        filename,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', logging: false },
        jsPDF: {
          unit: 'mm',
          format: 'a4',
          orientation: block.metadata?.plugin_options?.orientation === 'portrait' ? 'portrait' : 'landscape'
        },
        pagebreak: { mode: ['css', 'legacy'] }
      } as any).from(body).save()
    } catch {
      notifications.show({ color: 'red', message: 'PDF 下载失败，请重试' })
    } finally {
      setDownloading(false)
    }
  }
  const downloadActions = { download: downloadPdf }
  return (
    <ArtifactActionSurface
      className={styles.pluginHtmlResult}
      data-plugin-renderer="html-document"
      target={target}
      extraActions={downloadActions}
    >
      <div className={styles.structuredHeader}>
        <IconFile size={15} stroke={1.8} />
        <span>{block.title || '文档预览'}</span>
        {downloadablePdf && (
          <button type="button" disabled={downloading} onClick={() => void executeArtifactAction(target, 'download', downloadActions)}>
            <IconDownload size={14} stroke={1.8} />
            {downloading ? '生成中…' : '下载 PDF'}
          </button>
        )}
      </div>
      <iframe ref={iframeRef} title={block.title || '文档预览'} srcDoc={html} sandbox="allow-same-origin" />
    </ArtifactActionSurface>
  )
})


type BlockViewProps = {
  block: Block
  busy: boolean
  turnStatus?: Msg['status']
  expanded?: boolean
  groupedProcess?: boolean
  showThinking: boolean
  showTodo: boolean
  decision?: 'approved' | 'rejected'
  onDecide: (toolCallId: string, decision: ApprovalDecision, request?: any) => void
  onToggleExpand: (id: string, currentExpanded?: boolean) => void
  onReviewChanges: () => void
  threadId?: string | null
  workspaceAction?: NonNullable<Msg['workspaceActions']>[string]
  canMutateWorkspace: boolean
  reverting?: boolean
  onRevertChange: () => void
  onSubmitUserInput: (
    payload: ReturnType<typeof parseUserInputPayload>,
    answers: Record<string, { answers: string[] }>
  ) => Promise<void>
  onOpenConversation?: (conversationId: string) => void
  onOpenFileReference?: (target: FileReferenceOpenTarget) => void | Promise<void>
  canInteractGenerativeUi: boolean
  onGenerativeUiAction: (message: string) => Promise<void>
  webSources?: WebSource[]
}

export type ApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | 'acceptAlways'
  | 'decline'
  | 'cancel'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: string[] } }
  | { applyNetworkPolicyAmendment: { network_policy_amendment: { host: string; action: 'allow' | 'deny' } } }

function approvalDecisionKind(decision: unknown): string {
  if (typeof decision === 'string') return decision
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return ''
  if ('acceptWithExecpolicyAmendment' in decision) return 'acceptWithExecpolicyAmendment'
  if ('applyNetworkPolicyAmendment' in decision) return 'applyNetworkPolicyAmendment'
  return ''
}

export function isAcceptedApprovalDecision(decision: ApprovalDecision): boolean {
  const kind = approvalDecisionKind(decision)
  if (['accept', 'acceptForSession', 'acceptAlways', 'acceptWithExecpolicyAmendment'].includes(kind)) return true
  return kind === 'applyNetworkPolicyAmendment'
    && typeof decision === 'object'
    && 'applyNetworkPolicyAmendment' in decision
    && decision.applyNetworkPolicyAmendment.network_policy_amendment?.action === 'allow'
}

export const BlockView = memo(
  function BlockView({
    block: b,
    busy,
    turnStatus,
    expanded,
    groupedProcess,
    showThinking,
    showTodo,
    decision,
    onDecide,
    onToggleExpand,
    onReviewChanges,
    threadId,
    workspaceAction,
    canMutateWorkspace,
    reverting,
    onRevertChange,
    onSubmitUserInput,
    onOpenConversation,
    onOpenFileReference,
    canInteractGenerativeUi,
    onGenerativeUiAction,
    webSources = []
  }: BlockViewProps) {
    if (b.type === 'compact') {
      const state = activityState(b.title, busy)
      const running = state === 'running'
      return (
        <div
          className={styles.compactRow}
          data-running={running ? 'true' : 'false'}
          data-state={state}
          role="status"
        >
          <span className={styles.compactLine} />
          <span className={styles.compactLabel}>
            {running ? '压缩上下文中…' : state === 'stopped' ? '上下文压缩已停止' : b.content || '上下文已压缩'}
          </span>
          <span className={styles.compactLine} />
        </div>
      )
    }
    if (b.type === 'confirm') {
      const tcid = b.id.replace(/^confirm:/, '')
      const request = b.metadata?.approval_request
      const sandbox = request?.sandbox
      const riskLabel: Record<string, string> = {
        command_execution: '执行命令',
        file_write: '修改文件',
        product_write: '修改产品数据',
        external_data: '访问外部服务',
        local_read: '本地只读',
        external_read: '外部只读',
        local_write: '本地写入',
        external_write: '外部写入',
        data_egress: '数据外发',
        high_risk_execution: '高风险执行',
        tool_action: '执行工具'
      }
      const sandboxLabel = sandbox
        ? sandbox.system_enforced
          ? `系统沙箱 · 仅授权目录可写 · ${sandbox.network === 'blocked' ? '禁止联网' : '允许联网'}`
          : '应用级限制（未启用系统沙箱）'
        : request?.network === 'external_tool'
          ? '外部工具执行，不受本地沙箱保护'
          : ''
      const state = approvalInteractionState(b.title, b.metadata?.status, decision, turnStatus)
      const stateLabel = state === 'approved'
        ? '已确认'
        : state === 'rejected'
          ? '已拒绝'
          : state === 'stopped'
            ? '确认已停止'
            : state === 'error'
              ? '确认失败'
              : ''
      const availableDecisions = Array.isArray(request?.availableDecisions)
        ? request.availableDecisions as ApprovalDecision[]
        : null
      const hasDecision = (kind: string) => availableDecisions
        ? availableDecisions.some((entry) => approvalDecisionKind(entry) === kind)
        : ['accept', 'decline'].includes(kind)
      const amendmentDecisions = (availableDecisions || []).filter((entry) => (
        ['acceptWithExecpolicyAmendment', 'applyNetworkPolicyAmendment'].includes(approvalDecisionKind(entry))
      ))
      return (
        <div
          className={styles.govCard}
          data-agent-approval="true"
          data-state={state}
        >
          <div className={styles.govHd}>
            <IconAlertTriangle size={15} stroke={1.8} />
            {request?.kind === 'mcp_tool_call' ? '需要确认 · 外部工具' : '需要确认 · 写入 / 执行'}
          </div>
          <div className={styles.govBody}>
            <code>{b.content}</code>
          </div>
          {request && (
            <div className={styles.govMeta}>
              <span>{riskLabel[request.risk] || '执行操作'}</span>
              {request.target && <span title={request.target}>目标：{request.target}</span>}
              {Array.isArray(request.sending_fields) && request.sending_fields.length > 0 && (
                <span title={request.sending_fields.join(', ')}>发送字段：{request.sending_fields.join(', ')}</span>
              )}
              {Array.isArray(request.permissionSummary) && request.permissionSummary.length > 0 && (
                <span title={request.permissionSummary.join('\n')}>申请权限：{request.permissionSummary.join('；')}</span>
              )}
              {Array.isArray(request.policySummary) && request.policySummary.length > 0 && (
                <span title={request.policySummary.join('\n')}>将记住：{request.policySummary.join('；')}</span>
              )}
              {sandboxLabel && <span>{sandboxLabel}</span>}
            </div>
          )}
          {state !== 'requested' ? (
            <div className={state === 'approved' ? styles.govApproved : state === 'stopped' ? styles.govStopped : styles.govRejected}>
              {stateLabel}
            </div>
          ) : (
            <div className={styles.govBtns}>
              {hasDecision('accept') && (
                <button className={styles.govOk} onClick={() => onDecide(tcid, 'accept', request)}>
                  本次允许
                </button>
              )}
              {hasDecision('acceptForSession') && (
                <button className={styles.govRemember} onClick={() => onDecide(tcid, 'acceptForSession', request)}>
                  本会话允许
                </button>
              )}
              {hasDecision('acceptAlways') && (
                <button className={styles.govRemember} onClick={() => onDecide(tcid, 'acceptAlways', request)}>
                  始终允许
                </button>
              )}
              {amendmentDecisions.map((entry, index) => {
                const kind = approvalDecisionKind(entry)
                const action = typeof entry === 'object' && 'applyNetworkPolicyAmendment' in entry
                  ? entry.applyNetworkPolicyAmendment.network_policy_amendment?.action
                  : null
                return (
                  <button
                    key={`${kind}:${index}`}
                    className={action === 'deny' ? styles.govNo : styles.govRemember}
                    onClick={() => onDecide(tcid, entry, request)}
                  >
                    {kind === 'acceptWithExecpolicyAmendment'
                      ? '允许并记住类似命令'
                      : action === 'deny' ? '拒绝并记住此网络规则' : '允许并记住此网络规则'}
                  </button>
                )
              })}
              {hasDecision('decline') && (
                <button className={styles.govNo} onClick={() => onDecide(tcid, 'decline', request)}>
                  拒绝
                </button>
              )}
              {hasDecision('cancel') && (
                <button className={styles.govNo} onClick={() => onDecide(tcid, 'cancel', request)}>
                  拒绝并停止
                </button>
              )}
            </div>
          )}
        </div>
      )
    }
    if (b.type === 'user_input') {
      const payload = parseUserInputPayload(b.content)
      const interactionState = userInputInteractionState(b.title, b.metadata?.status, turnStatus)
      const selectedValue = resolvedUserInputLabel(payload, b.metadata?.response)
      return (
        <UserInputBlock
          block={b}
          interactionState={interactionState}
          selectedValue={selectedValue}
          onSubmit={onSubmitUserInput}
        />
      )
    }
    if (b.type === 'action') {
      const { target, label, description, href, externalHost } = resolveAgentAction(parseJsonObject(b.content))
      const openExternalAction = async () => {
        if (!href || target !== 'mcp_authorization') return
        const api = (window as any).electronAPI
        if (typeof api?.openExternalUrl === 'function') {
          await api.openExternalUrl(href)
          return
        }
        window.open(href, '_blank', 'noopener,noreferrer')
      }
      return (
        <section className={styles.actionCard} data-action-target={target || undefined}>
          <div className={styles.actionCopy}>
            <strong>{b.title || '需要完成设置'}</strong>
            <span>{description}</span>
            {externalHost && <code>{externalHost}</code>}
          </div>
          {href && target === 'mcp_authorization' ? (
            <button type="button" className={styles.actionLink} onClick={openExternalAction}>
              {label}
            </button>
          ) : href ? (
            <a className={styles.actionLink} href={href}>
              {label}
            </a>
          ) : (
            <span className={styles.actionLabel}>{label}</span>
          )}
        </section>
      )
    }
    if (b.type === 'status') {
      const rawStatus = b.metadata?.status || b.title
      const state = activityState(rawStatus, busy)
      const wasRunning = ['running', 'inprogress', 'in_progress'].includes(String(rawStatus || '').toLowerCase())
      const content = state === 'stopped' && wasRunning
        ? b.metadata?.item_type === 'imageGeneration'
          ? '图片生成已停止'
          : b.metadata?.item_type === 'sleep'
            ? '等待已停止'
            : '操作已停止'
        : b.content
      return (
        <div className={styles.runtimeStatusRow} data-state={state} role="status">
          {state === 'running'
            ? <span className={styles.typing} />
            : state === 'done'
              ? <IconCheck size={13} stroke={2.2} />
              : <IconX size={13} stroke={2.2} />}
          <span>{content || b.title || activityStateLabel(state)}</span>
        </div>
      )
    }
    if (b.type === 'thinking') {
      if (!showThinking) return null
      const thinkingExpanded = resolveThinkingExpanded(expanded, busy, Boolean(groupedProcess))
      return (
        <div
          className={styles.thinkingBlock}
          data-agent-block="thinking"
          data-expanded={thinkingExpanded ? 'true' : 'false'}
          data-grouped={groupedProcess ? 'true' : 'false'}
        >
          <button
            type="button"
            className={styles.thinkingHead}
            aria-expanded={thinkingExpanded}
            onClick={() => onToggleExpand(b.id, thinkingExpanded)}
          >
            <IconChevronRight
              size={13}
              className={thinkingExpanded ? styles.trChevOpen : styles.trChev}
            />
            <IconBrain size={15} stroke={1.7} className={styles.thinkingIcon} />
            <span className={styles.thinkingTitle}>{groupedProcess ? '思考' : busy ? '思考中' : '思考'}</span>
            {busy && !groupedProcess && <span className={styles.typing} />}
            <span className={styles.trHint}>{thinkingExpanded ? '收起' : '展开'}</span>
          </button>
          {thinkingExpanded && <div className={styles.thinkingBody}>{b.content}</div>}
        </div>
      )
    }
    if (b.type === 'evidence_validation') {
      const validation = queryValidationPresentation(b.metadata?.validation_ref || b.content, b.title)
      const detailId = `${b.id}:technical-details`
      return (
        <section
          className={styles.queryValidation}
          data-query-validation
          data-tone={validation.tone}
        >
          <button
            type="button"
            className={styles.queryValidationSummary}
            aria-expanded={Boolean(expanded)}
            aria-controls={detailId}
            onClick={() => onToggleExpand(b.id, Boolean(expanded))}
          >
            <span className={styles.queryValidationIcon} aria-hidden="true">
              {validation.tone === 'ok'
                ? <IconCheck size={14} stroke={2.2} />
                : <IconAlertTriangle size={14} stroke={1.9} />}
            </span>
            <span className={styles.queryValidationCopy}>
              <strong>{validation.title}</strong>
              <small>{validation.scopeLabel} · {validation.summary}</small>
            </span>
            <span className={styles.queryValidationHint}>{expanded ? '收起' : '技术详情'}</span>
            <IconChevronRight
              size={13}
              className={expanded ? styles.trChevOpen : styles.trChev}
            />
          </button>
          {validation.issueSummary && (
            <div className={styles.queryValidationIssue}>{validation.issueSummary}</div>
          )}
          {expanded && (
            <div id={detailId} className={styles.queryValidationDetails}>
              <div>原始检查记录</div>
              <pre>{validation.rawJson}</pre>
            </div>
          )}
        </section>
      )
    }
    if (b.type === 'subtask' || b.type === 'delegated_subtask') {
      const payload = parseJsonObject(b.content) || {}
      const state = activityState(b.title || payload.status, busy)
      const taskTitle = b.metadata?.subtask_title || payload.title || '子任务'
      const childThreadIds = Array.isArray(payload.child_thread_ids) ? payload.child_thread_ids : []
      const detail = b.type === 'delegated_subtask'
        ? payload.summary || payload.error || ''
        : b.content
      return (
        <div
          className={styles.subtaskRow}
          data-status={state}
          data-native-collaboration={payload.source === 'app-server' ? 'true' : undefined}
        >
          <IconChartBar size={14} stroke={1.7} className={styles.subtaskIcon} />
          <span className={styles.subtaskName}>{taskTitle}</span>
          {childThreadIds.length > 0 && <code>{childThreadIds.length} 个子任务</code>}
          {b.metadata?.tool_name || payload.tool_name ? (
            <code>{b.metadata?.tool_name || payload.tool_name}</code>
          ) : null}
          {detail && <span className={styles.subtaskSummary}>{detail}</span>}
          <span className={styles.toolStatus} aria-label={activityStateLabel(state)} title={activityStateLabel(state)}>
            {state === 'running' ? (
              <span className={styles.typing} />
            ) : state === 'error' || state === 'rejected' || state === 'stopped' ? (
              <IconX size={13} stroke={2.2} />
            ) : (
              <IconCheck size={13} stroke={2.2} />
            )}
            <small>{activityStateLabel(state)}</small>
          </span>
        </div>
      )
    }
    if (b.type === 'tool') {
      const state = activityState(b.title, busy)
      const callView = b.metadata?.dshCallView || (b.metadata?.dshView?.for === 'call' ? b.metadata.dshView : null)
      const resultView = b.metadata?.dshResultView || (b.metadata?.dshView?.for === 'result' ? b.metadata.dshView : null)
      const dshView = resultView || callView
      const diffView = resultView?.view?.card === 'diff' ? resultView : callView?.view?.card === 'diff' ? callView : null
      const card = diffView?.view?.card
      // A `diff` call card reuses the existing FileChangeCard: adapt the DSH
      // FileDiff[] into the { changes } payload the diff card already reads.
      if (card === 'diff' && Array.isArray(diffView?.view?.diffs) && diffView.view.diffs.length > 0) {
        const diffBlock = diffViewToolBlock(b, diffView.view.diffs, b.title || 'done')
        return (
          <FileChangeCard
            block={diffBlock}
            turnRunning={busy}
            action={workspaceAction}
            canRevert={canMutateWorkspace}
            reverting={reverting}
            onReview={onReviewChanges}
            onRevert={onRevertChange}
          />
        )
      }
      // generic / terminal / unknown / no-view: the standard tool row. The
      // label now comes from the DSH presenter's title (via dshView) when
      // present, falling back to the tool-name table only when it does not.
      const tool = toolCallPresentation(b.content, b.metadata?.tool_name, dshView)
      const resultBody = dshResultBody(resultView?.view, String(b.metadata?.resultText || ''))
      const hasDetails = Boolean(tool.rawArguments || resultBody)
      const detailId = `${b.id}:arguments`
      return (
        <div
          className={styles.toolCall}
          data-agent-block="tool"
          data-tool-name={b.metadata?.tool_name || undefined}
          data-state={state}
        >
          <div className={styles.blkTool}>
            <IconTerminal2 size={14} stroke={1.7} className={styles.toolIcon} />
            <span className={styles.toolName}>{tool.label}</span>
            {tool.summary && <span className={styles.toolSummary} title={tool.summary}>{tool.summary}</span>}
            {hasDetails && (
              <button
                type="button"
                className={styles.toolDetailsToggle}
                aria-expanded={Boolean(expanded)}
                aria-controls={detailId}
                onClick={() => onToggleExpand(b.id, Boolean(expanded))}
              >
                <IconChevronRight
                  size={12}
                  className={expanded ? styles.trChevOpen : styles.trChev}
                />
                <span>{expanded ? '收起' : resultBody ? '结果' : '参数'}</span>
              </button>
            )}
            <span className={styles.toolStatus} aria-label={activityStateLabel(state)} title={activityStateLabel(state)}>
              {state === 'running' ? (
                <span className={styles.typing} />
              ) : state === 'error' || state === 'rejected' || state === 'stopped' ? (
                <IconX size={13} stroke={2.2} />
              ) : (
                <IconCheck size={13} stroke={2.2} />
              )}
              <small>{activityStateLabel(state)}</small>
            </span>
          </div>
          {expanded && hasDetails && (
            <div id={detailId}>
              {tool.rawArguments && <pre className={styles.toolArguments}>{tool.rawArguments}</pre>}
              {resultBody && resultBody.kind === 'code'
                ? <CodeView code={resultBody.text} max={360} />
                : resultBody ? <pre className={styles.toolArguments}>{resultBody.text}</pre> : null}
            </div>
          )}
        </div>
      )
    }
    if (b.type === 'file_change') {
      return (
        <FileChangeCard
          block={b}
          turnRunning={busy}
          action={workspaceAction}
          canRevert={canMutateWorkspace}
          reverting={reverting}
          onReview={onReviewChanges}
          onRevert={onRevertChange}
        />
      )
    }
    if (b.type === 'tool_result') {
      return (
        <div className={styles.toolResult}>
          <div className={styles.trHead} onClick={() => onToggleExpand(b.id, Boolean(expanded))}>
            <IconChevronRight size={13} className={expanded ? styles.trChevOpen : styles.trChev} />
            <span className={styles.trName}>{b.title} 结果</span>
            <span className={styles.trHint}>{expanded ? '收起' : '展开'}</span>
          </div>
          {expanded &&
            (b.title === 'read' ? (
              <CodeView code={b.content} max={320} />
            ) : (
              <pre className={styles.trBody}>
                {b.title === 'edit' || b.title === 'write'
                  ? b.content.split('\n').map((ln, i) => (
                      <div
                        key={i}
                        className={
                          ln.startsWith('+')
                            ? styles.diffAdd
                            : ln.startsWith('-')
                              ? styles.diffDel
                              : undefined
                        }
                      >
                        {ln || ' '}
                      </div>
                    ))
                  : b.content}
              </pre>
            ))}
        </div>
      )
    }
    if (b.type === 'error') {
      return <div className={styles.blkErr}>{visibleAgentError(b.content)}</div>
    }
    if (b.type === 'project_memory') {
      // Older messages may still contain this block. Keep it silent.
      return null
    }
    if (b.type === 'global_memory') {
      const memory = globalMemoryFromBlock(b)
      const count = memory.entries.length + memory.conversations.length
      if (!count) return null
      const countLabel = [
        memory.entries.length ? `${memory.entries.length} 条记忆` : '',
        memory.conversations.length ? `${memory.conversations.length} 个对话` : '',
      ].filter(Boolean).join(' · ')
      return (
        <details
          className={styles.projectMemoryCard}
          data-global-memory
          title="查看提供给本轮回答的本机记忆"
        >
          <summary>
            <IconHistory size={15} stroke={1.8} />
            <strong>已提供本机记忆</strong>
            <span>{countLabel}</span>
            <IconChevronRight size={13} className={styles.projectMemoryChevron} />
          </summary>
          <div className={styles.projectMemorySources}>
            <p className={styles.projectMemoryDisclosure}>
              这些内容作为个性化参考提供给模型，回答不一定逐项采用。
            </p>
            {memory.entries.map((entry) => (
              <div
                key={entry.id}
                className={`${styles.projectMemorySource} ${styles.globalMemoryEntry}`}
                data-global-memory-entry
              >
                <strong>已保存记忆</strong>
                <span>{entry.content}</span>
              </div>
            ))}
            {memory.conversations.map((source) => (
              <button
                type="button"
                key={source.session_id}
                className={styles.projectMemorySource}
                title={`打开对话：${source.title}`}
                aria-label={`打开来源对话：${source.title}`}
                data-global-memory-conversation
                onClick={() => onOpenConversation?.(source.session_id)}
                disabled={!onOpenConversation}
              >
                <strong>{source.title}</strong>
                {source.snippet && <span>{source.snippet}</span>}
              </button>
            ))}
          </div>
        </details>
      )
    }
    if (b.type === 'web_sources') {
      const sources = webSourcesFromBlock(b)
      if (!sources.length) return null
      return (
        <section className={styles.webSources} data-web-sources>
          <div className={styles.webSourcesTitle}>
            <IconWorldSearch size={15} stroke={1.8} />
            <strong>来源</strong>
            <span>{sources.length}</span>
          </div>
          <div className={styles.webSourcesList}>
            {sources.map((source) => (
              <a
                key={source.source_id}
                id={`dsh-web-source-${source.source_id}`}
                href={source.url}
                target="_blank"
                rel="noreferrer"
                title={source.excerpt || source.url}
              >
                <span className={styles.webSourceId}>{source.source_id}</span>
                <span className={styles.webSourceCopy}>
                  <strong>{source.title || source.url}</strong>
                  <small>{source.site_name || source.url} · {source.published_at || source.accessed_at || '本轮访问'}</small>
                </span>
              </a>
            ))}
          </div>
        </section>
      )
    }
    if (b.type === 'generative_ui') {
      return (
        <GenerativeUiBlock
          block={b}
          canInteract={canInteractGenerativeUi}
          onAction={onGenerativeUiAction}
        />
      )
    }
    if (b.type === 'file') {
      return <ArtifactResultBlock block={b} />
    }
    if (b.type === 'html' && b.metadata?.plugin_renderer === 'html-document') {
      return <PluginHtmlResultBlock block={b} />
    }
    if (canRenderStructuredBlock(b)) {
      return <StructuredResultBlock block={b} />
    }
    const evidenceRef = parseJsonObject(b.metadata?.evidence_bundle_ref) || b.metadata?.evidence_bundle_ref
    return (
      <>
        <AssistantMarkdown
          content={b.content}
          annotations={Array.isArray(b.metadata?.annotations) ? b.metadata.annotations : []}
          webSources={webSources}
          threadId={threadId}
          canOpenLocalFile={canMutateWorkspace}
          onOpenFileReference={onOpenFileReference}
        />
        {evidenceRef?.id && (
          <EvidenceCard
            evidenceRef={evidenceRef}
            expanded={Boolean(expanded)}
            onExpandedChange={() => onToggleExpand(b.id, Boolean(expanded))}
          />
        )}
      </>
    )
  },
  (prev, next) =>
    prev.block === next.block &&
    prev.busy === next.busy &&
    prev.turnStatus === next.turnStatus &&
    prev.expanded === next.expanded &&
    prev.groupedProcess === next.groupedProcess &&
    prev.showThinking === next.showThinking &&
    prev.showTodo === next.showTodo &&
    prev.decision === next.decision &&
    prev.workspaceAction === next.workspaceAction &&
    prev.canMutateWorkspace === next.canMutateWorkspace &&
    prev.reverting === next.reverting
    && prev.canInteractGenerativeUi === next.canInteractGenerativeUi
    && prev.onGenerativeUiAction === next.onGenerativeUiAction
    && prev.webSources === next.webSources
)
