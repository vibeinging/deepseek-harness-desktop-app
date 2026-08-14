import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'
import { encodeDshModelRoute } from '../server/src/engine/dsh_runtime/model_route.js'

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'message-actions-ui-smoke-'))
const projectName = `消息操作验收 ${Date.now()}`
const conversationTitle = `原对话 ${Date.now()}`
const originalQuestion = `原问题-${Date.now()}`
const editedQuestion = `编辑后的问题-${Date.now()}`
const requests = []

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
    const answer = `分支回答-${requests.length}`
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl_message_actions_${requests.length}`,
      model: 'message-actions-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }],
    })}\n\n`)
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl_message_actions_${requests.length}`,
      model: 'message-actions-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
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

function messageText(row) {
  const items = typeof row?.content_items === 'string' ? JSON.parse(row.content_items) : row?.content_items
  return (Array.isArray(items) ? items : [])
    .filter((item) => ['text', 'inputText', 'markdown', 'agentMessage'].includes(item?.type))
    .map((item) => String(item.content ?? item.text ?? ''))
    .join('\n')
}

let session = null
let fakeModel = null
let projectId = ''
const providerId = 'message-actions-eval'
const modelId = 'message-actions-model'
const credentialRef = 'MESSAGE_ACTIONS_EVAL_API_KEY'
let providerSaved = false
try {
  fakeModel = await startFakeModel()
  session = await openSession({ port: 9361 })
  session.onEvent('Runtime.consoleAPICalled', (event) => {
    const values = (event?.args || []).map((arg) => arg.value ?? arg.description).filter(Boolean)
    if (values.some((value) => String(value).includes('message-action-debug'))) {
      console.error('[renderer-console]', ...values)
    }
  })
  const ui = makeUiDriver(session)
  const driver = makeDriver(session)
  await driver.login()
  await session.evalJs(`
    localStorage.setItem('dsh:onboarding:completed:v1', 'true');
    return true;
  `)

  projectId = await driver.ensureProjectRecord(projectName)
  const snapshot = await driver.raw.api('GET', '/api/dsh/models')
  const namespace = snapshot.json?.data?.namespaces?.find((item) => item.ns === 'llm-pi-ai')
  assert.equal(typeof namespace?.revision, 'number', JSON.stringify(snapshot.json))
  const credential = await driver.raw.api('POST', '/api/dsh/models/credentials', {
    ref: credentialRef,
    value: 'message-actions-key',
  })
  assert.equal(credential.status, 200, JSON.stringify(credential.json))
  const configured = await driver.raw.api('POST', '/api/dsh/models/settings/mutate', {
    ns: 'llm-pi-ai',
    expected_revision: namespace.revision,
    ops: [{
      op: 'set',
      path: ['providers', providerId],
      value: {
        displayName: '消息操作假模型',
        apiKeyEnv: credentialRef,
        api: 'openai-completions',
        baseURL: fakeModel.baseUrl,
        models: [{ id: modelId, name: '消息操作假模型' }],
      },
    }],
  })
  assert.equal(configured.status, 200, JSON.stringify(configured.json))
  providerSaved = true

  const original = await driver.askAgent(projectId, originalQuestion, {
    title: conversationTitle,
    model: encodeDshModelRoute(providerId, modelId),
  })
  assert.equal(original.sid.length > 0, true)
  assert.equal(requests.length, 1)
  const originalHistory = await driver.raw.api('GET', `/api/projects/${projectId}/sessions/${original.sid}/messages`)
  assert.equal(originalHistory.status, 200, JSON.stringify(originalHistory.json))
  assert.equal((originalHistory.json?.data?.messages || []).length > 0, true, JSON.stringify(originalHistory.json))
  const listedSessions = await driver.raw.api('GET', `/api/agent/projects/${projectId}/sessions`)
  assert.equal(
    (listedSessions.json?.data?.items || []).some((item) => item.id === original.sid),
    true,
    JSON.stringify(listedSessions.json),
  )

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitUntil(`async () => Boolean(document.querySelector('[data-testid="agent-message-input"]'))`, {
    timeout: 30_000,
    label: 'DSH 输入框可用',
  })
  await ui.waitFor(`[data-agent-workspace-id="${projectId}"]`, { timeout: 15_000 })
  if (!(await ui.exists(`[data-agent-conv-id="${original.sid}"]`))) {
    await ui.click(`[data-agent-workspace-id="${projectId}"]`)
  }
  await ui.waitFor(`[data-agent-conv-id="${original.sid}"]`, { timeout: 15_000 })
  await ui.click(`[data-agent-conv-id="${original.sid}"]`)
  await ui.waitUntil(`async () => document.body.innerText.includes('分支回答-1')`, {
    timeout: 15_000,
    label: '原回答恢复完成',
  })
  const originalActionState = await session.evalJs(`
    return Object.fromEntries(['copy-assistant', 'edit-user', 'retry-assistant', 'branch-assistant'].map((name) => {
      const element = document.querySelector('[data-message-action="' + name + '"]');
      return [name, { exists: Boolean(element), disabled: element?.disabled ?? null, title: element?.getAttribute('title') || '' }];
    }));
  `)
  assert.deepEqual(
    Object.fromEntries(Object.entries(originalActionState).map(([name, value]) => [name, value.exists && !value.disabled])),
    { 'copy-assistant': true, 'edit-user': true, 'retry-assistant': true, 'branch-assistant': true },
    JSON.stringify(originalActionState),
  )

  await ui.click('[data-message-action="copy-assistant"]')
  const copyState = await ui.waitUntil(`async () => {
    const clipboardText = await window.electronAPI.evalReadClipboardText();
    const bodyText = document.body.innerText;
    if (clipboardText !== '分支回答-1') return false;
    return { clipboardText, notified: bodyText.includes('已复制') };
  }`, { timeout: 5_000, label: '助手回答写入真实系统剪贴板' })
  assert.equal(copyState.clipboardText, '分支回答-1')
  assert.equal(copyState.notified, true, '复制成功后必须给出可见提示')

  await ui.click('[data-message-action="edit-user"]')
  await ui.waitFor('[data-message-edit-panel] textarea', { timeout: 5_000 })
  await ui.fill('[data-message-edit-panel] textarea', editedQuestion)
  await ui.click('[data-message-edit-submit]')
  try {
    await ui.waitUntil(`async () => {
      const text = document.body.innerText;
      return text.includes(${JSON.stringify(editedQuestion)})
        && text.includes('分支回答-2')
        && Boolean(document.querySelector('[data-message-action="retry-assistant"]:not(:disabled)'));
    }`, { timeout: 45_000, label: '编辑消息在新分支完成回答' })
  } catch (error) {
    const currentSessions = await apiJson(session, {
      method: 'GET',
      url: `/api/agent/projects/${encodeURIComponent(projectId)}/sessions`,
      headers: {}, body: null,
    }).catch(() => null)
    const histories = []
    for (const item of currentSessions?.data?.items || []) {
      const history = await apiJson(session, {
        method: 'GET',
        url: `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(item.id)}/messages`,
        headers: {}, body: null,
      }).catch(() => null)
      histories.push({
        id: item.id,
        title: item.title,
        messages: (history?.data?.messages || []).map((message) => ({ role: message.role, text: messageText(message) })),
      })
    }
    const uiState = await session.evalJs(`return {
      text: document.body.innerText.slice(0, 4000),
      selected: document.querySelector('[data-agent-conv-id][data-active="true"]')?.getAttribute('data-agent-conv-id') || null,
    }`).catch(() => null)
    console.error('[message-actions-ui-smoke] edit timeout diagnostics', JSON.stringify({
      requestCount: requests.length,
      histories,
      uiState,
    }))
    throw error
  }
  assert.equal(requests.length, 2)

  let sessions = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/${encodeURIComponent(projectId)}/sessions`,
    headers: {}, body: null,
  })
  const editSession = sessions?.data?.items?.find((item) => item.id !== original.sid && item.title.includes('编辑'))
  assert.equal(typeof editSession?.id, 'string', JSON.stringify(sessions))
  const originalMessages = await apiJson(session, {
    method: 'GET',
    url: `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(original.sid)}/messages`,
    headers: {}, body: null,
  })
  assert.deepEqual(
    originalMessages.data.messages.map(messageText),
    [originalQuestion, '分支回答-1'],
    '编辑必须保留原对话不变',
  )

  await ui.click('[data-message-action="retry-assistant"]')
  await ui.waitUntil(`async () => {
    const text = document.body.innerText;
    return text.includes('分支回答-3')
      && Boolean(document.querySelector('[data-message-action="branch-assistant"]:not(:disabled)'));
  }`, { timeout: 45_000, label: '重试在第二个新分支完成回答' })
  assert.equal(requests.length, 3)

  sessions = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/${encodeURIComponent(projectId)}/sessions`,
    headers: {}, body: null,
  })
  const retrySession = sessions?.data?.items?.find((item) => item.id !== editSession.id && item.title.includes('重试'))
  assert.equal(typeof retrySession?.id, 'string', JSON.stringify(sessions))

  await ui.click('[data-message-action="branch-assistant"]')
  await ui.waitUntil(`async () => {
    const rows = [...document.querySelectorAll('[data-agent-conv-id]')];
    return rows.some((row) => row.getAttribute('title')?.includes('分支'))
      && document.body.innerText.includes('分支回答-3');
  }`, { timeout: 20_000, label: '完整回答分支已出现在侧栏' })
  assert.equal(requests.length, 3, '单纯创建分支不能自动再调用模型')

  sessions = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/${encodeURIComponent(projectId)}/sessions`,
    headers: {}, body: null,
  })
  assert.equal(sessions.data.items.length, 4, JSON.stringify(sessions))
  const branchSession = sessions.data.items.find((item) => item.id !== retrySession.id && item.title.includes('分支'))
  assert.equal(typeof branchSession?.id, 'string')
  for (const item of [editSession, retrySession, branchSession]) {
    const detail = await apiJson(session, {
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(item.id)}`,
      headers: {}, body: null,
    })
    const config = typeof detail.data.session_config === 'string'
      ? JSON.parse(detail.data.session_config)
      : detail.data.session_config
    assert.equal(typeof config.dsh_runtime_session_id, 'string')
  }

  console.log('[message-actions-ui-smoke] PASS 复制 + 编辑分支 + 重试分支 + 完整回答分支 + 原对话不变')
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
