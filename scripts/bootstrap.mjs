import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MARKER_PATH = join(APP_DIR, '.desktop-deps.json');
const FORCE = process.argv.includes('--force');
const CHECK_ONLY = process.argv.includes('--check');
const PACKAGES = [
  { name: 'Renderer', dir: 'renderer', probe: 'node_modules/vite/package.json' },
  { name: 'Server', dir: 'server', probe: 'node_modules/better-sqlite3/package.json' },
  { name: 'Electron', dir: 'electron', probe: 'node_modules/electron/package.json' },
];

function supportedNode(version = process.versions.node) {
  const [major = 0] = String(version).split('.').map(Number);
  return major >= 24;
}

function fail(message) {
  console.error(`\n[setup] ${message}\n`);
  process.exitCode = 1;
}

if (!supportedNode()) {
  fail(`Node ${process.version} 太旧。请安装 Node 24，再重新执行 npm install。`);
  process.exit();
}

async function lockFingerprint() {
  const hash = createHash('sha256');
  for (const item of PACKAGES) {
    const lockPath = join(APP_DIR, item.dir, 'package-lock.json');
    hash.update(item.dir);
    hash.update(await readFile(lockPath));
  }
  return hash.digest('hex');
}

async function expectedMarker() {
  return {
    fingerprint: await lockFingerprint(),
    platform: process.platform,
    arch: process.arch,
    nodeMajor: Number(process.versions.node.split('.')[0]),
    nodeModulesAbi: process.versions.modules,
  };
}

async function markerMatches(expected) {
  if (!PACKAGES.every((item) => existsSync(join(APP_DIR, item.dir, item.probe)))) return false;
  try {
    const actual = JSON.parse(await readFile(MARKER_PATH, 'utf8'));
    return Object.entries(expected).every(([key, value]) => actual[key] === value);
  } catch {
    return false;
  }
}

function electronExecutablePath() {
  const packageDir = join(APP_DIR, 'electron', 'node_modules', 'electron');
  const relative = process.platform === 'darwin'
    ? join('Electron.app', 'Contents', 'MacOS', 'Electron')
    : process.platform === 'win32'
      ? 'electron.exe'
      : 'electron';
  return join(packageDir, 'dist', relative);
}

function electronBinaryReady() {
  return existsSync(electronExecutablePath());
}

function nativeBinaryArchitectures(filePath) {
  if (!existsSync(filePath)) return [];
  if (process.platform === 'darwin') {
    try {
      return execFileSync('lipo', ['-archs', filePath], { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }
  return [process.arch];
}

function nativeBinariesMatchRuntime() {
  if (!electronBinaryReady()) return false;
  if (process.platform !== 'darwin') return true;
  const expected = process.arch === 'x64' ? 'x86_64' : process.arch;
  const sqliteNative = join(APP_DIR, 'server', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  return nativeBinaryArchitectures(electronExecutablePath()).includes(expected)
    && nativeBinaryArchitectures(sqliteNative).includes(expected);
}

function ensureElectronBinary() {
  if (electronBinaryReady()) return Promise.resolve();
  const packageDir = join(APP_DIR, 'electron', 'node_modules', 'electron');
  const installScript = join(packageDir, 'install.js');
  if (!existsSync(installScript)) throw new Error('Electron 安装脚本不存在，请重新执行 npm run setup');
  console.log('[setup] 下载 Electron 开发运行时...');
  return new Promise((resolveInstall, reject) => {
    const child = spawn(process.execPath, [installScript], {
      cwd: packageDir,
      env: {
        ...process.env,
        PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH || ''}`,
      },
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 && electronBinaryReady()) resolveInstall();
      else reject(new Error(`Electron 运行时安装失败(code=${code}, signal=${signal || 'none'})`));
    });
  });
}

const expected = await expectedMarker();
const ready = await markerMatches(expected) && nativeBinariesMatchRuntime();

if (CHECK_ONLY) {
  if (!ready) {
    fail('依赖未安装，或 Node/CPU 架构已经变化。请先执行 npm install；切换架构后执行 npm run setup。');
  } else {
    console.log(`[setup] 依赖就绪: ${process.platform}/${process.arch}, Node ${process.versions.node}`);
  }
  process.exit();
}

if (ready && !FORCE) {
  await ensureElectronBinary();
  console.log(`[setup] 依赖没有变化，跳过重复安装 (${process.platform}/${process.arch})`);
  process.exit();
}

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  fail('找不到 npm。请通过 npm install 或 npm run setup 执行安装。');
  process.exit();
}

function install(item) {
  return new Promise((resolveInstall, reject) => {
    console.log(`[setup] 安装 ${item.name} 依赖...`);
    const nodeDir = dirname(process.execPath);
    const child = spawn(process.execPath, [npmCli, 'ci', '--no-audit', '--no-fund'], {
      cwd: join(APP_DIR, item.dir),
      env: {
        ...process.env,
        PATH: `${nodeDir}${delimiter}${process.env.PATH || ''}`,
        npm_node_execpath: process.execPath,
        npm_config_arch: process.arch,
      },
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolveInstall();
      else reject(new Error(`${item.name} 安装失败(code=${code}, signal=${signal || 'none'})`));
    });
  });
}

for (const item of PACKAGES) await install(item);
await ensureElectronBinary();
if (!nativeBinariesMatchRuntime()) {
  throw new Error(`依赖安装完成后原生模块仍与 ${process.platform}/${process.arch} 不一致`);
}
await writeFile(MARKER_PATH, `${JSON.stringify({ ...expected, installedAt: new Date().toISOString() }, null, 2)}\n`);
console.log('\n[setup] 安装完成。建议先运行 npm run doctor，再运行 npm run dev。');
