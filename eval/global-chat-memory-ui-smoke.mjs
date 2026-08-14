import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'
import { encodeDshModelRoute } from '../server/src/engine/dsh_runtime/model_route.js'

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'global-chat-memory-ui-smoke-'))
const sourceTitle = `海王星发布记录 ${Date.now()}`
const currentTitle = `记忆回答验收 ${Date.now()}`
const sourceQuestion = `海王星发布计划-${Date.now()}：发布日期定在周四。`
const currentQuestion = `请回忆海王星发布计划-${Date.now()}的发布日期。`
const savedMemory = `回答偏好-${Date.now()}：先给结论，再给证据。`
const editedMemory = `${savedMemory} 不要铺垫。`
const scratchMemory = `待删除记忆-${Date.now()}`
const requests = []
const providerId = 'global-memory-eval'
const modelId = 'global-memory-model'
const credentialRef = 'GLOBAL_MEMORY_EVAL_API_KEY'
const modelRoute = encodeDshModelRoute(providerId, modelId)

process.env.DSH_EVAL_ISOLATED = '1'
process.env.DSH_EVAL_HOME = evalHome
process.env.DSH_USER_DATA_DIR = path.join(evalHome, 'electron-user-data')

async function startFakeModel() {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
    const answer = requests.length === 1
      ? '来源回答：周四上线。'
      : requests.length === 2
        ? '记忆回答：周四上线，并已按偏好先给结论。'
        : '临时回答：本轮没有读取记忆。'
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl_global_memory_${requests.length}`,
      model: 'global-memory-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }],
    })}\n\n`)
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl_global_memory_${requests.length}`,
      model: 'global-memory-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    })}\n\n`)
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function apiJson(session, request) {
  return session.evalJs(`
    const response = await window.electronAPI.apiRequest(${JSON.stringify(request)});
    return response.json;
  `, { timeoutMs: 20_000 })
}

async function createChatSession(session, title, temporary = false) {
  const response = await apiJson(session, {
    method: 'POST',
    url: '/api/projects/__chat__/sessions',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title,
      source_type: 'agent',
      source_id: '__chat__',
      action_type: 'agentic_chat',
      temporary,
    }),
  })
  const id = response?.data?.id || response?.data?.session_id || response?.data
  assert.equal(typeof id, 'string', JSON.stringify(response))
  return id
}

const clientCapabilities = {
  surface: 'desktop',
  projectChatMemory: true,
  globalChatMemory: true,
  renderMarkdown: true,
  renderChart: true,
  pageDataResult: true,
  openLocalFile: true,
  reviewWorkspaceDiff: true,
  mutateWorkspace: true,
  downloadArtifact: true,
}

