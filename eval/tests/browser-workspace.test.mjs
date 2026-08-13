import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

const require = createRequire(import.meta.url);
const {
  ASKABLE_BROWSER_PERMISSIONS,
  BrowserWorkspaceController,
  createBrowserTabState,
  closeBrowserTabState,
  normalizeBrowserHistory,
  normalizeBrowserBounds,
  normalizeBrowserPermissionRules,
  normalizeBrowserTarget,
  normalizeZoomFactor,
  permissionRuleKey,
  safeDownloadFilename,
  sanitizeHistoryUrl,
} = require('../../electron/browser-workspace.js');

test('browser navigation accepts web URLs, searches plain text and rejects dangerous schemes', () => {
  assert.equal(normalizeBrowserTarget('example.com/docs'), 'https://example.com/docs');
  assert.equal(normalizeBrowserTarget('http://localhost:4173/demo'), 'http://localhost:4173/demo');
  assert.equal(normalizeBrowserTarget('季度报告'), 'https://duckduckgo.com/?q=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A');
  assert.equal(normalizeBrowserTarget('javascript:alert(1)'), null);
  assert.equal(normalizeBrowserTarget('file:///etc/passwd'), null);
  assert.equal(normalizeBrowserTarget('data:text/html,hello'), null);
});

test('browser tabs preserve one active tab and cap untrusted titles and URLs', () => {
  let state = createBrowserTabState();
  state = createBrowserTabState(state, { id: 'tab-1', title: 'A'.repeat(500), url: 'https://example.com' });
  state = createBrowserTabState(state, { id: 'tab-2', title: '第二页', url: 'https://example.com/two' });
  assert.equal(state.activeTabId, 'tab-2');
  assert.equal(state.tabs[0].title.length <= 160, true);
  state = closeBrowserTabState(state, 'tab-2');
  assert.equal(state.activeTabId, 'tab-1');
  state = closeBrowserTabState(state, 'tab-1');
  assert.equal(state.tabs.length, 0);
  assert.equal(state.activeTabId, null);
});

test('site permission rules keep only supported decisions and stable HTTPS origins', () => {
  assert.equal(ASKABLE_BROWSER_PERMISSIONS.has('media'), true);
  assert.equal(ASKABLE_BROWSER_PERMISSIONS.has('openExternal'), false);
  assert.equal(permissionRuleKey('https://example.com/path', 'geolocation'), 'https://example.com|geolocation');
  assert.equal(permissionRuleKey('file:///tmp/a', 'geolocation'), null);
  assert.deepEqual(normalizeBrowserPermissionRules({
    'https://example.com|geolocation': 'allow',
    'https://example.com|media': 'deny',
    'file://|media': 'allow',
    'https://example.com|openExternal': 'allow',
    'https://example.com|notifications': 'maybe',
  }), {
    'https://example.com|geolocation': 'allow',
    'https://example.com|media': 'deny',
  });
});

test('browser view bounds are finite, positive and clamped to the host content area', () => {
  assert.deepEqual(normalizeBrowserBounds({ x: -20, y: 12.8, width: 9000, height: 700 }, { width: 1200, height: 800 }), {
    x: 0,
    y: 13,
    width: 1200,
    height: 700,
  });
  assert.equal(normalizeBrowserBounds({ x: 0, y: 0, width: 0, height: 20 }, { width: 1200, height: 800 }), null);
});

test('browser zoom and download filenames stay inside bounded safe values', () => {
  assert.equal(normalizeZoomFactor(9), 2);
  assert.equal(normalizeZoomFactor(0.1), 0.5);
  assert.equal(normalizeZoomFactor(1.26), 1.3);
  assert.equal(safeDownloadFilename('../../季度:报告?.pdf'), '季度_报告_.pdf');
});

