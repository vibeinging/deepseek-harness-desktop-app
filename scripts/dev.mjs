import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import process from 'node:process'
import { nodeArch, nodeVersion, projectNodeEnv, resolveNpmCli, resolveProjectNode } from './project-runtime.mjs'

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const CUSTOM_RENDERER_URL = process.env.DSH_DEV_URL

function resolvePort(value, fallback) {
  const explicitPort = Number(value)
  if (Number.isInteger(explicitPort) && explicitPort >= 1 && explicitPort <= 65535) return explicitPort
  return fallback
}

const RENDERER_PORT = resolvePort(process.env.DSH_RENDERER_PORT, 52731)
const SERVER_PORT = resolvePort(process.env.DSH_SERVER_PORT || process.env.SERVER_PORT, 52838)
const RENDERER_URL = CUSTOM_RENDERER_URL || `http://127.0.0.1:${RENDERER_PORT}`

const children = new Set()
let shuttingDown = false

function isPortOpen(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(500, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function waitForPort(port, timeoutMs = 30000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function isExpectedRenderer(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return false
    const html = await response.text()
    return html.includes('id="app"') && html.includes('dsh-work')
  } catch {
    return false
  }
}

function run(name, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  children.add(child)
  child.once('exit', (code, signal) => {
    children.delete(child)
    if (!shuttingDown && options.exitOnClose) {
      shutdown(code ?? (signal ? 1 : 0))
    }
  })
  child.once('error', (error) => {
    console.error(`[dev] ${name} 启动失败: ${error.message}`)
    if (options.exitOnClose) shutdown(1)
  })
  return child
}

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  for (const child of children) {
    try {
      child.kill()
    } catch {
      // ignore
    }
  }
  setTimeout(() => process.exit(code), 100)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

const PROJECT_NODE = resolveProjectNode({ appDir: APP_DIR })
const PROJECT_NODE_ENV = projectNodeEnv(PROJECT_NODE)

console.log(`[dev] 项目 Node: ${PROJECT_NODE} (${nodeArch(PROJECT_NODE)}, v${nodeVersion(PROJECT_NODE)})`)
console.log(`[dev] 开发端口: Renderer ${RENDERER_PORT}, Server ${SERVER_PORT}`)

async function ensureDesktopDependencies() {
  const npmCli = resolveNpmCli(PROJECT_NODE)
  await new Promise((resolveReady, reject) => {
    const child = spawn(PROJECT_NODE, [join(APP_DIR, 'scripts', 'bootstrap.mjs')], {
      cwd: APP_DIR,
      env: { ...PROJECT_NODE_ENV, npm_execpath: npmCli, npm_config_arch: nodeArch(PROJECT_NODE) },
      stdio: 'inherit',
      shell: false,
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveReady()
      else reject(new Error(`依赖架构检查失败(code=${code}, signal=${signal || 'none'})`))
    })
  })
}

try {
  await ensureDesktopDependencies()
} catch (error) {
  console.error(`[dev] ${error?.message || error}`)
  process.exit(1)
}

const rendererPortBusy = CUSTOM_RENDERER_URL ? false : await isPortOpen(RENDERER_PORT)
const rendererAlreadyRunning = await isExpectedRenderer(RENDERER_URL)
const serverPortBusy = await isPortOpen(SERVER_PORT)

if (serverPortBusy) {
  console.error(`[dev] ${SERVER_PORT} 端口已被其他服务占用；可通过 DSH_SERVER_PORT 指定其他端口`)
  process.exit(1)
}

if (CUSTOM_RENDERER_URL) {
  if (!rendererAlreadyRunning) {
    console.error(`[dev] DSH_DEV_URL 不是可用的 dsh-work Renderer: ${RENDERER_URL}`)
    process.exit(1)
  }
  console.log(`[dev] 使用 DSH_DEV_URL: ${RENDERER_URL}`)
} else if (!rendererAlreadyRunning) {
  if (rendererPortBusy) {
    console.error(`[dev] ${RENDERER_PORT} 端口已被其他服务占用`)
    process.exit(1)
  }
  run('renderer', 'npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(RENDERER_PORT), '--strictPort'], {
    cwd: join(APP_DIR, 'renderer'),
    env: { ...PROJECT_NODE_ENV, DSH_SERVER_PORT: String(SERVER_PORT) },
    exitOnClose: true,
  })
  const ready = await waitForPort(RENDERER_PORT)
  if (!ready) {
    console.error(`[dev] renderer 未能在 ${RENDERER_PORT} 端口启动`)
    shutdown(1)
  }
} else {
  console.log(`[dev] renderer 已在 ${RENDERER_URL} 运行，复用现有服务`)
}

run('electron', 'npm', ['run', 'dev'], {
  cwd: join(APP_DIR, 'electron'),
  env: {
    ...PROJECT_NODE_ENV,
    DSH_DEV_URL: RENDERER_URL,
    DSH_NODE_BIN: PROJECT_NODE,
    DSH_SERVER_PORT: String(SERVER_PORT),
  },
  exitOnClose: true
})
