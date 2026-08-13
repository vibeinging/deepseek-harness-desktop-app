const fs = require('node:fs');
const path = require('node:path');

const BROWSER_PARTITION = 'persist:browser-workspace';
const MAX_BROWSER_TABS = 12;
const MAX_BROWSER_TARGET_LENGTH = 4096;
const MAX_BROWSER_TITLE_LENGTH = 160;
const MAX_BROWSER_PAGE_TEXT_LENGTH = 120_000;
const MAX_BROWSER_DOWNLOADS = 100;
const MAX_BROWSER_HISTORY = 500;
const MIN_BROWSER_ZOOM_FACTOR = 0.5;
const MAX_BROWSER_ZOOM_FACTOR = 2;
const PERMISSION_REQUEST_TIMEOUT_MS = 30_000;
const ASKABLE_BROWSER_PERMISSIONS = new Set([
  'media',
  'geolocation',
  'notifications',
  'clipboard-read',
]);
const PERMISSION_DECISIONS = new Set(['allow', 'deny']);
const SENSITIVE_HISTORY_PARAM = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|code|auth|authorization|api[_-]?key|session|session[_-]?id|signature|credential)$/i;

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim()
    .slice(0, maxLength);
}

function parsedWebUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.username = '';
    parsed.password = '';
    return parsed;
  } catch {
    return null;
  }
}

function normalizeBrowserTarget(raw) {
  const value = cleanText(raw, MAX_BROWSER_TARGET_LENGTH);
  if (!value) return 'about:blank';
  if (value === 'about:blank') return value;

  const explicitScheme = /^[a-z][a-z0-9+.-]*:/i.exec(value)?.[0]?.toLowerCase();
  if (explicitScheme && explicitScheme !== 'http:' && explicitScheme !== 'https:') return null;

  let candidate = value;
  if (!explicitScheme) {
    if (value.startsWith('//')) {
      candidate = `https:${value}`;
    } else if (/^(localhost|127(?:\.\d{1,3}){3}|\[(?:[a-f0-9:]+)\])(?::\d+)?(?:[/?#]|$)/i.test(value)) {
      candidate = `http://${value}`;
    } else if (/^[^\s/]+\.[^\s/]+(?:[/?#].*)?$/i.test(value)) {
      candidate = `https://${value}`;
    } else {
      return `https://duckduckgo.com/?q=${encodeURIComponent(value)}`;
    }
  }

  const parsed = parsedWebUrl(candidate);
  return parsed ? parsed.toString() : null;
}

function isAllowedBrowserNavigation(raw) {
  const value = cleanText(raw, MAX_BROWSER_TARGET_LENGTH);
  if (value === 'about:blank') return true;
  return Boolean(parsedWebUrl(value));
}

function sanitizeBrowserTitle(value) {
  return cleanText(value, MAX_BROWSER_TITLE_LENGTH) || '新标签页';
}

function sanitizeBrowserUrl(value) {
  const raw = cleanText(value, MAX_BROWSER_TARGET_LENGTH);
  if (raw === 'about:blank') return raw;
  const parsed = parsedWebUrl(raw);
  return parsed ? parsed.toString() : 'about:blank';
}

function createBrowserTabState(state = {}, tab = {}) {
  const currentTabs = Array.isArray(state.tabs) ? state.tabs : [];
  const id = cleanText(tab.id, 120);
  if (!id) return { tabs: [...currentTabs], activeTabId: state.activeTabId || null };
  const normalized = {
    id,
    title: sanitizeBrowserTitle(tab.title),
    url: sanitizeBrowserUrl(tab.url),
    isLoading: Boolean(tab.isLoading),
    canGoBack: Boolean(tab.canGoBack),
    canGoForward: Boolean(tab.canGoForward),
    error: cleanText(tab.error, 500) || null,
  };
  const tabs = [...currentTabs.filter((item) => item?.id !== id), normalized].slice(-MAX_BROWSER_TABS);
  return { tabs, activeTabId: id };
}

function closeBrowserTabState(state = {}, tabId) {
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  const index = tabs.findIndex((tab) => tab?.id === tabId);
  if (index < 0) return { tabs: [...tabs], activeTabId: state.activeTabId || null };
  const nextTabs = tabs.filter((tab) => tab?.id !== tabId);
  const activeTabId = state.activeTabId === tabId
    ? nextTabs[Math.min(index, nextTabs.length - 1)]?.id || null
    : (nextTabs.some((tab) => tab.id === state.activeTabId) ? state.activeTabId : nextTabs[0]?.id || null);
  return { tabs: nextTabs, activeTabId };
}

function finiteInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number) : null;
}

function normalizeZoomFactor(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.round(Math.max(MIN_BROWSER_ZOOM_FACTOR, Math.min(MAX_BROWSER_ZOOM_FACTOR, number)) * 10) / 10;
}

function safeDownloadFilename(value) {
  const name = path.basename(cleanText(value, 240)).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim();
  return name && name !== '.' && name !== '..' ? name : 'download';
}

function uniqueDownloadPath(directory, filename) {
  const safeName = safeDownloadFilename(filename);
  const parsed = path.parse(safeName);
  let candidate = path.join(directory, safeName);
  for (let index = 1; fs.existsSync(candidate) && index < 10_000; index += 1) {
    candidate = path.join(directory, `${parsed.name} (${index})${parsed.ext}`);
  }
  return candidate;
}

function sanitizeHistoryUrl(value) {
  const parsed = parsedWebUrl(cleanText(value, MAX_BROWSER_TARGET_LENGTH));
  if (!parsed) return null;
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_HISTORY_PARAM.test(key)) parsed.searchParams.delete(key);
  }
  return parsed.toString();
}

