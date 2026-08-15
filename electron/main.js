// DSH App — Electron main process.
//
// Responsibilities:
// 1. Create main window (size/background/custom title bar);
// 2. Start local Node backend (app/server); stop it when the app exits;
// 3. Use ipcMain for native file/folder pickers and expose preload bridge;
// 4. Load the loopback surface published by the official DSH Web Profile.
//
// Backend process model: dev uses system node; prod runs local backend in Electron's Node mode.

const { app, BrowserWindow, WebContentsView, ipcMain, dialog, screen, shell, nativeImage, Menu, protocol, session, clipboard, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { normalizeWebSearchSettings, applyWebSearchEnv } = require('./web-search-settings');
const { normalizeProxyUrl } = require('./network-proxy-settings');
const { BrowserWorkspaceController } = require('./browser-workspace');
const { createAttachmentGrant } = require('./attachment-grants');
const { createArtifactContextMenu } = require('./artifact-context-menu');
const { createSettingsStore, saveResult, copyValidatedBgImage } = require('./skin-settings-store');
const { AppUpdateController } = require('./app-update-controller');
const { loadOrCreateRendererSurfacePort } = require('./renderer-surface-port');

const isDev = !app.isPackaged;
const APP_ROOT = isDev ? path.join(__dirname, '..') : process.resourcesPath;
const SERVER_DIR = path.join(APP_ROOT, 'server');
const APP_ICON = path.join(__dirname, 'icons', 'icon.png'); // application icon
const APP_DISPLAY_NAME = 'DeepSeek Harness Desktop App';
const LEGACY_DEFAULT_APP_NAMES = new Set(['DeepSeek Harness', 'dsh-work']);
const USER_DATA_DIR_NAME = 'dsh-electron';
const LOCAL_FILE_SCHEME = 'dsh-file';
// 用户本地底图资源协议：dsh-skin-asset://<filename> 映射到 userData/bg-images/<filename>。
const BG_ASSET_SCHEME = 'dsh-skin-asset';
const DATA_ROOT = process.env.DSH_DATA_ROOT
  ? path.resolve(process.env.DSH_DATA_ROOT)
  : path.join(os.homedir(), '.dsh');
const ATTACHMENTS_ROOT = path.join(DATA_ROOT, 'attachments');
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const LOCAL_MEDIA_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mp3', '.wav', '.m4a', '.ogg', '.aac', '.flac']);
const localFileRoots = new Set();
const nativeAttachmentPaths = new Set();
const ATTACHMENT_GRANT_SECRET = randomBytes(32).toString('base64url');
const ATTACHMENT_GRANT_TTL_MS = 5 * 60_000;
const DEFAULT_NO_PROXY = ['localhost', '127.0.0.1', '::1'];
const CHAT_PID = '__chat__';
const PASTE_ATTACHMENTS_DIR = 'pasted-text';
const PASTE_IMAGE_ATTACHMENTS_DIR = 'pasted-images';
const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_PASTED_IMAGE_EDGE = 16_384;
const BACKEND_START_TIMEOUT_MS = Number(process.env.DSH_BACKEND_START_TIMEOUT_MS || 30_000);
const API_REQUEST_TIMEOUT_MS = Number(process.env.DSH_API_REQUEST_TIMEOUT_MS || 300_000);
const STREAM_REQUEST_TIMEOUT_MS = Number(process.env.DSH_STREAM_REQUEST_TIMEOUT_MS || 30 * 60_000);
const BACKEND_STOP_TIMEOUT_MS = Number(process.env.DSH_BACKEND_STOP_TIMEOUT_MS || 8_000);
const SMOKE_TEST = process.env.DSH_SMOKE_TEST === '1';
const SMOKE_EXPECT_SELECTOR = String(process.env.DSH_SMOKE_EXPECT_SELECTOR || '').trim();
const SMOKE_REJECT_SELECTOR = String(process.env.DSH_SMOKE_REJECT_SELECTOR || '').trim();
const SMOKE_CLICK_SELECTORS = parseSmokeClickSelectors(process.env.DSH_SMOKE_CLICK_SELECTORS);
const UPDATE_API_BASE_URL = String(process.env.DSH_UPDATE_API_BASE_URL || '').trim();

function parseSmokeClickSelectors(raw) {
  const source = String(raw || '').trim();
  if (!source) return [];
  const parsed = JSON.parse(source);
  if (!Array.isArray(parsed) || parsed.some((selector) => typeof selector !== 'string' || !selector.trim())) {
    throw new Error('DSH_SMOKE_CLICK_SELECTORS 必须是非空 CSS selector 字符串数组');
  }
  return parsed.map((selector) => selector.trim());
}

protocol.registerSchemesAsPrivileged([
  { scheme: LOCAL_FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: BG_ASSET_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

function getUserDataPath() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', USER_DATA_DIR_NAME);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), USER_DATA_DIR_NAME);
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), USER_DATA_DIR_NAME);
}

app.setName(APP_DISPLAY_NAME);
app.setPath('userData', process.env.DSH_USER_DATA_DIR ? path.resolve(process.env.DSH_USER_DATA_DIR) : getUserDataPath());
const rendererSurfacePort = loadOrCreateRendererSurfacePort({ userDataPath: app.getPath('userData') });

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow = null;
let browserWorkspace = null;
let backendProc = null;
let backendState = 'stopped';
let backendReadyPromise = null;
let backendReadyResolve = null;
let backendReadyReject = null;
let backendReadyTimer = null;
let backendShutdownResolve = null;
let backendStopPromise = null;
let backendRestartAttempts = 0;
let backendStableTimer = null;
let rendererSurfaceUrl = null;
let isQuitting = false;
let allowFinalQuit = false;
let closePromptOpen = false;
const pending = new Map(); // id → {handle,fail,timer}: route backend messages by id
let reqSeq = 0;
let appUpdateController = null;
const CLOSE_BEHAVIOR_VALUES = new Set(['ask', 'minimize', 'quit']);

function networkSettingsPath() {
  return path.join(app.getPath('userData'), 'agent-network-settings.json');
}

function closeBehaviorPath() {
  return path.join(app.getPath('userData'), 'window-close-behavior.json');
}

// 用户自定义皮肤定义长久保存在 userData：localStorage 之上的第二份保险，卸载/升级后仍可恢复。
function skinsSettingsPath() {
  return path.join(app.getPath('userData'), 'skins.json');
}

// 品牌名 + 品牌外观长久保存（userData）：用户自定义的应用名/底图/底色/透明度。
function brandSettingsPath() {
  return path.join(app.getPath('userData'), 'brand.json');
}
function brandAppearanceSettingsPath() {
  return path.join(app.getPath('userData'), 'brand-appearance.json');
}
// 用户本地底图复制到 userData/bg-images，通过 dsh-skin-asset:// 协议稳定访问。
function bgImagesDir() {
  return path.join(app.getPath('userData'), 'bg-images');
}

function authorizedLocalRootsPath() {
  return path.join(app.getPath('userData'), 'authorized-local-roots.json');
}

function normalizeNetworkSettings(value = {}) {
  return {
    httpProxy: normalizeProxyUrl(value.httpProxy),
    noProxy: String(value.noProxy || '').trim(),
    customCert: String(value.customCert || '').trim(),
    ...normalizeWebSearchSettings(value),
  };
}

function loadNetworkSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(networkSettingsPath(), 'utf8'));
    const normalized = normalizeNetworkSettings(raw);
    // 旧版本可能把代理 userinfo 明文写入设置。读取时立即清除，不能再回传 renderer 或注入环境。
    if (String(raw?.httpProxy || '').trim() !== normalized.httpProxy) {
      writeNetworkSettingsFile(normalized);
    }
    return normalized;
  } catch {
    return normalizeNetworkSettings();
  }
}

