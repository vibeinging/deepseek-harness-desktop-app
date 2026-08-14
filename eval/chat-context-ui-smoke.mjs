import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'
import { encodeDshModelRoute } from '../server/src/engine/dsh_runtime/model_route.js'

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'chat-context-ui-smoke-'))
const stamp = Date.now()
const projectName = `上下文项目 ${stamp}`
const conversationTitle = `待移动对话 ${stamp}`
const globalInstructions = `全局规则-${stamp}：回答必须先写“全局已生效”。`
const projectInstructions = `项目规则-${stamp}：回答必须保留项目上下文。`
const sourceQuestion = `移动前口令-${stamp}：木星。请先记住。`
const continueQuestion = `移动后继续-${stamp}：请说出刚才的口令。`
const temporaryQuestion = `临时验收-${stamp}`
const movedDraft = `移动中的未发送草稿-${stamp}`
const restartDraft = `重启后继续的草稿-${stamp}`
const requests = []
const providerId = 'chat-context-eval'
const modelId = 'chat-context-model'
const credentialRef = 'CHAT_CONTEXT_EVAL_API_KEY'
const modelRoute = encodeDshModelRoute(providerId, modelId)

process.env.DSH_EVAL_ISOLATED = '1'
process.env.DSH_EVAL_VERBOSE = '1'
process.env.DSH_EVAL_HOME = evalHome
process.env.DSH_USER_DATA_DIR = path.join(evalHome, 'electron-user-data')

function requestText(body) {
  return JSON.stringify(body?.messages || [])
}

async function startFakeModel() {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    requests.push(body)
    const text = requestText(body)
    const answer = text.includes(temporaryQuestion)
      ? `临时回答-${stamp}`
      : text.includes(restartDraft)
        ? `草稿回答-${stamp}`
        : text.includes(continueQuestion)
          ? `移动后仍记得木星-${stamp}`
          : `已经记住木星-${stamp}`
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl_context_${requests.length}`,
      model: 'chat-context-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: answer }, finish_reason: null }],
    })}\n\n`)
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl_context_${requests.length}`,
      model: 'chat-context-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 },
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
    return { status: response.status, json: response.json };
  `, { timeoutMs: 20_000 })
}