function normalizeBrowserHistory(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const url = sanitizeHistoryUrl(raw?.url);
    if (!url || seen.has(url)) continue;
    const visitedAt = new Date(raw?.visitedAt || 0);
    if (!Number.isFinite(visitedAt.getTime())) continue;
    seen.add(url);
    out.push({
      id: cleanText(raw?.id, 160) || `history-${visitedAt.getTime()}-${out.length + 1}`,
      title: sanitizeBrowserTitle(raw?.title),
      url,
      visitedAt: visitedAt.toISOString(),
      visitCount: Math.max(1, finiteInteger(raw?.visitCount) || 1),
    });
    if (out.length >= MAX_BROWSER_HISTORY) break;
  }
  return out;
}

function normalizeBrowserBounds(bounds, hostSize) {
  const hostWidth = finiteInteger(hostSize?.width);
  const hostHeight = finiteInteger(hostSize?.height);
  const inputWidth = finiteInteger(bounds?.width);
  const inputHeight = finiteInteger(bounds?.height);
  if (!hostWidth || !hostHeight || !inputWidth || !inputHeight || inputWidth < 1 || inputHeight < 1) return null;
  const x = Math.max(0, Math.min(hostWidth - 1, finiteInteger(bounds?.x) || 0));
  const y = Math.max(0, Math.min(hostHeight - 1, finiteInteger(bounds?.y) || 0));
  return {
    x,
    y,
    width: Math.max(1, Math.min(inputWidth, hostWidth - x)),
    height: Math.max(1, Math.min(inputHeight, hostHeight - y)),
  };
}

