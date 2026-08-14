import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePackagedLayout } from './packaged-layout.mjs'

const appInput = process.argv[2]
const { executable } = resolvePackagedLayout(appInput)
// Rosetta may need extra translation when first launching x64 Electron; actual window and server startup
// can be noticeably slower on quit, while native architecture may be faster. Server still keeps 30s startup timeout.
const timeoutMs = Number(process.env.DSH_SMOKE_TIMEOUT_MS || 180_000)
const tempDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-app-'))
const output = []
let child

try {
  const env = { ...process.env }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'DB_SQLITE_PATH', 'INTERMEDIATE_DIR', 'DSH_AGENT_SESSION_DIR', 'DSH_YITRACE_DIR']) {
    delete env[key]
  }
  Object.assign(env, {
    DSH_SMOKE_TEST: '1',
    DSH_USER_DATA_DIR: join(tempDir, 'user-data'),
    DSH_DATA_ROOT: join(tempDir, 'data'),
    DSH_AGENT_RUNTIME_HOME: join(tempDir, 'agent_runtime'),
    DSH_SKILLS_ROOT: join(tempDir, 'data', 'skills'),
  })
  child = spawn(executable, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk) => output.push(chunk.toString()))

  const result = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`随包 App smoke 超时(${timeoutMs}ms)\n${output.join('')}`))
    }, timeoutMs)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolveExit({ code, signal })
    })
  })
  const text = output.join('')
  if (result.code !== 0) throw new Error(`随包 App 退出失败 code=${result.code} signal=${result.signal}\n${text}`)
  if (!text.includes('[smoke] Renderer 已加载')) throw new Error(`Renderer 没有完成加载\n${text}`)
  if (!text.includes('Server 退出 code=0')) throw new Error(`Server 没有正常退出\n${text}`)
  console.log('[smoke] 随包 App 启动、Renderer 加载和 Server 关闭正常')
} finally {
  try { child?.kill() } catch { /* ignore */ }
  try {
    // Windows 上 Electron 退出后句柄释放有延迟，重试；清理失败不得掩盖 smoke 的真实结果
    await rm(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  } catch (error) {
    console.warn(`[smoke] 临时目录清理失败(已忽略): ${error.code || error.message}`)
  }
}