function writeNetworkSettingsFile(settings) {
  fs.mkdirSync(path.dirname(networkSettingsPath()), { recursive: true });
  fs.writeFileSync(networkSettingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  try { fs.chmodSync(networkSettingsPath(), 0o600); } catch { /* best effort on platforms without POSIX modes */ }
}

function saveNetworkSettings(settings) {
  const strictProxy = normalizeProxyUrl(settings?.httpProxy, { strict: true });
  const normalized = normalizeNetworkSettings({ ...settings, httpProxy: strictProxy });
  writeNetworkSettingsFile(normalized);
  return normalized;
}

function loadCloseBehavior() {
  try {
    const raw = JSON.parse(fs.readFileSync(closeBehaviorPath(), 'utf8'));
    const behavior = String(raw?.behavior || 'ask');
    return CLOSE_BEHAVIOR_VALUES.has(behavior) ? behavior : 'ask';
  } catch {
    return 'ask';
  }
}

function saveCloseBehavior(behavior) {
  const normalized = CLOSE_BEHAVIOR_VALUES.has(behavior) ? behavior : 'ask';
  fs.mkdirSync(path.dirname(closeBehaviorPath()), { recursive: true });
  fs.writeFileSync(closeBehaviorPath(), JSON.stringify({ behavior: normalized }, null, 2));
  return normalized;
}

// 皮肤、应用名、品牌外观共享同一套版本信封和原子写入实现。
// load 明确区分 missing/corrupt/valid；save 通过结构化结果把错误返回 Renderer。
let skinSettingsPersistence = null;
function settingsPersistence() {
  if (!skinSettingsPersistence) {
    skinSettingsPersistence = createSettingsStore({
      skinsPath: skinsSettingsPath(),
      brandPath: brandSettingsPath(),
      appearancePath: brandAppearanceSettingsPath(),
      defaultAppName: APP_DISPLAY_NAME,
    });
  }
  return skinSettingsPersistence;
}

function loadSkinsSettings() {
  return settingsPersistence().loadSkins();
}
function saveSkinsSettings(settings) {
  return saveResult(() => settingsPersistence().saveSkins(settings));
}

// 运行时应用名：启动时从 brand.json 读，渲染层可通过 IPC 实时更新。
// 注意：不调用 app.setName（避免 userData 路径派生副作用），仅更新窗口标题/About/菜单显示。
let runtimeAppName = APP_DISPLAY_NAME;
function normalizeRuntimeAppName(name) {
  const normalized = typeof name === 'string' ? name.trim() : '';
  if (normalized.length > 32) {
    const error = new Error('应用名称不能超过 32 个字符');
    error.code = 'BRAND_NAME_TOO_LONG';
    throw error;
  }
  return !normalized || LEGACY_DEFAULT_APP_NAMES.has(normalized) ? APP_DISPLAY_NAME : normalized;
}

function applyRuntimeAppName(name) {
  runtimeAppName = normalizeRuntimeAppName(name);
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setTitle(runtimeAppName);
  if (process.platform === 'darwin') app.setAboutPanelOptions({ applicationName: runtimeAppName });
  return runtimeAppName;
}

function loadBrandSettings() {
  return settingsPersistence().loadBrand();
}
function saveBrandSettings(settings) {
  return saveResult(() => settingsPersistence().saveBrand(settings));
}

function loadBrandAppearanceSettings() {
  return settingsPersistence().loadAppearance();
}
function saveBrandAppearanceSettings(settings) {
  return saveResult(() => settingsPersistence().saveAppearance(settings));
}

async function copyBgImageToUserData(payload) {
  if (!payload || typeof payload.path !== 'string' || !payload.path) {
    const error = new Error('没有可读取的图片文件');
    error.code = 'BG_IMAGE_PATH_INVALID';
    throw error;
  }
  return copyValidatedBgImage({
    filePath: payload.path,
    declaredMimeType: typeof payload.mimeType === 'string' ? payload.mimeType : '',
    destinationDir: bgImagesDir(),
  });
}

function splitNoProxy(value) {
  return String(value || '')
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function mergedNoProxy(value) {
  return [...new Set([...DEFAULT_NO_PROXY, ...splitNoProxy(value)])].join(',');
}

function applyNetworkEnv(env, settings = loadNetworkSettings()) {
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    delete env[key];
  }
  const proxyUrl = normalizeProxyUrl(settings.httpProxy);
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.ALL_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.all_proxy = proxyUrl;
  }

  const noProxy = mergedNoProxy(settings.noProxy);
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;

  delete env.NODE_EXTRA_CA_CERTS;
  const certPath = String(settings.customCert || '').trim();
  if (certPath && fs.existsSync(certPath)) {
    env.NODE_EXTRA_CA_CERTS = certPath;
  } else if (certPath) {
    console.warn(`[electron] 自定义证书不存在,已跳过: ${certPath}`);
  }
  applyWebSearchEnv(env, settings);
}

async function applyRendererNetworkProxy(settings = loadNetworkSettings()) {
  const proxyUrl = normalizeProxyUrl(settings.httpProxy);
  const sessions = [session.defaultSession, session.fromPartition('persist:browser-workspace')];
  await Promise.all(sessions.map(async (targetSession) => {
    try {
      if (!proxyUrl) {
        await targetSession.setProxy({ mode: 'direct' });
        return;
      }
      await targetSession.setProxy({
        mode: 'fixed_servers',
        proxyRules: `http=${proxyUrl};https=${proxyUrl}`,
        proxyBypassRules: mergedNoProxy(settings.noProxy),
      });
    } catch (e) {
      console.warn('[electron] 应用渲染层代理失败:', e?.message || e);
    }
  }));
}

function configureProductionSecurityHeaders() {
  if (isDev) return;
  const policy = [
    "default-src 'self' data: blob: dsh-file:",
    // DSH modules injects the reviewed window.__DSH_BOOT__ graph as one inline
    // script into the App-owned index. Plugin code itself remains same-origin.
    // unsafe-eval: the DSH web client evaluates Cordis config __jsExpr via
    // new Function at module top level; without it the whole bundle fails.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: dsh-file: dsh-skin-asset: https: http:",
    "media-src 'self' data: blob: dsh-file: https: http://localhost:* http://127.0.0.1:*",
    "font-src 'self' data:",
    "connect-src 'self' https: http: wss: ws:",
    "worker-src 'self' blob:",
    "frame-src 'self' data: blob: https: http:",
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    });
  });
}

