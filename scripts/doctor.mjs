import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = join(APP_DIR, 'server');
const SUPPORTED = process.platform === 'darwin'
  ? new Set(['arm64', 'x64'])
  : process.platform === 'win32'
    ? new Set(['x64'])
    : new Set();

function supportedNode(version = process.versions.node) {
  const [major = 0] = String(version).split('.').map(Number);
  return major >= 24;
}

function assertReady(condition, message) {
  if (!condition) throw new Error(message);
}

console.log(`[doctor] 系统: ${process.platform}/${process.arch}`);
console.log(`[doctor] Node: ${process.version} (ABI ${process.versions.modules})`);
assertReady(supportedNode(), 'Node 版本太旧，请安装 Node 24 后重新执行 npm install');
assertReady(SUPPORTED.has(process.arch), `桌面端暂不支持 ${process.platform}/${process.arch}`);

for (const relativePath of [
  'renderer/node_modules/vite/package.json',
  'server/node_modules/better-sqlite3/package.json',
  'server/node_modules/@duckdb/node-api/package.json',
  'server/node_modules/@yitrace/db/package.json',
  'electron/node_modules/electron/package.json',
]) {
  assertReady(existsSync(join(APP_DIR, relativePath)), `缺少 ${relativePath}，请先执行 npm install`);
}
console.log('[doctor] 桌面端依赖齐全');

if (process.platform === 'darwin') {
  const electronRequire = createRequire(join(APP_DIR, 'electron', 'package.json'));
  const electronExecutable = electronRequire('electron');
  const sqliteNative = join(SERVER_DIR, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
  const expectedArch = process.arch === 'x64' ? 'x86_64' : process.arch;
  const readArchitectures = (binaryPath) => execFileSync('lipo', ['-archs', binaryPath], { encoding: 'utf8' })
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const electronArchitectures = readArchitectures(electronExecutable);
  const sqliteArchitectures = readArchitectures(sqliteNative);
  assertReady(
    electronArchitectures.includes(expectedArch),
    `Electron 架构不匹配: 需要 ${expectedArch}，实际 ${electronArchitectures.join(', ')}`,
  );
  assertReady(
    sqliteArchitectures.includes(expectedArch),
    `better-sqlite3 架构不匹配: 需要 ${expectedArch}，实际 ${sqliteArchitectures.join(', ')}`,
  );
  console.log(`[doctor] Electron 与 better-sqlite3 架构一致: ${expectedArch}`);
}

const tempDir = await mkdtemp(join(tmpdir(), 'dsh-doctor-'));
let child;
try {
  const duckPath = join(tempDir, 'doctor.duckdb');
  const { duckWriteRecords, duckRunRecords } = await import('../server/src/engine/datasources/duck.js');
  await duckWriteRecords(duckPath, 'doctor', [{ ok: 1 }], ['ok']);
  const duckRows = await duckRunRecords(duckPath, 'SELECT ok FROM doctor', 1);
  assertReady(duckRows[0]?.ok === 1, 'DuckDB 读写结果不正确');
  console.log('[doctor] DuckDB 原生模块读写正常');

  process.env.DSH_DATA_ROOT = join(tempDir, 'data');
  process.env.DSH_AGENT_RUNTIME_HOME = join(tempDir, 'agent_runtime');
  process.env.DSH_SKILLS_ROOT = join(tempDir, 'data', 'skills');
  process.env.DSH_YITRACE_DIR = join(tempDir, 'data', 'yitrace');
  const { getYiTraceDb, closeYiTraceDb } = await import('../server/src/app/traces/yitrace_service.js');
  const traceDb = await getYiTraceDb();
  assertReady(traceDb, 'YiTrace 原生模块无法打开');
  await closeYiTraceDb();
  console.log('[doctor] YiTrace 原生模块打开和关闭正常');

  const output = [];
  child = spawn(process.execPath, [join('src', 'index.js')], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      DSH_DATA_ROOT: join(tempDir, 'server-data'),
      DSH_AGENT_RUNTIME_HOME: join(tempDir, 'server-agent_runtime'),
      DSH_SKILLS_ROOT: join(tempDir, 'server-data', 'skills'),
      DSH_YITRACE_DIR: join(tempDir, 'server-data', 'yitrace'),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));

  const messages = [];
  const exitPromise = new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
  const ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server 启动超时\n${output.join('')}`)), 30_000);
    child.on('message', (message) => {
      messages.push(message);
      if (message?.type === 'lifecycle' && message.event === 'ready') {
        clearTimeout(timer);
        resolveReady(message);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`Server 在 ready 前退出(code=${code}, signal=${signal || 'none'})\n${output.join('')}`));
    });
  });
  assertReady(ready.arch === process.arch, `Server 架构不一致: ${ready.arch}`);
  assertReady(output.join('').includes('vexdb_lite 向量扩展已加载'), `vexdb_lite 没有正常加载\n${output.join('')}`);
  child.send({ type: 'lifecycle', event: 'shutdown' });
  const exited = await exitPromise;
  assertReady(exited.code === 0, `Server 退出失败(code=${exited.code})\n${output.join('')}`);
  assertReady(messages.some((message) => message?.event === 'shutdown-complete'), 'Server 没有完成优雅关闭');
  console.log('[doctor] SQLite、vexdb_lite 和 Server 生命周期正常');
  console.log('\n[doctor] 全部通过，可以运行 npm run dev');
} finally {
  try { child?.kill(); } catch { /* ignore */ }
  await rm(tempDir, { recursive: true, force: true });
}
