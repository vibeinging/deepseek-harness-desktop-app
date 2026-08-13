import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconArrowLeft,
  IconCheck,
  IconCode,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconDeviceTablet,
  IconDownload,
  IconHistory,
  IconLoader2,
  IconMouse,
  IconPlus,
  IconRefresh,
  IconRestore,
  IconSend,
  IconSparkles,
  IconWorld
} from '@tabler/icons-react'
import { modals } from '@mantine/modals'
import { notifications } from '@mantine/notifications'
import {
  createAgentCanvas,
  editAgentCanvas,
  getAgentCanvas,
  getAgentCanvasVersion,
  listAgentCanvases,
  restoreAgentCanvasVersion,
  type AgentCanvas,
  type AgentCanvasVersion
} from '@/api/agent'
import styles from './SiteWorkspace.module.scss'

export const SITE_PREVIEW_CHANNEL = 'dsh-local-site-preview-v1'

export interface WorkspaceSiteOpenRequest {
  sessionId: string
  siteId: string
  nonce: number
}

export interface SiteElementSelection {
  selector: string
  tag: string
  text: string
  ariaLabel: string
  bounds: { x: number; y: number; width: number; height: number }
}

export interface WorkspaceSiteReference {
  site: AgentCanvas
  version: AgentCanvasVersion
  selection?: SiteElementSelection | null
}

type PreviewViewport = 'desktop' | 'tablet' | 'mobile'
type ViewMode = 'preview' | 'source'

const MAX_SELECTION_SELECTOR = 600
const MAX_SELECTION_TEXT = 600
const MAX_SELECTION_LABEL = 300

