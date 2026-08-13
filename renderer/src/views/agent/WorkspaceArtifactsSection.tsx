import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArchive,
  IconArrowLeft,
  IconArrowsDiff,
  IconCode,
  IconExternalLink,
  IconFile,
  IconFilePlus,
  IconFolderOpen,
  IconHistory,
  IconLoader2,
  IconPencil,
  IconPhoto,
  IconPlus,
  IconRefresh,
  IconRestore,
  IconSearch,
  IconSend,
  IconSparkles,
  IconTable,
  IconX
} from '@tabler/icons-react'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import AppSelect from '@/components/AppSelect'
import {
  compareProjectArtifactVersions,
  compareProjectOfficeArtifactVersions,
  createProjectOfficeArtifact,
  getProjectArtifact,
  listProjectArtifacts,
  previewProjectArtifactVersion,
  restoreProjectArtifactVersion,
  type ProjectArtifact,
  type ProjectArtifactDiff,
  type ProjectArtifactVersion,
  type ProjectArtifactVersionPreview,
  type ProjectOfficeArtifactDiff,
  type OfficeArtifactFormat
} from '@/api/agent'
import { artifactKindForPath, imageSrcFromPath } from './stream/uiCapabilities'
import { authorizePreviewRoot, openLocalFile, revealInFinder } from './folders'
import OfficeArtifactEditor, { type OfficeArtifactSelection } from './OfficeArtifactEditor'
import CanvasWorkspace, {
  type WorkspaceCanvasOpenRequest,
  type WorkspaceCanvasReference
} from './CanvasWorkspace'
import styles from './agent.module.scss'

export interface WorkspaceArtifactOpenRequest {
  projectId: string
  sessionId: string | null
  artifactId: string
  nonce: number
}

export interface WorkspaceArtifactReference {
  artifact: ProjectArtifact
  version: ProjectArtifactVersion
  officeSelections?: OfficeArtifactSelection[]
}

export function artifactBelongsToSession(artifact: ProjectArtifact, sessionId?: string | null) {
  if (!sessionId) return false
  return artifact.source_session_id === sessionId
    || artifact.current_version?.source_session_id === sessionId
}

type VisibleArtifactDiff = ProjectArtifactDiff | ProjectOfficeArtifactDiff

const OFFICE_FORMAT_OPTIONS: Array<{ value: OfficeArtifactFormat; label: string }> = [
  { value: 'markdown', label: 'Markdown 文档' },
  { value: 'docx', label: 'Word 文档' },
  { value: 'xlsx', label: 'Excel 表格' },
  { value: 'pptx', label: 'PowerPoint 演示' },
  { value: 'pdf', label: 'PDF 文档' }
]

const OFFICE_EXTENSION: Record<OfficeArtifactFormat, string> = {
  markdown: '.md',
  docx: '.docx',
  xlsx: '.xlsx',
  pptx: '.pptx',
  pdf: '.pdf'
}

function officeFormatForArtifact(artifact?: ProjectArtifact | null): OfficeArtifactFormat | null {
  if (!artifact) return null
  const declared = String(artifact.current_version?.metadata?.office_format || artifact.metadata?.office_format || '').toLowerCase()
  if (OFFICE_FORMAT_OPTIONS.some((item) => item.value === declared)) return declared as OfficeArtifactFormat
  const extension = artifact.name.toLowerCase().match(/(\.[a-z0-9]+)$/)?.[1] || ''
  if (extension === '.md' || extension === '.markdown') return 'markdown'
  const match = (Object.entries(OFFICE_EXTENSION) as Array<[OfficeArtifactFormat, string]>).find(([, value]) => value === extension)
  return match?.[0] || null
}

function renderDiffValue(value: unknown) {
  if (value === null || value === undefined) return '空'
  if (typeof value === 'string') return value || '空'
  try { return JSON.stringify(value) } catch { return String(value) }
}

const KIND_OPTIONS = [
  { value: 'all', label: '全部类型' },
  { value: 'report', label: '报告' },
  { value: 'document', label: '文档' },
  { value: 'table', label: '表格' },
  { value: 'image', label: '图片' },
  { value: 'code', label: '代码' },
  { value: 'template', label: '模板' },
  { value: 'file', label: '其他文件' }
]

const KIND_LABELS: Record<string, string> = {
  report: '报告',
  document: '文档',
  table: '表格',
  image: '图片',
  code: '代码',
  template: '模板',
  file: '文件'
}