let session = null
let fakeModel = null
let providerSaved = false
let sourceSessionId = ''
let currentSessionId = ''
try {
  fakeModel = await startFakeModel()
  session = await openSession({ port: 9363 })
  let driver = makeDriver(session)
  let ui = makeUiDriver(session)
  await driver.login()
  await session.evalJs(`
    localStorage.setItem('dsh:onboarding:completed:v1', 'true');
    return true;
  `)

  const snapshot = await driver.raw.api('GET', '/api/dsh/models')
  const namespace = snapshot.json?.data?.namespaces?.find((item) => item.ns === 'llm-pi-ai')
  assert.equal(typeof namespace?.revision, 'number', JSON.stringify(snapshot.json))
  const credential = await driver.raw.api('POST', '/api/dsh/models/credentials', {
    ref: credentialRef,
    value: 'global-memory-key',
  })
  assert.equal(credential.status, 200, JSON.stringify(credential.json))
  const configured = await driver.raw.api('POST', '/api/dsh/models/settings/mutate', {
    ns: 'llm-pi-ai',
    expected_revision: namespace.revision,
    ops: [{
      op: 'set',
      path: ['providers', providerId],
      value: {
        displayName: '全局记忆假模型',
        apiKeyEnv: credentialRef,
        api: 'openai-completions',
        baseURL: fakeModel.baseUrl,
        models: [{ id: modelId, name: '全局记忆假模型' }],
      },
    }],
  })
  assert.equal(configured.status, 200, JSON.stringify(configured.json))
  providerSaved = true

  sourceSessionId = await createChatSession(session, sourceTitle)
  const sourceTurn = await driver.raw.streamBlocks(
    `/api/agent/projects/__chat__/threads/${sourceSessionId}/turns`,
    {
      input: [{ type: 'text', text: sourceQuestion }],
      model: modelRoute,
      approvalMode: 'ask',
      clientCapabilities,
    },
  )
  assert.equal(requests.length, 1)
  assert.equal(sourceTurn.blocks.some((block) => block.type === 'global_memory'), false)

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor('[title="设置"]', { timeout: 30_000 })
  await ui.click('[title="设置"]')
  await ui.clickText('记忆', { selector: 'button', exact: true, timeout: 10_000 })
  await ui.waitFor('[data-global-memory-settings]', { timeout: 15_000 })
  await ui.waitUntil(`async () => Boolean(document.querySelector('[data-memory-source-id="${sourceSessionId}"]'))`, {
    timeout: 10_000,
    label: '来源聊天出现在记忆设置',
  })

  await ui.fill('[data-testid="memory-entry-input"]', savedMemory)
  await ui.click('[data-testid="memory-entry-add"]')
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(savedMemory)})`, {
    timeout: 10_000,
    label: '新增记忆可见',
  })
  let memoryState = await apiJson(session, { method: 'GET', url: '/api/agent/chat-memory', headers: {}, body: null })
  const mainEntryId = memoryState.data.entries.find((entry) => entry.content === savedMemory)?.id
  assert.equal(typeof mainEntryId, 'string', JSON.stringify(memoryState))

  await ui.click(`[data-memory-entry-id="${mainEntryId}"] [data-testid="memory-entry-edit"]`)
  await ui.fill('[data-testid="memory-entry-edit-input"]', editedMemory)
  await ui.click('[data-testid="memory-entry-save"]')
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(editedMemory)})`, {
    timeout: 10_000,
    label: '修改记忆可见',
  })

  await ui.fill('[data-testid="memory-entry-input"]', scratchMemory)
  await ui.click('[data-testid="memory-entry-add"]')
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(scratchMemory)})`, {
    timeout: 10_000,
    label: '待删除记忆可见',
  })
  memoryState = await apiJson(session, { method: 'GET', url: '/api/agent/chat-memory', headers: {}, body: null })
  const scratchEntryId = memoryState.data.entries.find((entry) => entry.content === scratchMemory)?.id
  assert.equal(typeof scratchEntryId, 'string', JSON.stringify(memoryState))
  await session.evalJs('window.confirm = () => true; return true;')
  await ui.click(`[data-memory-entry-id="${scratchEntryId}"] [data-testid="memory-entry-delete"]`)
  await ui.waitUntil(`async () => !document.body.innerText.includes(${JSON.stringify(scratchMemory)})`, {
    timeout: 10_000,
    label: '删除记忆立即消失',
  })

  await ui.click(`[data-memory-source-id="${sourceSessionId}"] [data-testid="memory-source-toggle"]`)
  await ui.waitUntil(`async () => document.querySelector('[data-memory-source-id="${sourceSessionId}"]')?.getAttribute('data-excluded') === 'true'`, {
    timeout: 10_000,
    label: '排除来源对话',
  })
  await ui.click(`[data-memory-source-id="${sourceSessionId}"] [data-testid="memory-source-toggle"]`)
  await ui.waitUntil(`async () => {
    const row = document.querySelector('[data-memory-source-id="${sourceSessionId}"]');
    return Boolean(row) && row.getAttribute('data-excluded') !== 'true';
  }`, {
    timeout: 10_000,
    label: '恢复来源对话',
  })

  await ui.click('[data-memory-setting="saved"] label')
  await ui.waitUntil(`async () => {
    const toggle = document.querySelector('[data-testid="saved-memory-toggle"]');
    return toggle?.checked === false && toggle.disabled === false;
  }`, {
    timeout: 10_000,
    label: '关闭已保存记忆',
  })
  await ui.click('[data-memory-setting="saved"] label')
  await ui.waitUntil(`async () => {
    const toggle = document.querySelector('[data-testid="saved-memory-toggle"]');
    return toggle?.checked === true && toggle.disabled === false;
  }`, {
    timeout: 10_000,
    label: '重新开启已保存记忆',
  })
  assert.equal((await session.evalJs("return document.querySelectorAll('[data-testid=\"memory-audit-list\"] > div').length")) > 0, true)

  await ui.clickText('返回项目', { selector: 'button', exact: true })
  currentSessionId = await createChatSession(session, currentTitle)
  const currentTurn = await driver.raw.streamBlocks(
    `/api/agent/projects/__chat__/threads/${currentSessionId}/turns`,
    {
      input: [{ type: 'text', text: currentQuestion }],
      model: modelRoute,
      approvalMode: 'ask',
      clientCapabilities,
    },
  )
  assert.equal(requests.length, 2)
  const currentRequestText = JSON.stringify(requests[1])
  assert.match(currentRequestText, /saved_memories/)
  assert.match(currentRequestText, /chat_history_sources/)
  assert.match(currentRequestText, /不要铺垫/)
  assert.match(currentRequestText, /周四/)
  const trajectory = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/__chat__/threads/${currentSessionId}/dsh-trajectory`,
    headers: {}, body: null,
  })
  const memoryEvent = (trajectory?.data?.events || [])
    .find((entry) => entry?.event?.data?.source?.plugin === 'dsh-work-memory')
  assert.equal(memoryEvent?.event?.data?.source?.dshWorkMemory?.type, 'global_memory')

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${currentSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${currentSessionId}"]`)
  try {
    await ui.waitUntil(`async () => document.body.innerText.includes('记忆回答：周四上线') && Boolean(document.querySelector('[data-global-memory]'))`, {
      timeout: 15_000,
      label: '真实桌面展示记忆回答和来源卡片',
    })
  } catch (error) {
    const history = await apiJson(session, {
      method: 'GET',
      url: `/api/projects/__chat__/sessions/${currentSessionId}/messages`,
      headers: {},
      body: null,
    }).catch(() => null)
    const uiState = await session.evalJs(`return {
      text: document.body.innerText.slice(0, 6000),
      globalMemoryCount: document.querySelectorAll('[data-global-memory]').length,
      selected: [...document.querySelectorAll('[data-agent-conv-id]')].map((row) => ({
        id: row.getAttribute('data-agent-conv-id'),
        active: row.getAttribute('data-active'),
        text: row.textContent?.trim(),
      })),
    }`).catch(() => null)
    console.error('[global-chat-memory-ui-smoke] timeline diagnostics', JSON.stringify({
      currentSessionId,
      currentTurn: currentTurn.blocks,
      history,
      uiState,
      requestCount: requests.length,
    }))
    throw error
  }
  await ui.click('[data-global-memory] summary')
  await ui.waitUntil(`async () => Boolean(document.querySelector('[data-global-memory-entry]')) && Boolean(document.querySelector('[data-global-memory-conversation]'))`, {
    timeout: 5_000,
    label: '来源卡片同时展示保存记忆和来源对话',
  })
  await ui.click('[data-global-memory-conversation]')
  await ui.waitUntil(`async () => document.body.innerText.includes('来源回答：周四上线')`, {
    timeout: 10_000,
    label: '来源卡片可打开原聊天',
  })

  const temporarySessionId = await createChatSession(session, '临时记忆隔离', true)
  const temporaryTurn = await driver.raw.streamBlocks(
    `/api/agent/projects/__chat__/threads/${temporarySessionId}/turns`,
    {
      input: [{ type: 'text', text: currentQuestion }],
      model: modelRoute,
      approvalMode: 'ask',
      clientCapabilities,
    },
  )
  assert.equal(requests.length >= 3, true)
  const temporaryRequest = [...requests].reverse()
    .find((request) => JSON.stringify(request).includes(currentQuestion)
      && !JSON.stringify(request).includes('saved_memories'))
  assert.ok(temporaryRequest, '临时对话模型请求必须存在')
  const temporaryRequestText = JSON.stringify(temporaryRequest)
  assert.doesNotMatch(temporaryRequestText, /saved_memories|chat_history_sources|不要铺垫/)
  assert.equal(temporaryTurn.blocks.some((block) => block.type === 'global_memory'), false)

  await session.close()
  session = null
  session = await openSession({ port: 9364 })
  driver = makeDriver(session)
  ui = makeUiDriver(session)
  await driver.login()
  const restartedState = await apiJson(session, { method: 'GET', url: '/api/agent/chat-memory', headers: {}, body: null })
  assert.equal(restartedState.data.settings.saved_memory_enabled, true)
  assert.equal(restartedState.data.settings.chat_history_enabled, true)
  assert.equal(restartedState.data.entries.some((entry) => entry.content === editedMemory), true)
  assert.equal(restartedState.data.entries.some((entry) => entry.content === scratchMemory), false)

  console.log('[global-chat-memory-ui-smoke] PASS 设置 CRUD + 来源排除/恢复 + 真实 Turn 注入 + 来源卡片 + 临时隔离 + 重启持久化')
} finally {
  if (session && providerSaved) {
    await apiJson(session, {
      method: 'POST',
      url: '/api/dsh/models/settings/mutate',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ns: 'llm-pi-ai',
        ops: [{ op: 'unset', path: ['providers', providerId] }],
      }),
    }).catch(() => null)
  }
  if (session) await apiJson(session, {
    method: 'DELETE',
    url: `/api/dsh/models/credentials/${encodeURIComponent(credentialRef)}`,
    headers: {}, body: null,
  }).catch(() => null)
  try { await session?.close() } catch { /* ignore */ }
  try { await fakeModel?.close() } catch { /* ignore */ }
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
