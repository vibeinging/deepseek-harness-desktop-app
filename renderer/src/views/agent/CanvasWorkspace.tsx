import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArrowLeft,
  IconBulb,
  IconCheck,
  IconCode,
  IconFileText,
  IconHistory,
  IconLoader2,
  IconMessage,
  IconPlus,
  IconRefresh,
  IconRestore,
  IconSparkles,
  IconX
} from '@tabler/icons-react'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import AppSelect from '@/components/AppSelect'
import {
  createAgentCanvas,
  decideAgentCanvasSuggestion,
  editAgentCanvas,
  getAgentCanvas,
  getAgentCanvasVersion,
  listAgentCanvases,
  restoreAgentCanvasVersion,
  type AgentCanvas,
  type AgentCanvasSuggestion,
  type AgentCanvasVersion
} from '@/api/agent'
import styles from './agent.module.scss'

export interface WorkspaceCanvasOpenRequest {
  sessionId: string
  canvasId: string
  nonce: number
}

export interface CanvasTextSelection {
  start: number
  end: number
  text: string
}

export interface WorkspaceCanvasReference {
  canvas: AgentCanvas
  selection: CanvasTextSelection
}

const KIND_OPTIONS = [
  { value: 'document', label: '文档' },
  { value: 'code', label: '代码' }
]

