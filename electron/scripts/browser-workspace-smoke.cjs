const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const { BrowserWorkspaceController } = require('../browser-workspace');

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-workspace-smoke-'));
app.setName('BrowserWorkspaceSmoke');
app.setPath('userData', userDataPath);
app.commandLine.appendSwitch('disable-gpu');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address()));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待超时: ${label}`);
}

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url === '/two') {
    response.end('<!doctype html><title>第二页</title><main>第二页正文</main>');
    return;
  }
  if (request.url === '/popup') {
    response.end('<!doctype html><title>弹出页</title><main>弹出页正文</main>');
    return;
  }
  if (request.url === '/download') {
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    response.setHeader('content-disposition', 'attachment; filename="browser-smoke.txt"');
    response.end('真实下载内容');
    return;
  }
  response.end(`<!doctype html>
    <title>安全浏览器测试</title>
    <main id="content">可抓取的本地网页正文</main>
    <button id="popup" onclick="window.open('/popup', '_blank')">打开弹出页</button>
    <a id="download" href="/download" download>测试下载</a>`);
});

let controller = null;
let win = null;
let exitCode = 0;

async function run() {
  const address = await listen(server);
  const origin = `http://127.0.0.1:${address.port}`;
  const events = [];
  win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  controller = new BrowserWorkspaceController({
    WebContentsView,
    browserSession: session.fromPartition('persist:browser-workspace-smoke'),
    getParentWindow: () => win,
    userDataPath,
    sendEvent: (channel, payload) => events.push({ channel, payload }),
  });
  win.show();
  assert.equal(controller.setBounds({ x: 10, y: 10, width: 700, height: 560 }), true);
  controller.setVisible(true);
  const firstTabId = controller.getState().activeTabId;
  controller.navigate(firstTabId, `${origin}/one`);

  const firstTab = await waitFor(() => {
    const tab = controller.tabById(firstTabId);
    return tab && !tab.isLoading && tab.title === '安全浏览器测试' ? tab : null;
  }, '首页加载');
  assert.equal(firstTab.url, `${origin}/one`);
  assert.equal(await firstTab.view.webContents.executeJavaScript('typeof process'), 'undefined');
  const firstHistory = controller.getState().history.find((item) => item.url === `${origin}/one`);
  assert.equal(firstHistory?.title, '安全浏览器测试');

  const captured = await controller.capturePage(firstTabId);
  assert.equal(captured.title, '安全浏览器测试');
  assert.equal(captured.url, `${origin}/one`);
  assert.match(captured.text, /可抓取的本地网页正文/);
  assert.equal(captured.selected, false);

  await firstTab.view.webContents.executeJavaScript(`(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('#content'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  })()`);
  const selection = await controller.capturePage(firstTabId);
  assert.equal(selection.selected, true);
  assert.equal(selection.text, '可抓取的本地网页正文');
  await firstTab.view.webContents.executeJavaScript('window.getSelection()?.removeAllRanges()');

  firstTab.view.webContents.focus();
  await new Promise((resolve) => setTimeout(resolve, 120));
  controller.findInPage(firstTabId, '本地网页', true);
  await waitFor(() => controller.tabById(firstTabId)?.findMatches > 0, '页面内查找');
  controller.stopFindInPage(firstTabId);
  assert.equal(controller.tabById(firstTabId).findMatches, 0);

  controller.setZoomFactor(firstTabId, 1.3);
  assert.equal(controller.getState().tabs.find((tab) => tab.id === firstTabId).zoomFactor, 1.3);
  const screenshot = await controller.captureScreenshot(firstTabId);
  assert.equal(screenshot.png.length > 100, true);

  await firstTab.view.webContents.executeJavaScript("document.querySelector('#download').click()");
  const completedDownload = await waitFor(() => controller.getState().downloads.find((item) => item.state === 'completed'), '真实网页下载');
  assert.equal(fs.readFileSync(completedDownload.path, 'utf8'), '真实下载内容');

  controller.navigate(firstTabId, `${origin}/two`);
  await waitFor(() => {
    const tab = controller.tabById(firstTabId);
    return tab && !tab.isLoading && tab.title === '第二页';
  }, '第二页加载');
  assert.equal(controller.tabById(firstTabId).canGoBack, true);
  assert.equal(controller.getState().history.some((item) => item.url === `${origin}/two`), true);
  controller.goBack(firstTabId);
  await waitFor(() => {
    const tab = controller.tabById(firstTabId);
    return tab && !tab.isLoading && tab.title === '安全浏览器测试';
  }, '后退到首页');

  const tabCountBeforePopup = controller.getState().tabs.length;
  await firstTab.view.webContents.executeJavaScript("document.querySelector('#popup').click()");
  const popupTab = await waitFor(() => {
    const state = controller.getState();
    if (state.tabs.length !== tabCountBeforePopup + 1) return null;
    return controller.activeTab()?.title === '弹出页' && !controller.activeTab()?.isLoading
      ? controller.activeTab()
      : null;
  }, '弹出页转换为内部标签页');
  assert.equal(popupTab.url, `${origin}/popup`);
  assert.equal(controller.attachedView, popupTab.view);

  controller.activateTab(firstTabId);
  assert.equal(controller.getState().activeTabId, firstTabId);
  controller.closeTab(popupTab.id);
  assert.equal(controller.getState().tabs.length, tabCountBeforePopup);
  assert.equal(events.some((event) => event.channel === 'browser-workspace-state'), true);

  const popupHistory = controller.getState().history.find((item) => item.url === `${origin}/popup`);
  assert.equal(popupHistory?.title, '弹出页');
  controller.removeHistory(popupHistory.id);
  assert.equal(controller.getState().history.some((item) => item.id === popupHistory.id), false);

  console.log('[browser-smoke] PASS 真实 WebContentsView 加载/导航/标签/弹窗/下载/历史/查找/缩放/截图/沙箱/页面抓取');
}

app.whenReady()
  .then(run)
  .catch((error) => {
    exitCode = 1;
    console.error('[browser-smoke] FAIL', error?.stack || error);
  })
  .finally(async () => {
    try { controller?.destroy(); } catch { /* ignore */ }
    try { win?.destroy(); } catch { /* ignore */ }
    try { await closeServer(server); } catch { /* ignore */ }
    try { fs.rmSync(userDataPath, { recursive: true, force: true }); } catch { /* ignore */ }
    app.exit(exitCode);
  });