function normalizeLocalFileRoot(rootPath) {
  const raw = String(rootPath || '').trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function saveAuthorizedLocalRoots() {
  try {
    const roots = [...localFileRoots].filter((root) => root !== normalizeLocalFileRoot(ATTACHMENTS_ROOT));
    fs.mkdirSync(path.dirname(authorizedLocalRootsPath()), { recursive: true });
    fs.writeFileSync(authorizedLocalRootsPath(), JSON.stringify(roots, null, 2));
  } catch (error) {
    console.warn('[electron] 保存本地目录授权失败:', error?.message || error);
  }
}

function registerLocalFileRoot(rootPath, { persist = false } = {}) {
  const root = normalizeLocalFileRoot(rootPath);
  if (!root) return null;
  localFileRoots.add(root);
  if (persist) saveAuthorizedLocalRoots();
  return root;
}

function registerNativeAttachmentPath(filePath) {
  const real = realPathForExisting(filePath);
  try {
    if (!fs.statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  nativeAttachmentPaths.delete(real);
  nativeAttachmentPaths.add(real);
  while (nativeAttachmentPaths.size > 2048) {
    nativeAttachmentPaths.delete(nativeAttachmentPaths.values().next().value);
  }
  return real;
}

function attachmentGrant(pathValue) {
  const real = realPathForExisting(pathValue);
  if (!nativeAttachmentPaths.has(real)) return null;
  return {
    path: real,
    token: createAttachmentGrant(real, ATTACHMENT_GRANT_SECRET, { ttlMs: ATTACHMENT_GRANT_TTL_MS }),
  };
}

function isAgentTurnRequest(rawUrl) {
  const pathname = String(rawUrl || '').split('?')[0];
  return /^\/api\/agent\/projects\/[^/]+\/threads\/[^/]+\/turns$/.test(pathname)
    || /^\/api\/agent\/threads\/[^/]+\/turns\/[^/]+\/steer$/.test(pathname)
    || /^\/api\/agent\/projects\/[^/]+\/threads\/[^/]+\/dsh-prompt$/.test(pathname);
}

// The renderer may describe a path, but only the main process can turn a path
// chosen through the OS picker/drop/clipboard flow into a short-lived grant.
function authorizeAgentAttachmentRequest(request = {}) {
  if (!isAgentTurnRequest(request.url) || request.bodyEncoding || typeof request.body !== 'string') return request;
  let body;
  try {
    body = JSON.parse(request.body);
  } catch {
    return request;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return request;
  const grantsByPath = new Map();
  const grantFor = (rawPath) => {
    const key = String(rawPath || '').trim();
    if (!key) return null;
    if (!grantsByPath.has(key)) grantsByPath.set(key, attachmentGrant(key));
    return grantsByPath.get(key);
  };
  for (const item of Array.isArray(body.input) ? body.input : []) {
    if (item?.type !== 'localImage') continue;
    const grant = grantFor(item.path);
    delete item.attachmentGrant;
    delete item.attachment_grant;
    if (!grant) continue;
    item.path = grant.path;
    item.attachmentGrant = grant.token;
  }
  for (const item of Array.isArray(body.attachments) ? body.attachments : []) {
    const ext = path.extname(String(item?.path || '')).toLowerCase();
    const isImage = String(item?.mime_type || item?.mimeType || '').toLowerCase().startsWith('image/')
      || ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext);
    if (!isImage) continue;
    const grant = grantFor(item.path);
    delete item.attachmentGrant;
    delete item.attachment_grant;
    if (!grant) continue;
    item.path = grant.path;
    item.attachment_grant = grant.token;
  }
  return { ...request, body: JSON.stringify(body) };
}

function loadAuthorizedLocalRoots() {
  try {
    const roots = JSON.parse(fs.readFileSync(authorizedLocalRootsPath(), 'utf8'));
    if (Array.isArray(roots)) {
      for (const root of roots) {
        if (isExistingDirectory(root)) registerLocalFileRoot(root);
      }
    }
  } catch {
    // No authorized roots on first launch or old versions.
  }
}

function isInsideRoot(filePath, rootPath) {
  return filePath === rootPath || filePath.startsWith(rootPath + path.sep);
}

function isAllowedLocalPath(filePath) {
  const real = realPathForExisting(filePath);
  return [...localFileRoots].some((root) => isInsideRoot(real, root));
}

function resolveArtifactActionPath(filePath) {
  const real = realPathForExisting(String(filePath || ''));
  const appOwnedRoots = [
    path.join(DATA_ROOT, 'runs'),
    path.join(DATA_ROOT, 'project_artifacts'),
    path.join(DATA_ROOT, 'projects'),
    ATTACHMENTS_ROOT,
  ].map(realPathForExisting);
  const allowed = isAllowedLocalPath(real) || appOwnedRoots.some((root) => isInsideRoot(real, root));
  if (!allowed) return null;
  try {
    return fs.statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

function realPathForExisting(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function safeWorkspaceSegment(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 160);
}

function isExistingDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function pasteAttachmentWorkspaceRoot(projectId, sessionId) {
  const safePid = safeWorkspaceSegment(projectId) || CHAT_PID;
  const safeSessionId = safeWorkspaceSegment(sessionId) || 'draft';
  return path.join(ATTACHMENTS_ROOT, safePid, safeSessionId);
}

function savePastedTextAttachment(payload = {}) {
  const content = String(payload.content || '');
  if (!content) throw new Error('粘贴内容为空');
  const workspaceRoot = pasteAttachmentWorkspaceRoot(payload.projectId, payload.sessionId);
  const dir = path.join(workspaceRoot, PASTE_ATTACHMENTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  registerLocalFileRoot(workspaceRoot);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `pasted-text-${stamp}-${suffix}.txt`;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf8');
  return {
    path: filePath,
    name,
    size: Buffer.byteLength(content, 'utf8'),
  };
}

function savePastedImageAttachment(payload = {}) {
  const bytes = Buffer.from(payload.bytes || []);
  if (!bytes.length) throw new Error('粘贴图片为空');
  if (bytes.length > MAX_PASTED_IMAGE_BYTES) throw new Error('粘贴图片不能超过 20 MB');
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) throw new Error('无法识别粘贴图片');
  const size = image.getSize();
  if (!size.width || !size.height || size.width > MAX_PASTED_IMAGE_EDGE || size.height > MAX_PASTED_IMAGE_EDGE) {
    throw new Error('粘贴图片尺寸无效或过大');
  }
  const png = image.toPNG();
  if (!png.length || png.length > MAX_PASTED_IMAGE_BYTES) throw new Error('粘贴图片转换失败或文件过大');
  const workspaceRoot = pasteAttachmentWorkspaceRoot(payload.projectId, payload.sessionId);
  const dir = path.join(workspaceRoot, PASTE_IMAGE_ATTACHMENTS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  registerLocalFileRoot(workspaceRoot);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `pasted-image-${stamp}-${suffix}.png`;
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, png);
  registerNativeAttachmentPath(filePath);
  return {
    path: filePath,
    name,
    size: png.length,
    width: size.width,
    height: size.height,
    mimeType: 'image/png',
  };
}

function configureApplicationIdentity() {
  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: runtimeAppName,
      applicationVersion: app.getVersion(),
      version: app.getVersion(),
      iconPath: APP_ICON,
    });
  }
}

function configureApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }
  const closeBehavior = loadCloseBehavior();
  const setCloseBehavior = (behavior) => {
    saveCloseBehavior(behavior);
    configureApplicationMenu();
  };

  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        {
          label: '关闭按钮行为',
          submenu: [
            {
              label: '每次询问',
              type: 'radio',
              checked: closeBehavior === 'ask',
              click: () => setCloseBehavior('ask'),
            },
            {
              label: '最小化',
              type: 'radio',
              checked: closeBehavior === 'minimize',
              click: () => setCloseBehavior('minimize'),
            },
            {
              label: '关闭应用',
              type: 'radio',
              checked: closeBehavior === 'quit',
              click: () => setCloseBehavior('quit'),
            },
          ],
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: isDev
        ? [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ]
        : [{ role: 'togglefullscreen' }],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerLocalFileProtocol() {
  protocol.registerFileProtocol(LOCAL_FILE_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url);
      const encoded = url.hostname === 'local'
        ? (url.pathname || '').replace(/^\/+/, '')
        : `${url.hostname}${url.pathname || ''}`.replace(/^\/+/, '');
      const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(encoded.length / 4) * 4, '=');
      const filePath = Buffer.from(b64, 'base64').toString('utf8');
      const resolved = path.resolve(filePath);
      const ext = path.extname(resolved).toLowerCase();
      const real = realPathForExisting(resolved);
      const allowed = [...localFileRoots].some((root) => isInsideRoot(real, root));
      if ((!IMAGE_EXTS.has(ext) && !LOCAL_MEDIA_EXTS.has(ext)) || !allowed) {
        callback({ error: -10 });
        return;
      }
      callback({ path: real });
    } catch {
      callback({ error: -2 });
    }
  });
}

// 底图资源协议：dsh-skin-asset://<filename> 限定到 userData/bg-images。
// 严格校验文件名（24 位内容哈希+扩展名），防越界；只放行图片扩展名。
const BG_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
function registerBgAssetProtocol() {
  protocol.registerFileProtocol(BG_ASSET_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url);
      const name = decodeURIComponent(url.hostname || '').replace(/^\/+|\/+$/g, '');
      // 文件名白名单：仅允许 <hash>.<ext> 形态，禁止路径分隔符。
      if (!/^[a-f0-9]{24}\.(png|jpe?g|webp|gif)$/i.test(name)) {
        callback({ error: -10 });
        return;
      }
      const resolved = path.resolve(bgImagesDir(), name);
      const ext = path.extname(resolved).toLowerCase();
      const real = realPathForExisting(resolved);
      const realRoot = realPathForExisting(bgImagesDir());
      // 必须在 bg-images 目录内且是图片。
      if (!BG_IMAGE_EXTS.has(ext) || !isInsideRoot(real, realRoot)) {
        callback({ error: -10 });
        return;
      }
      callback({ path: real });
    } catch {
      callback({ error: -2 });
    }
  });
}

