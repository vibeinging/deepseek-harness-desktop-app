import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArchive,
  IconChevronRight,
  IconCode,
  IconExternalLink,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconLoader2,
  IconPhoto,
  IconRefresh,
  IconSearch,
  IconTable,
  IconX
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import {
  createProjectArtifact,
  getAgentFile,
  listAgentDirectory,
  listAgentFiles,
  searchAgentFiles,
  type AgentFilePreview,
  type AgentFileRoot,
  type AgentFileSearchResult,
  type FileNode,
  type ProjectArtifact
} from '@/api/agent'
import { artifactKindForPath, imageSrcFromPath } from './stream/uiCapabilities'
import { authorizePreviewRoot, openLocalFile, revealInFinder } from './folders'
import {
  buildWorkspaceFileBreadcrumb,
  workspaceFileScopeLabel,
  type WorkspaceFileScope
} from './workspaceFileBreadcrumb'
import styles from './agent.module.scss'

type Preview = {
  path: string
  name: string
  rootId: string
  rootPath: string
  rootName: string
  absolutePath: string
  scope: WorkspaceFileScope
  kind: ReturnType<typeof artifactKindForPath>
  loading: boolean
  size?: number
  extension?: string
  canPreview?: boolean
  previewKind?: AgentFilePreview['preview_kind']
  previewMode?: AgentFilePreview['preview_mode']
  truncated?: boolean
  reason?: string
  content?: string
  error?: string
  actionError?: string
}

export interface WorkspaceFileOpenRequest {
  rootId?: string
  absolutePath?: string
  path: string
  name: string
  size?: number
  nonce: number
}

function relativePathFromRoot(rootPath: string, candidatePath: string) {
  const normalizedRoot = String(rootPath || '').replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedCandidate = String(candidatePath || '').replace(/\\/g, '/')
  const caseInsensitive = /^[a-z]:\//i.test(normalizedRoot)
  const comparableRoot = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot
  const comparableCandidate = caseInsensitive ? normalizedCandidate.toLowerCase() : normalizedCandidate
  const prefix = `${comparableRoot}/`
  if (!comparableCandidate.startsWith(prefix)) return null
  return normalizedCandidate.slice(normalizedRoot.length + 1)
}

function normalizeFilesResponse(res: any): AgentFileRoot[] {
  const data = res?.data || res || {}
  return Array.isArray(data?.roots) ? data.roots : []
}

function replaceDirectoryChildren(nodes: FileNode[], path: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.type !== 'dir') return node
    if (node.path === path) return { ...node, children, loaded: true }
    if (!node.children?.length) return node
    return { ...node, children: replaceDirectoryChildren(node.children, path, children) }
  })
}