function formatTime(value?: string | null) {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function formatSize(size = 0) {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function versionSource(version: AgentCanvasVersion) {
  if (version.source_type === 'assistant') return 'DSH 创建'
  if (version.source_type === 'tool') return 'DSH 修改'
  if (version.source_type === 'restore') return '恢复历史'
  return '直接编辑'
}

function textDiff(before: string, after: string) {
  const left = before.split('\n')
  const right = after.split('\n')
  let prefix = 0
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < left.length - prefix && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1
  return {
    removed: left.slice(prefix, left.length - suffix),
    added: right.slice(prefix, right.length - suffix),
    unchanged: prefix === left.length && prefix === right.length
  }
}

function selectionFromTextarea(node: HTMLTextAreaElement | null): CanvasTextSelection | null {
  if (!node) return null
  const start = Number(node.selectionStart || 0)
  const end = Number(node.selectionEnd || 0)
  if (end <= start) return null
  return { start, end, text: node.value.slice(start, end) }
}

function requestErrorMessage(error: any, fallback: string) {
  return error?.response?.data?.message || error?.response?.data?.msg || error?.msg || error?.message || fallback
}

function isVersionConflict(error: any) {
  const message = requestErrorMessage(error, '')
  return Number(error?.response?.status || error?.status || 0) === 409 && /已经产生新版本|已经变化/.test(message)
}

export default function CanvasWorkspace({
  sessionId,
  initialCanvasId = null,
  openRequestNonce = null,
  onClose,
  onReference
}: {
  sessionId?: string | null
  initialCanvasId?: string | null
  openRequestNonce?: number | null
  onClose?: () => void
  onReference?: (reference: WorkspaceCanvasReference) => void
}) {
  const [items, setItems] = useState<AgentCanvas[]>([])
  const [listLoading, setListLoading] = useState(Boolean(sessionId))
  const [listError, setListError] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(initialCanvasId)
  const [detail, setDetail] = useState<AgentCanvas | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [selection, setSelection] = useState<CanvasTextSelection | null>(null)
  const [creating, setCreating] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createKind, setCreateKind] = useState<'document' | 'code'>('document')
  const [createLanguage, setCreateLanguage] = useState('')
  const [createContent, setCreateContent] = useState('')
  const [versionPreview, setVersionPreview] = useState<{ version: AgentCanvasVersion; content: string } | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)
  const [suggestionBusy, setSuggestionBusy] = useState<string | null>(null)
  const [versionConflict, setVersionConflict] = useState<AgentCanvas | null>(null)
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const handledOpenRequest = useRef<number | null>(null)

  const dirty = Boolean(detail && draft !== String(detail.content || ''))

  const loadList = useCallback(async () => {
    if (!sessionId) {
      setItems([])
      setListLoading(false)
      return
    }
    const requestId = ++listRequest.current
    setListLoading(true)
    setListError(false)
    try {
      const response: any = await listAgentCanvases(sessionId)
      if (listRequest.current !== requestId) return
      const next = response?.data?.items || response?.items || []
      setItems(Array.isArray(next) ? next.filter((item) => item?.kind !== 'site') : [])
    } catch {
      if (listRequest.current === requestId) {
        setItems([])
        setListError(true)
      }
    } finally {
      if (listRequest.current === requestId) setListLoading(false)
    }
  }, [sessionId])

  const loadDetail = useCallback(async (canvasId: string) => {
    if (!sessionId) return
    const requestId = ++detailRequest.current
    setDetailLoading(true)
    try {
      const response: any = await getAgentCanvas(sessionId, canvasId)
      if (detailRequest.current !== requestId) return
      const next: AgentCanvas | null = response?.data || response || null
      setDetail(next)
      setDraft(String(next?.content || ''))
      setSelection(null)
      setVersionPreview(null)
      setVersionConflict(null)
    } catch (error: any) {
      if (detailRequest.current === requestId) {
        setDetail(null)
        notifications.show({ color: 'red', message: error?.msg || '读取 Canvas 失败' })
      }
    } finally {
      if (detailRequest.current === requestId) setDetailLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    setSelectedId(initialCanvasId)
    setDetail(null)
    setDraft('')
    setCreating(false)
    setVersionConflict(null)
    void loadList()
  }, [loadList, sessionId])

  useEffect(() => {
    if (openRequestNonce == null) return
    const nonce = Number(openRequestNonce)
    if (!sessionId || !initialCanvasId || !Number.isFinite(nonce) || handledOpenRequest.current === nonce) return
    handledOpenRequest.current = nonce
    if (dirty) {
      if (selectedId !== initialCanvasId) {
        notifications.show({ color: 'orange', message: '当前 Canvas 还有未保存修改，已保留本地稿。新的 Canvas 可稍后从列表打开。' })
        return
      }
      const localDraft = draft
      void getAgentCanvas(sessionId, initialCanvasId).then((response: any) => {
        const next: AgentCanvas | null = response?.data || response || null
        if (!next) return
        setDetail(next)
        setDraft(localDraft)
        setSelection(null)
        setVersionPreview(null)
        if (next.current_version_id !== detail?.current_version_id) {
          setVersionConflict(next)
          notifications.show({ color: 'orange', message: `DSH 已保存 v${next.current_version?.version_number || ''}，你的本地稿仍保留，请选择如何处理。` })
        }
        void loadList()
      }).catch((error: any) => {
        notifications.show({ color: 'red', message: error?.msg || '刷新 Canvas 失败，本地稿仍保留' })
      })
      return
    }
    if (selectedId === initialCanvasId) void loadDetail(initialCanvasId)
    else setSelectedId(initialCanvasId)
  }, [detail?.current_version_id, dirty, draft, initialCanvasId, loadDetail, loadList, openRequestNonce, selectedId, sessionId])

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId)
  }, [loadDetail, selectedId])

  const createCanvas = async () => {
    if (!sessionId || createBusy) return
    setCreateBusy(true)
    try {
      const response: any = await createAgentCanvas(sessionId, {
        title: createTitle.trim() || undefined,
        kind: createKind,
        language: createKind === 'code' ? createLanguage.trim() || undefined : undefined,
        content: createContent,
        changeSummary: '创建 Canvas'
      })
      const canvas: AgentCanvas | null = response?.data?.canvas || response?.canvas || null
      if (!canvas) throw new Error('服务端没有返回 Canvas')
      setCreating(false)
      setCreateTitle('')
      setCreateLanguage('')
      setCreateContent('')
      setSelectedId(canvas.id)
      await loadList()
      notifications.show({ color: 'green', message: `已创建 Canvas「${canvas.title}」` })
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.msg || error?.message || '创建 Canvas 失败' })
    } finally {
      setCreateBusy(false)
    }
  }

  const save = async (resolveConflict = false) => {
    if (!(sessionId && detail?.current_version_id) || saving || !dirty || (versionConflict && !resolveConflict)) return
    const localDraft = draft
    setSaving(true)
    try {
      const response: any = await editAgentCanvas(sessionId, detail.id, {
        baseVersionId: detail.current_version_id,
        content: draft,
        changeSummary: '直接编辑 Canvas'
      })
      const next: AgentCanvas | null = response?.data?.canvas || null
      if (!next) throw new Error('服务端没有返回新版本')
      setDetail(next)
      setDraft(String(next.content || ''))
      setSelection(null)
      setVersionConflict(null)
      await loadList()
      notifications.show({ color: 'green', message: `已保存 v${next.current_version.version_number}` })
    } catch (error: any) {
      const message = requestErrorMessage(error, '保存 Canvas 失败')
      if (isVersionConflict(error)) {
        try {
          const response: any = await getAgentCanvas(sessionId, detail.id)
          const latest: AgentCanvas | null = response?.data || response || null
          if (!latest) throw new Error('服务端没有返回最新版本')
          setDetail(latest)
          setDraft(localDraft)
          setSelection(null)
          setVersionPreview(null)
          setVersionConflict(latest)
          await loadList()
          notifications.show({ color: 'orange', message: `Canvas 已更新到 v${latest.current_version?.version_number || ''}，你的本地稿仍保留，请选择如何处理。` })
        } catch (refreshError: any) {
          notifications.show({ color: 'red', message: requestErrorMessage(refreshError, '读取最新 Canvas 失败，本地稿仍保留') })
        }
      } else {
        notifications.show({ color: 'red', message })
      }
    } finally {
      setSaving(false)
    }
  }

  const updateSelection = () => setSelection(selectionFromTextarea(editorRef.current))

  const suggestWithDsh = () => {
    if (!detail) return
    const currentSelection = selectionFromTextarea(editorRef.current)
    if (!currentSelection) {
      notifications.show({ color: 'orange', message: '请先选择要建议的文字' })
      return
    }
    if (dirty) {
      notifications.show({ color: 'orange', message: '请先保存当前修改，再交给 DSH' })
      return
    }
    onReference?.({ canvas: detail, selection: currentSelection })
  }

  const decideSuggestion = async (suggestion: AgentCanvasSuggestion, decision: 'accept' | 'reject') => {
    if (!(sessionId && detail) || suggestionBusy) return
    if (dirty) {
      notifications.show({ color: 'orange', message: '请先处理未保存修改，再接受或拒绝建议' })
      return
    }
    setSuggestionBusy(suggestion.id)
    try {
      const response: any = await decideAgentCanvasSuggestion(sessionId, detail.id, suggestion.id, decision)
      const next: AgentCanvas | null = response?.data?.canvas || null
      if (next) {
        setDetail(next)
        setDraft(String(next.content || ''))
      } else {
        await loadDetail(detail.id)
      }
      await loadList()
      notifications.show({ color: 'green', message: decision === 'accept' ? '已接受建议并保存新版本' : '已拒绝建议' })
    } catch (error: any) {
      notifications.show({ color: 'orange', message: error?.msg || '处理建议失败' })
      await loadDetail(detail.id)
    } finally {
      setSuggestionBusy(null)
    }
  }

  const previewVersion = async (version: AgentCanvasVersion) => {
    if (!(sessionId && detail)) return
    if (version.id === detail.current_version_id) {
      setVersionPreview(null)
      return
    }
    setVersionLoading(true)
    try {
      const response: any = await getAgentCanvasVersion(sessionId, detail.id, version.id)
      const next = response?.data || response
      setVersionPreview({ version: next.version, content: String(next.content || '') })
    } catch (error: any) {
      notifications.show({ color: 'red', message: error?.msg || '读取历史版本失败' })
    } finally {
      setVersionLoading(false)
    }
  }

  const restoreVersion = (version: AgentCanvasVersion) => {
    if (!(sessionId && detail?.current_version_id)) return
    if (dirty) {
      notifications.show({ color: 'orange', message: '请先处理未保存修改，再恢复历史版本' })
      return
    }
    modals.openConfirmModal({
      title: `恢复 v${version.version_number}`,
      children: '恢复会创建一个新的当前版本，现有历史不会被覆盖。',
      labels: { confirm: '恢复为新版本', cancel: '取消' },
      confirmProps: { 'data-canvas-confirm-restore': 'true' },
      onConfirm: async () => {
        try {
          const response: any = await restoreAgentCanvasVersion(sessionId, detail.id, {
            baseVersionId: detail.current_version_id,
            versionId: version.id
          })
          const next: AgentCanvas | null = response?.data?.canvas || null
          if (!next) throw new Error('服务端没有返回新版本')
          setDetail(next)
          setDraft(String(next.content || ''))
          setVersionPreview(null)
          await loadList()
          notifications.show({ color: 'green', message: `已恢复为 v${next.current_version.version_number}` })
        } catch (error: any) {
          notifications.show({ color: 'orange', message: error?.msg || error?.message || '恢复失败' })
          await loadDetail(detail.id)
        }
      }
    })
  }

  const pendingSuggestions = useMemo(
    () => (detail?.suggestions || []).filter((item) => item.status === 'pending'),
    [detail?.suggestions]
  )
  const previewDiff = useMemo(
    () => versionPreview && detail ? textDiff(versionPreview.content, String(detail.content || '')) : null,
    [detail, versionPreview]
  )

  if (!sessionId) {
    return (
      <div className={styles.canvasEmpty} data-canvas-empty="conversation">
        <IconFileText size={27} stroke={1.35} />
        <strong>开始对话后使用 Canvas</strong>
        <span>长文和代码会在这里直接编辑并保留版本。</span>
        {onClose && <button type="button" onClick={onClose}>返回产物</button>}
      </div>
    )
  }

  if (!selectedId) {
    return (
      <div className={styles.canvasWorkspace} data-canvas-library={sessionId}>
        <div className={styles.canvasLibraryHead}>
          {onClose && (
            <button type="button" aria-label="返回项目产物" onClick={onClose}><IconArrowLeft size={15} /></button>
          )}
          <div><strong>Canvas</strong><span>当前对话的文档与代码</span></div>
          <button type="button" aria-label="新建 Canvas" onClick={() => setCreating((value) => !value)}>
            {creating ? <IconX size={15} /> : <IconPlus size={15} />}
          </button>
          <button type="button" aria-label="刷新 Canvas" onClick={() => void loadList()}><IconRefresh size={14} /></button>
        </div>
        {creating && (
          <section className={styles.canvasCreatePanel} data-canvas-create={createKind}>
            <div className={styles.canvasCreateRow}>
              <AppSelect aria-label="Canvas 类型" value={createKind} options={KIND_OPTIONS} onChange={(value) => setCreateKind(value as 'document' | 'code')} size="xs" />
              {createKind === 'code' && <input data-canvas-create-field="language" value={createLanguage} onChange={(event) => setCreateLanguage(event.target.value)} placeholder="语言，例如 TypeScript" />}
            </div>
            <input data-canvas-create-field="title" value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="标题（可选）" />
            <textarea data-canvas-create-field="content" value={createContent} onChange={(event) => setCreateContent(event.target.value)} placeholder={createKind === 'code' ? '输入代码，或创建后再编辑' : '输入正文，或创建后再编辑'} />
            <div className={styles.canvasCreateActions}>
              <button type="button" onClick={() => setCreating(false)}>取消</button>
              <button type="button" data-canvas-create-action="confirm" disabled={createBusy} onClick={() => void createCanvas()}>
                {createBusy ? <IconLoader2 size={14} className={styles.wsFileSpinner} /> : <IconPlus size={14} />} 创建
              </button>
            </div>
          </section>
        )}
        <div className={styles.canvasList}>
          {listLoading ? (
            <div className={styles.canvasState}><IconLoader2 size={15} className={styles.wsFileSpinner} /> 正在读取 Canvas…</div>
          ) : listError ? (
            <div className={styles.canvasState}>Canvas 暂时不可用，请刷新重试。</div>
          ) : items.length === 0 ? (
            <div className={styles.canvasEmpty} data-canvas-empty="list">
              <IconSparkles size={26} stroke={1.35} />
              <strong>这段对话还没有 Canvas</strong>
              <span>长回答会自动进入这里，也可以先新建空白文档或代码。</span>
              <button type="button" onClick={() => setCreating(true)}>新建 Canvas</button>
            </div>
          ) : items.map((canvas) => (
            <button type="button" key={canvas.id} className={styles.canvasCard} data-canvas-id={canvas.id} onClick={() => setSelectedId(canvas.id)}>
              <span className={styles.canvasCardIcon}>{canvas.kind === 'code' ? <IconCode size={16} /> : <IconFileText size={16} />}</span>
              <span className={styles.canvasCardCopy}>
                <strong>{canvas.title}</strong>
                <small>{canvas.kind === 'code' ? canvas.language || '代码' : '文档'} · {canvas.version_count} 个版本</small>
                <span>{formatTime(canvas.updated_at)}</span>
              </span>
              {canvas.pending_suggestion_count > 0 && <em>{canvas.pending_suggestion_count} 条建议</em>}
              <b>v{canvas.current_version?.version_number || 0}</b>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.canvasWorkspace} data-canvas-editor={selectedId}>
      <div className={styles.canvasEditorHead}>
        <button
          type="button"
          aria-label="返回 Canvas 列表"
          onClick={() => {
            if (dirty && !window.confirm('当前修改尚未保存，仍要返回吗？')) return
            setSelectedId(null)
            setDetail(null)
          }}
        ><IconArrowLeft size={15} /></button>
        <div>
          <strong>{detail?.title || 'Canvas'}</strong>
          <span>{detail ? `${detail.kind === 'code' ? detail.language || '代码' : '文档'} · v${detail.current_version?.version_number || 0}` : '读取中…'}</span>
        </div>
        <span className={styles.canvasSaveState} data-dirty={dirty ? 'true' : undefined}>{dirty ? '未保存' : '已保存'}</span>
        <button type="button" aria-label="刷新 Canvas" title={dirty ? '请先处理未保存修改' : '刷新 Canvas'} disabled={!detail || detailLoading || dirty} onClick={() => detail && void loadDetail(detail.id)}><IconRefresh size={14} /></button>
      </div>
      {detailLoading && !detail ? (
        <div className={styles.canvasState}><IconLoader2 size={15} className={styles.wsFileSpinner} /> 正在读取 Canvas…</div>
      ) : !detail ? (
        <div className={styles.canvasState}>Canvas 不存在或无权限</div>
      ) : (
        <div className={styles.canvasEditorBody}>
          <div className={styles.canvasEditorActions}>
            <button type="button" disabled={!dirty || saving || Boolean(versionConflict)} data-canvas-action="save" onClick={() => void save()}>
              {saving ? <IconLoader2 size={14} className={styles.wsFileSpinner} /> : <IconCheck size={14} />} 保存新版本
            </button>
            <button type="button" disabled={dirty || !selection} data-canvas-action="suggest" onClick={suggestWithDsh}>
              <IconBulb size={14} /> 行内建议
            </button>
          </div>
          {versionConflict && (
            <section className={styles.canvasConflict} data-canvas-conflict={versionConflict.current_version?.version_number || 'latest'}>
              <div>
                <strong>Canvas 已有新版本</strong>
                <span>你的本地稿仍保留。可以改用 v{versionConflict.current_version?.version_number || ''}，或明确把本地稿另存为下一版。</span>
              </div>
              <footer>
                <button
                  type="button"
                  data-canvas-conflict-action="latest"
                  onClick={() => {
                    setDraft(String(versionConflict.content || ''))
                    setSelection(null)
                    setVersionConflict(null)
                  }}
                >使用最新版本</button>
                <button type="button" data-canvas-conflict-action="local" disabled={saving} onClick={() => void save(true)}>
                  {saving ? <IconLoader2 size={13} className={styles.wsFileSpinner} /> : <IconCheck size={13} />} 本地稿另存新版本
                </button>
              </footer>
            </section>
          )}
          {selection && (
            <div className={styles.canvasSelection} data-canvas-selection={`${selection.start}:${selection.end}`}>
              已选择 {selection.end - selection.start} 个字符
              <span>{selection.text.replace(/\s+/g, ' ').slice(0, 90)}</span>
            </div>
          )}
          <textarea
            ref={editorRef}
            className={styles.canvasTextEditor}
            data-canvas-kind={detail.kind}
            aria-label={`${detail.title}正文`}
            spellCheck={detail.kind !== 'code'}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
              setSelection(null)
            }}
            onSelect={updateSelection}
            onKeyUp={updateSelection}
            onMouseUp={updateSelection}
          />
          {pendingSuggestions.length > 0 && (
            <section className={styles.canvasSuggestions}>
              <div className={styles.canvasSectionTitle}><span><IconMessage size={14} /> 行内建议</span><small>{pendingSuggestions.length} 条待处理</small></div>
              {pendingSuggestions.map((suggestion) => (
                <article key={suggestion.id} data-canvas-suggestion={suggestion.id}>
                  <p>{suggestion.instruction || 'DSH 建议修改这段内容'}</p>
                  <div><del>{suggestion.selected_text || '空'}</del><ins>{suggestion.replacement_text || '删除'}</ins></div>
                  <footer>
                    <button type="button" disabled={dirty || suggestionBusy === suggestion.id} onClick={() => void decideSuggestion(suggestion, 'reject')}><IconX size={13} /> 拒绝</button>
                    <button type="button" disabled={dirty || suggestionBusy === suggestion.id} data-canvas-suggestion-action="accept" onClick={() => void decideSuggestion(suggestion, 'accept')}><IconCheck size={13} /> 接受</button>
                  </footer>
                </article>
              ))}
            </section>
          )}
          {versionPreview && previewDiff && (
            <section className={styles.canvasVersionPreview} data-canvas-version-preview={versionPreview.version.version_number}>
              <div className={styles.canvasSectionTitle}>
                <span>v{versionPreview.version.version_number} 与当前版本</span>
                <button type="button" onClick={() => setVersionPreview(null)} aria-label="关闭版本预览"><IconX size={13} /></button>
              </div>
              {previewDiff.unchanged ? <p>内容相同</p> : (
                <div className={styles.canvasDiffLines}>
                  {previewDiff.removed.map((line, index) => <del key={`r-${index}`}>- {line || ' '}</del>)}
                  {previewDiff.added.map((line, index) => <ins key={`a-${index}`}>+ {line || ' '}</ins>)}
                </div>
              )}
              <pre>{versionPreview.content || '空白版本'}</pre>
              <button type="button" data-canvas-action="restore" disabled={dirty} onClick={() => restoreVersion(versionPreview.version)}><IconRestore size={13} /> 恢复此版本</button>
            </section>
          )}
          <section className={styles.canvasVersions}>
            <div className={styles.canvasSectionTitle}><span><IconHistory size={14} /> 版本历史</span><small>恢复不会覆盖历史</small></div>
            {(detail.versions || []).map((version) => (
              <button
                type="button"
                key={version.id}
                data-canvas-version={version.version_number}
                data-active={version.id === detail.current_version_id ? 'true' : undefined}
                disabled={versionLoading}
                onClick={() => void previewVersion(version)}
              >
                <b>v{version.version_number}</b>
                <span><strong>{version.change_summary || '更新 Canvas'}</strong><small>{versionSource(version)} · {formatTime(version.created_at)} · {formatSize(version.size_bytes)}</small></span>
                {version.id === detail.current_version_id && <em>当前</em>}
              </button>
            ))}
          </section>
        </div>
      )}
    </div>
  )
}
