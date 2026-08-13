// Global search panel (⌘K): search projects, conversations and authorized local files.
// Project rows come from AgentShell memory; body and file matches come from the local backend.
// Rendered through .dsh-root (in theme scope, not scaled by .dsh-zoom); Esc / click outside to close.
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconArchive, IconFile, IconFolder, IconMessage, IconSearch, IconWorldSearch } from '@tabler/icons-react'
import AppSelect from '@/components/AppSelect'
import {
  searchAgentConversations,
  searchAgentArtifacts,
  searchAgentFiles,
  searchAgentWebSources,
  type AgentConversationSearchResult,
  type AgentFileSearchResult,
  type AgentSearchFilters,
  type AgentWebSourceSearchResult,
  type ProjectArtifact
} from '@/api/agent'
import styles from './agent.module.scss'

export interface SearchWorkspace {
  id: string
  name: string
}

export interface SearchPaletteProps {
  workspaces?: SearchWorkspace[]
  convByWs?: Record<string, { id: string; title: string; updated_at?: string | null }[]>
  onClose?: () => void
  onSelect?: (wsId: string, convId?: string) => void
  onSelectFile?: (file: AgentFileSearchResult) => void
  onSelectArtifact?: (artifact: ProjectArtifact) => void
}

interface FlatItem {
  key: string
  kind: 'workspace' | 'conv' | 'file' | 'artifact' | 'web'
  title: string
  wsId: string
  convId?: string
  wsName: string
  snippet?: string
  archived?: boolean
  updatedAt?: string | null
  file?: AgentFileSearchResult
  artifact?: ProjectArtifact
  web?: AgentWebSourceSearchResult
}

const wsKindLabel = (id: string) => (id === '__chat__' ? '聊天' : '项目')
type ResultKind = 'all' | 'workspace' | 'conv' | 'file' | 'artifact' | 'web'
type TimeRange = 'all' | 'day' | 'week' | 'month'
const RESULT_KIND_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'workspace', label: '项目' },
  { value: 'conv', label: '对话' },
  { value: 'file', label: '文件' },
  { value: 'artifact', label: '产物' },
  { value: 'web', label: '网页来源' }
] as const
const TIME_RANGE_OPTIONS = [
  { value: 'all', label: '不限' },
  { value: 'day', label: '24 小时' },
  { value: 'week', label: '7 天' },
  { value: 'month', label: '30 天' }
] as const

function sinceForRange(range: TimeRange) {
  if (range === 'all') return undefined
  const days = range === 'day' ? 1 : range === 'week' ? 7 : 30
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
}

