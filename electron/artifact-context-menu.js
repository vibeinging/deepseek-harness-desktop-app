const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');

const execFileAsync = promisify(execFile);
const MAX_COPY_TEXT_BYTES = 2 * 1024 * 1024;
const APPLICATION_CACHE_TTL_MS = 5 * 60_000;
const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.conf', '.cpp', '.css', '.csv', '.fish', '.go', '.h', '.hpp', '.htm', '.html',
  '.ini', '.java', '.js', '.json', '.jsonl', '.jsx', '.kt', '.log', '.md', '.markdown', '.mjs',
  '.py', '.rb', '.rs', '.sh', '.sql', '.swift', '.toml', '.ts', '.tsx', '.tsv', '.txt', '.xml',
  '.yaml', '.yml', '.zsh',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);
const applicationCache = new Map();

const MAC_APPLICATIONS_SCRIPT = String.raw`
ObjC.import('AppKit')

function run(argv) {
  const filePath = String(argv[0] || '')
  if (!filePath) return '[]'
  const workspace = $.NSWorkspace.sharedWorkspace
  const fileUrl = $.NSURL.fileURLWithPath(filePath)
  const urls = workspace.URLsForApplicationsToOpenURL(fileUrl)
  const result = []
  for (let index = 0; index < Number(urls.count); index += 1) {
    const appUrl = urls.objectAtIndex(index)
    const appPath = ObjC.unwrap(appUrl.path)
    const bundle = $.NSBundle.bundleWithURL(appUrl)
    const displayName = bundle ? ObjC.unwrap(bundle.objectForInfoDictionaryKey('CFBundleDisplayName')) : ''
    const bundleName = bundle ? ObjC.unwrap(bundle.objectForInfoDictionaryKey('CFBundleName')) : ''
    const fallbackName = String(appPath || '').split('/').pop().replace(/\.app$/i, '')
    if (appPath) result.push({ path: appPath, name: displayName || bundleName || fallbackName })
  }
  return JSON.stringify(result)
}
`;

function appName(value) {
  return String(value || '').trim().replace(/\.app$/i, '');
}

function validApplication(item) {
  const appPath = String(item?.path || '').trim();
  if (!appPath.toLowerCase().endsWith('.app')) return null;
  try {
    if (!fs.statSync(appPath).isDirectory()) return null;
  } catch {
    return null;
  }
  return { path: appPath, name: appName(item?.name || path.basename(appPath)) };
}

function uniqueApplications(items) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const application = validApplication(item);
    if (!application || seen.has(application.path)) continue;
    seen.add(application.path);
    result.push(application);
  }
  return result;
}

async function listMacApplicationsForFile(filePath, { platform = process.platform, execute = execFileAsync } = {}) {
  if (platform !== 'darwin') return [];
  const key = path.extname(filePath).toLowerCase() || path.basename(filePath).toLowerCase();
  const cached = applicationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.applications;
  try {
    const { stdout } = await execute('/usr/bin/osascript', [
      '-l', 'JavaScript', '-e', MAC_APPLICATIONS_SCRIPT, '--', filePath,
    ], { timeout: 4_000, maxBuffer: 256 * 1024 });
    const applications = uniqueApplications(JSON.parse(String(stdout || '[]'))).slice(0, 16);
    applicationCache.set(key, { applications, expiresAt: Date.now() + APPLICATION_CACHE_TTL_MS });
    return applications;
  } catch {
    return [];
  }
}

function openWithApplication(filePath, applicationPath, { launch = spawn } = {}) {
  const application = validApplication({ path: applicationPath });
  if (!application) return false;
  try {
    const child = launch('/usr/bin/open', ['-a', application.path, filePath], {
      detached: true,
      stdio: 'ignore',
    });
    child.once?.('error', () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

function canCopyTextContent(filePath) {
  if (!TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return false;
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size <= MAX_COPY_TEXT_BYTES;
  } catch {
    return false;
  }
}

function copyTextContent(filePath, clipboard) {
  if (!canCopyTextContent(filePath)) return false;
  try {
    const content = fs.readFileSync(filePath);
    if (content.includes(0)) return false;
    clipboard.writeText(content.toString('utf8'));
    return true;
  } catch {
    return false;
  }
}

async function iconForApplication(app, applicationPath) {
  try {
    return await app.getFileIcon(applicationPath, { size: 'small' });
  } catch {
    return undefined;
  }
}

async function defaultApplicationForFile(app, filePath) {
  try {
    const info = await app.getApplicationInfoForProtocol(pathToFileURL(filePath).href);
    return validApplication(info) ? { ...validApplication(info), icon: info.icon } : null;
  } catch {
    return null;
  }
}

async function createArtifactContextMenu({
  app,
  Menu,
  shell,
  clipboard,
  nativeImage,
  filePath,
  kind = 'file',
  platform = process.platform,
  listApplications = listMacApplicationsForFile,
}) {
  const normalizedKind = String(kind || 'file').trim().toLowerCase();
  const extension = path.extname(filePath).toLowerCase();
  const isImage = normalizedKind === 'image' || IMAGE_EXTENSIONS.has(extension);

  if (isImage) {
    return Menu.buildFromTemplate([
      {
        label: platform === 'darwin' ? '在 Finder 中显示' : '在文件管理器中显示',
        click: () => { try { shell.showItemInFolder(filePath); } catch {} },
      },
      {
        label: '复制图片',
        click: () => {
          try {
            const image = nativeImage.createFromPath(filePath);
            if (!image.isEmpty()) clipboard.writeImage(image);
          } catch {}
        },
      },
    ]);
  }

  const [defaultApplication, discoveredApplications] = await Promise.all([
    defaultApplicationForFile(app, filePath),
    listApplications(filePath, { platform }),
  ]);
  const applications = uniqueApplications([
    ...(defaultApplication ? [defaultApplication] : []),
    ...discoveredApplications,
  ]);
  const applicationsWithIcons = await Promise.all(applications.map(async (application) => ({
    ...application,
    icon: defaultApplication?.path === application.path
      ? defaultApplication.icon
      : await iconForApplication(app, application.path),
  })));
  const copyableText = canCopyTextContent(filePath);
  const template = [
    {
      label: '打开文件',
      click: () => { void shell.openPath(filePath); },
    },
    ...(defaultApplication ? [{
      label: `在 ${defaultApplication.name} 中打开`,
      icon: defaultApplication.icon,
      click: () => { openWithApplication(filePath, defaultApplication.path); },
    }] : []),
    ...(applicationsWithIcons.length ? [{
      label: '打开方式',
      submenu: applicationsWithIcons.map((application) => ({
        label: application.name,
        icon: application.icon,
        click: () => { openWithApplication(filePath, application.path); },
      })),
    }] : []),
    { type: 'separator' },
    {
      label: '复制路径',
      click: () => { clipboard.writeText(filePath); },
    },
    {
      label: '复制文件内容',
      enabled: copyableText,
      click: () => { copyTextContent(filePath, clipboard); },
    },
    {
      label: platform === 'darwin' ? '在 Finder 中显示' : '在文件管理器中显示',
      click: () => { try { shell.showItemInFolder(filePath); } catch {} },
    },
  ];
  return Menu.buildFromTemplate(template);
}

module.exports = {
  MAX_COPY_TEXT_BYTES,
  canCopyTextContent,
  copyTextContent,
  createArtifactContextMenu,
  listMacApplicationsForFile,
  openWithApplication,
  uniqueApplications,
};