function formatSize(size = 0) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function formatTime(value?: string | null) {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function shortId(value?: string | null) {
  const text = String(value || '')
  return text.length > 12 ? `${text.slice(0, 8)}…` : text
}

function ArtifactIcon({ artifact, size = 16 }: { artifact: ProjectArtifact; size?: number }) {
  const path = artifact.current_version?.snapshot_path || artifact.name
  const kind = artifact.kind || artifactKindForPath(path)
  if (kind === 'image') return <IconPhoto size={size} stroke={1.7} />
  if (kind === 'table') return <IconTable size={size} stroke={1.7} />
  if (kind === 'code') return <IconCode size={size} stroke={1.7} />
  if (kind === 'report' || kind === 'document') return <IconFile size={size} stroke={1.7} />
  return <IconArchive size={size} stroke={1.7} />
}

function sourceLabel(version?: ProjectArtifactVersion | null) {
  if (!version) return '来源未知'
  const conversation = version.source_session_title || (version.source_session_id ? '来源对话' : '手动加入')
  const turn = version.source_turn_id ? ` · Turn ${shortId(version.source_turn_id)}` : ''
  return `${conversation}${turn}`
}

export default function WorkspaceArtifactsSection({
  projectId,
  sessionId,
  temporary = false,
  openRequest,
  canvasOpenRequest,
  refreshNonce = 0,
  onReference,
  onCanvasReference,
  onOpenFiles,
  onOpenSourceConversation
}: {
  projectId: string
  sessionId?: string | null
  temporary?: boolean
  openRequest?: WorkspaceArtifactOpenRequest | null
  canvasOpenRequest?: WorkspaceCanvasOpenRequest | null
  refreshNonce?: number
  onReference?: (reference: WorkspaceArtifactReference) => void
  onCanvasReference?: (reference: WorkspaceCanvasReference) => void
  onOpenFiles?: () => void
  onOpenSourceConversation?: (sessionId: string) => void
}) {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [items, setItems] = useState<ProjectArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<ProjectArtifact | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  const [preview, setPreview] = useState<ProjectArtifactVersionPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [diff, setDiff] = useState<VisibleArtifactDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [editingOffice, setEditingOffice] = useState(false)
  const [creatingOffice, setCreatingOffice] = useState(false)
  const [createFormat, setCreateFormat] = useState<OfficeArtifactFormat>('markdown')
  const [createName, setCreateName] = useState('')
  const [createTitle, setCreateTitle] = useState('')
  const [createContent, setCreateContent] = useState('')
  const [createBusy, setCreateBusy] = useState(false)
  const [canvasMode, setCanvasMode] = useState(false)
  const [canvasInitialId, setCanvasInitialId] = useState<string | null>(null)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const previewRequest = useRef(0)
  const handledOpenRequest = useRef<number | null>(null)
  const handledCanvasOpenRequest = useRef<number | null>(null)

  const visibleItems = useMemo(() => {
    return items.filter((artifact) => artifactBelongsToSession(artifact, sessionId))
  }, [items, sessionId])

  const loadList = useCallback(async () => {
    const version = ++listRequest.current
    setLoading(true)
    setLoadError(false)
    try {
      const response: any = await listProjectArtifacts(projectId, { query: query.trim(), kind, limit: 120 })
      if (listRequest.current !== version) return
      const next = response?.data?.items || response?.items || []
      setItems(Array.isArray(next) ? next : [])
    } catch {
      if (listRequest.current === version) {
        setItems([])
        setLoadError(true)
      }
    } finally {
      if (listRequest.current === version) setLoading(false)
    }
  }, [kind, projectId, query])

  useEffect(() => {
    const timer = window.setTimeout(() => void loadList(), query.trim() ? 160 : 0)
    return () => window.clearTimeout(timer)
  }, [loadList, refreshNonce, refreshTick])

  useEffect(() => {
    detailRequest.current += 1
    previewRequest.current += 1
    setSelectedId(null)
    setDetail(null)
    setSelectedVersionId(null)
    setPreview(null)
    setDiff(null)
    setEditingOffice(false)
    setCreatingOffice(false)
    setCanvasMode(false)
    setCanvasInitialId(null)
  }, [projectId, sessionId])

  useEffect(() => {
    if (
      !openRequest
      || openRequest.projectId !== projectId
      || openRequest.sessionId !== sessionId
      || handledOpenRequest.current === openRequest.nonce
    ) return
    handledOpenRequest.current = openRequest.nonce
    setSelectedId(openRequest.artifactId)
  }, [openRequest, projectId, sessionId])

  useEffect(() => {
    if (!canvasOpenRequest || canvasOpenRequest.sessionId !== sessionId || handledCanvasOpenRequest.current === canvasOpenRequest.nonce) return
    handledCanvasOpenRequest.current = canvasOpenRequest.nonce
    setCanvasInitialId(canvasOpenRequest.canvasId)
    setCanvasMode(true)
  }, [canvasOpenRequest, sessionId])

  const loadDetail = useCallback(async (artifactId: string, preferredVersionId?: string | null) => {
    const version = ++detailRequest.current
    setDetailLoading(true)
    setDiff(null)
    try {
      const response: any = await getProjectArtifact(projectId, artifactId)
      if (detailRequest.current !== version) return
      const next: ProjectArtifact | null = response?.data || response || null
      setDetail(next)
      const available = next?.versions || []
      const preferred = preferredVersionId && available.some((item) => item.id === preferredVersionId)
        ? preferredVersionId
        : next?.current_version_id || available[0]?.id || null
      setSelectedVersionId(preferred)
    } catch (error: any) {
      if (detailRequest.current === version) {
        setDetail(null)
        notifications.show({ color: 'red', message: error?.msg || '读取产物详情失败' })
      }
    } finally {
      if (detailRequest.current === version) setDetailLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    if (!selectedId) return
    void loadDetail(selectedId)
  }, [loadDetail, selectedId])

  useEffect(() => {
    setEditingOffice(false)
  }, [selectedId])

  useEffect(() => {
    if (!temporary) return
    setEditingOffice(false)
    setCreatingOffice(false)
  }, [temporary])

  useEffect(() => {
    if (!detail || !selectedVersionId) {
      setPreview(null)
      return
    }
    const version = ++previewRequest.current
    setPreviewLoading(true)
    previewProjectArtifactVersion(projectId, detail.id, selectedVersionId)
      .then(async (response: any) => {
        if (previewRequest.current !== version) return
        const next: ProjectArtifactVersionPreview | null = response?.data || response || null
        if (next?.version?.snapshot_root) await authorizePreviewRoot(next.version.snapshot_root)
        if (previewRequest.current === version) setPreview(next)
      })
      .catch(() => {
        if (previewRequest.current === version) setPreview(null)
      })
      .finally(() => {
        if (previewRequest.current === version) setPreviewLoading(false)
      })
  }, [detail, projectId, selectedVersionId])

  const selectedVersion = useMemo(
    () => detail?.versions?.find((version) => version.id === selectedVersionId) || null,
    [detail, selectedVersionId]
  )
  const officeFormat = useMemo(() => officeFormatForArtifact(detail), [detail])

  const runNativeAction = async (action: 'open' | 'reveal') => {
    if (!selectedVersion?.snapshot_path) return
    if (selectedVersion.snapshot_root) await authorizePreviewRoot(selectedVersion.snapshot_root)
    const ok = action === 'open'
      ? await openLocalFile(selectedVersion.snapshot_path)
      : await revealInFinder(selectedVersion.snapshot_path)
    if (!ok) notifications.show({ color: 'red', message: action === 'open' ? '无法用本机应用打开产物' : '无法在文件夹中显示产物' })
  }

  const compareSelectedVersion = async () => {
    if (!detail || !selectedVersion) return
    const versions = detail.versions || []
    const currentId = detail.current_version_id || versions[0]?.id
    const fromId = selectedVersion.id === currentId
      ? versions.find((version) => version.version_number === selectedVersion.version_number - 1)?.id
      : selectedVersion.id
    if (!fromId) {
      notifications.show({ color: 'blue', message: '还没有可比较的上一版' })
      return
    }
    setDiffLoading(true)
    try {
      const response: any = officeFormat
        ? await compareProjectOfficeArtifactVersions(projectId, detail.id, fromId, currentId)
        : await compareProjectArtifactVersions(projectId, detail.id, fromId, currentId)
      setDiff(response?.data || response || null)
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.msg || '比较版本失败' })
    } finally {
      setDiffLoading(false)
    }
  }

  const createOfficeArtifact = async () => {
    if (createBusy || temporary) return
    const title = createTitle.trim()
    const name = createName.trim()
    if (!title && !name) {
      notifications.show({ color: 'orange', message: '填写文档标题或文件名' })
      return
    }
    setCreateBusy(true)
    try {
      const response: any = await createProjectOfficeArtifact(projectId, {
        format: createFormat,
        name: name || undefined,
        title: title || name,
        content: createContent,
        sessionId,
        temporary
      })
      const artifact: ProjectArtifact | null = response?.data?.artifact || response?.artifact || null
      if (!artifact) throw new Error('服务端没有返回新产物')
      setCreatingOffice(false)
      setCreateName('')
      setCreateTitle('')
      setCreateContent('')
      setRefreshTick((value) => value + 1)
      setDetail(artifact)
      setSelectedVersionId(artifact.current_version_id || null)
      setSelectedId(artifact.id)
      notifications.show({ color: 'green', message: `已创建「${artifact.name}」` })
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.msg || error?.message || '创建办公产物失败' })
    } finally {
      setCreateBusy(false)
    }
  }

  const confirmRestore = () => {
    if (!detail || !selectedVersion || selectedVersion.id === detail.current_version_id || restoring || temporary) return
    modals.openConfirmModal({
      title: `恢复 v${selectedVersion.version_number}`,
      children: '恢复会创建一个新的当前版本，已有历史不会被覆盖。',
      labels: { confirm: '恢复为新版本', cancel: '取消' },
      onConfirm: async () => {
        setRestoring(true)
        try {
          const response: any = await restoreProjectArtifactVersion(projectId, detail.id, selectedVersion.id, sessionId, temporary)
          const restored: ProjectArtifact | null = response?.data?.artifact || null
          notifications.show({ color: 'green', message: `已恢复「${detail.name}」，新版本为 v${restored?.current_version?.version_number || ''}` })
          setRefreshTick((value) => value + 1)
          await loadDetail(detail.id, restored?.current_version_id)
        } catch (error: any) {
          notifications.show({ color: 'red', message: error?.msg || '恢复产物失败' })
        } finally {
          setRestoring(false)
        }
      }
    })
  }

  if (canvasMode) {
    return (
      <CanvasWorkspace
        sessionId={sessionId}
        initialCanvasId={canvasInitialId}
        openRequestNonce={canvasOpenRequest?.sessionId === sessionId ? (canvasOpenRequest?.nonce ?? null) : null}
        onClose={() => {
          setCanvasMode(false)
          setCanvasInitialId(null)
        }}
        onReference={onCanvasReference}
      />
    )
  }

  if (selectedId) {
    if (detail && editingOffice) {
      return (
        <OfficeArtifactEditor
          projectId={projectId}
          artifact={detail}
          onClose={() => setEditingOffice(false)}
          onReferenceSelection={(inspection, selections) => onReference?.({
            artifact: inspection.artifact,
            version: inspection.version,
            officeSelections: selections
          })}
        />
      )
    }
    return (
      <div className={styles.artifactLibrary} data-artifact-detail={selectedId}>
        <div className={styles.artifactDetailHead}>
          <button type="button" aria-label="返回产物列表" onClick={() => setSelectedId(null)}>
            <IconArrowLeft size={15} stroke={1.8} />
          </button>
          <div>
            <strong>{detail?.name || '产物详情'}</strong>
            <span>{detail ? `${KIND_LABELS[detail.kind] || detail.kind} · ${detail.version_count} 个版本` : '读取中…'}</span>
          </div>
          <button type="button" aria-label="刷新产物详情" onClick={() => selectedId && void loadDetail(selectedId, selectedVersionId)}>
            <IconRefresh size={14} stroke={1.8} />
          </button>
        </div>
        {detailLoading && !detail ? (
          <div className={styles.artifactLibraryState}><IconLoader2 size={16} className={styles.wsFileSpinner} /> 读取中…</div>
        ) : !detail ? (
          <div className={styles.artifactLibraryState}>产物不存在或无权限</div>
        ) : (
          <div className={styles.artifactDetailBody}>
            {detail.description && <p className={styles.artifactDescription}>{detail.description}</p>}
            <div className={styles.artifactDetailActions}>
              {!temporary && officeFormat && selectedVersion?.id === detail.current_version_id && (
                <button type="button" data-artifact-action="edit-office" onClick={() => setEditingOffice(true)}>
                  <IconPencil size={14} stroke={1.8} /> 编辑
                </button>
              )}
              <button
                type="button"
                data-artifact-action="reference"
                disabled={!selectedVersion || previewLoading || !preview}
                onClick={() => selectedVersion && onReference?.({ artifact: detail, version: selectedVersion })}
              >
                <IconSend size={14} stroke={1.8} /> 引用 v{selectedVersion?.version_number || ''}
              </button>
              <button type="button" onClick={() => void runNativeAction('open')}>
                <IconExternalLink size={14} stroke={1.8} /> 打开
              </button>
              <button type="button" onClick={() => void runNativeAction('reveal')}>
                <IconFolderOpen size={14} stroke={1.8} /> 显示
              </button>
              <button type="button" disabled={diffLoading || (detail.versions?.length || 0) < 2} onClick={() => void compareSelectedVersion()}>
                {diffLoading ? <IconLoader2 size={14} className={styles.wsFileSpinner} /> : <IconArrowsDiff size={14} stroke={1.8} />} 比较
              </button>
              {!temporary && selectedVersion && selectedVersion.id !== detail.current_version_id && (
                <button type="button" data-artifact-action="restore" disabled={restoring} onClick={confirmRestore}>
                  <IconRestore size={14} stroke={1.8} /> 恢复
                </button>
              )}
            </div>
            <section className={styles.artifactPreview}>
              <div className={styles.artifactSectionTitle}>
                <span>预览</span>
                <small>v{selectedVersion?.version_number || ''} · {formatSize(selectedVersion?.size_bytes || 0)}</small>
              </div>
              {previewLoading ? (
                <div className={styles.artifactLibraryState}>正在读取版本…</div>
              ) : !preview ? (
                <div className={styles.artifactLibraryState}>该版本无法预览，可以用本机应用打开。</div>
              ) : preview.preview.preview_kind === 'image' ? (
                <img src={imageSrcFromPath(preview.version.snapshot_path)} alt={detail.name} />
              ) : preview.preview.can_preview ? (
                <pre>{preview.preview.content || '文件为空'}</pre>
              ) : (
                <div className={styles.artifactLibraryState}>{preview.preview.reason || '该格式暂不支持内置预览。'}</div>
              )}
            </section>
            {diff && (
              <section className={styles.artifactDiff} data-artifact-diff={'mode' in diff ? diff.mode : `office-${diff.format}`}>
                <div className={styles.artifactSectionTitle}>
                  <span>版本差异</span>
                  <small>v{diff.from.version_number} → v{diff.to.version_number}</small>
                </div>
                <p>{diff.summary}</p>
                {'diff' in diff && diff.diff && <pre>{diff.diff}</pre>}
                {'changes' in diff && diff.changes.length > 0 && (
                  <div className={styles.officeDiffChanges}>
                    {diff.changes.slice(0, 80).map((change, index) => (
                      <div key={`${change.anchor}-${index}`} data-office-diff-change={change.type}>
                        <code>{change.anchor}</code>
                        <span>{renderDiffValue(change.before)}</span>
                        <strong>→</strong>
                        <span>{renderDiffValue(change.after)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}
            <section className={styles.artifactVersions}>
              <div className={styles.artifactSectionTitle}>
                <span><IconHistory size={14} stroke={1.8} /> 版本历史</span>
                <small>恢复不会覆盖历史</small>
              </div>
              {(detail.versions || []).map((version) => (
                <button
                  type="button"
                  key={version.id}
                  data-artifact-version={version.version_number}
                  data-active={version.id === selectedVersionId ? 'true' : undefined}
                  onClick={() => {
                    setSelectedVersionId(version.id)
                    setDiff(null)
                  }}
                >
                  <span className={styles.artifactVersionNumber}>v{version.version_number}</span>
                  <span className={styles.artifactVersionCopy}>
                    <strong>{version.change_summary || '更新产物'}</strong>
                    <small>
                      {sourceLabel(version)} · {formatTime(version.created_at)}
                      {version.restored_from_version_id ? ' · 恢复版本' : ''}
                    </small>
                  </span>
                  {version.id === detail.current_version_id && <em>当前</em>}
                </button>
              ))}
            </section>
            {selectedVersion?.source_session_id && (
              <button
                type="button"
                className={styles.artifactSourceLink}
                onClick={() => onOpenSourceConversation?.(selectedVersion.source_session_id as string)}
              >
                打开来源对话：{selectedVersion.source_session_title || shortId(selectedVersion.source_session_id)}
                {selectedVersion.source_turn_id ? ` · Turn ${shortId(selectedVersion.source_turn_id)}` : ''}
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.artifactLibrary} data-artifact-library={projectId}>
      <div className={styles.artifactToolbar}>
        <div className={styles.artifactSearch}>
          <IconSearch size={13} stroke={1.7} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索产物" />
        </div>
        <button type="button" aria-label="打开 Canvas" data-artifact-action="open-canvas" onClick={() => {
          setCanvasInitialId(null)
          setCanvasMode(true)
        }}>
          <IconSparkles size={14} stroke={1.8} />
        </button>
        {!temporary && (
          <button type="button" aria-label="新建办公产物" data-artifact-action="create-office" onClick={() => setCreatingOffice((value) => !value)}>
            {creatingOffice ? <IconX size={14} stroke={1.8} /> : <IconPlus size={14} stroke={1.8} />}
          </button>
        )}
        <button type="button" aria-label="刷新产物库" onClick={() => setRefreshTick((value) => value + 1)}>
          <IconRefresh size={14} stroke={1.8} />
        </button>
      </div>
      <AppSelect
        aria-label="产物类型"
        className={styles.artifactKindSelect}
        value={kind}
        options={KIND_OPTIONS}
        onChange={setKind}
        size="xs"
      />
      {creatingOffice && (
        <section className={styles.officeCreatePanel} data-office-create={createFormat}>
          <div className={styles.officeCreateTitle}>
            <IconFilePlus size={15} stroke={1.7} />
            <div><strong>新建可编辑产物</strong><span>创建后会立即保留 v1</span></div>
          </div>
          <AppSelect
            aria-label="办公产物格式"
            value={createFormat}
            options={OFFICE_FORMAT_OPTIONS}
            onChange={(value) => {
              const next = value as OfficeArtifactFormat
              setCreateFormat(next)
              if (createName && Object.values(OFFICE_EXTENSION).some((extension) => createName.toLowerCase().endsWith(extension))) {
                setCreateName(createName.replace(/\.[^.]+$/, OFFICE_EXTENSION[next]))
              }
            }}
            size="xs"
          />
          <div className={styles.officeCreateFields}>
            <input data-office-create-field="title" value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="文档标题" />
            <input data-office-create-field="name" value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder={`文件名（可选，${OFFICE_EXTENSION[createFormat]}）`} />
            <textarea data-office-create-field="content" value={createContent} onChange={(event) => setCreateContent(event.target.value)} placeholder={createFormat === 'xlsx' ? '起始内容，每行写入一个单元格' : '起始内容（可选）'} />
          </div>
          <div className={styles.officeCreateActions}>
            <button type="button" onClick={() => setCreatingOffice(false)}>取消</button>
            <button type="button" data-office-create-action="confirm" disabled={createBusy} onClick={() => void createOfficeArtifact()}>
              {createBusy ? <IconLoader2 size={14} className={styles.wsFileSpinner} /> : <IconPlus size={14} />} 创建
            </button>
          </div>
        </section>
      )}
      <div className={styles.artifactList}>
        {loading ? (
          <div className={styles.artifactLibraryState}>正在读取产物…</div>
        ) : loadError ? (
          <div className={styles.artifactLibraryState}>产物库暂时不可用，请刷新重试。</div>
        ) : visibleItems.length === 0 ? (
          <div className={styles.artifactLibraryEmpty} data-artifact-empty="project">
            <IconArchive size={26} stroke={1.4} />
            <strong>{query.trim() ? '当前会话没有匹配的产物' : '当前会话还没有产物'}</strong>
            <span>{query.trim() ? '换一个关键词或类型试试。' : '当前会话生成或加入的产物会显示在这里。'}</span>
            {!query.trim() && !temporary && (
              <div className={styles.artifactEmptyActions}>
                <button type="button" onClick={() => setCreatingOffice(true)}>新建产物</button>
                {onOpenFiles && <button type="button" onClick={onOpenFiles}>打开文件栏</button>}
              </div>
            )}
          </div>
        ) : visibleItems.map((artifact) => (
          <button
            type="button"
            key={artifact.id}
            className={styles.artifactCard}
            data-artifact-id={artifact.id}
            onClick={() => setSelectedId(artifact.id)}
          >
            <span className={styles.artifactCardIcon}><ArtifactIcon artifact={artifact} /></span>
            <span className={styles.artifactCardCopy}>
              <strong>{artifact.name}</strong>
              <small>{artifact.description || sourceLabel(artifact.current_version)}</small>
              <span>{formatTime(artifact.current_version?.created_at || artifact.updated_at)}</span>
            </span>
            <span className={styles.artifactCardVersion}>v{artifact.current_version?.version_number || 0}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