async function waitForApiStatus(driver, request, expectedStatus, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let response = null
  while (Date.now() < deadline) {
    response = await driver.raw.api(request.method || 'GET', request.url, request.body)
    if (response.status === expectedStatus) return response
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.equal(response?.status, expectedStatus)
  return response
}

async function openProjectSettings(session, ui, name) {
  await session.evalJs(`
    const name = ${JSON.stringify(name)};
    const row = [...document.querySelectorAll('[data-agent-workspace-id]')]
      .find((candidate) => candidate.getAttribute('title') === name);
    if (!row) throw new Error('找不到项目行: ' + name);
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + Math.min(80, rect.width / 2),
      clientY: rect.top + rect.height / 2,
    }));
    return true;
  `)
  await ui.click(`[role="menuitem"][aria-label="打开${name}的项目设置"]`, { timeout: 10_000 })
  await ui.waitForText('基本信息', { selector: 'button', exact: true, timeout: 15_000 })
}

async function openConversationMenu(session, conversationId) {
  await session.evalJs(`
    const row = document.querySelector('[data-agent-conv-id="${conversationId}"]');
    if (!row) throw new Error('找不到对话行');
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + Math.min(80, rect.width / 2),
      clientY: rect.top + rect.height / 2,
    }));
    return true;
  `)
}

function draftStorageKey(projectId, conversationId) {
  const scope = `${String(projectId || '__chat__')}:${String(conversationId || '__new__')}`
  return `dsh-conversation-draft:v1:${encodeURIComponent(scope)}`
}

async function draftState(session, projectId, conversationId) {
  return session.evalJs(`
    const source = localStorage.getItem(${JSON.stringify(draftStorageKey(projectId, conversationId))});
    return source ? JSON.parse(source) : null;
  `)
}

async function fillComposer(session, ui, value) {
  await ui.fill('[data-testid="agent-message-input"]', value)
  const current = await session.evalJs(`return document.querySelector('[data-testid="agent-message-input"]')?.value || ''`)
  if (current !== value) {
    await session.evalJs(`
      const input = document.querySelector('[data-testid="agent-message-input"]');
      if (!input) throw new Error('找不到 DSH 输入框');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter.call(input, ${JSON.stringify(value)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return input.value;
    `)
  }
  await ui.waitUntil(`async () => document.querySelector('[data-testid="agent-message-input"]')?.value === ${JSON.stringify(value)}`, {
    timeout: 5_000,
    label: `输入框写入 ${value}`,
  })
}

async function submitComposer(session, ui) {
  await ui.waitFor('[data-testid="agent-send-button"]:not(:disabled)', { timeout: 5_000 })
  await session.evalJs(`
    const button = document.querySelector('[data-testid="agent-send-button"]');
    if (!button || button.disabled) throw new Error('发送按钮不可用');
    button.click();
    return true;
  `)
  await ui.waitUntil(`async () => document.querySelector('[data-testid="agent-message-input"]')?.value === ''`, {
    timeout: 5_000,
    label: '发送后输入框已清空',
  })
}

let session = null
let fakeModel = null
let projectId = ''
let providerSaved = false
let sourceSessionId = ''
let projectSessionId = ''
try {
  fakeModel = await startFakeModel()
  session = await openSession({ port: 9365 })
  let driver = makeDriver(session)
  let ui = makeUiDriver(session)
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
    value: 'context-key',
  })
  assert.equal(credential.status, 200, JSON.stringify(credential.json))
  const configured = await driver.raw.api('POST', '/api/dsh/models/settings/mutate', {
    ns: 'llm-pi-ai',
    expected_revision: namespace.revision,
    ops: [{
      op: 'set',
      path: ['providers', providerId],
      value: {
        displayName: '上下文假模型',
        apiKeyEnv: credentialRef,
        api: 'openai-completions',
        baseURL: fakeModel.baseUrl,
        models: [{ id: modelId, name: '上下文假模型' }],
      },
    }],
  })
  assert.equal(configured.status, 200, JSON.stringify(configured.json))
  providerSaved = true

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor('[title="设置"]', { timeout: 30_000 })
  await ui.click('[title="设置"]')
  await ui.clickText('全局指令', { selector: 'button', exact: true, timeout: 10_000 })
  await ui.waitFor('[data-app-instructions]', { timeout: 10_000 })
  await ui.waitFor('[data-testid="app-instructions-input"]:not(:disabled)', { timeout: 10_000 })
  await ui.fill('[data-testid="app-instructions-input"]', globalInstructions)
  await ui.waitFor('[data-testid="app-instructions-save"]:not(:disabled)', { timeout: 5_000 })
  await ui.click('[data-testid="app-instructions-save"]')
  await ui.waitUntil(`async () => {
    const response = await window.electronAPI.apiRequest({
      method: 'GET', url: '/api/agent/settings/instructions', headers: {}, body: null
    });
    return response.json?.data?.instructions === ${JSON.stringify(globalInstructions)};
  }`, {
    timeout: 10_000,
    label: '全局指令已写入本地数据库',
  })
  await ui.clickText('返回项目', { selector: 'button', exact: true })

  await ui.waitFor(`[aria-label="查看项目 ${projectName}"]`, { timeout: 15_000 })
  await openProjectSettings(session, ui, projectName)
  await ui.clickText('项目指令', { selector: 'button', exact: true, timeout: 10_000 })
  await ui.waitFor('[data-project-instructions]', { timeout: 10_000 })
  await ui.fillByTestId('project-instructions-input', projectInstructions)
  await ui.waitFor('[data-testid="project-instructions-save"]:not(:disabled)', { timeout: 5_000 })
  await ui.clickByTestId('project-instructions-save')
  await ui.waitUntil(`async () => {
    const response = await window.electronAPI.apiRequest({
      method: 'GET', url: '/api/projects/${projectId}', headers: {}, body: null
    });
    return response.json?.data?.instructions === ${JSON.stringify(projectInstructions)};
  }`, {
    timeout: 10_000,
    label: '项目指令已写入本地数据库',
  })
  await ui.clickText('返回项目', { selector: 'button', exact: true })

  const source = await driver.askAgent('__chat__', sourceQuestion, { title: conversationTitle, model: modelRoute })
  sourceSessionId = source.sid
  assert.equal(requests.length, 1)
  const sourcePayload = requestText(requests[0])
  assert.match(sourcePayload, new RegExp(globalInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(sourcePayload, new RegExp(projectInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const sourceDetail = await driver.raw.api('GET', `/api/projects/__chat__/sessions/${sourceSessionId}`)
  const sourceConfig = typeof sourceDetail.json?.data?.session_config === 'string'
    ? JSON.parse(sourceDetail.json.data.session_config)
    : sourceDetail.json?.data?.session_config || {}
  const sourceDshSessionId = sourceConfig.dsh_runtime_session_id
  assert.equal(typeof sourceDshSessionId, 'string')
  assert.equal(sourceConfig.runtime_backend, 'dsh')

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${sourceSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${sourceSessionId}"]`)
  await session.evalJs(`await new Promise((resolve) => setTimeout(resolve, 300)); return true;`)
  await fillComposer(session, ui, movedDraft)
  await ui.click('[data-search-mode="auto"]')
  await ui.waitFor('[data-search-mode="required"]', { timeout: 5_000 })
  await ui.waitUntil(`async () => {
    const raw = localStorage.getItem(${JSON.stringify(draftStorageKey('__chat__', sourceSessionId))});
    return raw && JSON.parse(raw).input === ${JSON.stringify(movedDraft)};
  }`, { timeout: 5_000, label: '普通聊天草稿已保存' })

  await openConversationMenu(session, sourceSessionId)
  const moveUnavailable = await session.evalJs(`
    const item = document.querySelector('[role="menuitem"][aria-label="移动对话（DSH 暂不支持）"]');
    return Boolean(item?.disabled);
  `)
  assert.equal(moveUnavailable, true)
  await ui.press('Escape')
  assert.equal((await draftState(session, '__chat__', sourceSessionId))?.input, movedDraft)

  const temporaryCreated = await driver.raw.api('POST', '/api/projects/__chat__/sessions', {
    title: `临时验收 ${stamp}`,
    source_type: 'agent',
    source_id: '__chat__',
    action_type: 'temporary_chat',
    temporary: true,
  })
  const temporarySessionId = temporaryCreated.json?.data?.id || temporaryCreated.json?.data?.session_id
  assert.equal(typeof temporarySessionId, 'string', JSON.stringify(temporaryCreated.json))
  await driver.raw.streamBlocks(
    `/api/agent/projects/__chat__/threads/${temporarySessionId}/turns`,
    {
      input: [{ type: 'text', text: temporaryQuestion }],
      model: modelRoute,
      approvalMode: 'ask',
    },
  )
  const temporaryPayload = requestText(requests[1])
  assert.match(temporaryPayload, new RegExp(globalInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(temporaryPayload, new RegExp(projectInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(temporaryPayload, /当前是临时对话/)
  const chatList = await driver.raw.api('GET', '/api/agent/projects/__chat__/sessions')
  assert.equal((chatList.json?.data?.items || []).some((item) => item.id === temporarySessionId), false)
  const removedTemporary = await driver.raw.api(
    'DELETE',
    `/api/projects/__chat__/sessions/${temporarySessionId}`,
  )
  assert.equal(removedTemporary.status, 200, JSON.stringify(removedTemporary.json))
  const missingTemporary = await waitForApiStatus(driver, {
    method: 'GET',
    url: `/api/projects/__chat__/sessions/${temporarySessionId}`,
  }, 404)
  assert.equal(missingTemporary.status, 404)

  const projectConversation = await driver.askAgent(projectId, continueQuestion, {
    title: `项目指令验收 ${stamp}`,
    model: modelRoute,
  })
  projectSessionId = projectConversation.sid
  assert.equal(requests.length >= 3, true)
  const projectRequest = [...requests].reverse().find((request) => {
    const text = requestText(request)
    return text.includes(continueQuestion) && text.includes(projectInstructions)
  })
  assert.ok(projectRequest, '项目对话必须收到项目指令')
  const projectPayload = requestText(projectRequest)
  assert.match(projectPayload, new RegExp(continueQuestion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(projectPayload, new RegExp(globalInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(projectPayload, new RegExp(projectInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const projectDetail = await driver.raw.api('GET', `/api/projects/${projectId}/sessions/${projectSessionId}`)
  const projectConfig = typeof projectDetail.json?.data?.session_config === 'string'
    ? JSON.parse(projectDetail.json.data.session_config)
    : projectDetail.json?.data?.session_config || {}
  assert.equal(typeof projectConfig.dsh_runtime_session_id, 'string')
  assert.notEqual(projectConfig.dsh_runtime_session_id, sourceDshSessionId)
  assert.equal(projectConfig.runtime_backend, 'dsh')
  for (const [pid, sid, expectedProject] of [
    ['__chat__', sourceSessionId, false],
    [projectId, projectSessionId, true],
  ]) {
    const trajectory = await driver.raw.api('GET', `/api/agent/projects/${pid}/threads/${sid}/dsh-trajectory`)
    const contextEvent = (trajectory.json?.data?.events || [])
      .find((entry) => entry?.event?.data?.source?.plugin === 'dsh-work-context')
    assert.equal(contextEvent?.event?.data?.source?.dshWorkInstructions?.application, true)
    assert.equal(contextEvent?.event?.data?.source?.dshWorkInstructions?.project, expectedProject)
  }

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })

  await ui.waitFor(`[data-agent-conv-id="${sourceSessionId}"]`, { timeout: 10_000 })
  await ui.click(`[data-agent-conv-id="${sourceSessionId}"]`)
  await session.evalJs(`await new Promise((resolve) => setTimeout(resolve, 300)); return true;`)
  await fillComposer(session, ui, restartDraft)
  await session.evalJs(`document.querySelector('[data-search-mode="auto"]')?.click(); return true;`)
  await ui.waitFor('[data-search-mode="required"]', { timeout: 5_000 })
  await session.evalJs(`document.querySelector('[data-search-mode="required"]')?.click(); return true;`)
  await ui.waitFor('[data-search-mode="off"]', { timeout: 5_000 })
  await ui.waitUntil(`async () => {
    const raw = localStorage.getItem(${JSON.stringify(draftStorageKey('__chat__', sourceSessionId))});
    return raw && JSON.parse(raw).input === ${JSON.stringify(restartDraft)} && JSON.parse(raw).searchMode === 'off';
  }`, { timeout: 5_000, label: '重启草稿已保存' })

  await session.close()
  session = null
  session = await openSession({ port: 9366 })
  driver = makeDriver(session)
  ui = makeUiDriver(session)
  await driver.login()
  await ui.waitFor(`[data-agent-conv-id="${sourceSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${sourceSessionId}"]`)
  await ui.waitUntil(`async () => {
    const input = document.querySelector('[data-testid="agent-message-input"]');
    return input?.value === ${JSON.stringify(restartDraft)} && Boolean(document.querySelector('[data-search-mode="off"]'));
  }`, { timeout: 10_000, label: '重启后恢复草稿与联网方式' })
  await ui.click('[title="设置"]')
  await ui.clickText('全局指令', { selector: 'button', exact: true, timeout: 10_000 })
  await ui.waitUntil(`async () => document.querySelector('[data-testid="app-instructions-input"]')?.value === ${JSON.stringify(globalInstructions)}`, {
    timeout: 10_000,
    label: '重启后恢复全局指令',
  })
  await ui.clickText('返回项目', { selector: 'button', exact: true })
  await ui.waitFor(`[data-agent-conv-id="${sourceSessionId}"]`, { timeout: 10_000 })
  await ui.click(`[data-agent-conv-id="${sourceSessionId}"]`)
  await submitComposer(session, ui)
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(`草稿回答-${stamp}`)})`, {
    timeout: 45_000,
    label: '恢复的草稿成功发送',
  })
  const restartRequest = [...requests].reverse()
    .find((request) => requestText(request).includes(restartDraft))
  assert.ok(restartRequest, '重启后发送的草稿必须进入 DSH 模型请求')
  assert.match(requestText(restartRequest), new RegExp(restartDraft.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${sourceSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${sourceSessionId}"]`)
  assert.equal(await session.evalJs(`return document.querySelector('[data-testid="agent-message-input"]')?.value || ''`), '')

  console.log('[chat-context-ui-smoke] PASS 全局/项目指令 DSH 轨迹 + DSH 移动限制 + 草稿重启 + 临时对话清理')
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
  if (session) {
    await apiJson(session, {
      method: 'DELETE',
      url: `/api/dsh/models/credentials/${encodeURIComponent(credentialRef)}`,
      headers: {}, body: null,
    }).catch(() => null)
  }
  try { await session?.close() } catch { /* ignore */ }
  try { await fakeModel?.close() } catch { /* ignore */ }
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