// ── Backend lifecycle ──
function startBackend() {
  if (backendState === 'ready') return Promise.resolve();
  if (backendState === 'starting' && backendReadyPromise) return backendReadyPromise;

  const entryRel = path.join('src', 'index.js');
  const entryAbs = path.join(SERVER_DIR, entryRel);
  if (!fs.existsSync(entryAbs)) return Promise.reject(new Error(`Server 入口不存在: ${entryAbs}`));
  // dev: system node; prod: Electron runs backend in Node mode (self-contained, requires electron-rebuild for native modules)
  const cmd = isDev ? (process.env.DSH_NODE_BIN || 'node') : process.execPath;
  const args = isDev ? [entryRel] : [entryAbs];
  const env = { ...process.env };
  env.DSH_DATA_ROOT = DATA_ROOT;
  env.DSH_APP_VERSION = app.getVersion();
  env.DSH_APP_NAME = runtimeAppName; // 用户自定义应用名，server 侧作为 Agent client 身份
  env.DSH_ATTACHMENT_GRANT_SECRET = ATTACHMENT_GRANT_SECRET;
  env.DSH_RUNTIME_DISTRIBUTION = process.env.DSH_RUNTIME_DISTRIBUTION || 'npm';
  env.DSH_DESKTOP_WEB_PORT = String(rendererSurfacePort);
  if (isDev) {
    env.DSH_SOURCE_ROOT = process.env.DSH_SOURCE_ROOT || path.resolve(APP_ROOT, '..', 'test-vibeinging');
  }
  applyNetworkEnv(env);
  if (isDev) env.DSH_TCP = '1'; // dev: backend also listens on TCP so eval can reuse running instance; prod: process channel only (portless)
  if (!isDev) env.ELECTRON_RUN_AS_NODE = '1';

  backendState = 'starting';
  backendReadyPromise = new Promise((resolve, reject) => {
    backendReadyResolve = resolve;
    backendReadyReject = reject;
  });
  backendReadyTimer = setTimeout(() => {
    const error = new Error(`本地 Server 启动超时(${BACKEND_START_TIMEOUT_MS}ms)`);
    backendReadyReject?.(error);
    backendReadyResolve = null;
    backendReadyReject = null;
    backendState = 'failed';
    try { backendProc?.kill(); } catch { /* ignore */ }
  }, BACKEND_START_TIMEOUT_MS);

  try {
    // stdio fd 4 uses 'ipc' to build process message channel (process.send/on('message')), no socket or port transport
    const child = spawn(cmd, args, { cwd: SERVER_DIR, env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    backendProc = child;
    child.on('error', (error) => {
      console.error('[electron] Server 启动失败:', error?.message || error);
      if (backendState === 'starting') backendReadyReject?.(error);
      rejectPending(error);
    });
    child.on('exit', (code, signal) => {
      if (backendProc !== child) {
        console.log(`[electron] 旧 Server 进程已退出 code=${code} signal=${signal}`);
        return;
      }
      const wasReady = backendState === 'ready';
      backendProc = null;
      clearTimeout(backendReadyTimer);
      backendReadyTimer = null;
      if (backendState === 'starting') {
        backendReadyReject?.(new Error(`本地 Server 提前退出(code=${code}, signal=${signal || 'none'})`));
      }
      backendReadyResolve = null;
      backendReadyReject = null;
      backendReadyPromise = null;
      backendState = isQuitting ? 'stopped' : 'failed';
      rejectPending(new Error('本地 Server 已退出'));
      backendShutdownResolve?.();
      backendShutdownResolve = null;
      notifyBackendState({ state: backendState, code, signal });
      console.log(`[electron] Server 退出 code=${code} signal=${signal}`);
      if (wasReady && !isQuitting) scheduleBackendRestart();
    });
    child.on('message', (message) => {
      if (message?.type === 'lifecycle') {
        if (message.event === 'ready') {
          clearTimeout(backendReadyTimer);
          backendReadyTimer = null;
          backendState = 'ready';
          backendReadyResolve?.();
          backendReadyResolve = null;
          backendReadyReject = null;
          clearTimeout(backendStableTimer);
          backendStableTimer = setTimeout(() => { backendRestartAttempts = 0; }, 60_000);
          backendStableTimer.unref?.();
          notifyBackendState({ state: 'ready', detail: message });
        } else if (message.event === 'startup-error') {
          backendReadyReject?.(new Error(message.error || '本地 Server 启动失败'));
        } else if (message.event === 'shutdown-complete') {
          // Resource cleanup is acknowledged before the child actually exits.
          // Keep waiting for the exit event so the app cannot tear down first.
          console.log('[electron] Server 资源关闭完成，等待进程退出');
        }
        return;
      }
      if (message && message.id != null) pending.get(message.id)?.handle(message);
    });
    console.log(`[electron] Server 进程已创建 (${cmd} ${args.join(' ')}, pid=${child.pid})`);
  } catch (e) {
    clearTimeout(backendReadyTimer);
    backendReadyTimer = null;
    backendState = 'failed';
    backendReadyReject?.(e);
    backendReadyResolve = null;
    backendReadyReject = null;
  }
  return backendReadyPromise;
}

function notifyBackendState(payload) {
  try {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('backend-state', payload);
  } catch {
    // Main window may still be closing.
  }
}

function rejectPending(error) {
  for (const [, entry] of pending) entry.fail(error);
  pending.clear();
}

function scheduleBackendRestart() {
  clearTimeout(backendStableTimer);
  backendStableTimer = null;
  if (backendRestartAttempts >= 3) {
    notifyBackendState({ state: 'failed', error: '本地服务连续恢复失败，请重启应用' });
    return;
  }
  const delay = 1_000 * (2 ** backendRestartAttempts);
  backendRestartAttempts += 1;
  notifyBackendState({ state: 'restarting' });
  setTimeout(() => {
    if (isQuitting || backendState === 'ready' || backendState === 'starting') return;
    startBackend().catch((error) => {
      console.error('[electron] Server 自动恢复失败:', error?.message || error);
      notifyBackendState({ state: 'failed', error: error?.message || String(error) });
    });
  }, delay).unref?.();
}

function stopBackendGracefully() {
  if (backendStopPromise) return backendStopPromise;
  const child = backendProc;
  if (!child) return Promise.resolve();
  backendState = 'stopping';
  rejectPending(new Error('应用正在退出'));
  backendStopPromise = new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      backendShutdownResolve = null;
      resolve();
    };
    backendShutdownResolve = finish;
    const timer = setTimeout(() => {
      console.warn(`[electron] Server 未在 ${BACKEND_STOP_TIMEOUT_MS}ms 内关闭，强制终止`);
      try { child.kill(); } catch { /* ignore */ }
      finish();
    }, BACKEND_STOP_TIMEOUT_MS);
    child.once('exit', finish);
    try {
      if (!child.connected) throw new Error('IPC 已断开');
      child.send({ type: 'lifecycle', event: 'shutdown' }, (error) => {
        if (!error) return;
        try { child.kill(); } catch { /* ignore */ }
      });
    } catch {
      try { child.kill(); } catch { /* ignore */ }
    }
  });
  return backendStopPromise.finally(() => { backendStopPromise = null; });
}

