import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import net from 'node:net'
import process from 'node:process'
import { nodeArch, nodeVersion, projectNodeEnv, resolveNpmCli, resolveProjectNode } from './project-runtime.mjs'

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url)))

function resolvePort(value, fallback) {
  const explicitPort = Number(value)
  if (Number.isInteger(explicitPort) && explicitPort >= 1 && explicitPort <= 65535) return explicitPort
  return fallback
}

const SERVER_PORT = resolvePort(process.env.DSH_SERVER_PORT || process.env.SERVER_PORT, 52838)

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
console.log(`[dev] App API 端口: ${SERVER_PORT}`)

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

async function buildDshClientPlugin() {
  await new Promise((resolveReady, reject) => {
    const child = spawn('npm', ['run', 'build:dsh-client'], {
      cwd: join(APP_DIR, 'renderer'),
      env: { ...process.env, ...PROJECT_NODE_ENV },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveReady()
      else reject(new Error(`dsh-work Client Plugin 构建失败(code=${code}, signal=${signal || 'none'})`))
    })
  })
}

try {
  await buildDshClientPlugin()
} catch (error) {
  console.error(`[dev] ${error?.message || error}`)
  process.exit(1)
}

const serverPortBusy = await isPortOpen(SERVER_PORT)

if (serverPortBusy) {
  console.error(`[dev] ${SERVER_PORT} 端口已被其他服务占用；可通过 DSH_SERVER_PORT 指定其他端口`)
  process.exit(1)
}

run('electron', 'npm', ['run', 'dev'], {
  cwd: join(APP_DIR, 'electron'),
  env: {
    ...PROJECT_NODE_ENV,
    DSH_NODE_BIN: PROJECT_NODE,
    DSH_SERVER_PORT: String(SERVER_PORT),
  },
  exitOnClose: true
})
