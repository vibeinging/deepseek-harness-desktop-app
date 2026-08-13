// Electron preload — exposes safe native APIs to `window.electronAPI` through contextBridge.
// Renderer detects the desktop shell through the presence of window.electronAPI.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const MAX_BG_IMAGE_BYTES = 8 * 1024 * 1024;
const BG_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

function bgImageHeaderMatches(bytes, mimeType) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return false;
  if (mimeType === 'image/png') {
    return [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value);
  }
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (mimeType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6));
  if (mimeType === 'image/webp') return ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
  return false;
}

contextBridge.exposeInMainWorld('electronAPI', {
  // Pick native file/folder
  pickPaths: (defaultPath) => ipcRenderer.invoke('pick-paths', defaultPath ?? null),
  pickFolder: (defaultPath) => ipcRenderer.invoke('pick-folder', defaultPath ?? null),
  // `file.path` is removed from Electron; dragged native File objects must be resolved in preload.
  // Renderer cannot submit arbitrary paths directly; only disk-backed files can be registered as attachments.
  registerDroppedFile: (file) => {
    try {
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) return Promise.resolve(null);
      return ipcRenderer
        .invoke('register-dropped-paths', [filePath])
        .then((items) => (Array.isArray(items) ? items[0] || null : null));
    } catch {
      // Ignore objects that are not native disk File instances.
      return Promise.resolve(null);
    }
  },
  // Reveal in Finder / File Explorer
  revealInFinder: (p) => ipcRenderer.invoke('reveal-in-finder', p),
  openLocalFile: (p) => ipcRenderer.invoke('open-local-file', p),
  // Open a workspace file in the OS-configured editor. The main process
  // validates the path and deliberately ignores executable/command input.
  openInEditor: (payload) => ipcRenderer.invoke('open-in-editor', payload),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', url),
  authorizePreviewRoot: (p) => ipcRenderer.invoke('authorize-preview-root', p),
  // Use Electron's system clipboard in the trusted app renderer. Browser builds
  // keep their own Clipboard API fallback in renderer/src/utils/clipboard.ts.
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard-write-text', text),
  // All delivered artifacts use one native action channel. The main process
  // validates the action and app-owned/authorized path before touching the OS.
  runArtifactAction: (payload) => ipcRenderer.invoke('artifact-native-action', payload),
  showArtifactContextMenu: (payload) => ipcRenderer.invoke('artifact-context-menu', payload),
  // Export the exact original HTML for a local Site. Preview-only CSP and
  // annotation code are injected in the renderer and never enter this payload.
  exportLocalSite: (payload) => ipcRenderer.invoke('export-local-site', payload),
  // Default local data root: ~/.dsh
  defaultDataRoot: () => ipcRenderer.invoke('default-data-root'),
  // Updates remain in the trusted main process; renderer receives only state and explicit actions.
  appUpdateGetState: () => ipcRenderer.invoke('app-update-get-state'),
  appUpdateCheck: () => ipcRenderer.invoke('app-update-check'),
  appUpdateDownloadAndInstall: () => ipcRenderer.invoke('app-update-download-install'),
  onAppUpdateState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('app-update-state', handler);
    return () => ipcRenderer.removeListener('app-update-state', handler);
  },
  getWindowFullScreenState: () => ipcRenderer.invoke('window-full-screen-state'),
  onWindowFullScreenChanged: (listener) => {
    const handler = (_event, fullScreen) => listener(Boolean(fullScreen));
    ipcRenderer.on('window-full-screen-changed', handler);
    return () => ipcRenderer.removeListener('window-full-screen-changed', handler);
  },
  // Save long pasted text as a txt attachment in current workspace.
  savePastedTextAttachment: (payload) => ipcRenderer.invoke('save-pasted-text-attachment', payload),
  // Clipboard images do not have a stable disk path. Copy the bytes into the
  // app-managed attachment directory before sending a localImage turn input.
  savePastedImageAttachment: async (payload, file) => {
    try {
      if (!file || typeof file.arrayBuffer !== 'function') return null;
      const bytes = new Uint8Array(await file.arrayBuffer());
      return ipcRenderer.invoke('save-pasted-image-attachment', {
        ...(payload || {}),
        bytes,
        mimeType: String(file.type || ''),
        originalName: String(file.name || ''),
      });
    } catch {
      return null;
    }
  },
  // Network settings must be read by the main process before backend startup, stored in Electron userData.
  loadNetworkSettings: () => ipcRenderer.invoke('network-settings-load'),
  saveNetworkSettings: (settings) => ipcRenderer.invoke('network-settings-save', settings),
  // 用户自定义皮肤定义：长久保存在 userData，卸载/升级后仍可恢复。
  loadSkins: () => ipcRenderer.invoke('skins-load'),
  saveSkins: (settings) => ipcRenderer.invoke('skins-save', settings),
  // 品牌名（运行时应用名）：长久保存 + 实时更新窗口标题/About/菜单。
  loadBrand: () => ipcRenderer.invoke('brand-load'),
  saveBrand: (settings) => ipcRenderer.invoke('brand-save', settings),
  setBrandName: (name) => ipcRenderer.invoke('brand-set-name', name),
  // 品牌外观（底图/底色/透明度）：长久保存。
  loadBrandAppearance: () => ipcRenderer.invoke('brand-appearance-load'),
  saveBrandAppearance: (settings) => ipcRenderer.invoke('brand-appearance-save', settings),
  // 复制用户本地底图到 userData/bg-images，返回 dsh-skin-asset:// URL。
  // File.path 在 Electron 27+ 已移除，必须用 webUtils.getPathForFile 解析真实路径后再传给主进程。
  copyBgImage: async (file) => {
    try {
      if (!file || typeof file.slice !== 'function') throw new Error('没有可读取的图片文件');
      const mimeType = String(file.type || '').toLowerCase();
      if (!BG_IMAGE_MIME_TYPES.has(mimeType)) throw new Error('仅支持 PNG、JPEG、WebP 或 GIF 图片');
      if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('图片文件为空');
      if (file.size > MAX_BG_IMAGE_BYTES) throw new Error('图片不能超过 8MB');
      // 只读 16 字节做格式签名预检，避免把伪装扩展名的大文件交给主进程。
      const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
      if (!bgImageHeaderMatches(header, mimeType)) throw new Error('图片类型与文件内容不一致');
      const filePath = webUtils.getPathForFile(file);
      if (!filePath) throw new Error('只能选择本机磁盘上的图片');
      return ipcRenderer.invoke('brand-copy-bg-image', {
        path: filePath,
        mimeType,
        size: file.size,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error('图片处理失败');
    }
  },
  // Local browser workspace. Remote pages have no preload; only this trusted app renderer can invoke controls.
  browserWorkspaceGetState: () => ipcRenderer.invoke('browser-workspace-get-state'),
  browserWorkspaceCreateTab: (target) => ipcRenderer.invoke('browser-workspace-create-tab', target),
  browserWorkspaceActivateTab: (tabId) => ipcRenderer.invoke('browser-workspace-activate-tab', tabId),
  browserWorkspaceCloseTab: (tabId) => ipcRenderer.invoke('browser-workspace-close-tab', tabId),
  browserWorkspaceNavigate: (tabId, target) => ipcRenderer.invoke('browser-workspace-navigate', { tabId, target }),
  browserWorkspaceGoBack: (tabId) => ipcRenderer.invoke('browser-workspace-go-back', tabId),
  browserWorkspaceGoForward: (tabId) => ipcRenderer.invoke('browser-workspace-go-forward', tabId),
  browserWorkspaceReload: (tabId) => ipcRenderer.invoke('browser-workspace-reload', tabId),
  browserWorkspaceStop: (tabId) => ipcRenderer.invoke('browser-workspace-stop', tabId),
  browserWorkspaceFind: (tabId, text, forward) => ipcRenderer.invoke('browser-workspace-find', { tabId, text, forward }),
  browserWorkspaceStopFind: (tabId) => ipcRenderer.invoke('browser-workspace-stop-find', tabId),
  browserWorkspaceSetZoom: (tabId, factor) => ipcRenderer.invoke('browser-workspace-set-zoom', { tabId, factor }),
  browserWorkspacePrint: (tabId) => ipcRenderer.invoke('browser-workspace-print', tabId),
  browserWorkspaceOpenDevTools: (tabId) => ipcRenderer.invoke('browser-workspace-open-devtools', tabId),
  browserWorkspaceSetBounds: (bounds) => ipcRenderer.invoke('browser-workspace-set-bounds', bounds),
  browserWorkspaceSetVisible: (visible) => ipcRenderer.invoke('browser-workspace-set-visible', visible),
  browserWorkspaceCapturePage: (tabId) => ipcRenderer.invoke('browser-workspace-capture-page', tabId),
  browserWorkspaceSaveScreenshot: (tabId) => ipcRenderer.invoke('browser-workspace-save-screenshot', tabId),
  browserWorkspaceClearData: () => ipcRenderer.invoke('browser-workspace-clear-data'),
  browserWorkspaceRemoveHistory: (historyId) => ipcRenderer.invoke('browser-workspace-remove-history', historyId),
  browserWorkspaceClearHistory: () => ipcRenderer.invoke('browser-workspace-clear-history'),
  browserWorkspaceClearPermissions: () => ipcRenderer.invoke('browser-workspace-clear-permissions'),
  browserWorkspaceClearDownloads: () => ipcRenderer.invoke('browser-workspace-clear-downloads'),
  browserWorkspaceShowDownload: (downloadId) => ipcRenderer.invoke('browser-workspace-show-download', downloadId),
  browserWorkspaceResolvePermission: (requestId, decision) => (
    ipcRenderer.invoke('browser-workspace-resolve-permission', { requestId, decision })
  ),
  browserWorkspaceRemovePermission: (origin, permission) => (
    ipcRenderer.invoke('browser-workspace-remove-permission', { origin, permission })
  ),
  onBrowserWorkspaceState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('browser-workspace-state', handler);
    return () => ipcRenderer.removeListener('browser-workspace-state', handler);
  },
  onBrowserWorkspacePermissionRequest: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('browser-workspace-permission-request', handler);
    return () => ipcRenderer.removeListener('browser-workspace-permission-request', handler);
  },
  // REST requests are forwarded to local backend via main process (axios adapter), no direct HTTP from renderer.
  apiRequest: (req) => ipcRenderer.invoke('api-request', req),
  // Eval-only fault injection. Main process rejects this outside DSH_EVAL_MODE.
  evalRestartBackend: () => ipcRenderer.invoke('eval-restart-backend'),
  evalProcessSnapshot: () => ipcRenderer.invoke('eval-process-snapshot'),
  evalReadClipboardText: () => ipcRenderer.invoke('eval-read-clipboard-text'),
  evalQuitApplication: () => ipcRenderer.invoke('eval-quit-application'),
  onBackendState: (listener) => {
    const handler = (_event, payload) => listener(payload);
    ipcRenderer.on('backend-state', handler);
    return () => ipcRenderer.removeListener('backend-state', handler);
  },
  // SSE stream: main process pulls from local backend and forwards each chunk through `dsh-stream:<id>`;
  // onMsg receives {type:'head'|'data'|'end'|'error'}. Returns dispose() to remove listener and cancel upstream
  // (supports frontend AbortSignal and component unmount).
  streamStart: (req, onMsg) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const channel = `dsh-stream:${id}`;
    const listener = (_e, msg) => {
      onMsg(msg);
      if (msg && (msg.type === 'end' || msg.type === 'error')) ipcRenderer.removeListener(channel, listener);
    };
    ipcRenderer.on(channel, listener);
    ipcRenderer.invoke('stream-start', { ...req, id });
    return () => {
      ipcRenderer.removeListener(channel, listener);
      ipcRenderer.send('stream-abort', id);
    };
  },
});