function sendAppUpdateState(state = appUpdateController?.getState()) {
  try {
    if (state && mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app-update-state', state);
  } catch {
    // Window may be loading or closing; renderer also reads the latest snapshot over IPC.
  }
}

function initializeAppUpdater() {
  if (appUpdateController) return appUpdateController;
  try {
    const { autoUpdater } = require('electron-updater');
    appUpdateController = new AppUpdateController({
      app,
      updater: autoUpdater,
      fetch: (url, options) => net.fetch(url, options),
      apiBaseUrl: UPDATE_API_BASE_URL,
      platform: process.platform,
      arch: process.arch,
      channel: String(process.env.DSH_UPDATE_CHANNEL || 'stable').trim() || 'stable',
      locale: app.getLocale() || 'zh-CN',
      userDataPath: app.getPath('userData'),
      dataRoot: DATA_ROOT,
      isPackaged: app.isPackaged,
      onStateChange: sendAppUpdateState,
      prepareToInstall: async () => {
        isQuitting = true;
        await stopBackendGracefully();
        allowFinalQuit = true;
      },
      recoverInstallFailure: async () => {
        allowFinalQuit = false;
        isQuitting = false;
        if (backendState !== 'ready' && backendState !== 'starting') await startBackend();
      },
      logger: console,
    });
    appUpdateController.start();
  } catch (error) {
    console.error('[updater] 初始化失败:', error?.message || error);
  }
  return appUpdateController;
}

function forceStopBackend() {
  clearTimeout(backendReadyTimer);
  clearTimeout(backendStableTimer);
  backendReadyTimer = null;
  backendStableTimer = null;
  try { backendProc?.kill(); } catch { /* ignore */ }
  backendProc = null;
  backendReadyPromise = null;
  backendReadyResolve = null;
  backendReadyReject = null;
  backendState = 'stopped';
  rejectPending(new Error('本地 Server 已停止'));
}

function backendSend(msg) {
  if (backendState !== 'ready' || !backendProc?.connected) return false;
  try {
    backendProc.send(msg);
    return true;
  } catch {
    return false;
  }
}

function minimizeMainWindow(win = mainWindow) {
  try {
    if (win && !win.isDestroyed() && !win.isMinimized()) win.minimize();
  } catch {
    /* ignore */
  }
}

function quitApplication() {
  isQuitting = true;
  app.quit();
}

async function handleMainWindowCloseRequest(win = mainWindow) {
  if (!win || win.isDestroyed() || closePromptOpen) return;
  const behavior = loadCloseBehavior();
  if (behavior === 'minimize') {
    minimizeMainWindow(win);
    return;
  }
  if (behavior === 'quit') {
    quitApplication();
    return;
  }

  closePromptOpen = true;
  try {
    const result = await dialog.showMessageBox(win, {
      type: 'question',
      title: `关闭${runtimeAppName}？`,
      message: '要关闭应用还是最小化到后台？',
      detail: '最小化会保留本地服务和当前会话；关闭应用会停止后台进程。',
      buttons: ['最小化', '关闭应用', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      checkboxLabel: '不再询问，记住我的选择',
      checkboxChecked: false,
    });
    if (result.response === 0) {
      if (result.checkboxChecked) {
        saveCloseBehavior('minimize');
        configureApplicationMenu();
      }
      minimizeMainWindow(win);
    } else if (result.response === 1) {
      if (result.checkboxChecked) {
        saveCloseBehavior('quit');
        configureApplicationMenu();
      }
      quitApplication();
    }
  } finally {
    closePromptOpen = false;
  }
}

// ── Main window (default 1200x800, bg #36313f, custom title bar with traffic lights kept)──
function createWindow(surfaceUrl = rendererSurfaceUrl) {
  if (!surfaceUrl) throw new Error('DSH Client 地址尚未就绪');
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(1400, Math.round(sw * 0.92));
  const height = Math.min(900, Math.round(sh * 0.92));
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#36313f',
    title: runtimeAppName,
    icon: APP_ICON, // Windows/Linux taskbar icon (on macOS icon is set by app.dock.setIcon below)
    // macOS: hide title bar while keeping traffic lights; align with front-end -webkit-app-region:drag.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 16, y: 18 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      navigateOnDragDrop: false,
    },
  });
  browserWorkspace?.destroy();
  browserWorkspace = new BrowserWorkspaceController({
    WebContentsView,
    browserSession: session.fromPartition('persist:browser-workspace'),
    getParentWindow: () => mainWindow,
    userDataPath: app.getPath('userData'),
    downloadDirectory: app.getPath('downloads'),
    isDev,
    sendEvent: (channel, payload) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      mainWindow.webContents.send(channel, payload);
      return true;
    },
  });
  const sendWindowFullScreenState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window-full-screen-changed', mainWindow.isFullScreen());
  };
  mainWindow.on('enter-full-screen', sendWindowFullScreenState);
  mainWindow.on('leave-full-screen', sendWindowFullScreenState);
  mainWindow.center();
  lockPageZoom(mainWindow);
  let surfaceLoadRetried = false;
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 || surfaceLoadRetried) return;
    surfaceLoadRetried = true;
    mainWindow?.loadURL(surfaceUrl);
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() || '';
    let sameSurface = false;
    try { sameSurface = new URL(url).origin === new URL(surfaceUrl).origin; } catch { /* invalid navigation */ }
    if (url === current || sameSurface) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
  });
  // Local Site previews use opaque-origin srcdoc frames. They may run their own
  // scripts, but cannot turn the trusted app window into a remote page.
  mainWindow.webContents.on('will-frame-navigate', (details) => {
    if (details.isMainFrame) return;
    const current = String(details.frame?.url || '');
    if (!/^about:srcdoc(?:$|[#?])/i.test(current)) return;
    if (/^about:(?:srcdoc|blank)(?:$|[#?])/i.test(String(details.url || ''))) return;
    details.preventDefault();
  });
  const rendererErrors = [];
  if (SMOKE_TEST) {
    mainWindow.webContents.on('console-message', (details) => {
      if (details?.level !== 'error') return;
      const location = details.location ? ` @${details.location.url || ''}:${details.location.line || 0}` : '';
      rendererErrors.push(String(details.message || '未知 Renderer 错误') + location);
    });
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const deadline = Date.now() + 30_000;
        let state = null;
        let nextClickIndex = 0;
        while (Date.now() < deadline) {
          state = await mainWindow.webContents.executeJavaScript(`({ title: document.title, appReady: document.documentElement.dataset.appReady === 'true', runtime: document.documentElement.dataset.dshWorkRuntime || null, bodyText: document.body?.innerText?.slice(0, 500) || '', expectedSurface: ${JSON.stringify(SMOKE_EXPECT_SELECTOR)} === '' || document.querySelector(${JSON.stringify(SMOKE_EXPECT_SELECTOR)}) !== null, rejectedSurfaceAbsent: ${JSON.stringify(SMOKE_REJECT_SELECTOR)} === '' || document.querySelector(${JSON.stringify(SMOKE_REJECT_SELECTOR)}) === null })`);
          if (state.appReady && nextClickIndex < SMOKE_CLICK_SELECTORS.length) {
            const selector = SMOKE_CLICK_SELECTORS[nextClickIndex];
            const clicked = await mainWindow.webContents.executeJavaScript(`(() => { const target = document.querySelector(${JSON.stringify(selector)}); if (!target) return false; target.click(); return true })()`);
            if (clicked) nextClickIndex += 1;
          }
          if (state.appReady && nextClickIndex === SMOKE_CLICK_SELECTORS.length && state.expectedSurface) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (SMOKE_REJECT_SELECTOR && state?.appReady) {
          await new Promise((resolve) => setTimeout(resolve, 2_500));
          state = await mainWindow.webContents.executeJavaScript(`({ title: document.title, appReady: document.documentElement.dataset.appReady === 'true', runtime: document.documentElement.dataset.dshWorkRuntime || null, expectedSurface: true, rejectedSurfaceAbsent: document.querySelector(${JSON.stringify(SMOKE_REJECT_SELECTOR)}) === null })`);
        }
        const clicksCompleted = nextClickIndex === SMOKE_CLICK_SELECTORS.length;
        console.log(`[smoke] Renderer 已加载 title=${state.title} appReady=${state.appReady} clicks=${nextClickIndex}/${SMOKE_CLICK_SELECTORS.length}`);
        if (!state.appReady) console.error(`[smoke] Renderer 页面摘要: ${String(state.bodyText || '').replace(/\s+/g, ' ').trim()}`);
        if (rendererErrors.length) console.error(`[smoke] Renderer 控制台错误: ${rendererErrors.join(' | ')}`);
        if (!state.appReady || state.runtime !== 'dsh-client' || !clicksCompleted || !state.expectedSurface || !state.rejectedSurfaceAbsent || rendererErrors.length) process.exitCode = 1;
      } catch (error) {
        console.error('[smoke] Renderer 验证失败:', error?.message || error);
        process.exitCode = 1;
      } finally {
        // Let startup IPC invoked by mounted React effects settle before the
        // smoke-only teardown makes their sender untrusted or stops Server.
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
        quitApplication();
      }
    });
  }
  mainWindow.loadURL(surfaceUrl);
  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    event.preventDefault();
    handleMainWindowCloseRequest(mainWindow);
  });
  mainWindow.on('closed', () => {
    browserWorkspace?.destroy();
    browserWorkspace = null;
    mainWindow = null;
  });
}

function lockPageZoom(win) {
  const resetZoom = () => {
    try { win.webContents.setZoomLevel(0); } catch { /* ignore */ }
    try { win.webContents.setZoomFactor(1); } catch { /* ignore */ }
  };
  resetZoom();
  win.webContents.on('did-finish-load', resetZoom);
  win.webContents.on('zoom-changed', (event) => {
    event.preventDefault();
    resetZoom();
  });
  try {
    win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  } catch {
    /* ignore */
  }
}

// ── ipc: native file/folder picker; returns {path,isDir} matching renderer contract ──
ipcMain.handle('pick-paths', async (event, defaultPath) => {
  requireTrustedRenderer(event);
  const res = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ['openFile', 'openDirectory', 'multiSelections'],
    defaultPath: defaultPath || undefined,
  });
  if (res.canceled) return [];
  return res.filePaths.map((p) => {
    let isDir = false;
    try { isDir = fs.statSync(p).isDirectory(); } catch { isDir = false; }
    registerLocalFileRoot(isDir ? p : path.dirname(p), { persist: true });
    const selectedPath = isDir ? realPathForExisting(p) : registerNativeAttachmentPath(p) || p;
    return { path: selectedPath, isDir };
  });
});