export default function SearchPalette({
  workspaces = [],
  convByWs = {},
  onClose,
  onSelect,
  onSelectFile,
  onSelectArtifact
}: SearchPaletteProps) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [conversationResults, setConversationResults] = useState<AgentConversationSearchResult[]>([])
  const [fileResults, setFileResults] = useState<AgentFileSearchResult[]>([])
  const [artifactResults, setArtifactResults] = useState<ProjectArtifact[]>([])
  const [webResults, setWebResults] = useState<AgentWebSourceSearchResult[]>([])
  const [resultKind, setResultKind] = useState<ResultKind>('all')
  const [projectFilter, setProjectFilter] = useState('__all__')
  const [timeRange, setTimeRange] = useState<TimeRange>('all')
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [remoteError, setRemoteError] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const requestVersion = useRef(0)

  // Flatten: workspaces + all child conversations, each with workspace name for subtitle display.
  const flat = useMemo<FlatItem[]>(() => {
    const out: FlatItem[] = []
    for (const ws of workspaces) {
      out.push({ key: `ws:${ws.id}`, kind: 'workspace', title: ws.name, wsId: ws.id, wsName: ws.name })
      for (const c of convByWs[ws.id] || []) {
        out.push({
          key: `conv:${ws.id}:${c.id}`,
          kind: 'conv',
          title: c.title || '新对话',
          wsId: ws.id,
          convId: c.id,
          wsName: ws.name,
          updatedAt: c.updated_at
        })
      }
    }
    return out
  }, [workspaces, convByWs])

  const workspaceNames = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces]
  )

  useEffect(() => {
    const keyword = q.trim()
    const version = ++requestVersion.current
    setConversationResults([])
    setFileResults([])
    setArtifactResults([])
    setWebResults([])
    setRemoteError(false)
    if (!keyword) {
      setRemoteLoading(false)
      return undefined
    }

    const searchConversations = resultKind === 'all' || resultKind === 'conv'
    const searchFiles = resultKind === 'all' || resultKind === 'file'
    const searchArtifacts = resultKind === 'all' || resultKind === 'artifact'
    const searchWeb = resultKind === 'all' || resultKind === 'web'
    if (!searchConversations && !searchFiles && !searchArtifacts && !searchWeb) {
      setRemoteLoading(false)
      return undefined
    }

    setRemoteLoading(true)
    const timer = window.setTimeout(async () => {
      try {
        const filters: AgentSearchFilters = {
          ...(projectFilter !== '__all__' ? { projectId: projectFilter } : {}),
          ...(sinceForRange(timeRange) ? { since: sinceForRange(timeRange) } : {})
        }
        const [conversationResponse, fileResponse, artifactResponse, webResponse] = await Promise.allSettled([
          searchConversations ? searchAgentConversations(keyword, 60, filters) : Promise.resolve(null),
          searchFiles ? searchAgentFiles(keyword, 60, filters) : Promise.resolve(null),
          searchArtifacts ? searchAgentArtifacts(keyword, 60, filters) : Promise.resolve(null),
          searchWeb ? searchAgentWebSources(keyword, 50, filters) : Promise.resolve(null)
        ])
        if (requestVersion.current !== version) return
        const conversations = conversationResponse.status === 'fulfilled'
          ? (conversationResponse.value as any)?.data?.items || (conversationResponse.value as any)?.items || []
          : []
        const files = fileResponse.status === 'fulfilled'
          ? (fileResponse.value as any)?.data?.items || (fileResponse.value as any)?.items || []
          : []
        const artifacts = artifactResponse.status === 'fulfilled'
          ? (artifactResponse.value as any)?.data?.items || (artifactResponse.value as any)?.items || []
          : []
        const webSources = webResponse.status === 'fulfilled'
          ? (webResponse.value as any)?.data?.items || (webResponse.value as any)?.items || []
          : []
        setConversationResults(Array.isArray(conversations) ? conversations : [])
        setFileResults(Array.isArray(files) ? files : [])
        setArtifactResults(Array.isArray(artifacts) ? artifacts : [])
        setWebResults(Array.isArray(webSources) ? webSources : [])
        setRemoteError(
          conversationResponse.status === 'rejected'
          || fileResponse.status === 'rejected'
          || artifactResponse.status === 'rejected'
          || webResponse.status === 'rejected'
          || Boolean((fileResponse.status === 'fulfilled' ? (fileResponse.value as any)?.data?.partial : false))
        )
      } catch {
        if (requestVersion.current === version) setRemoteError(true)
      } finally {
        if (requestVersion.current === version) setRemoteLoading(false)
      }
    }, 180)

    return () => {
      window.clearTimeout(timer)
      if (requestVersion.current === version) requestVersion.current += 1
    }
  }, [projectFilter, q, resultKind, timeRange])

  const results = useMemo<FlatItem[]>(() => {
    const kw = q.trim().toLowerCase()
    const since = sinceForRange(timeRange)
    const sinceTime = since ? Date.parse(since) : null
    const filteredFlat = flat.filter((item) => (
      (projectFilter === '__all__' || item.wsId === projectFilter)
      && (resultKind === 'all' || resultKind === item.kind)
      && (
        sinceTime == null
        || (item.kind === 'conv' && Number.isFinite(Date.parse(String(item.updatedAt || '')))
          && Date.parse(String(item.updatedAt)) >= sinceTime)
      )
    ))
    if (!kw) return filteredFlat.slice(0, 50) // Empty query: show first 50 items to avoid large-list lag.
    const localMatches = filteredFlat.filter(
      (item) => item.title.toLowerCase().includes(kw) || item.wsName.toLowerCase().includes(kw)
    )
    const merged = new Map<string, FlatItem>()
    const add = (item: FlatItem) => {
      if (!merged.has(item.key)) merged.set(item.key, item)
    }

    // Matching projects remain first. Remote results then add body snippets and
    // archived conversations that are not present in the navigation cache.
    localMatches.filter((item) => item.kind === 'workspace').forEach(add)
    conversationResults.forEach((item) => add({
      key: `conv:${item.project_id}:${item.session_id}`,
      kind: 'conv',
      title: item.title || '新对话',
      wsId: item.project_id,
      convId: item.session_id,
      wsName: item.project_name || workspaceNames.get(item.project_id) || '项目',
      snippet: item.snippet || undefined,
      archived: item.status === 'archived'
    }))
    fileResults.forEach((file) => add({
      key: `file:${file.project_id}:${file.session_id || ''}:${file.root_id}:${file.path}`,
      kind: 'file',
      title: file.name,
      wsId: file.project_id,
      convId: file.session_id || undefined,
      wsName: file.project_name || workspaceNames.get(file.project_id) || '项目',
      snippet: file.snippet
        ? `${file.path}${file.line_number ? `:${file.line_number}` : ''} · ${file.snippet}`
        : file.path,
      file
    }))
    artifactResults.forEach((artifact) => add({
      key: `artifact:${artifact.project_id}:${artifact.id}`,
      kind: 'artifact',
      title: artifact.name,
      wsId: artifact.project_id,
      convId: artifact.current_version?.source_session_id || undefined,
      wsName: artifact.project_name || workspaceNames.get(artifact.project_id) || '项目',
      snippet: artifact.description || artifact.current_version?.change_summary || `v${artifact.current_version?.version_number || 0}`,
      updatedAt: artifact.current_version?.created_at || artifact.updated_at,
      artifact
    }))
    webResults.forEach((web) => add({
      key: `web:${web.session_id}:${web.canonical_url || web.url}`,
      kind: 'web',
      title: web.title || web.url,
      wsId: web.project_id,
      convId: web.session_id,
      wsName: web.project_name || workspaceNames.get(web.project_id) || '项目',
      snippet: web.excerpt || web.url,
      web
    }))
    localMatches.filter((item) => item.kind === 'conv').forEach(add)
    return [...merged.values()].slice(0, 80)
  }, [artifactResults, conversationResults, fileResults, flat, projectFilter, q, resultKind, timeRange, webResults, workspaceNames])

  useEffect(() => {
    setActive(0)
  }, [projectFilter, q, resultKind, timeRange])

  useEffect(() => {
    setActive((index) => results.length ? Math.min(index, results.length - 1) : 0)
  }, [results.length])

  // Auto-focus input box.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Scroll the active item into view.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (it?: FlatItem) => {
    if (!it) return
    if (it.kind === 'file' && it.file) onSelectFile?.(it.file)
    else if (it.kind === 'artifact' && it.artifact) onSelectArtifact?.(it.artifact)
    else if (it.kind === 'web' && it.web) window.open(it.web.url, '_blank', 'noopener,noreferrer')
    else onSelect?.(it.wsId, it.convId)
    onClose?.()
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose?.()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (!results.length) return
      setActive((i) => Math.min(results.length - 1, i + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (!results.length) return
      setActive((i) => Math.max(0, i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(results[active])
    }
  }

  // 挂到 <body>：与 ContextMenu / Mantine 浮层一致，确保 position:fixed 相对视口定位，
  // 避开 .dsh-root 内可能为 fixed 后代建立包含块的祖先。主题变量已在 <html> 铺设。
  const host = typeof document !== 'undefined' ? document.body : null
  if (!host) return null

  return createPortal(
    <div className={styles.searchMask} onMouseDown={onClose}>
      <div
        className={styles.searchPalette}
        role="dialog"
        aria-modal="true"
        aria-label="搜索项目、对话、文件、产物与网页来源"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.searchHeader}>
          <IconSearch size={16} stroke={1.8} className={styles.searchIcon} />
          <input
            ref={inputRef}
            className={styles.searchInput}
            placeholder="搜索项目、对话、文件、产物或网页来源…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
          />
          <kbd className={styles.searchEsc}>Esc</kbd>
        </div>
        <div className={styles.searchFilters} aria-label="搜索筛选">
          <label>
            <span>类型</span>
            <AppSelect<ResultKind>
              aria-label="结果类型"
              className={styles.searchFilterSelect}
              value={resultKind}
              options={RESULT_KIND_OPTIONS}
              onChange={setResultKind}
              size="xs"
            />
          </label>
          <label>
            <span>项目</span>
            <AppSelect
              aria-label="项目范围"
              className={styles.searchFilterSelect}
              value={projectFilter}
              options={[
                { value: '__all__', label: '全部项目' },
                ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))
              ]}
              onChange={setProjectFilter}
              size="xs"
            />
          </label>
          <label>
            <span>时间</span>
            <AppSelect<TimeRange>
              aria-label="更新时间"
              className={styles.searchFilterSelect}
              value={timeRange}
              options={TIME_RANGE_OPTIONS}
              onChange={setTimeRange}
              size="xs"
            />
          </label>
        </div>
        <div className={styles.searchList} ref={listRef}>
          {q.trim() && results.length > 0 && (remoteLoading || remoteError) && (
            <div className={styles.searchState} role="status">
              {remoteLoading ? '正在搜索…' : '部分搜索暂时不可用，当前显示已有结果'}
            </div>
          )}
          {results.length === 0 ? (
            <div className={styles.searchEmpty}>
              {remoteLoading
                ? '正在搜索…'
                : remoteError
                  ? '部分搜索暂时不可用，仍可搜索项目和标题'
                  : '没有匹配结果'}
            </div>
          ) : (
            results.map((it, idx) => (
              <button
                key={it.key}
                 type="button"
                 data-idx={idx}
                 data-search-result-kind={it.kind}
                 className={`${styles.searchItem} ${idx === active ? styles.searchItemActive : ''}`}
                onMouseEnter={() => setActive(idx)}
                onClick={() => choose(it)}
              >
                {it.kind === 'workspace'
                  ? <IconFolder size={15} stroke={1.7} />
                  : it.kind === 'file'
                    ? <IconFile size={14} stroke={1.7} />
                    : it.kind === 'artifact'
                      ? <IconArchive size={14} stroke={1.7} />
                    : it.kind === 'web'
                      ? <IconWorldSearch size={14} stroke={1.7} />
                    : <IconMessage size={14} stroke={1.7} />}
                <span className={styles.searchItemContent}>
                  <span className={styles.searchItemTitle}>{it.title}</span>
                  {it.snippet && <span className={styles.searchItemSnippet}>{it.snippet}</span>}
                </span>
                <span className={styles.searchItemMeta}>
                  {it.kind === 'workspace'
                    ? wsKindLabel(it.wsId)
                    : it.kind === 'file'
                      ? `${it.wsName} · ${it.file?.session_title ? `${it.file.session_title} · ` : ''}${it.file?.root_name || '文件'}`
                      : it.kind === 'artifact'
                        ? `${it.wsName} · v${it.artifact?.current_version?.version_number || 0} · 产物`
                      : it.kind === 'web'
                        ? `${it.wsName} · ${it.web?.site_name || '网页来源'}`
                      : `${it.wsName}${it.archived ? ' · 已归档' : ''}`}
                </span>
              </button>
            ))
          )}
        </div>
        <div className={styles.searchFoot}>
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>↵</kbd> 打开
          </span>
        </div>
      </div>
    </div>,
    host
  )
}
