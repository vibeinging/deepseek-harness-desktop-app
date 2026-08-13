import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER_DIR = join(APP_DIR, 'server')

test('desktop server reports ready and completes graceful shutdown', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'dsh-lifecycle-'))
  const output = []
  let child
  try {
    const env = {
      ...process.env,
      DSH_DATA_ROOT: tempDir,
      VEXDB_EXT_PATH: join(tempDir, 'missing-vexdb-extension'),
    }
    delete env.DB_SQLITE_PATH
    child = spawn(process.execPath, [join('src', 'index.js')], {
      cwd: SERVER_DIR,
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
      const timer = setTimeout(() => reject(new Error(`Server ready 超时\n${output.join('')}`)), 30_000)
      child.on('message', (message) => {
        messages.push(message)
        if (message?.type === 'lifecycle' && message.event === 'ready') {
          clearTimeout(timer)
          resolveReady(message)
        }
      })
      child.once('exit', (code, signal) => {
        clearTimeout(timer)
        reject(new Error(`Server 在 ready 前退出 code=${code} signal=${signal}\n${output.join('')}`))
      })
    })

    assert.equal(ready.arch, process.arch)
    assert.equal(existsSync(join(tempDir, 'local.db')), true)

    const apiResponse = await new Promise((resolveApi, reject) => {
      const requestId = 'local-user-projects'
      const chunks = []
      let status = 0
      const timer = setTimeout(() => reject(new Error(`无令牌项目请求超时\n${output.join('')}`)), 10_000)
      const onMessage = (message) => {
        if (message?.id !== requestId) return
        if (message.type === 'head') status = message.status
        if (message.type === 'data') chunks.push(message.chunk)
        if (message.type === 'end') {
          clearTimeout(timer)
          child.off('message', onMessage)
          resolveApi({ status, body: JSON.parse(chunks.join('')) })
        }
      }
      child.on('message', onMessage)
      child.send({ id: requestId, method: 'GET', url: '/api/projects', headers: {} })
    })
    assert.equal(apiResponse.status, 200)
    assert.equal(apiResponse.body.success, true)

    child.send({ type: 'lifecycle', event: 'shutdown' })
    const exited = await exitPromise
    assert.equal(exited.code, 0, output.join(''))
    assert.ok(messages.some((message) => message?.event === 'shutdown-complete'), output.join(''))
  } finally {
    try { child?.kill() } catch { /* ignore */ }
    await rm(tempDir, { recursive: true, force: true })
  }
})