test('browser history removes secrets, merges repeat visits and persists with private file permissions', (context) => {
  assert.equal(
    sanitizeHistoryUrl('https://user:pass@example.com/report?token=secret&zipcode=200000&api_key=hidden#part'),
    'https://example.com/report?zipcode=200000',
  );
  assert.equal(sanitizeHistoryUrl('about:blank'), null);
  assert.deepEqual(normalizeBrowserHistory([
    { id: 'one', title: '第一页', url: 'https://example.com/?code=hidden&view=full', visitedAt: '2026-07-31T01:00:00.000Z', visitCount: 2 },
    { id: 'duplicate', title: '重复', url: 'https://example.com/?view=full', visitedAt: '2026-07-31T02:00:00.000Z' },
    { id: 'bad', title: '本地文件', url: 'file:///tmp/private', visitedAt: '2026-07-31T03:00:00.000Z' },
  ]), [{
    id: 'one',
    title: '第一页',
    url: 'https://example.com/?view=full',
    visitedAt: '2026-07-31T01:00:00.000Z',
    visitCount: 2,
  }]);

  const userDataPath = mkdtempSync(join(tmpdir(), 'browser-workspace-history-'));
  context.after(() => rmSync(userDataPath, { recursive: true, force: true }));
  const browserSession = {
    setPermissionCheckHandler() {},
    setPermissionRequestHandler() {},
    on() {},
    removeListener() {},
  };
  const controller = new BrowserWorkspaceController({
    WebContentsView: function FakeWebContentsView() {},
    browserSession,
    getParentWindow: () => null,
    userDataPath,
    sendEvent: () => {},
  });
  context.after(() => controller.destroy());

  assert.equal(controller.recordHistory('https://example.com/report?token=first&view=full#one', '报告'), true);
  assert.equal(controller.recordHistory('https://example.com/report?token=second&view=full#two', '报告新版'), true);
  assert.equal(controller.getState().history.length, 1);
  assert.equal(controller.getState().history[0].visitCount, 2);
  assert.equal(controller.getState().history[0].title, '报告新版');
  const historyPath = join(userDataPath, 'browser-history.json');
  const historyFile = readFileSync(historyPath, 'utf8');
  assert.doesNotMatch(historyFile, /first|second/);
  assert.equal(statSync(historyPath).mode & 0o777, 0o600);

  const historyId = controller.getState().history[0].id;
  controller.removeHistory(historyId);
  assert.equal(controller.getState().history.length, 0);
  controller.recordHistory('https://example.com/again', '再次访问');
  controller.clearHistory();
  assert.deepEqual(JSON.parse(readFileSync(historyPath, 'utf8')), []);
});