// Drag-and-drop authorization only accepts paths resolved from preload's native File objects via webUtils.
// Keep permission boundary consistent with OS file picker: file grants parent directory, folder grants itself.
ipcMain.handle('register-dropped-paths', async (event, droppedPaths) => {
  requireTrustedRenderer(event);
  const result = [];
  const seen = new Set();
  for (const rawPath of Array.isArray(droppedPaths) ? droppedPaths.slice(0, 200) : []) {
    if (typeof rawPath !== 'string' || !rawPath.trim()) continue;
    const filePath = realPathForExisting(rawPath);
    if (seen.has(filePath)) continue;
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() && !stat.isDirectory()) continue;
      const isDir = stat.isDirectory();
      registerLocalFileRoot(isDir ? filePath : path.dirname(filePath), { persist: true });
      result.push({ path: isDir ? filePath : registerNativeAttachmentPath(filePath) || filePath, isDir });
      seen.add(filePath);
    } catch {
      // Ignore entries that are moved or deleted after being dragged in.
    }
  }
  return result;
});

ipcMain.handle('pick-folder', async (_e, defaultPath) => {
  const res = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ['openDirectory'],
    defaultPath: defaultPath || undefined,
  });
  if (res.canceled || !res.filePaths.length) return null;
  registerLocalFileRoot(res.filePaths[0], { persist: true });
  return res.filePaths[0];
});

ipcMain.handle('reveal-in-finder', async (_e, p) => {
  const target = String(p || '');
  if (!target || !isAllowedLocalPath(target)) return false;
  try { shell.showItemInFolder(target); return true; } catch { return false; }
});

ipcMain.handle('open-local-file', async (_e, p) => {
  const target = String(p || '');
  if (!target || !isAllowedLocalPath(target)) return false;
  try { return (await shell.openPath(target)) === ''; } catch { return false; }
});

// Open an authorized workspace file with the operating system's configured
// editor. Renderer payloads must never choose an executable or command line:
// a compromised view could otherwise turn this file action into code execution.
ipcMain.handle('open-in-editor', async (event, payload = {}) => {
  requireTrustedRenderer(event);
  const filePath = String(payload.path || '');
  if (!filePath) return false;
  const resolved = resolveArtifactActionPath(filePath);
  if (!resolved) return false;
  try { return (await shell.openPath(resolved)) === ''; } catch { return false; }
});

ipcMain.handle('open-external-url', async (event, rawUrl) => {
  requireTrustedRenderer(event);
  try {
    const url = new URL(String(rawUrl || ''));
    const localHost = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) return false;
    await shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
});

// Source folders are authorized by the native picker. Generated project files
// live under the app-owned projects directory, so the renderer may authorize
// only the exact preview root returned by the local backend.
ipcMain.handle('authorize-preview-root', async (_e, p) => {
  const root = normalizeLocalFileRoot(p);
  if (!root || !isExistingDirectory(root)) return false;
  if ([...localFileRoots].some((allowed) => isInsideRoot(root, allowed))) return true;
  const projectsRoot = normalizeLocalFileRoot(path.join(DATA_ROOT, 'projects'));
  if (!projectsRoot || !isInsideRoot(root, projectsRoot)) return false;
  registerLocalFileRoot(root);
  return true;
});

ipcMain.handle('save-pasted-text-attachment', async (_e, payload) => savePastedTextAttachment(payload));
ipcMain.handle('save-pasted-image-attachment', async (_e, payload) => savePastedImageAttachment(payload));

ipcMain.handle('default-data-root', async () => DATA_ROOT);
ipcMain.handle('network-settings-load', async () => loadNetworkSettings());
ipcMain.handle('network-settings-save', async (_e, settings) => {
  const saved = saveNetworkSettings(settings);
  await applyRendererNetworkProxy(saved);
  return saved;
});
// 皮肤定义：渲染层读取恢复自定义皮肤 / 写入长久保存（userData）。
ipcMain.handle('skins-load', async (event) => {
  requireTrustedRenderer(event);
  return loadSkinsSettings();
});
ipcMain.handle('skins-save', async (event, settings) => {
  requireTrustedRenderer(event);
  return saveSkinsSettings(settings);
});

// 品牌名：渲染层读取/写入长久保存 + 运行时更新窗口标题/About/菜单。
ipcMain.handle('brand-load', async (event) => {
  requireTrustedRenderer(event);
  return loadBrandSettings();
});
ipcMain.handle('brand-save', async (event, settings) => {
  requireTrustedRenderer(event);
  // 在写盘前先验证有效运行时名称；写盘成功后在同一个 IPC 中更新窗口，避免半成功。
  let effectiveName;
  try {
    effectiveName = normalizeRuntimeAppName(settings?.effectiveName ?? settings?.name);
  } catch (error) {
    return { ok: false, error: { code: error.code || 'BRAND_NAME_INVALID', message: error.message } };
  }
  const result = saveBrandSettings(settings);
  if (result.ok) applyRuntimeAppName(effectiveName);
  return result;
});
ipcMain.handle('brand-set-name', async (event, name) => {
  requireTrustedRenderer(event);
  return applyRuntimeAppName(name);
});

// 品牌外观（底图/底色/透明度）长久保存。
ipcMain.handle('brand-appearance-load', async (event) => {
  requireTrustedRenderer(event);
  return loadBrandAppearanceSettings();
});
ipcMain.handle('brand-appearance-save', async (event, settings) => {
  requireTrustedRenderer(event);
  return saveBrandAppearanceSettings(settings);
});

// 复制用户本地底图到 userData/bg-images，返回 dsh-skin-asset:// URL。
ipcMain.handle('brand-copy-bg-image', async (event, file) => {
  requireTrustedRenderer(event);
  return copyBgImageToUserData(file);
});

function requireTrustedRenderer(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    const error = new Error('请求来源不受信任');
    error.code = 'UNTRUSTED_RENDERER_SOURCE';
    throw error;
  }
}

ipcMain.handle('app-update-get-state', async (event) => {
  requireTrustedRenderer(event);
  return initializeAppUpdater()?.getState() || {
    enabled: false,
    status: 'disabled',
    currentVersion: app.getVersion(),
    latest: null,
    progress: null,
    error: null,
  };
});
ipcMain.handle('app-update-check', async (event) => {
  requireTrustedRenderer(event);
  return initializeAppUpdater()?.check() || null;
});
ipcMain.handle('app-update-download-install', async (event) => {
  requireTrustedRenderer(event);
  return initializeAppUpdater()?.downloadAndInstall() || null;
});
ipcMain.handle('window-full-screen-state', async (event) => {
  requireTrustedRenderer(event);
  return Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFullScreen());
});

ipcMain.handle('clipboard-write-text', async (event, text) => {
  requireTrustedRenderer(event);
  clipboard.writeText(String(text ?? ''));
  return true;
});