const DEFAULT_SITE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>我的本地 Site</title>
  <style>
    :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #292531; background: #f5f2fa; }
    main { width: min(620px, calc(100% - 40px)); padding: 44px; border: 1px solid #ded7e8; border-radius: 22px; background: #fcfaff; }
    p { color: #6f6878; line-height: 1.7; }
    button { border: 0; border-radius: 10px; padding: 11px 18px; color: #fff; background: #6750a4; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <p>本地 Site</p>
    <h1>从一个可交互页面开始</h1>
    <p id="status">页面运行在断网沙箱中，可以放心预览和标注。</p>
    <button id="site-action" type="button">点一下</button>
  </main>
  <script>
    document.querySelector('#site-action').addEventListener('click', () => {
      document.querySelector('#status').textContent = '交互已经生效。接下来可以选择元素，让 DSH 继续修改。';
    });
  </script>
</body>
</html>`

function cleanText(value: unknown, maxLength: number) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

function finiteNumber(value: unknown) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return Math.max(-100_000, Math.min(100_000, number))
}

export function normalizeSiteElementSelection(value: unknown): SiteElementSelection | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, any>
  const rawSelector = String(input.selector ?? '').trim()
  if (rawSelector.length > MAX_SELECTION_SELECTOR) return null
  const selector = cleanText(input.selector, MAX_SELECTION_SELECTOR)
  const tag = cleanText(input.tag, 80).toLowerCase()
  const text = cleanText(input.text, MAX_SELECTION_TEXT)
  const ariaLabel = cleanText(input.ariaLabel, MAX_SELECTION_LABEL)
  if (!selector || selector.length > MAX_SELECTION_SELECTOR || !/^[a-z][a-z0-9-]*$/i.test(tag)) return null
  const rawBounds = input.bounds && typeof input.bounds === 'object' ? input.bounds : {}
  const x = finiteNumber(rawBounds.x)
  const y = finiteNumber(rawBounds.y)
  const width = finiteNumber(rawBounds.width)
  const height = finiteNumber(rawBounds.height)
  if ([x, y, width, height].some((item) => item == null) || Number(width) < 0 || Number(height) < 0) return null
  return {
    selector,
    tag,
    text,
    ariaLabel,
    bounds: { x: Number(x), y: Number(y), width: Number(width), height: Number(height) }
  }
}

function previewRuntime(token: string) {
  const safeToken = JSON.stringify(token).replace(/</g, '\\u003c')
  const safeChannel = JSON.stringify(SITE_PREVIEW_CHANNEL)
  return `<style>
html[data-dsh-annotate="true"] * { cursor: crosshair !important; }
html[data-dsh-annotate="true"] [data-dsh-site-hover="true"] { outline: 2px solid #7656b8 !important; outline-offset: 2px !important; }
</style>
<script>
(() => {
  const channel = ${safeChannel};
  const token = ${safeToken};
  let annotationEnabled = false;
  let hovered = null;
  const send = (type, payload = {}) => window.parent.postMessage({ channel, token, type, ...payload }, '*');
  const escapeCss = (value) => window.CSS && typeof window.CSS.escape === 'function'
    ? window.CSS.escape(value)
    : String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => '\\\\' + char);
  const selectorFor = (element) => {
    if (element.id) return '#' + escapeCss(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.documentElement) {
      if (current.id) {
        parts.unshift('#' + escapeCss(current.id));
        break;
      }
      let part = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (parent) {
        const sameTag = [...parent.children].filter((child) => child.tagName === current.tagName);
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      }
      parts.unshift(part);
      if (current === document.body) break;
      current = parent;
    }
    return parts.join(' > ');
  };
  const clearHover = () => {
    if (hovered) hovered.removeAttribute('data-dsh-site-hover');
    hovered = null;
  };
  document.addEventListener('submit', (event) => event.preventDefault(), true);
  document.addEventListener('mouseover', (event) => {
    if (!annotationEnabled || !(event.target instanceof Element)) return;
    clearHover();
    hovered = event.target;
    hovered.setAttribute('data-dsh-site-hover', 'true');
  }, true);
  document.addEventListener('mouseout', () => {
    if (annotationEnabled) clearHover();
  }, true);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const link = target?.closest('a[href]');
    if (link && !String(link.getAttribute('href') || '').startsWith('#')) event.preventDefault();
    if (!annotationEnabled || !target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = target.getBoundingClientRect();
    send('element-selected', {
      selection: {
        selector: selectorFor(target),
        tag: target.tagName.toLowerCase(),
        text: String(target.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, ${MAX_SELECTION_TEXT}),
        ariaLabel: String(target.getAttribute('aria-label') || '').trim().slice(0, ${MAX_SELECTION_LABEL}),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      }
    });
  }, true);
  window.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.channel !== channel || data.token !== token || data.type !== 'annotation-mode') return;
    annotationEnabled = data.enabled === true;
    document.documentElement.dataset.dshAnnotate = annotationEnabled ? 'true' : 'false';
    if (!annotationEnabled) clearHover();
  });
  send('preview-ready');
})();
</script>`
}

export function buildSitePreviewDocument(content: string, token: string) {
  const csp = "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
  const security = `<meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">${previewRuntime(token)}`
  const source = String(content || '')
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*http-equiv\s*=\s*(?:"content-security-policy"|'content-security-policy'|content-security-policy)[^>]*>/gi, '')
  if (/<head(?:\s[^>]*)?>/i.test(source)) {
    return source.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${security}`)
  }
  if (/<html(?:\s[^>]*)?>/i.test(source)) {
    return source.replace(/<html(?:\s[^>]*)?>/i, (html) => `${html}<head>${security}</head>`)
  }
  return `<!doctype html><html lang="zh-CN"><head>${security}</head><body>${source}</body></html>`
}

function makePreviewToken() {
  try { return crypto.randomUUID() } catch { return `${Date.now()}-${Math.random().toString(36).slice(2)}` }
}

function formatTime(value?: string | null) {
  if (!value) return '时间未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function requestErrorMessage(error: any, fallback: string) {
  return error?.response?.data?.message || error?.response?.data?.msg || error?.msg || error?.message || fallback
}

function isVersionConflict(error: any) {
  return Number(error?.response?.status || error?.status || 0) === 409 && /已经产生新版本|已经变化/.test(requestErrorMessage(error, ''))
}

function safeExportName(title: string) {
  const name = String(title || '本地-Site').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim().slice(0, 100) || '本地-Site'
  return name.toLowerCase().endsWith('.html') ? name : `${name}.html`
}

function sourceLabel(version: AgentCanvasVersion) {
  if (version.source_type === 'tool') return 'DSH 修改'
  if (version.source_type === 'assistant') return 'DSH 创建'
  if (version.source_type === 'restore') return '恢复历史'
  return '直接编辑'
}

export default function SiteWorkspace({
  sessionId,
  openRequest,
  onReference
}: {
  sessionId?: string | null
  openRequest?: WorkspaceSiteOpenRequest | null
  onReference?: (reference: WorkspaceSiteReference) => void
}) {
  const [items, setItems] = useState<AgentCanvas[]>([])
  const [listLoading, setListLoading] = useState(Boolean(sessionId))
  const [listError, setListError] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<AgentCanvas | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createContent, setCreateContent] = useState(DEFAULT_SITE_HTML)
  const [createBusy, setCreateBusy] = useState(false)
  const [draft, setDraft] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('preview')
  const [viewport, setViewport] = useState<PreviewViewport>('desktop')
  const [annotationEnabled, setAnnotationEnabled] = useState(false)
  const [selection, setSelection] = useState<SiteElementSelection | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<{ version: AgentCanvasVersion; content: string } | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [versionConflict, setVersionConflict] = useState<AgentCanvas | null>(null)
  const [previewToken, setPreviewToken] = useState(makePreviewToken)
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const listRequest = useRef(0)
  const detailRequest = useRef(0)
  const handledOpenRequest = useRef<number | null>(null)

  const historical = Boolean(selectedVersion && selectedVersion.version.id !== detail?.current_version_id)
  const dirty = Boolean(detail && !historical && draft !== String(detail.content || ''))
  const visibleVersion = selectedVersion?.version || detail?.current_version || null
  const visibleContent = selectedVersion?.content ?? draft
  const previewDocument = useMemo(
    () => buildSitePreviewDocument(visibleContent, previewToken),
    [previewToken, visibleContent]
  )

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
      if (requestId !== listRequest.current) return
      const next = response?.data?.items || response?.items || []
      setItems(Array.isArray(next) ? next.filter((item) => item?.kind === 'site') : [])
    } catch {
      if (requestId === listRequest.current) {
        setItems([])
        setListError(true)
      }
    } finally {
      if (requestId === listRequest.current) setListLoading(false)
    }
  }, [sessionId])

  const loadDetail = useCallback(async (siteId: string, keepDraft = false) => {
    if (!sessionId) return
    const requestId = ++detailRequest.current
    setDetailLoading(true)
    try {
      const response: any = await getAgentCanvas(sessionId, siteId)
      if (requestId !== detailRequest.current) return
      const next: AgentCanvas | null = response?.data || response || null
      if (!next || next.kind !== 'site') throw new Error('这不是本地 Site')
      setDetail(next)
      if (!keepDraft) setDraft(String(next.content || ''))
      setSelectedVersion(null)
      setSelection(null)
      setVersionConflict(null)
      setPreviewToken(makePreviewToken())
    } catch (error: any) {
      if (requestId === detailRequest.current) {
        setDetail(null)
        notifications.show({ color: 'red', message: requestErrorMessage(error, '读取 Site 失败') })
      }
    } finally {
      if (requestId === detailRequest.current) setDetailLoading(false)
    }
  }, [sessionId])

  useEffect(() => {
    setSelectedId(null)
    setDetail(null)
    setDraft('')
    setCreating(false)
    setSelection(null)
    setSelectedVersion(null)
    setVersionConflict(null)
    void loadList()
  }, [loadList, sessionId])

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId)
  }, [loadDetail, selectedId])

  useEffect(() => {
    if (!openRequest || !sessionId || openRequest.sessionId !== sessionId || handledOpenRequest.current === openRequest.nonce) return
    handledOpenRequest.current = openRequest.nonce
    if (dirty && selectedId !== openRequest.siteId) {
      notifications.show({ color: 'orange', message: '当前 Site 还有未保存源码，新的 Site 可稍后从列表打开。' })
      return
    }
    if (selectedId === openRequest.siteId) void loadDetail(openRequest.siteId, dirty)
    else setSelectedId(openRequest.siteId)
  }, [dirty, loadDetail, openRequest, selectedId, sessionId])

  const sendAnnotationMode = useCallback(() => {
    iframeRef.current?.contentWindow?.postMessage({
      channel: SITE_PREVIEW_CHANNEL,
      token: previewToken,
      type: 'annotation-mode',
      enabled: annotationEnabled
    }, '*')
  }, [annotationEnabled, previewToken])

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      const data = event.data && typeof event.data === 'object' ? event.data : null
      if (!data || data.channel !== SITE_PREVIEW_CHANNEL || data.token !== previewToken) return
      if (data.type === 'preview-ready') {
        sendAnnotationMode()
        return
      }
      if (data.type !== 'element-selected') return
      const next = normalizeSiteElementSelection(data.selection)
      if (next) setSelection(next)
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [previewToken, sendAnnotationMode])

  useEffect(() => {
    sendAnnotationMode()
  }, [sendAnnotationMode])

  const createSite = async () => {
    if (!sessionId || createBusy) return
    setCreateBusy(true)
    try {
      const response: any = await createAgentCanvas(sessionId, {
        title: createTitle.trim() || undefined,
        kind: 'site',
        language: 'html',
        content: createContent,
        changeSummary: '创建本地 Site'
      })
      const site: AgentCanvas | null = response?.data?.canvas || response?.canvas || null
      if (!site) throw new Error('服务端没有返回 Site')
      setCreating(false)
      setCreateTitle('')
      setCreateContent(DEFAULT_SITE_HTML)
      await loadList()
      setSelectedId(site.id)
      notifications.show({ color: 'green', message: `已创建本地 Site「${site.title}」` })
    } catch (error: any) {
      notifications.show({ color: 'red', message: requestErrorMessage(error, '创建 Site 失败') })
    } finally {
      setCreateBusy(false)
    }
  }

  const saveSource = async (forceLatest = false) => {
    if (!sessionId || !detail || saving || historical) return
    const baseVersionId = forceLatest ? versionConflict?.current_version_id : detail.current_version_id
    if (!baseVersionId) return
    setSaving(true)
    try {
      const response: any = await editAgentCanvas(sessionId, detail.id, {
        baseVersionId,
        content: draft,
        changeSummary: '直接编辑 Site 源码'
      })
      const next: AgentCanvas | null = response?.data?.canvas || response?.canvas || null
      if (!next) throw new Error('服务端没有返回新版本')
      setDetail(next)
      setDraft(String(next.content || ''))
      setSelectedVersion(null)
      setVersionConflict(null)
      setSelection(null)
      setPreviewToken(makePreviewToken())
      await loadList()
      notifications.show({ color: 'green', message: `已保存 v${next.current_version?.version_number || ''}` })
    } catch (error: any) {
      if (isVersionConflict(error)) {
        const localDraft = draft
        try {
          const response: any = await getAgentCanvas(sessionId, detail.id)
          const latest: AgentCanvas | null = response?.data || response || null
          if (latest) {
            setDetail(latest)
            setDraft(localDraft)
            setVersionConflict(latest)
          }
        } catch { /* Keep the local draft and surface the original conflict. */ }
        notifications.show({ color: 'orange', message: 'Site 已有新版本，本地源码仍保留，请选择如何处理。' })
      } else {
        notifications.show({ color: 'red', message: requestErrorMessage(error, '保存 Site 失败') })
      }
    } finally {
      setSaving(false)
    }
  }

  const openVersion = async (version: AgentCanvasVersion) => {
    if (!sessionId || !detail || versionLoading) return
    if (dirty && !window.confirm('当前源码尚未保存，仍要查看历史版本吗？')) return
    if (version.id === detail.current_version_id) {
      setSelectedVersion(null)
      setDraft(String(detail.content || ''))
      setSelection(null)
      setPreviewToken(makePreviewToken())
      return
    }
    setVersionLoading(true)
    try {
      const response: any = await getAgentCanvasVersion(sessionId, detail.id, version.id)
      const next = response?.data || response || null
      if (!next?.version || typeof next.content !== 'string') throw new Error('版本内容不可用')
      setSelectedVersion({ version: next.version, content: next.content })
      setSelection(null)
      setPreviewToken(makePreviewToken())
    } catch (error: any) {
      notifications.show({ color: 'red', message: requestErrorMessage(error, '读取 Site 版本失败') })
    } finally {
      setVersionLoading(false)
    }
  }

  const restoreVersion = () => {
    if (!sessionId || !detail || !selectedVersion || restoring) return
    modals.openConfirmModal({
      title: `恢复 v${selectedVersion.version.version_number}`,
      children: '恢复会创建一个新的当前版本，已有版本不会被覆盖。',
      labels: { confirm: '恢复为新版本', cancel: '取消' },
      confirmProps: { 'data-site-confirm-restore': 'true' },
      onConfirm: async () => {
        setRestoring(true)
        try {
          const response: any = await restoreAgentCanvasVersion(sessionId, detail.id, {
            baseVersionId: detail.current_version_id,
            versionId: selectedVersion.version.id,
            changeSummary: `恢复 Site v${selectedVersion.version.version_number}`
          })
          const next: AgentCanvas | null = response?.data?.canvas || response?.canvas || null
          if (!next) throw new Error('服务端没有返回恢复结果')
          setDetail(next)
          setDraft(String(next.content || ''))
          setSelectedVersion(null)
          setSelection(null)
          setPreviewToken(makePreviewToken())
          await loadList()
          notifications.show({ color: 'green', message: `已恢复为新版本 v${next.current_version?.version_number || ''}` })
        } catch (error: any) {
          notifications.show({ color: 'red', message: requestErrorMessage(error, '恢复 Site 失败') })
        } finally {
          setRestoring(false)
        }
      }
    })
  }

  const exportSite = async () => {
    if (!detail || !visibleVersion || exporting) return
    setExporting(true)
    try {
      const api = (window as any).electronAPI
      if (typeof api?.exportLocalSite === 'function') {
        const result = await api.exportLocalSite({ title: detail.title, content: visibleContent })
        if (result) notifications.show({ color: 'green', message: `已导出 ${result.name || safeExportName(detail.title)}` })
        return
      }
      const blob = new Blob([visibleContent], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = safeExportName(detail.title)
      anchor.click()
      URL.revokeObjectURL(url)
      notifications.show({ color: 'green', message: `已导出 ${anchor.download}` })
    } catch (error: any) {
      notifications.show({ color: 'red', message: requestErrorMessage(error, '导出 Site 失败') })
    } finally {
      setExporting(false)
    }
  }

  if (!sessionId) {
    return (
      <div className={styles.root} data-site-workspace="none">
        <div className={styles.state}>
          <IconWorld size={28} stroke={1.35} />
          <strong>开始对话后使用 Site</strong>
          <span>Site 属于当前对话，用来保存本地交互页面和版本。</span>
        </div>
      </div>
    )
  }

  if (!selectedId) {
    return (
      <div className={styles.root} data-site-workspace={sessionId} data-site-library={sessionId}>
        <header className={styles.libraryHead}>
          <div><strong>Site</strong><span>本地交互页面</span></div>
          <button type="button" aria-label="新建 Site" onClick={() => setCreating((value) => !value)}><IconPlus size={15} /></button>
        </header>
        {creating && (
          <section className={styles.create} data-site-create>
            <input data-site-create-field="title" value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="Site 标题（可选）" />
            <textarea data-site-create-field="content" value={createContent} onChange={(event) => setCreateContent(event.target.value)} aria-label="Site 初始 HTML" />
            <footer>
              <button type="button" onClick={() => setCreating(false)}>取消</button>
              <button type="button" data-site-create-action="confirm" disabled={createBusy} onClick={() => void createSite()}>
                {createBusy ? <IconLoader2 size={14} className={styles.spinner} /> : <IconPlus size={14} />} 创建
              </button>
            </footer>
          </section>
        )}
        <div className={styles.libraryList}>
          {listLoading ? (
            <div className={styles.state}><IconLoader2 size={16} className={styles.spinner} /> 正在读取 Site…</div>
          ) : listError ? (
            <div className={styles.state}><strong>Site 暂时不可用</strong><button type="button" onClick={() => void loadList()}>重新读取</button></div>
          ) : items.length === 0 ? (
            <div className={styles.state} data-site-empty>
              <IconSparkles size={28} stroke={1.35} />
              <strong>把页面留在对话旁边</strong>
              <span>DSH 创建的交互页面会出现在这里，也可以先建一个空白页面。</span>
              <button type="button" onClick={() => setCreating(true)}>新建 Site</button>
            </div>
          ) : items.map((site) => (
            <button type="button" key={site.id} className={styles.siteCard} data-site-id={site.id} onClick={() => setSelectedId(site.id)}>
              <span className={styles.siteCardIcon}><IconWorld size={16} /></span>
              <span><strong>{site.title}</strong><small>v{site.current_version?.version_number || 0} · {site.version_count} 个版本</small><em>{formatTime(site.updated_at)}</em></span>
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className={styles.root} data-site-workspace={sessionId} data-site-editor={selectedId}>
      <header className={styles.editorHead}>
        <button
          type="button"
          aria-label="返回 Site 列表"
          onClick={() => {
            if (dirty && !window.confirm('当前源码尚未保存，仍要返回吗？')) return
            setSelectedId(null)
            setDetail(null)
            setSelection(null)
          }}
        ><IconArrowLeft size={15} /></button>
        <div><strong>{detail?.title || 'Site'}</strong><span>{visibleVersion ? `v${visibleVersion.version_number}${historical ? ' · 历史预览' : ''}` : '读取中…'}</span></div>
        {dirty && <em>未保存</em>}
        <button type="button" aria-label="刷新 Site" disabled={!detail || detailLoading || dirty} onClick={() => detail && void loadDetail(detail.id)}><IconRefresh size={14} /></button>
      </header>

      {detailLoading && !detail ? (
        <div className={styles.state}><IconLoader2 size={16} className={styles.spinner} /> 正在读取 Site…</div>
      ) : !detail || !visibleVersion ? (
        <div className={styles.state}>Site 不存在或无权限</div>
      ) : (
        <div className={styles.editorBody}>
          <div className={styles.modeBar}>
            <div className={styles.segmented} aria-label="Site 视图">
              <button type="button" data-site-view="preview" data-active={viewMode === 'preview' ? 'true' : undefined} onClick={() => setViewMode('preview')}><IconWorld size={13} /> 预览</button>
              <button type="button" data-site-view="source" data-active={viewMode === 'source' ? 'true' : undefined} onClick={() => setViewMode('source')}><IconCode size={13} /> 源码</button>
            </div>
            <button
              type="button"
              className={styles.annotationButton}
              data-site-action="annotate"
              data-active={annotationEnabled ? 'true' : undefined}
              aria-pressed={annotationEnabled}
              disabled={viewMode !== 'preview'}
              onClick={() => setAnnotationEnabled((value) => !value)}
            ><IconMouse size={14} /> 选择元素</button>
            <button type="button" data-site-action="export" disabled={exporting} onClick={() => void exportSite()}>
              {exporting ? <IconLoader2 size={14} className={styles.spinner} /> : <IconDownload size={14} />} 导出
            </button>
          </div>

          {versionConflict && (
            <section className={styles.conflict} data-site-conflict>
              <div><strong>Site 已有新版本</strong><span>本地源码仍保留。选择最新版本，或把本地源码另存为下一版。</span></div>
              <footer>
                <button type="button" data-site-conflict-action="latest" onClick={() => {
                  setDraft(String(versionConflict.content || ''))
                  setDetail(versionConflict)
                  setVersionConflict(null)
                }}>使用最新版本</button>
                <button type="button" data-site-conflict-action="local" disabled={saving} onClick={() => void saveSource(true)}>本地源码另存</button>
              </footer>
            </section>
          )}

          {viewMode === 'preview' ? (
            <section className={styles.previewArea} data-site-preview>
              <div className={styles.viewportBar} aria-label="预览宽度">
                <button type="button" title="桌面" aria-label="桌面宽度" data-active={viewport === 'desktop' ? 'true' : undefined} onClick={() => setViewport('desktop')}><IconDeviceDesktop size={14} /></button>
                <button type="button" title="平板" aria-label="平板宽度" data-active={viewport === 'tablet' ? 'true' : undefined} onClick={() => setViewport('tablet')}><IconDeviceTablet size={14} /></button>
                <button type="button" title="手机" aria-label="手机宽度" data-active={viewport === 'mobile' ? 'true' : undefined} onClick={() => setViewport('mobile')}><IconDeviceMobile size={14} /></button>
                <span>断网沙箱 · {viewport === 'desktop' ? '自适应' : viewport === 'tablet' ? '768 px' : '390 px'}</span>
              </div>
              <div className={styles.previewScroll}>
                <iframe
                  ref={iframeRef}
                  className={styles.previewFrame}
                  data-site-preview-frame
                  data-viewport={viewport}
                  title={`${detail.title}本地预览`}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  srcDoc={previewDocument}
                  onLoad={sendAnnotationMode}
                />
              </div>
            </section>
          ) : (
            <section className={styles.sourceArea}>
              <textarea
                data-site-source-editor
                aria-label={`${detail.title} HTML 源码`}
                spellCheck={false}
                readOnly={historical}
                value={historical ? visibleContent : draft}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setSelection(null)
                }}
              />
              <footer>
                <span>{historical ? '历史版本只读，恢复后再编辑' : `${new Blob([draft]).size.toLocaleString('zh-CN')} 字节`}</span>
                <button type="button" data-site-action="save" disabled={historical || !dirty || saving || Boolean(versionConflict)} onClick={() => void saveSource()}>
                  {saving ? <IconLoader2 size={14} className={styles.spinner} /> : <IconCheck size={14} />} 保存新版本
                </button>
              </footer>
            </section>
          )}

          {selection && (
            <section className={styles.selection} data-site-selection={selection.selector}>
              <div><strong>{selection.tag}</strong><code>{selection.selector}</code></div>
              <p>{selection.text || selection.ariaLabel || '这个元素没有可见文字'}</p>
              <button
                type="button"
                data-site-action="ask"
                disabled={dirty}
                onClick={() => onReference?.({ site: detail, version: visibleVersion, selection })}
              ><IconSend size={14} /> 让 DSH 修改</button>
            </section>
          )}

          <section className={styles.versions}>
            <div className={styles.sectionTitle}><span><IconHistory size={14} /> 版本</span><small>恢复会创建新版本</small></div>
            <div className={styles.versionList}>
              {(detail.versions || []).map((version) => (
                <button
                  type="button"
                  key={version.id}
                  data-site-version={version.version_number}
                  data-active={visibleVersion.id === version.id ? 'true' : undefined}
                  disabled={versionLoading}
                  onClick={() => void openVersion(version)}
                >
                  <b>v{version.version_number}</b>
                  <span><strong>{version.change_summary || '更新 Site'}</strong><small>{sourceLabel(version)} · {formatTime(version.created_at)}</small></span>
                  {version.id === detail.current_version_id && <em>当前</em>}
                </button>
              ))}
            </div>
            {historical && (
              <button type="button" className={styles.restoreButton} data-site-action="restore" disabled={restoring} onClick={restoreVersion}>
                {restoring ? <IconLoader2 size={14} className={styles.spinner} /> : <IconRestore size={14} />} 恢复 v{selectedVersion?.version.version_number}
              </button>
            )}
          </section>
        </div>
      )}
    </div>
  )
}