test('site permission prompts and owned downloads stay inside the browser boundary', async (context) => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'browser-workspace-permissions-'));
  context.after(() => rmSync(userDataPath, { recursive: true, force: true }));
  const browserSession = {
    setPermissionCheckHandler(handler) { this.check = handler; },
    setPermissionRequestHandler(handler) { this.request = handler; },
    on(channel, handler) { if (channel === 'will-download') this.download = handler; },
    removeListener(channel, handler) { if (channel === 'will-download' && this.download === handler) this.download = null; },
    async clearCache() { this.cacheCleared = true; },
    async clearStorageData(options) { this.storageClearOptions = options; },
    async clearAuthCache() { this.authCleared = true; },
  };
  const events = [];
  const controller = new BrowserWorkspaceController({
    WebContentsView: function FakeWebContentsView() {},
    browserSession,
    getParentWindow: () => null,
    userDataPath,
    sendEvent: (channel, payload) => events.push({ channel, payload }),
  });
  context.after(() => controller.destroy());
  const webContents = { getURL: () => 'https://example.com/report', close() {}, reload() {} };
  controller.tabs.push({ id: 'fake-tab', view: { webContents } });
  controller.visible = true;

  const downloadItem = new EventEmitter();
  downloadItem.getFilename = () => '../../report?.txt';
  downloadItem.getURL = () => 'https://example.com/report.txt';
  downloadItem.getTotalBytes = () => 12;
  downloadItem.getReceivedBytes = () => 12;
  downloadItem.setSavePath = (value) => { downloadItem.savePath = value; };
  let downloadPrevented = false;
  browserSession.download({ preventDefault: () => { downloadPrevented = true; } }, downloadItem, webContents);
  assert.equal(downloadPrevented, false);
  assert.equal(downloadItem.savePath.startsWith(userDataPath), true);
  assert.equal(controller.getState().downloads[0].filename, 'report_.txt');
  downloadItem.emit('done', {}, 'completed');
  assert.equal(controller.getState().downloads[0].state, 'completed');

  let foreignPrevented = false;
  browserSession.download({ preventDefault: () => { foreignPrevented = true; } }, downloadItem, { getURL: () => 'https://outside.test' });
  assert.equal(foreignPrevented, true);

  let allowed = null;
  browserSession.request(webContents, 'geolocation', (value) => { allowed = value; }, {
    requestingUrl: 'https://example.com/report',
  });
  const request = events.find((event) => event.channel === 'browser-workspace-permission-request');
  assert.equal(request.payload.origin, 'https://example.com');
  assert.equal(controller.resolvePermissionRequest(request.payload.requestId, 'allow_once'), true);
  assert.equal(allowed, true);
  assert.equal(browserSession.check(webContents, 'geolocation', 'https://example.com', {}), true);

  allowed = null;
  browserSession.request(webContents, 'notifications', (value) => { allowed = value; }, {
    requestingUrl: 'https://example.com/report',
  });
  const notificationRequest = events.filter((event) => event.channel === 'browser-workspace-permission-request').at(-1);
  controller.resolvePermissionRequest(notificationRequest.payload.requestId, 'allow_always');
  assert.equal(allowed, true);
  assert.deepEqual(JSON.parse(readFileSync(join(userDataPath, 'browser-site-permissions.json'), 'utf8')), {
    'https://example.com|notifications': 'allow',
  });

  allowed = null;
  browserSession.request(webContents, 'openExternal', (value) => { allowed = value; }, {
    requestingUrl: 'https://example.com/report',
  });
  assert.equal(allowed, false);

  await controller.clearBrowsingData();
  assert.equal(browserSession.cacheCleared, true);
  assert.equal(browserSession.authCleared, true);
  assert.equal(browserSession.storageClearOptions.storages.includes('cookies'), true);
  assert.equal(controller.getState().history.length, 0);
});

test('Electron browser host keeps remote content sandboxed and the preload bridge bounded', () => {
  const main = readFileSync(new URL('../../electron/main.js', import.meta.url), 'utf8');
  const preload = readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8');
  const browserHost = readFileSync(new URL('../../electron/browser-workspace.js', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../../electron/package.json', import.meta.url), 'utf8'));

  assert.match(main, /WebContentsView/);
  assert.match(main, /persist:browser-workspace/);
  assert.match(browserHost, /setPermissionCheckHandler/);
  assert.match(browserHost, /setPermissionRequestHandler/);
  assert.match(browserHost, /will-download/);
  assert.match(browserHost, /nodeIntegration:\s*false/);
  assert.match(browserHost, /contextIsolation:\s*true/);
  assert.match(browserHost, /sandbox:\s*true/);
  assert.match(main, /browser-workspace-get-state/);
  assert.match(main, /browser-workspace-find/);
  assert.match(main, /browser-workspace-set-zoom/);
  assert.match(main, /browser-workspace-save-screenshot/);
  assert.match(main, /browser-workspace-clear-data/);
  assert.match(main, /browser-workspace-remove-history/);
  assert.match(main, /browser-workspace-clear-history/);
  assert.match(browserHost, /browser-workspace-state/);
  assert.match(preload, /browserWorkspaceGetState/);
  assert.match(preload, /browserWorkspaceCapturePage/);
  assert.match(preload, /browserWorkspaceSaveScreenshot/);
  assert.match(preload, /browserWorkspaceRemoveHistory/);
  assert.match(preload, /browserWorkspaceClearHistory/);
  assert.match(preload, /browserWorkspaceShowDownload/);
  assert.equal(packageJson.build.files.includes('browser-workspace.js'), true);
});
