import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePackagedLayout } from './packaged-layout.mjs'

const appInput = process.argv[2]
const { executable, resourcesDir } = resolvePackagedLayout(appInput)
const serverDir = join(resourcesDir, 'server')
const timeoutMs = Number(process.env.DSH_SMOKE_TIMEOUT_MS || 60_000)
const tempDir = await mkdtemp(join(tmpdir(), 'dsh-packaged-smoke-'))
const output = []
let child

function ipcRequest(proc, { method, url, body = null }, requestTimeoutMs) {
  return new Promise((resolveRequest, reject) => {
    const id = `packaged-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const chunks = []
    let status = 0
    const cleanup = () => {
      clearTimeout(timer)
      proc.off('message', onMessage)
      proc.off('exit', onExit)
    }
    const fail = (error) => {
      cleanup()
      reject(error)
    }
    const onExit = (code, signal) => fail(new Error(`随包 Server 请求期间退出 code=${code} signal=${signal}`))
    const onMessage = (message) => {
      if (message?.id !== id) return
      if (message.type === 'head') status = Number(message.status || 0)
      if (message.type === 'data' && !message.b64) chunks.push(String(message.chunk || ''))
      if (message.type !== 'end') return
      cleanup()
      const text = chunks.join('')
      let json = null
      try { json = JSON.parse(text) } catch { /* leave raw body */ }
      resolveRequest({ status, json, body: text })
    }
    const timer = setTimeout(
      () => fail(new Error(`随包 Server IPC 请求超时(${requestTimeoutMs}ms): ${method} ${url}`)),
      requestTimeoutMs,
    )
    proc.on('message', onMessage)
    proc.once('exit', onExit)
    proc.send({
      id,
      method,
      url,
      headers: { 'content-type': 'application/json' },
      body: body == null ? null : JSON.stringify(body),
    }, (error) => {
      if (error) fail(error)
    })
  })
}

try {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_DATA_ROOT: join(tempDir, 'data'),
    DSH_AGENT_RUNTIME_HOME: join(tempDir, 'agent_runtime'),
    DSH_SKILLS_ROOT: join(tempDir, 'data', 'skills'),
  }
  for (const key of ['DB_SQLITE_PATH', 'INTERMEDIATE_DIR', 'DSH_AGENT_SESSION_DIR', 'DSH_YITRACE_DIR']) {
    delete env[key]
  }
  child = spawn(executable, [join(serverDir, 'src', 'index.js')], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  })
  child.stdout.on('data', (chunk) => output.push(chunk.toString()))
  child.stderr.on('data', (chunk) => output.push(chunk.toString()))

  const messages = []
  const exitPromise = new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolveExit({ code, signal }))
  })
  const ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`随包 Server ready 超时(${timeoutMs}ms)\n${output.join('')}`)), timeoutMs)
    child.on('message', (message) => {
      messages.push(message)
      if (message?.type === 'lifecycle' && message.event === 'ready') {
        clearTimeout(timer)
        resolveReady(message)
      }
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`随包 Server 在 ready 前退出 code=${code} signal=${signal}\n${output.join('')}`))
    })
  })

  const agentRuntime = await ipcRequest(child, {
    method: 'GET',
    url: '/api/agents/runtime',
  }, timeoutMs)
  if (agentRuntime.status !== 200 || agentRuntime.json?.data?.available !== true) {
    throw new Error(`随包 Agent 运行时检查失败\n${agentRuntime.body}\n${output.join('')}`)
  }

  child.send({ type: 'lifecycle', event: 'shutdown' })
  const exited = await exitPromise
  if (exited.code !== 0) throw new Error(`随包 Server 退出失败 code=${exited.code}\n${output.join('')}`)
  if (!messages.some((message) => message?.event === 'shutdown-complete')) {
    throw new Error(`随包 Server 没有返回 shutdown-complete\n${output.join('')}`)
  }
  if (!output.join('').includes('vexdb_lite 向量扩展已加载')) {
    throw new Error(`随包 Server 没有加载 vexdb_lite\n${output.join('')}`)
  }
  console.log(`[smoke] 随包 Server 和 Agent 运行时正常: node=${ready.node} arch=${ready.arch}`)
} finally {
  try { child?.kill() } catch { /* ignore */ }
  await rm(tempDir, { recursive: true, force: true })
}