ipcMain.handle('artifact-context-menu', async (event, payload = {}) => {
  requireTrustedRenderer(event);
  const target = resolveArtifactActionPath(payload.path);
  if (!target) return false;
  try {
    const menu = await createArtifactContextMenu({
      app,
      Menu,
      shell,
      clipboard,
      nativeImage,
      filePath: target,
      kind: payload.kind,
    });
    const popupOptions = { window: mainWindow };
    const x = Number(payload.x);
    const y = Number(payload.y);
    if (Number.isFinite(x) && Number.isFinite(y)) {
      popupOptions.x = Math.max(0, Math.round(x));
      popupOptions.y = Math.max(0, Math.round(y));
    }
    menu.popup(popupOptions);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('artifact-native-action', async (event, payload = {}) => {
  requireTrustedRenderer(event);
  const action = String(payload.action || '').trim().toLowerCase();
  if (!['open', 'reveal', 'copy'].includes(action)) return false;
  const target = resolveArtifactActionPath(payload.path);

  if (action === 'open') {
    if (!target) return false;
    try { return (await shell.openPath(target)) === ''; } catch { return false; }
  }
  if (action === 'reveal') {
    if (!target) return false;
    try { shell.showItemInFolder(target); return true; } catch { return false; }
  }
  if (action === 'copy') {
    let image = null;
    if (target && IMAGE_EXTS.has(path.extname(target).toLowerCase())) image = nativeImage.createFromPath(target);
    if ((!image || image.isEmpty()) && typeof payload.dataUrl === 'string') {
      const match = payload.dataUrl.match(/^data:image\/(?:png|jpe?g|webp|gif);base64,([a-z0-9+/=]+)$/i);
      if (match) {
        const bytes = Buffer.from(match[1], 'base64');
        if (bytes.length > 0 && bytes.length <= MAX_PASTED_IMAGE_BYTES) image = nativeImage.createFromBuffer(bytes);
      }
    }
    if (!image || image.isEmpty()) return false;
    clipboard.writeImage(image);
    return true;
  }
  return false;
});

ipcMain.handle('export-local-site', async (event, payload = {}) => {
  requireTrustedRenderer(event);
  const content = typeof payload.content === 'string' ? payload.content.replace(/\r\n?/g, '\n') : null;
  if (content == null) throw new Error('Site 内容必须是文本');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > 8 * 1024 * 1024) throw new Error('Site 内容不能超过 8 MB');
  const safeTitle = String(payload.title || '本地-Site')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .trim()
    .slice(0, 100) || '本地-Site';
  const fileName = safeTitle.toLowerCase().endsWith('.html') ? safeTitle : `${safeTitle}.html`;
  let filePath = null;
  if (process.env.DSH_EVAL_MODE === 'isolated' && process.env.DSH_EVAL_SITE_EXPORT_PATH) {
    filePath = path.resolve(process.env.DSH_EVAL_SITE_EXPORT_PATH);
  } else {
    const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
      title: '导出本地 Site',
      defaultPath: path.join(app.getPath('downloads'), fileName),
      filters: [{ name: 'HTML 页面', extensions: ['html'] }],
    });
    if (result.canceled || !result.filePath) return null;
    filePath = result.filePath.toLowerCase().endsWith('.html') ? result.filePath : `${result.filePath}.html`;
  }
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600, flag: 'w' });
  return { path: filePath, name: path.basename(filePath), size: bytes };
});

function requireBrowserWorkspace(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('浏览器控制请求来源无效');
  }
  if (!browserWorkspace) throw new Error('本地浏览器尚未就绪');
  return browserWorkspace;
}

ipcMain.handle('browser-workspace-get-state', (event) => requireBrowserWorkspace(event).getState());
ipcMain.handle('browser-workspace-create-tab', (event, target) => requireBrowserWorkspace(event).createTab(target));
ipcMain.handle('browser-workspace-activate-tab', (event, tabId) => requireBrowserWorkspace(event).activateTab(String(tabId || '')));
ipcMain.handle('browser-workspace-close-tab', (event, tabId) => requireBrowserWorkspace(event).closeTab(String(tabId || '')));
ipcMain.handle('browser-workspace-navigate', (event, payload = {}) => (
  requireBrowserWorkspace(event).navigate(String(payload.tabId || ''), payload.target)
));
ipcMain.handle('browser-workspace-go-back', (event, tabId) => requireBrowserWorkspace(event).goBack(String(tabId || '')));
ipcMain.handle('browser-workspace-go-forward', (event, tabId) => requireBrowserWorkspace(event).goForward(String(tabId || '')));
ipcMain.handle('browser-workspace-reload', (event, tabId) => requireBrowserWorkspace(event).reload(String(tabId || '')));
ipcMain.handle('browser-workspace-stop', (event, tabId) => requireBrowserWorkspace(event).stop(String(tabId || '')));
ipcMain.handle('browser-workspace-find', (event, payload = {}) => (
  requireBrowserWorkspace(event).findInPage(String(payload.tabId || ''), payload.text, payload.forward !== false)
));
ipcMain.handle('browser-workspace-stop-find', (event, tabId) => requireBrowserWorkspace(event).stopFindInPage(String(tabId || '')));
ipcMain.handle('browser-workspace-set-zoom', (event, payload = {}) => (
  requireBrowserWorkspace(event).setZoomFactor(String(payload.tabId || ''), payload.factor)
));
ipcMain.handle('browser-workspace-print', (event, tabId) => requireBrowserWorkspace(event).printPage(String(tabId || '')));
ipcMain.handle('browser-workspace-open-devtools', (event, tabId) => requireBrowserWorkspace(event).openDevTools(String(tabId || '')));
ipcMain.handle('browser-workspace-set-bounds', (event, bounds) => requireBrowserWorkspace(event).setBounds(bounds));
ipcMain.handle('browser-workspace-set-visible', (event, visible) => requireBrowserWorkspace(event).setVisible(Boolean(visible)));
ipcMain.handle('browser-workspace-capture-page', (event, tabId) => requireBrowserWorkspace(event).capturePage(String(tabId || '')));
ipcMain.handle('browser-workspace-save-screenshot', async (event, tabId) => {
  const controller = requireBrowserWorkspace(event);
  const screenshot = await controller.captureScreenshot(String(tabId || ''));
  const safeTitle = String(screenshot.title || '网页截图').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 80) || '网页截图';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = await dialog.showSaveDialog(mainWindow ?? undefined, {
    title: '保存网页截图',
    defaultPath: path.join(app.getPath('downloads'), `${safeTitle}-${stamp}.png`),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, screenshot.png, { mode: 0o600 });
  return { path: result.filePath, name: path.basename(result.filePath), size: screenshot.png.length };
});
ipcMain.handle('browser-workspace-clear-data', (event) => requireBrowserWorkspace(event).clearBrowsingData());
ipcMain.handle('browser-workspace-remove-history', (event, historyId) => (
  requireBrowserWorkspace(event).removeHistory(String(historyId || ''))
));
ipcMain.handle('browser-workspace-clear-history', (event) => requireBrowserWorkspace(event).clearHistory());
ipcMain.handle('browser-workspace-clear-permissions', (event) => requireBrowserWorkspace(event).clearPermissionRules());
ipcMain.handle('browser-workspace-clear-downloads', (event) => requireBrowserWorkspace(event).clearDownloadRecords());
ipcMain.handle('browser-workspace-show-download', (event, downloadId) => {
  const target = requireBrowserWorkspace(event).downloadPath(downloadId);
  if (!target || !fs.existsSync(target)) return false;
  shell.showItemInFolder(target);
  return true;
});
ipcMain.handle('browser-workspace-resolve-permission', (event, payload = {}) => (
  requireBrowserWorkspace(event).resolvePermissionRequest(payload.requestId, payload.decision)
));
ipcMain.handle('browser-workspace-remove-permission', (event, payload = {}) => (
  requireBrowserWorkspace(event).removePermission(payload.origin, payload.permission)
));