function formatSize(size?: number) {
  if (!size || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function fileIcon(path: string) {
  const kind = artifactKindForPath(path)
  if (kind === 'image') return IconPhoto
  if (kind === 'table') return IconTable
  if (kind === 'code') return IconCode
  return IconFile
}

function absolutePath(root: string, rel: string) {
  if (!root || rel.startsWith('/') || /^[a-z]:[\\/]/i.test(rel)) return rel
  const sep = root.includes('\\') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${rel.replace(/^[\\/]+/, '')}`
}

function parentPath(value: string) {
  const normalized = String(value || '').replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index > 0 ? normalized.slice(0, index) : ''
}

function extensionFromPath(path: string) {
  const match = /\.([a-z0-9]+)$/i.exec(path)
  return match?.[1]?.toLowerCase() || ''
}

function previewTypeLabel(preview: Preview) {
  const format = (preview.extension || extensionFromPath(preview.path) || '文件').toUpperCase()
  if (preview.previewMode === 'extracted_text') return `${format} · 提取文本`
  if (preview.previewMode === 'source_text') return `${format} · 文本预览`
  if (preview.kind === 'image') return `${format} · 图片`
  return format
}

export default function WorkspaceFilesSection({
  projectId,
  projectName,
  sessionId,
  temporary = false,
  openRequest,
  onArtifactPublished
}: {
  projectId: string
  projectName?: string
  sessionId?: string | null
  temporary?: boolean
  openRequest?: WorkspaceFileOpenRequest | null
  onArtifactPublished?: (artifact: ProjectArtifact) => void
}) {
  const [roots, setRoots] = useState<AgentFileRoot[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [expandedDirectories, setExpandedDirectories] = useState<Set<string>>(new Set())
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set())
  const [searchResults, setSearchResults] = useState<AgentFileSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [publishingArtifact, setPublishingArtifact] = useState(false)
  const [loadedIdentity, setLoadedIdentity] = useState('')
  const previewRequestVersion = useRef(0)
  const handledOpenRequest = useRef<number | null>(null)
  const workspaceIdentity = `${projectId}:${sessionId || ''}`

  useEffect(() => {
    let alive = true
    setLoading(true)
    setLoadedIdentity('')
    listAgentFiles(projectId, sessionId)
      .then((res: any) => {
        if (!alive) return
        const next = normalizeFilesResponse(res)
        setRoots(next)
        setExpandedDirectories(new Set())
        next.forEach((root) => {
          void authorizePreviewRoot(root.path)
        })
      })
      .catch(() => {
        if (alive) {
          setRoots([])
        }
      })
      .finally(() => {
        if (!alive) return
        setLoadedIdentity(workspaceIdentity)
        setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [projectId, refreshTick, sessionId, workspaceIdentity])

  useEffect(() => {
    previewRequestVersion.current += 1
    setPreview(null)
    setQuery('')
    setSearchResults([])
  }, [projectId, sessionId])

  const rootIdentity = useMemo(() => roots.map((root) => `${root.id}:${root.path}`).join('|'), [roots])
  const hasAnyItems = useMemo(() => roots.some((root) => root.tree.length > 0), [roots])

  useEffect(() => {
    const keyword = query.trim()
    let alive = true
    if (!keyword) {
      setSearchResults([])
      setSearchLoading(false)
      setSearchError(false)
      return undefined
    }
    setSearchLoading(true)
    setSearchError(false)
    const timer = window.setTimeout(() => {
      searchAgentFiles(keyword, 100, {
        projectId,
        ...(sessionId ? { sessionId } : {})
      })
        .then((res: any) => {
          if (!alive) return
          const items: AgentFileSearchResult[] = res?.data?.items || res?.items || []
          const visibleRootIds = new Set(roots.map((root) => root.id))
          setSearchResults(Array.isArray(items) ? items.filter((item) => visibleRootIds.has(item.root_id)) : [])
          setSearchError(Boolean(res?.data?.partial))
        })
        .catch(() => {
          if (alive) {
            setSearchResults([])
            setSearchError(true)
          }
        })
        .finally(() => {
          if (alive) setSearchLoading(false)
        })
    }, 180)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [projectId, query, rootIdentity, roots, sessionId])

  const toggleDirectory = useCallback((rootId: string, node: FileNode) => {
    const key = `${rootId}:${node.path}`
    if (expandedDirectories.has(key)) {
      setExpandedDirectories((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
      return
    }
    setExpandedDirectories((current) => new Set(current).add(key))
    if (node.loaded) return

    setLoadingDirectories((current) => new Set(current).add(key))
    listAgentDirectory(projectId, rootId, node.path, sessionId)
      .then((res: any) => {
        const data = res?.data || res || {}
        const children = Array.isArray(data.items) ? data.items : []
        setRoots((current) => current.map((root) => root.id === rootId
          ? { ...root, tree: replaceDirectoryChildren(root.tree, node.path, children) }
          : root))
      })
      .catch(() => {
        setExpandedDirectories((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      })
      .finally(() => {
        setLoadingDirectories((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      })
  }, [expandedDirectories, projectId, sessionId])

  const pickFile = useCallback((node: FileNode) => {
    const root = roots.find((item) => item.id === node.root_id)
    if (!root) return
    const version = ++previewRequestVersion.current
    const kind = artifactKindForPath(node.path)
    const fullPath = absolutePath(root.path, node.path)
    const next: Preview = {
      path: node.path,
      name: node.name,
      rootId: root.id,
      rootPath: root.path,
      rootName: root.name,
      absolutePath: fullPath,
      scope: projectId === '__chat__' ? 'chat' : 'project',
      kind,
      loading: kind !== 'image',
      size: node.size,
      extension: extensionFromPath(node.path),
      canPreview: kind === 'image',
      previewKind: kind === 'image' ? 'image' : undefined,
      previewMode: kind === 'image' ? 'native_image' : undefined
    }
    setPreview(next)
    if (kind === 'image') return
    getAgentFile(projectId, root.id, node.path, sessionId)
      .then((res: any) => {
        if (previewRequestVersion.current !== version) return
        const data: AgentFilePreview | null = res?.data !== undefined ? res.data : res
        if (!data) throw new Error(res?.message || '文件不存在或无权限')
        setPreview({
          ...next,
          loading: false,
          size: data.size,
          extension: data.extension,
          canPreview: data.can_preview,
          previewKind: data.preview_kind,
          previewMode: data.preview_mode,
          truncated: data.truncated,
          reason: data.reason,
          content: String(data.content || '')
        })
      })
      .catch((err: any) => {
        if (previewRequestVersion.current !== version) return
        setPreview({ ...next, loading: false, canPreview: false, error: err?.message || '读取失败' })
      })
  }, [projectId, roots, sessionId])

  useEffect(() => {
    if (!openRequest || loadedIdentity !== workspaceIdentity || handledOpenRequest.current === openRequest.nonce) return
    const root = roots.find((item) => item.id === openRequest.rootId)
      || (openRequest.absolutePath
        ? roots.find((item) => relativePathFromRoot(item.path, openRequest.absolutePath!) !== null)
        : undefined)
    if (!root && openRequest.absolutePath) {
      handledOpenRequest.current = openRequest.nonce
      const fullPath = openRequest.absolutePath
      setQuery('')
      setPreview({
        path: openRequest.path || openRequest.name,
        name: openRequest.name,
        rootId: '__external__',
        rootPath: parentPath(fullPath),
        rootName: '本机文件',
        absolutePath: fullPath,
        scope: 'external',
        kind: artifactKindForPath(fullPath),
        loading: false,
        size: openRequest.size,
        extension: extensionFromPath(fullPath),
        canPreview: false,
        previewMode: 'none',
        reason: '这是未加入当前项目的本机文件，不会在项目权限内读取内容。可以用本机应用打开，或在文件夹中显示。'
      })
      return
    }
    if (!root) return
    const path = openRequest.absolutePath
      ? relativePathFromRoot(root.path, openRequest.absolutePath)
      : openRequest.path
    if (!path) return
    handledOpenRequest.current = openRequest.nonce
    setQuery('')
    pickFile({
      name: openRequest.name,
      path,
      root_id: root.id,
      type: 'file',
      size: openRequest.size
    })
  }, [loadedIdentity, openRequest, pickFile, roots, workspaceIdentity])

  const imagePath = preview?.kind === 'image' && preview.canPreview !== false
    ? imageSrcFromPath(absolutePath(preview.rootPath, preview.path))
    : ''
  const previewBreadcrumb = useMemo(() => preview ? buildWorkspaceFileBreadcrumb({
    scope: preview.scope,
    projectName,
    rootName: preview.rootName,
    relativePath: preview.path,
    absolutePath: preview.absolutePath
  }) : [], [preview, projectName])

  const closePreview = () => {
    previewRequestVersion.current += 1
    setPreview(null)
  }

  const runNativeFileAction = async (action: 'open' | 'reveal') => {
    if (!preview) return
    if (preview.scope !== 'external') await authorizePreviewRoot(preview.rootPath)
    const ok = action === 'open'
      ? await openLocalFile(preview.absolutePath)
      : await revealInFinder(preview.absolutePath)
    if (!ok) {
      setPreview((current) => current ? {
        ...current,
        actionError: action === 'open' ? '无法用本机应用打开这个文件' : '无法在文件夹中显示这个文件'
      } : current)
    }
  }

  const publishPreviewAsArtifact = async () => {
    if (!preview || preview.scope !== 'project' || publishingArtifact || temporary) return
    setPublishingArtifact(true)
    try {
      const response: any = await createProjectArtifact(projectId, {
        rootId: preview.rootId,
        path: preview.path,
        sessionId,
        name: preview.name,
        kind: preview.kind,
        temporary
      })
      const data = response?.data || response || {}
      const artifact: ProjectArtifact | undefined = data.artifact
      if (!artifact) throw new Error('服务端没有返回产物')
      notifications.show({
        color: data.deduplicated ? 'blue' : 'green',
        message: data.deduplicated ? `「${artifact.name}」已经是最新版本` : `已将「${artifact.name}」加入产物库`
      })
      onArtifactPublished?.(artifact)
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.msg || error?.message || '加入产物库失败' })
    } finally {
      setPublishingArtifact(false)
    }
  }

  const renderTree = (root: AgentFileRoot, nodes: FileNode[], depth = 0): React.ReactNode => nodes.map((node) => {
    const key = `${root.id}:${node.path}`
    const expanded = expandedDirectories.has(key)
    const directoryLoading = loadingDirectories.has(key)
    if (node.type === 'dir') {
      return (
        <div className={styles.wsFileTreeBranch} key={key}>
          <button
            type="button"
            className={styles.wsFileItem}
            style={{ paddingLeft: `${7 + depth * 14}px` }}
            title={node.path}
            aria-expanded={expanded}
            onClick={() => toggleDirectory(root.id, node)}
          >
            {directoryLoading
              ? <IconLoader2 size={13} stroke={1.8} className={styles.wsFileSpinner} />
              : <IconChevronRight size={13} stroke={1.8} className={expanded ? styles.wsFileChevronOpen : styles.wsFileChevron} />}
            {expanded ? <IconFolderOpen size={15} stroke={1.7} /> : <IconFolder size={15} stroke={1.7} />}
            <span className={styles.wsFileName}>{node.name}</span>
          </button>
          {expanded && node.loaded && renderTree(root, node.children || [], depth + 1)}
        </div>
      )
    }
    const Icon = fileIcon(node.path)
    return (
      <button
        key={key}
        type="button"
        className={styles.wsFileItem}
        style={{ paddingLeft: `${26 + depth * 14}px` }}
        data-active={preview?.rootId === root.id && preview?.path === node.path ? 'true' : undefined}
        title={node.path}
        onClick={() => pickFile(node)}
      >
        <Icon size={15} stroke={1.7} />
        <span className={styles.wsFileName}>{node.name}</span>
        <span className={styles.wsFileSize}>{formatSize(node.size)}</span>
      </button>
    )
  })

  return (
    <div className={styles.wsFilesSection}>
      <div className={styles.wsFilesToolbar}>
        <div className={styles.wsFilesSearch}>
          <IconSearch size={13} stroke={1.7} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索文件名或正文" />
        </div>
        <button type="button" title="刷新项目文件" onClick={() => setRefreshTick((v) => v + 1)}>
          <IconRefresh size={14} stroke={1.8} />
        </button>
      </div>
      <div className={styles.wsFilesList}>
        {loading ? (
          <div className={styles.wsFilesEmpty}>加载中...</div>
        ) : query.trim() ? (
          searchLoading ? (
            <div className={styles.wsFilesEmpty}>正在搜索文件名和正文...</div>
          ) : searchResults.length === 0 ? (
            <div className={styles.wsFilesEmpty}>{searchError ? '部分搜索暂时不可用，没有找到已有结果' : '没有匹配文件'}</div>
          ) : searchResults.map((item) => {
            const Icon = fileIcon(item.path)
            return (
              <button
                key={`${item.project_id}:${item.session_id || ''}:${item.root_id}:${item.path}`}
                type="button"
                className={styles.wsFileItem}
                data-active={preview?.rootId === item.root_id && preview?.path === item.path ? 'true' : undefined}
                title={item.path}
                onClick={() => pickFile({ name: item.name, path: item.path, root_id: item.root_id, type: 'file', size: item.size })}
              >
                <Icon size={15} stroke={1.7} />
                <span className={styles.wsFileSearchCopy}>
                  <span className={styles.wsFileName}>{item.name}</span>
                  <small>{item.snippet ? `${item.path}${item.line_number ? `:${item.line_number}` : ''} · ${item.snippet}` : item.path}</small>
                </span>
                <span className={styles.wsFileSize}>{formatSize(item.size)}</span>
              </button>
            )
          })
        ) : !roots.length || !hasAnyItems ? (
          <div className={styles.wsFilesEmpty}>项目还没有关联文件夹或生成文件</div>
        ) : (
          roots.map((root) => (
            <section className={styles.wsFileRootGroup} key={`${root.id}:${root.path}`}>
              <div className={styles.wsFilesRoot} title={root.name}>
                <IconFolder size={13} stroke={1.7} />
                <span>{root.name}</span>
                {root.kind === 'source_folder' && (
                  <small className={styles.wsFileRootMode} data-write-target={root.write_target === true ? 'true' : 'false'}>
                    {root.write_target === true ? '写入位置' : '只读'}
                  </small>
                )}
              </div>
              {root.tree.length
                ? renderTree(root, root.tree)
                : <div className={styles.wsFilesEmpty}>这个位置还没有文件</div>}
            </section>
          ))
        )}
      </div>
      {preview && (
        <div className={styles.wsFilePreview}>
          <div className={styles.wsFilePreviewHead}>
            <div className={styles.wsFilePreviewTitle} title={previewBreadcrumb.join(' › ')}>
              <div
                className={styles.wsFileBreadcrumb}
                data-file-scope={preview.scope}
                aria-label={`文件位置：${previewBreadcrumb.join('，')}`}
              >
                <span className={styles.wsFileScopeBadge} data-file-scope={preview.scope}>
                  {workspaceFileScopeLabel(preview.scope)}
                </span>
                <div className={styles.wsFileBreadcrumbTrail}>
                  {previewBreadcrumb.map((item, index) => (
                    <span
                      className={styles.wsFileBreadcrumbPart}
                      data-current={index === previewBreadcrumb.length - 1 ? 'true' : undefined}
                      key={`${index}:${item}`}
                    >
                      {index > 0 && <IconChevronRight size={11} stroke={1.7} aria-hidden="true" />}
                      <span>{item}</span>
                    </span>
                  ))}
                </div>
              </div>
              <small>{previewTypeLabel(preview)}{preview.size != null ? ` · ${formatSize(preview.size)}` : ''}</small>
            </div>
            <div className={styles.wsFilePreviewActions}>
              {preview.scope === 'project' && !temporary && (
                <button
                  type="button"
                  data-file-action="publish-artifact"
                  title="加入项目产物库"
                  aria-label="加入项目产物库"
                  disabled={publishingArtifact}
                  onClick={() => void publishPreviewAsArtifact()}
                >
                  {publishingArtifact
                    ? <IconLoader2 size={14} stroke={1.8} className={styles.wsFileSpinner} />
                    : <IconArchive size={14} stroke={1.8} />}
                </button>
              )}
              <button type="button" title="用本机应用打开" aria-label="用本机应用打开" onClick={() => void runNativeFileAction('open')}>
                <IconExternalLink size={14} stroke={1.8} />
              </button>
              <button type="button" title="在文件夹中显示" aria-label="在文件夹中显示" onClick={() => void runNativeFileAction('reveal')}>
                <IconFolderOpen size={14} stroke={1.8} />
              </button>
              <button type="button" title="收起预览" aria-label="收起预览" onClick={closePreview}>
                <IconX size={14} stroke={1.8} />
              </button>
            </div>
          </div>
          {preview.loading ? (
            <div className={styles.wsFilesEmpty}>读取中...</div>
          ) : preview.error ? (
            <div className={styles.wsFileError}>{preview.error}</div>
          ) : preview.canPreview === false ? (
            <div className={styles.wsFilePreviewNotice}>{preview.reason || '暂不支持内置预览，请用本机应用打开。'}</div>
          ) : preview.kind === 'image' ? (
            <img
              src={imagePath}
              alt={preview.name}
              onError={() => setPreview((current) => current ? {
                ...current,
                canPreview: false,
                error: '图片无法读取，可以尝试用本机应用打开。'
              } : current)}
            />
          ) : (
            <>
              <pre>{preview.content || '文件为空'}</pre>
              {preview.reason && <div className={styles.wsFilePreviewNotice}>{preview.reason}</div>}
            </>
          )}
          {preview.actionError && <div className={styles.wsFileError}>{preview.actionError}</div>}
        </div>
      )}
    </div>
  )
}
