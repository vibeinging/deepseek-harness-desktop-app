// CDP harness: connect to an existing Electron renderer (or start one), then run JS in a real window.
// No external dependencies besides Node v18+ fetch / v22+ WebSocket.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { resolvePackagedLayout } from '../../electron/scripts/packaged-layout.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_DIR = path.resolve(__dirname, '..', '..', 'electron'); // eval/lib → electron
const RENDERER_DIR = path.resolve(__dirname, '..', '..', 'renderer');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP_PAGE_RE = /(?:localhost|127\.0\.0\.1):\d+|index\.html|file:\/\//;
const DEFAULT_RENDERER_PORT = Number(process.env.DSH_RENDERER_PORT || 52731);
const SERVER_NATIVE_SQLITE = path.resolve(__dirname, '..', '..', 'server', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const requireFromElectron = createRequire(path.join(ELECTRON_DIR, 'package.json'));

export function createCdpEventHub() {
  const listeners = new Map();
  const on = (method, listener) => {
    if (typeof listener !== 'function') throw new TypeError('CDP 事件监听器必须是函数');
    const key = String(method || '').trim();
    if (!key) throw new TypeError('CDP 事件名称不能为空');
    const entries = listeners.get(key) || new Set();
    entries.add(listener);
    listeners.set(key, entries);
    return () => {
      entries.delete(listener);
      if (!entries.size) listeners.delete(key);
    };
  };
  const emit = (method, params) => {
    for (const listener of listeners.get(String(method || '')) || []) {
      try { listener(params); } catch { /* a diagnostics listener must not break CDP */ }
    }
  };
  const clear = () => listeners.clear();
  return Object.freeze({ on, emit, clear });
}

export function resolveRendererLaunchMode({
  isolate = true,
  hasExplicitRendererUrl = false,
  packagedApp = false,
  defaultRendererReady = false,
} = {}) {
  if (packagedApp) return 'packaged-app';
  if (hasExplicitRendererUrl) return 'explicit-renderer-url';
  if (isolate) return 'dedicated-dev-server';
  return defaultRendererReady ? 'shared-dev-server' : 'dedicated-dev-server';
}

function rendererModuleIdentity(rawUrl, rendererUrl) {
  try {
    const parsed = new URL(String(rawUrl || ''), rendererUrl);
    const renderer = new URL(rendererUrl);
    if (!/^https?:$/.test(renderer.protocol) || parsed.origin !== renderer.origin) return null;
    if (!parsed.pathname.startsWith('/src/')) return null;
    const hmrToken = parsed.searchParams.get('t') || '';
    parsed.searchParams.delete('t');
    parsed.hash = '';
    return { module: parsed.href, hmrToken };
  } catch {
    return null;
  }
}

/** Track renderer source revisions reported by CDP without depending on Vite's console wording. */
export function createRendererRevisionMonitor({ rendererUrl, now = () => Date.now() } = {}) {
  const revisions = new Map();
  const changes = [];
  const observeScriptParsed = (params = {}) => {
    const identity = rendererModuleIdentity(params.url, rendererUrl);
    if (!identity) return;
    const next = {
      hash: String(params.hash || ''),
      hmrToken: identity.hmrToken,
      scriptId: String(params.scriptId || ''),
    };
    const previous = revisions.get(identity.module);
    revisions.set(identity.module, next);
    if (!previous) return;
    const sourceChanged = Boolean(previous.hash && next.hash && previous.hash !== next.hash);
    const hmrChanged = previous.hmrToken !== next.hmrToken
      && Boolean(previous.hmrToken || next.hmrToken);
    if (!sourceChanged && !hmrChanged) return;
    changes.push({
      type: 'renderer-source-revision-changed',
      at: new Date(now()).toISOString(),
      module: identity.module,
      previous,
      next,
      source_changed: sourceChanged,
      hmr_token_changed: hmrChanged,
    });
  };
  const checkpoint = () => changes.length;
  const pollutionSince = (from = 0) => {
    const recentChanges = changes.slice(Math.max(0, Number(from) || 0));
    return {
      polluted: recentChanges.length > 0,
      code: recentChanges.length ? 'EVAL_RENDERER_SOURCE_CHANGED' : null,
      changes: recentChanges,
    };
  };
  return Object.freeze({ observeScriptParsed, checkpoint, pollutionSince });
}

function isTruthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

function createEvalEnv(rendererUrl, { isolate = true } = {}) {
  const evalDataRoot = String(process.env.DSH_EVAL_DATA_ROOT || '').trim();
  const base = {
    ...process.env,
    DSH_DEV_URL: rendererUrl,
    DSH_NODE_BIN: resolveBackendNode(),
    ...(evalDataRoot
      ? {
          DSH_DATA_ROOT: path.resolve(evalDataRoot),
          DB_SQLITE_PATH: path.join(path.resolve(evalDataRoot), 'local.db'),
        }
      : {}),
    // Eval must not compete with a running desktop app for Electron's single-instance lock.
    // This changes only Chromium window state; HOME/DSH_DATA_ROOT and the real app database stay unchanged.
    DSH_USER_DATA_DIR: process.env.DSH_USER_DATA_DIR || path.join(tmpdir(), `dsh-electron-eval-${process.pid}`),
  };

  const shouldIsolate = isolate && !isTruthy(process.env.DSH_EVAL_REUSE_DATA);
  if (!shouldIsolate) {
    const env = { ...base };
    if (process.env.DSH_EVAL_DB_SQLITE_PATH) env.DB_SQLITE_PATH = process.env.DSH_EVAL_DB_SQLITE_PATH;
    env.DSH_EVAL_MODE = evalDataRoot || process.env.DSH_EVAL_DB_SQLITE_PATH ? 'custom-db' : 'normal';
    return { env, cleanupRoot: null };
  }

  const configuredEvalHome = String(process.env.DSH_EVAL_HOME || '').trim();
  const evalHome = configuredEvalHome || mkdtempSync(path.join(tmpdir(), 'dsh-app-eval-'));
  const dshDataDir = path.join(evalHome, '.dsh');
  mkdirSync(dshDataDir, { recursive: true });
  return {
    cleanupRoot: configuredEvalHome ? null : evalHome,
    env: {
      ...base,
      HOME: evalHome,
      USERPROFILE: evalHome,
      XDG_CONFIG_HOME: path.join(evalHome, '.config'),
      APPDATA: path.join(evalHome, 'AppData', 'Roaming'),
      DB_SQLITE_PATH: process.env.DSH_EVAL_DB_SQLITE_PATH || base.DB_SQLITE_PATH || path.join(dshDataDir, 'local.db'),
      DSH_DATA_ROOT: base.DSH_DATA_ROOT || dshDataDir,
      DSH_USER_DATA_DIR: process.env.DSH_USER_DATA_DIR || path.join(evalHome, '.electron'),
      DSH_AGENT_RUNTIME_HOME: path.join(evalHome, '.agent_runtime'),
      DSH_SKILLS_ROOT: path.join(dshDataDir, 'skills'),
      DSH_EVAL_HOME: evalHome,
      DSH_EVAL_MODE: 'isolated',
    },
  };
}

function nativeArch(filePath) {
  if (!existsSync(filePath)) return '';
  try {
    const out = execFileSync('file', [filePath], { encoding: 'utf8' });
    if (out.includes('arm64')) return 'arm64';
    if (out.includes('x86_64')) return 'x64';
  } catch {
    // ignore
  }
  return '';
}

function nodeArch(nodePath) {
  try {
    return execFileSync(nodePath, ['-p', 'process.arch'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function resolveBackendNode() {
  if (process.env.DSH_NODE_BIN && existsSync(process.env.DSH_NODE_BIN)) return process.env.DSH_NODE_BIN;
  const targetArch = nativeArch(SERVER_NATIVE_SQLITE);
  if (!targetArch) return process.execPath;
  const candidates = [
    process.execPath,
    ...String(process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'node')),
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ].filter((p, i, arr) => p && existsSync(p) && arr.indexOf(p) === i);
  return candidates.find((p) => nodeArch(p) === targetArch) || process.execPath;
}

function resolveElectronExecutable() {
  const executable = requireFromElectron('electron');
  if (!(typeof executable === 'string' && existsSync(executable))) {
    throw new Error(`找不到 Electron 可执行文件: ${String(executable || '')}`);
  }
  return executable;
}

function terminateChildTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch { /* fall back to the direct child */ }
  }
  try { child.kill(signal); } catch { /* already stopped */ }
}

async function stopChildTree(child, timeoutMs = 3000) {
  if (!child?.pid || child.exitCode != null || child.signalCode != null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  terminateChildTree(child, 'SIGTERM');
  await Promise.race([exited, sleep(timeoutMs)]);
  if (child.exitCode == null && child.signalCode == null) {
    terminateChildTree(child, 'SIGKILL');
    await Promise.race([exited, sleep(1000)]);
  }
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.setTimeout(500, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForRenderer(port, child, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) return false;
    if (await isDshRenderer(port)) return true;
    await sleep(250);
  }
  return false;
}

async function fetchJson(url, { timeoutMs = 1500 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, { timeoutMs = 1500 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function isDshRenderer(port) {
  try {
    const text = await fetchText(`http://127.0.0.1:${port}/src/store/basic.ts`);
    return text.includes('useBasicStore');
  } catch {
    return false;
  }
}

async function findFreePort(start) {
  let port = Number(start) || 52731;
  for (let i = 0; i < 50; i++) {
    if (!(await isPortOpen(port))) return port;
    port += 1;
  }
  throw new Error(`找不到可用 renderer 端口(从 ${start} 起试了 50 个)`);
}

/** Connect to an existing debug port if available; otherwise start an Electron instance and cleanly close it after use. Returns { evalJs, cdp, close }. */
export async function openSession({ port = 9333, reuseExisting = false, isolate = true, keepData = false } = {}) {
  let child = null;
  let rendererChild = null;
  let runtime = null;
  let reusedExisting = false;
  const packagedAppInput = String(process.env.DSH_EVAL_PACKAGED_APP || '').trim();
  const childStdio = isTruthy(process.env.DSH_EVAL_VERBOSE)
    ? ['ignore', 'inherit', 'inherit']
    : 'ignore';
  const explicitRendererUrl = String(process.env.DSH_DEV_URL || '').trim();
  let rendererUrl = explicitRendererUrl || `http://127.0.0.1:${DEFAULT_RENDERER_PORT}`;
  let rendererMode = resolveRendererLaunchMode({
    isolate,
    hasExplicitRendererUrl: Boolean(explicitRendererUrl),
    packagedApp: Boolean(packagedAppInput),
  });
  let existingDebugger = false;
  try {
    await fetchJson(`http://localhost:${port}/json/version`);
    existingDebugger = true;
  } catch { /* start a new app below */ }
  if (existingDebugger && !reuseExisting) {
    throw new Error(`CDP 端口 ${port} 已有运行中的 App。为避免使用用户数据，请更换端口；确需复用时显式传 --reuse-running-app`);
  }
  if (existingDebugger) reusedExisting = true;
  if (!existingDebugger) {
    if (!explicitRendererUrl && !packagedAppInput) {
      let rendererPort = DEFAULT_RENDERER_PORT;
      let rendererReady = false;
      if (isolate) {
        // Data isolation is not enough for UI evals: sharing an actively watched
        // Vite process lets an unrelated HMR remount reset component-local state.
        rendererPort = await findFreePort(rendererPort);
      } else {
        rendererReady = await isDshRenderer(rendererPort);
        if (!rendererReady && (await isPortOpen(rendererPort))) {
          rendererPort = await findFreePort(rendererPort + 1);
        }
      }
      rendererUrl = `http://127.0.0.1:${rendererPort}`;
      rendererMode = resolveRendererLaunchMode({ isolate, defaultRendererReady: rendererReady });
      if (!rendererReady) {
        rendererChild = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1'], {
          cwd: RENDERER_DIR,
          env: {
            ...process.env,
            VITE_APP_DEV_PORT: String(rendererPort),
            VITE_DEV_PORT: String(rendererPort),
          },
          stdio: childStdio,
          detached: process.platform !== 'win32',
          shell: process.platform === 'win32',
        });
        const ready = await waitForRenderer(rendererPort, rendererChild);
        if (!ready) {
          await stopChildTree(rendererChild);
          throw new Error(`renderer 未能在 ${rendererPort} 端口启动`);
        }
      }
    }
    runtime = createEvalEnv(rendererUrl, { isolate });
    const env = runtime.env;
    console.info(`[eval] 启动 Electron: mode=${env.DSH_EVAL_MODE || 'normal'} HOME=${env.HOME || process.env.HOME || ''} DB=${env.DB_SQLITE_PATH || '(default ~/.dsh/local.db)'}${packagedAppInput ? ` package=${packagedAppInput}` : ''}`);
    if (packagedAppInput) {
      const layout = resolvePackagedLayout(packagedAppInput);
      delete env.DSH_DEV_URL;
      child = spawn(layout.executable, [`--remote-debugging-port=${port}`], {
        cwd: path.dirname(layout.executable),
        env,
        stdio: childStdio,
      });
    } else {
      const electronArgs = ['.', `--remote-debugging-port=${port}`];
      // Isolated macOS smoke runs have no operator to answer a Keychain prompt.
      // Chromium's test keychain keeps the real Electron safeStorage API in the
      // path without touching the user's login keychain.
      if (env.DSH_EVAL_MODE === 'isolated' && process.platform === 'darwin') {
        electronArgs.push('--use-mock-keychain');
      }
      child = spawn(resolveElectronExecutable(), electronArgs, {
        cwd: ELECTRON_DIR,
        env,
        stdio: childStdio,
      });
    }
  }
  const deadline = Date.now() + 45000;
  let page;
  while (Date.now() < deadline) {
    try {
      const ts = await fetchJson(`http://localhost:${port}/json`);
      page = ts.find((t) => t.type === 'page' && APP_PAGE_RE.test(t.url || ''));
      if (page) break;
    } catch { /* not up */ }
    await sleep(400);
  }
  if (!page) {
    try { child?.kill(); } catch { /* ignore */ }
    await stopChildTree(rendererChild);
    throw new Error(`连不上 CDP(:${port})`);
  }
  if (reusedExisting) rendererMode = 'reused-running-app';

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const events = createCdpEventHub();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    else if (m.method) events.emit(m.method, m.params || {});
  });
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`CDP WebSocket 打开超时(:${port})`)), 10000);
    ws.addEventListener('open', () => { clearTimeout(timer); res(); }, { once: true });
    ws.addEventListener('error', (e) => { clearTimeout(timer); rej(e); }, { once: true });
  });
  const cmd = (method, params, opts = {}) => new Promise((res, rej) => {
    const i = ++id;
    let timer = null;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        pending.delete(i);
        rej(new Error(`CDP 命令超时: ${method}`));
      }, opts.timeoutMs);
    }
    pending.set(i, {
      res: (v) => { if (timer) clearTimeout(timer); res(v); },
      rej: (e) => { if (timer) clearTimeout(timer); rej(e); },
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const observedRendererUrl = page.url || rendererUrl;
  const revisionMonitor = createRendererRevisionMonitor({ rendererUrl: observedRendererUrl });
  const stopRevisionMonitor = events.on('Debugger.scriptParsed', revisionMonitor.observeScriptParsed);
  await cmd('Runtime.enable', {}, { timeoutMs: 5000 });
  await cmd('Page.enable', {}, { timeoutMs: 5000 }).catch(() => {});
  await cmd('Debugger.enable', {}, { timeoutMs: 5000 });

  const evalJs = async (expr, opts = {}) => {
    const r = await cmd('Runtime.evaluate', { expression: `(async()=>{${expr}})()`, awaitPromise: true, returnByValue: true }, opts);
    if (r.exceptionDetails) throw new Error('渲染层异常: ' + String(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 400));
    return r.result.value;
  };
  const d2 = Date.now() + 20000;
  let ready = false;
  while (Date.now() < d2) {
    try {
      if (await evalJs(`return !!(window.electronAPI&&window.electronAPI.apiRequest)`, { timeoutMs: 1500 })) {
        ready = true;
        break;
      }
    } catch { /* loading */ }
    await sleep(300);
  }
  if (!ready) {
    try { ws.close(); } catch { /* ignore */ }
    if (child) { try { child.kill(); } catch { /* ignore */ } }
    await stopChildTree(rendererChild);
    throw new Error(`渲染层未就绪: window.electronAPI.apiRequest 不可用(:${port})`);
  }

  const info = {
    mode: reusedExisting ? 'reused-running-app' : (runtime?.env?.DSH_EVAL_MODE || 'normal'),
    reused_existing_app: reusedExisting,
    eval_home: runtime?.env?.DSH_EVAL_HOME || '',
    data_root: runtime?.env?.DSH_DATA_ROOT || '',
    database_path: runtime?.env?.DB_SQLITE_PATH || '',
    cleanup_status: runtime?.cleanupRoot ? 'pending' : 'not-applicable',
    renderer: {
      mode: rendererMode,
      url: observedRendererUrl,
      dedicated: rendererMode === 'dedicated-dev-server',
      launched_by_eval: Boolean(rendererChild),
      revision_monitor: 'cdp-debugger-script-hash',
    },
  };

  return {
    evalJs,
    cdp: cmd,
    onEvent: events.on,
    infrastructureCheckpoint: revisionMonitor.checkpoint,
    infrastructurePollutionSince: revisionMonitor.pollutionSince,
    info,
    close: async ({ preserveData = false } = {}) => {
      if (child) {
        const exited = child.exitCode != null
          ? Promise.resolve()
          : new Promise((resolve) => child.once('exit', resolve));
        try {
          await evalJs('return await window.electronAPI.evalQuitApplication()', { timeoutMs: 3000 });
        } catch {
          try { child.kill(); } catch { /* ignore */ }
        }
        await Promise.race([exited, sleep(10_000)]);
        if (child.exitCode == null) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          await Promise.race([exited, sleep(2_000)]);
        }
      }
      try { ws.close(); } catch { /* ignore */ }
      stopRevisionMonitor();
      events.clear();
      await stopChildTree(rendererChild);
      if (runtime?.cleanupRoot && !keepData && !preserveData) {
        try {
          rmSync(runtime.cleanupRoot, { recursive: true, force: true });
          info.cleanup_status = 'removed';
        } catch {
          info.cleanup_status = 'cleanup-error';
        }
      } else if (runtime?.cleanupRoot && (keepData || preserveData)) {
        info.cleanup_status = 'preserved';
        console.info(`[eval] 保留隔离现场: ${runtime.cleanupRoot}`);
      }
    },
  };
}
