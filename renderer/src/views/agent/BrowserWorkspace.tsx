import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  IconAlertTriangle,
  IconArrowLeft,
  IconArrowRight,
  IconCamera,
  IconChevronDown,
  IconChevronUp,
  IconCode,
  IconDotsVertical,
  IconDownload,
  IconFolder,
  IconHistory,
  IconPlayerStop,
  IconPlus,
  IconPrinter,
  IconReload,
  IconSearch,
  IconSettings,
  IconShieldLock,
  IconTrash,
  IconWorld,
  IconX,
  IconZoomIn,
  IconZoomOut
} from '@tabler/icons-react'
import { notifications } from '@mantine/notifications'
import {
  permissionLabel,
  type BrowserCapturedPage,
  type BrowserPermissionRequest,
  type BrowserWorkspaceState
} from './browserWorkspaceModel'
import styles from './BrowserWorkspace.module.scss'

const EMPTY_STATE: BrowserWorkspaceState = {
  available: false,
  visible: false,
  activeTabId: null,
  tabs: [],
  permissions: [],
  downloads: [],
  history: [],
  downloadDirectory: ''
}

function normalizeWorkspaceState(value: BrowserWorkspaceState): BrowserWorkspaceState {
  return {
    ...EMPTY_STATE,
    ...(value || {}),
    tabs: Array.isArray(value?.tabs) ? value.tabs : [],
    permissions: Array.isArray(value?.permissions) ? value.permissions : [],
    downloads: Array.isArray(value?.downloads) ? value.downloads : [],
    history: Array.isArray(value?.history) ? value.history : []
  }
}

interface BrowserWorkspaceProps {
  active?: boolean
  onUsePage: (page: BrowserCapturedPage) => Promise<void> | void
}

type BrowserApi = {
  browserWorkspaceGetState?: () => Promise<BrowserWorkspaceState>
  browserWorkspaceCreateTab?: (target?: string) => Promise<BrowserWorkspaceState>
  browserWorkspaceActivateTab?: (tabId: string) => Promise<BrowserWorkspaceState>
  browserWorkspaceCloseTab?: (tabId: string) => Promise<BrowserWorkspaceState>
  browserWorkspaceNavigate?: (tabId: string, target: string) => Promise<BrowserWorkspaceState>
  browserWorkspaceGoBack?: (tabId: string) => Promise<BrowserWorkspaceState>
  browserWorkspaceGoForward?: (tabId: string) => Promise<BrowserWorkspaceState>
  browserWorkspaceReload?: (tabId: string) => Promise<BrowserWorkspaceState>
  browserWorkspaceStop?: (tabId: string) => Promise<BrowserWorkspaceState>
  browserWorkspaceFind?: (tabId: string, text: string, forward: boolean) => Promise<BrowserWorkspaceState>
  browserWorkspaceStopFind?: (tabId: string) => Promise<BrowserWorkspaceState>
  browserWorkspaceSetZoom?: (tabId: string, factor: number) => Promise<BrowserWorkspaceState>
  browserWorkspacePrint?: (tabId: string) => Promise<boolean>
  browserWorkspaceOpenDevTools?: (tabId: string) => Promise<boolean>
  browserWorkspaceSetBounds?: (bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>
  browserWorkspaceSetVisible?: (visible: boolean) => Promise<BrowserWorkspaceState>
  browserWorkspaceCapturePage?: (tabId: string) => Promise<BrowserCapturedPage>
  browserWorkspaceSaveScreenshot?: (tabId: string) => Promise<{ path: string; name: string; size: number } | null>
  browserWorkspaceClearData?: () => Promise<BrowserWorkspaceState>
  browserWorkspaceRemoveHistory?: (historyId: string) => Promise<BrowserWorkspaceState>
  browserWorkspaceClearHistory?: () => Promise<BrowserWorkspaceState>
  browserWorkspaceClearPermissions?: () => Promise<BrowserWorkspaceState>
  browserWorkspaceClearDownloads?: () => Promise<BrowserWorkspaceState>
  browserWorkspaceShowDownload?: (downloadId: string) => Promise<boolean>
  browserWorkspaceResolvePermission?: (requestId: string, decision: string) => Promise<boolean>
  browserWorkspaceRemovePermission?: (origin: string, permission: string) => Promise<boolean>
  onBrowserWorkspaceState?: (listener: (state: BrowserWorkspaceState) => void) => (() => void)
  onBrowserWorkspacePermissionRequest?: (listener: (request: BrowserPermissionRequest) => void) => (() => void)
}

function errorMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : '操作失败，请重试'
}