function permissionRuleKey(originOrUrl, permission) {
  if (!ASKABLE_BROWSER_PERMISSIONS.has(String(permission || ''))) return null;
  try {
    const parsed = new URL(String(originOrUrl || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return `${parsed.origin}|${permission}`;
  } catch {
    return null;
  }
}

function normalizeBrowserPermissionRules(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [rawKey, rawDecision] of Object.entries(value)) {
    if (!PERMISSION_DECISIONS.has(rawDecision)) continue;
    const splitAt = rawKey.lastIndexOf('|');
    if (splitAt < 1) continue;
    const key = permissionRuleKey(rawKey.slice(0, splitAt), rawKey.slice(splitAt + 1));
    if (key) out[key] = rawDecision;
  }
  return out;
}

function normalizeCapturedPage(value) {
  const url = sanitizeBrowserUrl(value?.url);
  if (url === 'about:blank') throw new Error('当前页面没有可加入对话的网页地址');
  return {
    title: sanitizeBrowserTitle(value?.title),
    url,
    text: cleanText(value?.text, MAX_BROWSER_PAGE_TEXT_LENGTH),
    selected: Boolean(value?.selected),
    capturedAt: new Date().toISOString(),
  };
}

class BrowserWorkspaceController {
  constructor({ WebContentsView, browserSession, getParentWindow, userDataPath, downloadDirectory, sendEvent, isDev = false }) {
    if (typeof WebContentsView !== 'function') throw new Error('Electron WebContentsView 不可用');
    this.WebContentsView = WebContentsView;
    this.browserSession = browserSession;
    this.getParentWindow = getParentWindow;
    this.userDataPath = userDataPath;
    this.downloadDirectory = path.resolve(downloadDirectory || path.join(userDataPath, 'browser-downloads'));
    this.sendEvent = sendEvent;
    this.isDev = isDev;
    this.tabs = [];
    this.activeTabId = null;
    this.visible = false;
    this.bounds = null;
    this.attachedView = null;
    this.sequence = 0;
    this.pendingPermissionRequests = new Map();
    this.sessionPermissionRules = new Map();
    this.downloads = [];
    this.history = this.loadHistory();
    this.permissionRules = this.loadPermissionRules();
    this.installPermissionHandlers();
    this.installDownloadHandler();
  }

  permissionRulesPath() {
    return path.join(this.userDataPath, 'browser-site-permissions.json');
  }

  historyPath() {
    return path.join(this.userDataPath, 'browser-history.json');
  }

  loadHistory() {
    try {
      return normalizeBrowserHistory(JSON.parse(fs.readFileSync(this.historyPath(), 'utf8')));
    } catch {
      return [];
    }
  }

  saveHistory() {
    fs.mkdirSync(path.dirname(this.historyPath()), { recursive: true });
    const temporaryPath = `${this.historyPath()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(this.history, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.historyPath());
    try { fs.chmodSync(this.historyPath(), 0o600); } catch { /* best effort */ }
  }

  recordHistory(url, title) {
    const safeUrl = sanitizeHistoryUrl(url);
    if (!safeUrl) return false;
    const previous = this.history.find((item) => item.url === safeUrl);
    const item = {
      id: previous?.id || `browser-history-${Date.now()}-${++this.sequence}`,
      title: sanitizeBrowserTitle(title),
      url: safeUrl,
      visitedAt: new Date().toISOString(),
      visitCount: Math.max(1, Number(previous?.visitCount || 0) + 1),
    };
    const currentHistory = this.history;
    this.history = [item, ...this.history.filter((entry) => entry.url !== safeUrl)].slice(0, MAX_BROWSER_HISTORY);
    try {
      this.saveHistory();
    } catch {
      this.history = currentHistory;
      return false;
    }
    this.emitState();
    return true;
  }

  removeHistory(historyId) {
    const before = this.history.length;
    this.history = this.history.filter((item) => item.id !== String(historyId || ''));
    if (this.history.length === before) return this.getState();
    this.saveHistory();
    this.emitState();
    return this.getState();
  }

  clearHistory() {
    this.history = [];
    this.saveHistory();
    this.emitState();
    return this.getState();
  }

  loadPermissionRules() {
    try {
      return normalizeBrowserPermissionRules(JSON.parse(fs.readFileSync(this.permissionRulesPath(), 'utf8')));
    } catch {
      return {};
    }
  }

  savePermissionRules() {
    fs.mkdirSync(path.dirname(this.permissionRulesPath()), { recursive: true });
    fs.writeFileSync(this.permissionRulesPath(), JSON.stringify(this.permissionRules, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.permissionRulesPath(), 0o600); } catch { /* best effort */ }
  }

  isOwnedWebContents(webContents) {
    return this.tabs.some((tab) => tab.view.webContents === webContents);
  }

  requestingOrigin(webContents, details = {}) {
    const raw = details.requestingUrl || details.securityOrigin || webContents?.getURL?.() || '';
    try {
      const parsed = new URL(raw);
      return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : '';
    } catch {
      return '';
    }
  }

  permissionDecision(webContents, permission, details) {
    if (!this.isOwnedWebContents(webContents)) return 'deny';
    const key = permissionRuleKey(this.requestingOrigin(webContents, details), permission);
    if (!key) return 'deny';
    return this.sessionPermissionRules.get(key) || this.permissionRules[key] || 'ask';
  }

  installPermissionHandlers() {
    this.browserSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => {
      const decision = this.permissionDecision(webContents, permission, {
        ...details,
        requestingUrl: requestingOrigin || details.requestingUrl,
      });
      return decision === 'allow';
    });
    this.browserSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
      const decision = this.permissionDecision(webContents, permission, details);
      if (decision !== 'ask' || !this.visible) {
        callback(decision === 'allow');
        return;
      }
      const origin = this.requestingOrigin(webContents, details);
      const key = permissionRuleKey(origin, permission);
      if (!key) {
        callback(false);
        return;
      }
      const requestId = `browser-permission-${Date.now()}-${++this.sequence}`;
      let settled = false;
      const finish = (allowed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingPermissionRequests.delete(requestId);
        callback(Boolean(allowed));
      };
      const timer = setTimeout(() => finish(false), PERMISSION_REQUEST_TIMEOUT_MS);
      this.pendingPermissionRequests.set(requestId, { key, origin, permission, finish });
      this.sendEvent('browser-workspace-permission-request', { requestId, origin, permission });
    });
  }

  installDownloadHandler() {
    this.downloadHandler = (event, item, webContents) => {
      if (!this.isOwnedWebContents(webContents)) {
        event.preventDefault();
        return;
      }
      fs.mkdirSync(this.downloadDirectory, { recursive: true });
      const filePath = uniqueDownloadPath(this.downloadDirectory, item.getFilename?.() || 'download');
      const download = {
        id: `browser-download-${Date.now()}-${++this.sequence}`,
        filename: path.basename(filePath),
        path: filePath,
        url: cleanText(item.getURL?.(), MAX_BROWSER_TARGET_LENGTH),
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: Math.max(0, Number(item.getTotalBytes?.()) || 0),
        startedAt: new Date().toISOString(),
        completedAt: null,
        error: null,
      };
      this.downloads = [download, ...this.downloads].slice(0, MAX_BROWSER_DOWNLOADS);
      item.setSavePath(filePath);
      const syncProgress = () => {
        download.receivedBytes = Math.max(0, Number(item.getReceivedBytes?.()) || 0);
        download.totalBytes = Math.max(0, Number(item.getTotalBytes?.()) || download.totalBytes || 0);
        this.emitState();
      };
      item.on('updated', syncProgress);
      item.once('done', (_doneEvent, state) => {
        syncProgress();
        download.state = state === 'completed' ? 'completed' : (state === 'cancelled' ? 'cancelled' : 'interrupted');
        download.completedAt = new Date().toISOString();
        download.error = download.state === 'interrupted' ? '下载中断' : null;
        this.emitState();
      });
      this.emitState();
    };
    this.browserSession.on('will-download', this.downloadHandler);
  }

  resolvePermissionRequest(requestId, decision) {
    const pending = this.pendingPermissionRequests.get(String(requestId || ''));
    if (!pending) return false;
    if (decision === 'allow_once') {
      this.sessionPermissionRules.set(pending.key, 'allow');
      pending.finish(true);
    } else if (decision === 'allow_always') {
      this.permissionRules[pending.key] = 'allow';
      this.savePermissionRules();
      pending.finish(true);
    } else if (decision === 'deny_always') {
      this.permissionRules[pending.key] = 'deny';
      this.savePermissionRules();
      pending.finish(false);
    } else {
      pending.finish(false);
    }
    this.emitState();
    return true;
  }

  listPermissions() {
    return Object.entries(this.permissionRules).map(([key, decision]) => {
      const splitAt = key.lastIndexOf('|');
      return { origin: key.slice(0, splitAt), permission: key.slice(splitAt + 1), decision };
    }).sort((left, right) => left.origin.localeCompare(right.origin) || left.permission.localeCompare(right.permission));
  }

  removePermission(origin, permission) {
    const key = permissionRuleKey(origin, permission);
    if (!key) return false;
    delete this.permissionRules[key];
    this.sessionPermissionRules.delete(key);
    this.savePermissionRules();
    this.emitState();
    return true;
  }

  tabById(tabId) {
    return this.tabs.find((tab) => tab.id === tabId) || null;
  }

  activeTab() {
    return this.tabById(this.activeTabId);
  }

  publicTab(tab) {
    return {
      id: tab.id,
      title: tab.title,
      url: tab.url,
      isLoading: tab.isLoading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
      error: tab.error,
      zoomFactor: normalizeZoomFactor(tab.zoomFactor),
      findMatches: Math.max(0, finiteInteger(tab.findMatches) || 0),
      findActiveMatch: Math.max(0, finiteInteger(tab.findActiveMatch) || 0),
    };
  }

  getState() {
    return {
      available: true,
      visible: this.visible,
      activeTabId: this.activeTabId,
      tabs: this.tabs.map((tab) => this.publicTab(tab)),
      permissions: this.listPermissions(),
      downloads: this.downloads.map((download) => ({ ...download })),
      downloadDirectory: this.downloadDirectory,
      history: this.history.map((item) => ({ ...item })),
    };
  }

  emitState() {
    this.sendEvent('browser-workspace-state', this.getState());
  }

  updateTab(tab, patch = {}) {
    Object.assign(tab, patch);
    try {
      tab.canGoBack = tab.view.webContents.navigationHistory.canGoBack();
      tab.canGoForward = tab.view.webContents.navigationHistory.canGoForward();
    } catch {
      tab.canGoBack = false;
      tab.canGoForward = false;
    }
    this.emitState();
  }

  guardNavigation(tab, event, url) {
    if (isAllowedBrowserNavigation(url)) return;
    event.preventDefault();
    if (tab) this.updateTab(tab, { error: '已阻止不安全的页面地址' });
  }

  wireTab(tab) {
    const contents = tab.view.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedBrowserNavigation(url) && this.tabs.length < MAX_BROWSER_TABS) {
        this.createTab(url);
      }
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => this.guardNavigation(tab, event, url));
    contents.on('will-redirect', (event, url) => this.guardNavigation(tab, event, url));
    contents.on('did-start-loading', () => this.updateTab(tab, { isLoading: true, error: null }));
    contents.on('did-stop-loading', () => this.updateTab(tab, {
      isLoading: false,
      url: sanitizeBrowserUrl(contents.getURL()),
    }));
    contents.on('did-navigate', (_event, url) => this.updateTab(tab, { url: sanitizeBrowserUrl(url), error: null }));
    contents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      this.updateTab(tab, { url: sanitizeBrowserUrl(url), error: null });
      if (isMainFrame) this.recordHistory(url, contents.getTitle());
    });
    contents.on('did-finish-load', () => {
      if (tab.suppressNextHistory) {
        tab.suppressNextHistory = false;
        return;
      }
      this.recordHistory(contents.getURL(), contents.getTitle());
    });
    contents.on('page-title-updated', (event, title) => {
      event.preventDefault();
      this.updateTab(tab, { title: sanitizeBrowserTitle(title) });
    });
    contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      this.updateTab(tab, {
        isLoading: false,
        url: isAllowedBrowserNavigation(url) ? sanitizeBrowserUrl(url) : tab.url,
        error: cleanText(description, 500) || `页面加载失败 (${code})`,
      });
    });
    contents.on('found-in-page', (_event, result = {}) => {
      this.updateTab(tab, {
        findMatches: Math.max(0, finiteInteger(result.matches) || 0),
        findActiveMatch: Math.max(0, finiteInteger(result.activeMatchOrdinal) || 0),
      });
    });
  }

  createTab(target = 'about:blank') {
    if (this.tabs.length >= MAX_BROWSER_TABS) throw new Error(`最多打开 ${MAX_BROWSER_TABS} 个标签页`);
    const url = normalizeBrowserTarget(target);
    if (!url) throw new Error('只允许打开 HTTP 或 HTTPS 网页');
    const id = `browser-tab-${Date.now()}-${++this.sequence}`;
    const view = new this.WebContentsView({
      webPreferences: {
        session: this.browserSession,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webviewTag: false,
        navigateOnDragDrop: false,
        allowRunningInsecureContent: false,
        spellcheck: true,
        devTools: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    const tab = {
      id,
      view,
      title: '新标签页',
      url,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      error: null,
      zoomFactor: 1,
      findMatches: 0,
      findActiveMatch: 0,
      findQuery: '',
      suppressNextHistory: false,
    };
    this.tabs.push(tab);
    this.activeTabId = id;
    this.wireTab(tab);
    this.attachActiveView();
    void view.webContents.loadURL(url).catch((error) => {
      this.updateTab(tab, { isLoading: false, error: cleanText(error?.message, 500) || '页面加载失败' });
    });
    this.emitState();
    return this.getState();
  }

  activateTab(tabId) {
    if (!this.tabById(tabId)) return this.getState();
    this.activeTabId = tabId;
    this.attachActiveView();
    this.emitState();
    return this.getState();
  }

  closeTab(tabId) {
    const index = this.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return this.getState();
    const [tab] = this.tabs.splice(index, 1);
    if (this.attachedView === tab.view) this.detachView(tab.view);
    try { tab.view.webContents.close(); } catch { /* already closed */ }
    if (this.activeTabId === tabId) {
      this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id || null;
    }
    if (this.visible && this.tabs.length === 0) return this.createTab();
    this.attachActiveView();
    this.emitState();
    return this.getState();
  }

  navigate(tabId, target) {
    const tab = this.tabById(tabId) || this.activeTab();
    if (!tab) return this.createTab(target);
    const url = normalizeBrowserTarget(target);
    if (!url) throw new Error('只允许打开 HTTP 或 HTTPS 网页');
    tab.error = null;
    void tab.view.webContents.loadURL(url).catch((error) => {
      this.updateTab(tab, { isLoading: false, error: cleanText(error?.message, 500) || '页面加载失败' });
    });
    this.updateTab(tab, { url, isLoading: true });
    return this.getState();
  }

  goBack(tabId) {
    const tab = this.tabById(tabId) || this.activeTab();
    if (tab?.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
    return this.getState();
  }

  goForward(tabId) {
    const tab = this.tabById(tabId) || this.activeTab();
    if (tab?.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
    return this.getState();
  }

  reload(tabId) {
    const tab = this.tabById(tabId) || this.activeTab();
    tab?.view.webContents.reload();
    return this.getState();
  }

  stop(tabId) {
    const tab = this.tabById(tabId) || this.activeTab();
    tab?.view.webContents.stop();
    return this.getState();
  }

  findInPage(tabId, text, forward = true) {
    const tab = this.tabById(tabId) || this.activeTab();
    if (!tab) return this.getState();
    const query = cleanText(text, 500);
    if (!query) {
      tab.view.webContents.stopFindInPage('clearSelection');
      this.updateTab(tab, { findQuery: '', findMatches: 0, findActiveMatch: 0 });
      return this.getState();
    }
    const findNext = tab.findQuery !== query;
    tab.findQuery = query;
    tab.view.webContents.findInPage(query, { forward: Boolean(forward), findNext });
    return this.getState();
  }

  stopFindInPage(tabId) {
    const tab = this.tabById(tabId) || this.activeTab();
    tab?.view.webContents.stopFindInPage('clearSelection');
    if (tab) this.updateTab(tab, { findQuery: '', findMatches: 0, findActiveMatch: 0 });
    return this.getState();
  }

  setZoomFactor(tabId, factor) {
    const tab = this.tabById(tabId) || this.activeTab();
    if (!tab) return this.getState();
    tab.zoomFactor = normalizeZoomFactor(factor);
    tab.view.webContents.setZoomFactor(tab.zoomFactor);
    this.emitState();
    return this.getState();
  }

  printPage(tabId) {
    const tab = this.tabById(tabId) || this.activeTab();
    if (!tab) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      tab.view.webContents.print({ silent: false, printBackground: true }, (success, failureReason) => {
        if (success) resolve(true);
        else reject(new Error(cleanText(failureReason, 500) || '打印失败'));
      });
    });
  }

  openDevTools(tabId) {
    const tab = this.tabById(tabId) || this.activeTab();
    if (!tab) return false;
    tab.view.webContents.openDevTools({ mode: 'detach', activate: true });
    return true;
  }

  async captureScreenshot(tabId) {
    const tab = this.tabById(tabId) || this.activeTab();
    if (!tab) throw new Error('没有可截图的网页');
    const image = await tab.view.webContents.capturePage();
    if (image.isEmpty()) throw new Error('网页截图为空');
    return { title: sanitizeBrowserTitle(tab.title), png: image.toPNG() };
  }

  async clearBrowsingData() {
    for (const pending of this.pendingPermissionRequests.values()) pending.finish(false);
    this.pendingPermissionRequests.clear();
    this.sessionPermissionRules.clear();
    this.history = [];
    this.saveHistory();
    await Promise.all([
      this.browserSession.clearCache(),
      this.browserSession.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'shadercache', 'websql'],
      }),
      typeof this.browserSession.clearAuthCache === 'function' ? this.browserSession.clearAuthCache() : Promise.resolve(),
    ]);
    for (const tab of this.tabs) {
      tab.error = null;
      tab.suppressNextHistory = true;
      tab.view.webContents.reload();
    }
    this.emitState();
    return this.getState();
  }

  clearPermissionRules() {
    this.permissionRules = {};
    this.sessionPermissionRules.clear();
    this.savePermissionRules();
    this.emitState();
    return this.getState();
  }

  downloadPath(downloadId) {
    return this.downloads.find((item) => item.id === String(downloadId || ''))?.path || null;
  }

  clearDownloadRecords() {
    this.downloads = [];
    this.emitState();
    return this.getState();
  }

  setBounds(bounds) {
    const win = this.getParentWindow();
    if (!win || win.isDestroyed()) return false;
    const content = win.getContentBounds();
    const normalized = normalizeBrowserBounds(bounds, { width: content.width, height: content.height });
    if (!normalized) return false;
    this.bounds = normalized;
    if (this.attachedView) this.attachedView.setBounds(normalized);
    return true;
  }

  setVisible(visible) {
    this.visible = Boolean(visible);
    if (this.visible && this.tabs.length === 0) return this.createTab();
    this.attachActiveView();
    this.emitState();
    return this.getState();
  }

  detachView(view = this.attachedView) {
    const win = this.getParentWindow();
    if (!view || !win || win.isDestroyed()) return;
    try { win.contentView.removeChildView(view); } catch { /* not attached */ }
    if (this.attachedView === view) this.attachedView = null;
  }

  attachActiveView() {
    const win = this.getParentWindow();
    const active = this.activeTab();
    if (this.attachedView && (!this.visible || !active || this.attachedView !== active.view)) {
      this.detachView(this.attachedView);
    }
    if (!this.visible || !active || !this.bounds || !win || win.isDestroyed()) return;
    if (this.attachedView !== active.view) {
      win.contentView.addChildView(active.view);
      this.attachedView = active.view;
    }
    active.view.setBounds(this.bounds);
  }

  async capturePage(tabId) {
    const tab = this.tabById(tabId) || this.activeTab();
    if (!tab) throw new Error('没有可加入对话的网页');
    const value = await tab.view.webContents.executeJavaScript(`(() => {
      const selectedText = String(window.getSelection?.()?.toString?.() || '').trim();
      const bodyText = String(document.body?.innerText || '').trim();
      return {
        title: String(document.title || ''),
        url: String(location.href || ''),
        text: (selectedText || bodyText).slice(0, ${MAX_BROWSER_PAGE_TEXT_LENGTH}),
        selected: Boolean(selectedText)
      };
    })()`);
    return normalizeCapturedPage(value);
  }

  destroy() {
    for (const pending of this.pendingPermissionRequests.values()) pending.finish(false);
    this.pendingPermissionRequests.clear();
    this.detachView();
    for (const tab of this.tabs) {
      try { tab.view.webContents.close(); } catch { /* ignore */ }
    }
    this.tabs = [];
    this.activeTabId = null;
    try { this.browserSession.setPermissionCheckHandler(null); } catch { /* ignore */ }
    try { this.browserSession.setPermissionRequestHandler(null); } catch { /* ignore */ }
    try { this.browserSession.removeListener('will-download', this.downloadHandler); } catch { /* ignore */ }
  }
}

module.exports = {
  ASKABLE_BROWSER_PERMISSIONS,
  BROWSER_PARTITION,
  BrowserWorkspaceController,
  MAX_BROWSER_PAGE_TEXT_LENGTH,
  MAX_BROWSER_TABS,
  closeBrowserTabState,
  createBrowserTabState,
  isAllowedBrowserNavigation,
  normalizeBrowserBounds,
  normalizeZoomFactor,
  normalizeBrowserPermissionRules,
  normalizeBrowserHistory,
  normalizeBrowserTarget,
  normalizeCapturedPage,
  permissionRuleKey,
  safeDownloadFilename,
  sanitizeHistoryUrl,
  uniqueDownloadPath,
};