// ── ipc: REST request → process message channel forwards to backend registry, returns single response ──
// req = { method, url(/api/...?query), headers, body(string|null) }; returns { status, statusText, headers, json|body }.
function requestBackend(req = {}, { timeoutMs = API_REQUEST_TIMEOUT_MS } = {}) {
  if (backendState !== 'ready') throw new Error('本地 Server 尚未就绪');
  const requestedTimeoutMs = Number(timeoutMs);
  const requestTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.max(1000, Math.min(requestedTimeoutMs, API_REQUEST_TIMEOUT_MS))
    : API_REQUEST_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const id = `q${++reqSeq}`;
    let status = 0;
    let statusText = '';
    let headers = {};
    let binary = false;
    const chunks = [];
    let settled = false;
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() => reject(new Error(`本地请求超时(${requestTimeoutMs}ms)`)));
      backendSend({ id, type: 'abort' });
    }, requestTimeoutMs);
    const entry = {
      timer,
      fail: (error) => finish(() => reject(error)),
      handle: (m) => {
        if (m.type === 'head') { status = m.status; statusText = m.statusText; headers = m.headers || {}; }
        else if (m.type === 'data') { if (m.b64) binary = true; chunks.push(m.chunk); }
        else if (m.type === 'error') { finish(() => reject(new Error(m.error || '本地请求失败'))); }
        else if (m.type === 'end') {
          if (binary) {
            // Binary blob download: decode each chunk and concatenate; encode once as base64 for renderer to rebuild Blob.
            const buf = Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
            finish(() => resolve({ status, statusText, headers, bodyB64: buf.toString('base64') }));
            return;
          }
          const text = chunks.join('');
          const ct = String(headers['content-type'] || '');
          let json;
          let body;
          if (/application\/json/i.test(ct)) { try { json = JSON.parse(text); } catch { body = text; } }
          else body = text;
          finish(() => resolve({ status, statusText, headers, json, body }));
        }
      },
    };
    pending.set(id, entry);
    if (!backendSend({ id, method: (req.method || 'GET').toUpperCase(), url: req.url || '/', headers: req.headers || {}, body: req.body ?? null, bodyEncoding: req.bodyEncoding })) {
      entry.fail(new Error('本地 Server 不可用'));
    }
  });
}

function normalizeRendererSurface(value) {
  const url = new URL(String(value || ''));
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('DSH Client 必须使用受信任的 loopback HTTP origin');
  }
  return `${url.origin}/`;
}

async function resolveRendererSurface() {
  const response = await requestBackend({
    method: 'GET',
    url: '/api/agents/runtime/client-surface',
  }, { timeoutMs: 90_000 });
  if (response.status !== 200 || response.json?.success !== true) {
    throw new Error(response.json?.message || `DSH Client 启动失败（HTTP ${response.status}）`);
  }
  return normalizeRendererSurface(response.json?.data?.url);
}

ipcMain.handle('api-request', async (event, req) => {
  requireTrustedRenderer(event);
  const authorized = authorizeAgentAttachmentRequest(req);
  return requestBackend(authorized, { timeoutMs: authorized?.timeoutMs });
});

// Eval-only fault injection: terminate the real child Server and let the normal
// Electron restart path bring it back. Production renderers cannot enable it.
ipcMain.handle('eval-restart-backend', async () => {
  if (!process.env.DSH_EVAL_MODE) throw new Error('后端重启诊断只在 Eval 环境可用');
  if (backendState !== 'ready' || !backendProc) throw new Error('本地 Server 尚未就绪');
  const pid = backendProc.pid;
  const killed = backendProc.kill('SIGKILL');
  if (!killed) throw new Error('无法终止本地 Server');
  return { pid, signal: 'SIGKILL' };
});

ipcMain.handle('eval-process-snapshot', async () => {
  if (!process.env.DSH_EVAL_MODE) throw new Error('进程诊断只在 Eval 环境可用');
  return {
    electron_pid: process.pid,
    backend_pid: backendProc?.pid || null,
    backend_state: backendState,
  };
});

ipcMain.handle('eval-read-clipboard-text', async () => {
  if (!process.env.DSH_EVAL_MODE) throw new Error('剪贴板诊断只在 Eval 环境可用');
  return clipboard.readText();
});

ipcMain.handle('eval-quit-application', async () => {
  if (!process.env.DSH_EVAL_MODE) throw new Error('应用退出诊断只在 Eval 环境可用');
  setImmediate(() => quitApplication());
  return { quitting: true };
});

// ── ipc: SSE stream → process message channel; backend res.write chunks are forwarded as message events to renderer ──
// payload = { id, url, method, headers, body }; pushed to `dsh-stream:<id>` as {type:'head'|'data'|'end'|'error'}.
ipcMain.handle('stream-start', async (e, payload) => {
  requireTrustedRenderer(e);
  const authorizedPayload = authorizeAgentAttachmentRequest(payload);
  const { id, url, method, headers, body } = authorizedPayload || {};
  const send = (msg) => { try { if (!e.sender.isDestroyed()) e.sender.send(`dsh-stream:${id}`, msg); } catch { /* renderer gone */ } };
  if (backendState !== 'ready') {
    send({ type: 'error', error: '本地 Server 尚未就绪' });
    return false;
  }
  const finish = () => {
    const entry = pending.get(id);
    if (entry) clearTimeout(entry.timer);
    pending.delete(id);
  };
  const timer = setTimeout(() => {
    send({ type: 'error', error: `流式请求超时(${STREAM_REQUEST_TIMEOUT_MS}ms)` });
    finish();
    backendSend({ id, type: 'abort' });
  }, STREAM_REQUEST_TIMEOUT_MS);
  const entry = {
    timer,
    fail: (error) => { send({ type: 'error', error: error?.message || String(error) }); finish(); },
    handle: (message) => {
      send(message);
      if (message.type === 'end' || message.type === 'error') finish();
    },
  };
  pending.set(id, entry);
  if (!backendSend({ id, method: (method || 'GET').toUpperCase(), url: url || '/', headers: headers || {}, body: body ?? null })) {
    entry.fail(new Error('本地 Server 不可用'));
    return false;
  }
  return true;
});
ipcMain.on('stream-abort', (_e, id) => {
  clearTimeout(pending.get(id)?.timer);
  pending.delete(id);
  backendSend({ id, type: 'abort' });
});

// ── App lifecycle ──
async function startApplicationWindow() {
  for (;;) {
    try {
      await startBackend();
      rendererSurfaceUrl = await resolveRendererSurface();
      createWindow(rendererSurfaceUrl);
      return;
    } catch (error) {
      console.error('[electron] 应用启动失败:', error?.message || error);
      forceStopBackend();
      backendState = 'stopped';
      const result = await dialog.showMessageBox({
        type: 'error',
        title: `${runtimeAppName}启动失败`,
        message: '本地服务没有正常启动',
        detail: error?.message || String(error),
        buttons: ['重试', '退出'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) continue;
      isQuitting = true;
      allowFinalQuit = true;
      app.quit();
      return;
    }
  }
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    try {
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
    } catch {
      // Main window may still be starting.
    }
  });

  app.whenReady().then(async () => {
    // 启动时只在 brand.json 有效时恢复用户应用名；缺失/损坏都保留安全默认值，
    // Renderer 稍后会从 localStorage 备份恢复并通过 brand-set-name 同步临时有效名。
    const loadedBrand = loadBrandSettings();
    runtimeAppName = normalizeRuntimeAppName(loadedBrand.status === 'valid' ? loadedBrand.value.name : APP_DISPLAY_NAME);
    configureApplicationIdentity();
    configureApplicationMenu();
    registerLocalFileRoot(ATTACHMENTS_ROOT);
    loadAuthorizedLocalRoots();
    registerLocalFileProtocol();
    registerBgAssetProtocol();
    configureProductionSecurityHeaders();
    // macOS dock icon; without setting in dev mode, default Electron icon is shown.
    if (process.platform === 'darwin' && app.dock) {
      try { app.dock.setIcon(nativeImage.createFromPath(APP_ICON)); } catch { /* ignore */ }
    }
    await applyRendererNetworkProxy();
    await startApplicationWindow();
    initializeAppUpdater();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        if (backendState === 'ready' && rendererSurfaceUrl) createWindow(rendererSurfaceUrl);
        else void startApplicationWindow();
        return;
      }
      try {
        if (mainWindow?.isMinimized()) mainWindow.restore();
        mainWindow?.show();
        mainWindow?.focus();
      } catch {
        /* ignore */
      }
    });
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', (event) => {
  isQuitting = true;
  if (allowFinalQuit) return;
  event.preventDefault();
  void stopBackendGracefully().finally(() => {
    allowFinalQuit = true;
    if (SMOKE_TEST) app.exit(process.exitCode || 0);
    else app.quit();
  });
});
process.on('exit', () => {
  appUpdateController?.destroy();
  forceStopBackend();
});