export default function BrowserWorkspace({ active = true, onUsePage }: BrowserWorkspaceProps) {
  const api = ((window as any).electronAPI || {}) as BrowserApi
  const viewportRef = useRef<HTMLDivElement>(null)
  const addressFocusedRef = useRef(false)
  const pendingPermissionRef = useRef<BrowserPermissionRequest[]>([])
  const [state, setState] = useState<BrowserWorkspaceState>(EMPTY_STATE)
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [capturing, setCapturing] = useState(false)
  const [showPermissions, setShowPermissions] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [showDownloads, setShowDownloads] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [confirmClearData, setConfirmClearData] = useState(false)
  const [confirmClearHistory, setConfirmClearHistory] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findText, setFindText] = useState('')
  const [pendingPermissions, setPendingPermissions] = useState<BrowserPermissionRequest[]>([])
  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.id === state.activeTabId) || null,
    [state.activeTabId, state.tabs]
  )
  const supported = typeof api.browserWorkspaceGetState === 'function'

  useEffect(() => {
    pendingPermissionRef.current = pendingPermissions
  }, [pendingPermissions])

  useEffect(() => {
    if (!supported) return
    let alive = true
    const disposeState = api.onBrowserWorkspaceState?.((next) => {
      if (alive) setState(normalizeWorkspaceState(next))
    })
    const disposePermission = api.onBrowserWorkspacePermissionRequest?.((request) => {
      if (!alive || !request?.requestId) return
      setPendingPermissions((current) => (
        current.some((item) => item.requestId === request.requestId) ? current : [...current, request]
      ))
    })

    void api.browserWorkspaceGetState?.()
      .then((next) => { if (alive) setState(normalizeWorkspaceState(next)) })
      .catch((cause) => { if (alive) setError(errorMessage(cause)) })

    return () => {
      alive = false
      disposeState?.()
      disposePermission?.()
      for (const request of pendingPermissionRef.current) {
        void api.browserWorkspaceResolvePermission?.(request.requestId, 'deny').catch(() => undefined)
      }
      void api.browserWorkspaceSetVisible?.(false).catch(() => undefined)
    }
  }, [supported])

  useLayoutEffect(() => {
    if (!supported) return
    let alive = true
    void api.browserWorkspaceSetVisible?.(active)
      .then((next) => { if (alive && next) setState(normalizeWorkspaceState(next)) })
      .catch((cause) => { if (alive) setError(errorMessage(cause)) })
    return () => {
      alive = false
    }
  }, [active, supported])

  useEffect(() => {
    if (!active || !supported) return
    const viewport = viewportRef.current
    if (!viewport) return
    let frame = 0
    const updateBounds = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => {
        const rect = viewport.getBoundingClientRect()
        if (rect.width < 1 || rect.height < 1) return
        void api.browserWorkspaceSetBounds?.({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }).catch((cause) => setError(errorMessage(cause)))
      })
    }
    const observer = new ResizeObserver(updateBounds)
    observer.observe(viewport)
    window.addEventListener('resize', updateBounds)
    updateBounds()
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', updateBounds)
    }
  }, [active, showPermissions, supported])

  useLayoutEffect(() => {
    if (!active || !supported) return
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect || rect.width < 1 || rect.height < 1) return
    void api.browserWorkspaceSetBounds?.({
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }).catch((cause) => setError(errorMessage(cause)))
  }, [active, confirmClearData, confirmClearHistory, findOpen, showDownloads, showHistory, showMenu, showPermissions, showSettings, supported])

  useEffect(() => {
    if (!addressFocusedRef.current) setAddress(activeTab?.url === 'about:blank' ? '' : activeTab?.url || '')
  }, [activeTab?.id, activeTab?.url])

  const run = async (action: (() => Promise<BrowserWorkspaceState | boolean | void>) | undefined) => {
    if (!action) return
    setError('')
    try {
      const next = await action()
      if (next && typeof next === 'object' && 'tabs' in next) setState(normalizeWorkspaceState(next as BrowserWorkspaceState))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const navigate = () => {
    if (!address.trim()) return
    addressFocusedRef.current = false
    void run(() => api.browserWorkspaceNavigate?.(activeTab?.id || '', address.trim()) as Promise<BrowserWorkspaceState>)
  }

  const resolvePermission = async (request: BrowserPermissionRequest, decision: string) => {
    setError('')
    try {
      await api.browserWorkspaceResolvePermission?.(request.requestId, decision)
      setPendingPermissions((current) => current.filter((item) => item.requestId !== request.requestId))
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const addPageToConversation = async () => {
    if (!activeTab || !api.browserWorkspaceCapturePage || capturing) return
    setCapturing(true)
    setError('')
    try {
      const page = await api.browserWorkspaceCapturePage(activeTab.id)
      await onUsePage(page)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setCapturing(false)
    }
  }

  const closeAuxiliaryPanels = () => {
    setShowMenu(false)
    setShowDownloads(false)
    setShowHistory(false)
    setShowSettings(false)
    setShowPermissions(false)
    setConfirmClearData(false)
    setConfirmClearHistory(false)
  }

  const openFind = () => {
    closeAuxiliaryPanels()
    setFindOpen(true)
  }

  const closeFind = () => {
    setFindOpen(false)
    setFindText('')
    void run(() => api.browserWorkspaceStopFind?.(activeTab?.id || '') as Promise<BrowserWorkspaceState>)
  }

  const find = (forward: boolean) => {
    void run(() => api.browserWorkspaceFind?.(activeTab?.id || '', findText, forward) as Promise<BrowserWorkspaceState>)
  }

  const setZoom = (factor: number) => {
    void run(() => api.browserWorkspaceSetZoom?.(activeTab?.id || '', factor) as Promise<BrowserWorkspaceState>)
  }

  const saveScreenshot = async () => {
    closeAuxiliaryPanels()
    setError('')
    try {
      const saved = await api.browserWorkspaceSaveScreenshot?.(activeTab?.id || '')
      if (saved?.path) notifications.show({ color: 'green', message: `截图已保存：${saved.name}` })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const clearBrowsingData = async () => {
    setError('')
    try {
      const next = await api.browserWorkspaceClearData?.()
      if (next) setState(normalizeWorkspaceState(next))
      setConfirmClearData(false)
      notifications.show({ color: 'green', message: '浏览数据已清除，页面正在重新加载' })
    } catch (cause) {
      setError(errorMessage(cause))
    }
  }

  const formatBytes = (value: number) => {
    if (!Number.isFinite(value) || value <= 0) return '0 B'
    if (value < 1024) return `${Math.round(value)} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
    return `${(value / 1024 / 1024).toFixed(1)} MB`
  }

  const formatHistoryTime = (value: string) => {
    const date = new Date(value)
    if (!Number.isFinite(date.getTime())) return ''
    const today = new Date()
    const sameDay = date.toDateString() === today.toDateString()
    return new Intl.DateTimeFormat('zh-CN', sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    ).format(date)
  }

  const historyHost = (value: string) => {
    try { return new URL(value).host }
    catch { return value }
  }

  const openHistoryItem = (url: string) => {
    closeAuxiliaryPanels()
    void run(() => api.browserWorkspaceNavigate?.(activeTab?.id || '', url) as Promise<BrowserWorkspaceState>)
  }

  if (!supported) {
    return (
      <section className={styles.unsupported} data-browser-workspace>
        <IconWorld size={28} stroke={1.5} />
        <h2>本地浏览器仅在桌面应用中可用</h2>
        <p>请在 dsh-work 桌面应用中打开此页。</p>
      </section>
    )
  }

  return (
    <section className={styles.root} data-browser-workspace>
      <div className={styles.tabStrip} role="tablist" aria-label="浏览器标签页">
        <div className={styles.tabs}>
          {state.tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === state.activeTabId}
              className={styles.tab}
              data-active={tab.id === state.activeTabId ? 'true' : undefined}
              onClick={() => void run(() => api.browserWorkspaceActivateTab?.(tab.id) as Promise<BrowserWorkspaceState>)}
              title={tab.title}
            >
              {tab.isLoading ? <span className={styles.loadingDot} /> : <IconWorld size={14} stroke={1.7} />}
              <span>{tab.title}</span>
              <span
                className={styles.closeTab}
                role="button"
                aria-label={`关闭 ${tab.title}`}
                onClick={(event) => {
                  event.stopPropagation()
                  void run(() => api.browserWorkspaceCloseTab?.(tab.id) as Promise<BrowserWorkspaceState>)
                }}
              >
                <IconX size={13} stroke={1.8} />
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="新建标签页"
          title="新建标签页"
          onClick={() => void run(() => api.browserWorkspaceCreateTab?.() as Promise<BrowserWorkspaceState>)}
        >
          <IconPlus size={16} stroke={1.8} />
        </button>
      </div>

      <div className={styles.toolbar}>
        <button
          type="button"
          className={styles.iconButton}
          disabled={!activeTab?.canGoBack}
          aria-label="后退"
          title="后退"
          onClick={() => void run(() => api.browserWorkspaceGoBack?.(activeTab?.id || '') as Promise<BrowserWorkspaceState>)}
        >
          <IconArrowLeft size={17} stroke={1.8} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          disabled={!activeTab?.canGoForward}
          aria-label="前进"
          title="前进"
          onClick={() => void run(() => api.browserWorkspaceGoForward?.(activeTab?.id || '') as Promise<BrowserWorkspaceState>)}
        >
          <IconArrowRight size={17} stroke={1.8} />
        </button>
        <button
          type="button"
          className={styles.iconButton}
          disabled={!activeTab}
          aria-label={activeTab?.isLoading ? '停止加载' : '重新加载'}
          title={activeTab?.isLoading ? '停止加载' : '重新加载'}
          onClick={() => void run(() => (
            activeTab?.isLoading
              ? api.browserWorkspaceStop?.(activeTab.id)
              : api.browserWorkspaceReload?.(activeTab?.id || '')
          ) as Promise<BrowserWorkspaceState>)}
        >
          {activeTab?.isLoading ? <IconPlayerStop size={15} stroke={1.8} /> : <IconReload size={16} stroke={1.8} />}
        </button>
        <form
          className={styles.addressForm}
          onSubmit={(event) => {
            event.preventDefault()
            navigate()
          }}
        >
          <IconShieldLock size={14} stroke={1.7} />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            onFocus={() => { addressFocusedRef.current = true }}
            onBlur={() => { addressFocusedRef.current = false }}
            placeholder="输入网址或搜索内容"
            aria-label="网址或搜索内容"
            spellCheck={false}
          />
        </form>
        <button
          type="button"
          className={`${styles.textButton} ${showPermissions ? styles.textButtonActive : ''}`}
          onClick={() => setShowPermissions((value) => !value)}
        >
          站点权限
          {state.permissions.length > 0 && <span className={styles.count}>{state.permissions.length}</span>}
        </button>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={!activeTab || activeTab.url === 'about:blank' || capturing}
          onClick={() => void addPageToConversation()}
        >
          {capturing ? '正在抓取…' : '加入对话'}
        </button>
        <button
          type="button"
          className={styles.iconButton}
          aria-label="浏览器菜单"
          title="浏览器菜单"
          data-browser-menu-trigger
          onClick={() => {
            const next = !showMenu
            closeAuxiliaryPanels()
            setShowMenu(next)
          }}
        >
          <IconDotsVertical size={17} stroke={1.8} />
        </button>
      </div>

      {findOpen && (
        <form
          className={styles.findBar}
          data-browser-find
          onSubmit={(event) => { event.preventDefault(); find(true) }}
        >
          <IconSearch size={15} stroke={1.8} />
          <input
            autoFocus
            value={findText}
            onChange={(event) => setFindText(event.target.value)}
            placeholder="在页面中查找"
            aria-label="在页面中查找"
          />
          <span>{activeTab?.findMatches ? `${activeTab.findActiveMatch}/${activeTab.findMatches}` : '0/0'}</span>
          <button type="button" aria-label="上一个匹配项" onClick={() => find(false)}><IconChevronUp size={15} /></button>
          <button type="button" aria-label="下一个匹配项" onClick={() => find(true)}><IconChevronDown size={15} /></button>
          <button type="button" aria-label="关闭页面查找" onClick={closeFind}><IconX size={15} /></button>
        </form>
      )}

      {showMenu && (
        <div className={styles.browserMenu} data-browser-menu>
          <button type="button" onClick={openFind}><IconSearch size={16} /><span>在页面中查找</span></button>
          <button type="button" onClick={() => { closeAuxiliaryPanels(); void run(() => api.browserWorkspacePrint?.(activeTab?.id || '') || Promise.resolve(false)) }}><IconPrinter size={16} /><span>打印</span></button>
          <div className={styles.zoomRow}>
            <span>缩放</span>
            <button type="button" aria-label="缩小网页" onClick={() => setZoom((activeTab?.zoomFactor || 1) - 0.1)}><IconZoomOut size={15} /></button>
            <strong>{Math.round((activeTab?.zoomFactor || 1) * 100)}%</strong>
            <button type="button" aria-label="放大网页" onClick={() => setZoom((activeTab?.zoomFactor || 1) + 0.1)}><IconZoomIn size={15} /></button>
            <button type="button" className={styles.resetZoom} onClick={() => setZoom(1)}>重置</button>
          </div>
          <button type="button" onClick={() => void saveScreenshot()}><IconCamera size={16} /><span>截取屏幕截图</span></button>
          <button type="button" onClick={() => { closeAuxiliaryPanels(); void run(() => api.browserWorkspaceOpenDevTools?.(activeTab?.id || '') || Promise.resolve(false)) }}><IconCode size={16} /><span>显示开发者工具</span></button>
          <div className={styles.menuDivider} />
          <button type="button" onClick={() => { closeAuxiliaryPanels(); setShowHistory(true) }}><IconHistory size={16} /><span>历史记录</span>{state.history.length > 0 && <em>{state.history.length}</em>}</button>
          <button type="button" onClick={() => { closeAuxiliaryPanels(); setShowDownloads(true) }}><IconDownload size={16} /><span>下载</span>{state.downloads.length > 0 && <em>{state.downloads.length}</em>}</button>
          <button type="button" onClick={() => { closeAuxiliaryPanels(); setConfirmClearData(true) }}><IconTrash size={16} /><span>清除浏览数据</span></button>
          <button type="button" onClick={() => { closeAuxiliaryPanels(); setShowSettings(true) }}><IconSettings size={16} /><span>浏览器设置</span></button>
        </div>
      )}

      {confirmClearData && (
        <div className={styles.confirmPanel} role="alertdialog" aria-label="清除浏览数据">
          <div><strong>清除浏览数据？</strong><span>将清除 Cookie、缓存和网站存储，并退出已登录的网站。下载的文件不会删除。</span></div>
          <button type="button" onClick={() => setConfirmClearData(false)}>取消</button>
          <button type="button" className={styles.dangerButton} onClick={() => void clearBrowsingData()}>清除</button>
        </div>
      )}

      {confirmClearHistory && (
        <div className={styles.confirmPanel} role="alertdialog" aria-label="清空浏览历史">
          <div><strong>清空浏览历史？</strong><span>只会删除本机保存的网址、标题和访问时间，不会删除下载的文件。</span></div>
          <button type="button" onClick={() => setConfirmClearHistory(false)}>取消</button>
          <button type="button" className={styles.dangerButton} onClick={() => void run(async () => {
            const next = await api.browserWorkspaceClearHistory?.()
            setConfirmClearHistory(false)
            setShowHistory(true)
            return next as BrowserWorkspaceState
          })}>清空</button>
        </div>
      )}

      {showHistory && (
        <div className={styles.toolPanel} data-browser-history>
          <div className={styles.toolPanelHeader}>
            <div><strong>历史记录</strong><span>最多保留 500 条，只保存在本机。</span></div>
            {state.history.length > 0 && <button type="button" onClick={() => { setShowHistory(false); setConfirmClearHistory(true) }}>清空历史</button>}
            <button type="button" aria-label="关闭历史记录" onClick={() => setShowHistory(false)}><IconX size={15} /></button>
          </div>
          {state.history.length === 0 ? <p>还没有浏览记录。</p> : (
            <div className={styles.historyList}>
              {state.history.map((item) => (
                <div className={styles.historyItem} key={item.id}>
                  <button type="button" className={styles.historyOpen} onClick={() => openHistoryItem(item.url)}>
                    <IconHistory size={15} />
                    <span><strong title={item.title}>{item.title}</strong><small title={item.url}>{historyHost(item.url)}</small></span>
                    <time dateTime={item.visitedAt}>{formatHistoryTime(item.visitedAt)}</time>
                    {item.visitCount > 1 && <em>{item.visitCount} 次</em>}
                  </button>
                  <button
                    type="button"
                    aria-label={`删除历史记录 ${item.title}`}
                    className={styles.historyDelete}
                    onClick={(event) => {
                      void run(() => api.browserWorkspaceRemoveHistory?.(item.id) as Promise<BrowserWorkspaceState>)
                    }}
                  ><IconTrash size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showDownloads && (
        <div className={styles.toolPanel} data-browser-downloads>
          <div className={styles.toolPanelHeader}>
            <div><strong>下载</strong><span title={state.downloadDirectory}>保存到 {state.downloadDirectory || '系统下载目录'}</span></div>
            {state.downloads.length > 0 && <button type="button" onClick={() => void run(() => api.browserWorkspaceClearDownloads?.() as Promise<BrowserWorkspaceState>)}>清空记录</button>}
            <button type="button" aria-label="关闭下载列表" onClick={() => setShowDownloads(false)}><IconX size={15} /></button>
          </div>
          {state.downloads.length === 0 ? <p>还没有下载记录。</p> : (
            <div className={styles.downloadList}>
              {state.downloads.map((download) => (
                <div key={download.id}>
                  <IconDownload size={15} />
                  <div><strong title={download.filename}>{download.filename}</strong><span>{download.state === 'progressing' ? `${formatBytes(download.receivedBytes)} / ${formatBytes(download.totalBytes)}` : download.state === 'completed' ? '下载完成' : download.state === 'cancelled' ? '已取消' : '下载中断'}</span></div>
                  {download.state === 'completed' && <button type="button" aria-label={`显示 ${download.filename}`} onClick={() => void api.browserWorkspaceShowDownload?.(download.id)}><IconFolder size={15} /></button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showSettings && (
        <div className={styles.toolPanel} data-browser-settings>
          <div className={styles.toolPanelHeader}>
            <div><strong>浏览器设置</strong><span>设置只保存在本机。</span></div>
            <button type="button" aria-label="关闭浏览器设置" onClick={() => setShowSettings(false)}><IconX size={15} /></button>
          </div>
          <div className={styles.settingsRow}><span>下载位置</span><strong title={state.downloadDirectory}>{state.downloadDirectory || '系统下载目录'}</strong></div>
          <div className={styles.settingsRow}><span>历史记录</span><strong>{state.history.length} 条</strong><button type="button" onClick={() => { setShowSettings(false); setShowHistory(true) }}>管理</button></div>
          <div className={styles.settingsRow}><span>站点权限</span><strong>{state.permissions.length} 条规则</strong><button type="button" onClick={() => { setShowSettings(false); setShowPermissions(true) }}>管理</button></div>
          {state.permissions.length > 0 && <button type="button" className={styles.clearPermissions} onClick={() => void run(() => api.browserWorkspaceClearPermissions?.() as Promise<BrowserWorkspaceState>)}>清除全部站点权限</button>}
        </div>
      )}

      {pendingPermissions.map((request) => (
        <div className={styles.permissionPrompt} key={request.requestId}>
          <IconShieldLock size={17} stroke={1.7} />
          <div>
            <strong>{request.origin}</strong>
            <span>正在请求{permissionLabel(request.permission)}权限。</span>
          </div>
          <div className={styles.permissionActions}>
            <button type="button" onClick={() => void resolvePermission(request, 'deny')}>拒绝</button>
            <button type="button" onClick={() => void resolvePermission(request, 'deny_always')}>始终拒绝</button>
            <button type="button" onClick={() => void resolvePermission(request, 'allow_once')}>本次允许</button>
            <button type="button" className={styles.permissionPrimary} onClick={() => void resolvePermission(request, 'allow_always')}>始终允许</button>
          </div>
        </div>
      ))}

      {showPermissions && (
        <div className={styles.permissionPanel}>
          <div>
            <strong>已保存的站点权限</strong>
            <span>本次允许不会保存；始终允许或拒绝只保存在本机。</span>
          </div>
          {state.permissions.length === 0 ? (
            <p>还没有保存的站点权限。</p>
          ) : (
            <div className={styles.permissionList}>
              {state.permissions.map((rule) => (
                <div key={`${rule.origin}|${rule.permission}`}>
                  <span title={rule.origin}>{rule.origin}</span>
                  <span>{permissionLabel(rule.permission)}</span>
                  <strong data-decision={rule.decision}>{rule.decision === 'allow' ? '允许' : '拒绝'}</strong>
                  <button
                    type="button"
                    onClick={() => void run(() => api.browserWorkspaceRemovePermission?.(rule.origin, rule.permission) as Promise<boolean>)}
                  >
                    清除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(error || activeTab?.error) && (
        <div className={styles.error} role="alert">
          <IconAlertTriangle size={15} stroke={1.8} />
          <span>{error || activeTab?.error}</span>
        </div>
      )}
      <div ref={viewportRef} className={styles.viewport} aria-label="网页显示区" />
    </section>
  )
}
