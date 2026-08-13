import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

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
    const rows = [...document.querySelectorAll('[title]')];
    const row = rows.find((item) => item.getAttribute('title') === name && item.querySelector('[aria-label^="查看项目"]'));
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
  await ui.clickText('项目设置', { selector: 'button', exact: true, timeout: 10_000 })
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

async function draftState(session, projectId, conversationId) {
  return session.evalJs(`
    const { conversationDraftStorageKey } = await import('/src/views/agent/conversationDraft.ts');
    const source = localStorage.getItem(conversationDraftStorageKey(${JSON.stringify(projectId)}, ${JSON.stringify(conversationId)}));
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
let globalModelId = ''
let projectModelId = ''
let sourceSessionId = ''
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
  const globalModel = await driver.raw.api('POST', '/api/llm_model/create', {
    model_name: 'chat-context-model',
    display_name: '上下文全局假模型',
    category: 'PRIMARY',
    api_base: fakeModel.baseUrl,
    api_key: 'context-global-key',
    api_format: 'chat_completions',
    supports_streaming: true,
  })
  assert.equal(globalModel.status, 200, JSON.stringify(globalModel.json))
  globalModelId = globalModel.json?.data?.id || ''
  const projectModel = await driver.raw.api('POST', `/api/projects/${projectId}/models`, {
    model_name: 'chat-context-model',
    display_name: '上下文项目假模型',
    category: 'PRIMARY',
    api_base: fakeModel.baseUrl,
    api_key: 'context-project-key',
    api_format: 'chat_completions',
    supports_streaming: true,
  })
  assert.equal(projectModel.status, 200, JSON.stringify(projectModel.json))
  projectModelId = projectModel.json?.data?.id || ''

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

  const source = await driver.askAgent('__chat__', sourceQuestion, { title: conversationTitle })
  sourceSessionId = source.sid
  assert.equal(requests.length, 1)
  const sourcePayload = requestText(requests[0])
  assert.match(sourcePayload, new RegExp(globalInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(sourcePayload, new RegExp(projectInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const sourceDetail = await driver.raw.api('GET', `/api/projects/__chat__/sessions/${sourceSessionId}`)
  const sourceConfig = typeof sourceDetail.json?.data?.session_config === 'string'
    ? JSON.parse(sourceDetail.json.data.session_config)
    : sourceDetail.json?.data?.session_config || {}
  const sourceThreadId = sourceConfig.agent_runtime_thread_id
  assert.equal(typeof sourceThreadId, 'string')

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${sourceSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${sourceSessionId}"]`)
  await session.evalJs(`await new Promise((resolve) => setTimeout(resolve, 300)); return true;`)
  await fillComposer(session, ui, movedDraft)
  await ui.click('[data-search-mode="auto"]')
  await ui.waitFor('[data-search-mode="required"]', { timeout: 5_000 })
  await ui.waitUntil(`async () => {
    const { conversationDraftStorageKey } = await import('/src/views/agent/conversationDraft.ts');
    const raw = localStorage.getItem(conversationDraftStorageKey('__chat__', ${JSON.stringify(sourceSessionId)}));
    return raw && JSON.parse(raw).input === ${JSON.stringify(movedDraft)};
  }`, { timeout: 5_000, label: '移动前草稿已保存' })

  await openConversationMenu(session, sourceSessionId)
  await ui.clickText('移到项目…', { selector: 'button', exact: true, timeout: 10_000 })
  await ui.waitFor('[data-conversation-move]', { timeout: 10_000 })
  await ui.click(`[data-target-project-id="${projectId}"]`)
  await ui.click('[data-testid="conversation-move-submit"]')
  await ui.waitUntil(`async () => {
    const row = document.querySelector('[data-agent-conv-id="${sourceSessionId}"]');
    const input = document.querySelector('[data-testid="agent-message-input"]');
    return row?.getAttribute('data-agent-ws-id') === ${JSON.stringify(projectId)}
      && input?.value === ${JSON.stringify(movedDraft)}
      && Boolean(document.querySelector('[data-search-mode="required"]'));
  }`, { timeout: 15_000, label: '移动后对话与草稿切换到目标项目' })
  assert.equal(await draftState(session, '__chat__', sourceSessionId), null)
  assert.equal((await draftState(session, projectId, sourceSessionId))?.input, movedDraft)

  await session.evalJs(`document.querySelector('[data-search-mode="required"]')?.click(); return true;`)
  await ui.waitFor('[data-search-mode="off"]', { timeout: 5_000 })
  await session.evalJs(`document.querySelector('[data-search-mode="off"]')?.click(); return true;`)
  await ui.waitFor('[data-search-mode="auto"]', { timeout: 5_000 })
  await fillComposer(session, ui, continueQuestion)
  await submitComposer(session, ui)
  try {
    await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(`移动后仍记得木星-${stamp}`)})`, {
      timeout: 45_000,
      label: '移动后的 UI 连续回答',
    })
  } catch (error) {
    const detail = await driver.raw.api('GET', `/api/projects/${projectId}/sessions/${sourceSessionId}`).catch(() => null)
    const messages = await driver.raw.api('GET', `/api/projects/${projectId}/sessions/${sourceSessionId}/messages`).catch(() => null)
    const page = await session.evalJs(`return {
      text: document.body.innerText.slice(0, 5000),
      input: document.querySelector('[data-testid="agent-message-input"]')?.value || '',
      running: Boolean(document.querySelector('[data-running="true"]')),
      sessionId: document.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id') || null,
    }`).catch(() => null)
    console.error('[chat-context-ui-smoke] moved turn diagnostics', JSON.stringify({
      requestCount: requests.length,
      requestModels: requests.map((request) => request.model),
      detail: detail?.json,
      messages: messages?.json,
      page,
    }))
    throw error
  }
  assert.equal(requests.length, 2)
  const movedPayload = requestText(requests[1])
  if (!movedPayload.includes(projectInstructions)) {
    const runtimeStatus = await driver.raw.api('GET', '/api/agents/runtime').catch(() => null)
    console.error('[chat-context-ui-smoke] missing target instructions', JSON.stringify({
      runtimeStatus: runtimeStatus?.json,
      systems: (requests[1]?.messages || [])
        .filter((message) => message?.role === 'system')
        .map((message) => ({
          length: String(message.content || '').length,
          hasGlobal: String(message.content || '').includes(globalInstructions),
          hasProject: String(message.content || '').includes(projectInstructions),
          tail: String(message.content || '').slice(-1600),
        })),
    }))
  }
  assert.match(movedPayload, new RegExp(sourceQuestion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(movedPayload, new RegExp(continueQuestion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(movedPayload, new RegExp(globalInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(movedPayload, new RegExp(projectInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const movedDetail = await driver.raw.api('GET', `/api/projects/${projectId}/sessions/${sourceSessionId}`)
  const movedConfig = typeof movedDetail.json?.data?.session_config === 'string'
    ? JSON.parse(movedDetail.json.data.session_config)
    : movedDetail.json?.data?.session_config || {}
  assert.equal(typeof movedConfig.agent_runtime_thread_id, 'string')
  assert.notEqual(movedConfig.agent_runtime_thread_id, sourceThreadId)
  assert.equal(movedConfig.agent_runtime_native_move, undefined)

  await ui.click('[data-agent-nav="temporary-chat"]')
  await ui.waitFor('[data-temporary="true"]', { timeout: 10_000 })
  await fillComposer(session, ui, temporaryQuestion)
  await submitComposer(session, ui)
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(`临时回答-${stamp}`)})`, {
    timeout: 45_000,
    label: '临时对话完成回答',
  })
  const temporarySessionId = await session.evalJs(`return document.querySelector('[data-temporary="true"]')?.getAttribute('data-agent-session-id') || ''`)
  assert.equal(typeof temporarySessionId, 'string')
  assert.equal(temporarySessionId.length > 0, true)
  const temporaryPayload = requestText(requests[2])
  assert.match(temporaryPayload, new RegExp(globalInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.doesNotMatch(temporaryPayload, new RegExp(projectInstructions.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(temporaryPayload, /当前是临时对话/)
  const chatList = await driver.raw.api('GET', '/api/agent/projects/__chat__/sessions')
  assert.equal((chatList.json?.data?.items || []).some((item) => item.id === temporarySessionId), false)
  await ui.clickText('退出临时对话', { selector: 'button', exact: true })
  await ui.waitUntil(`async () => !document.querySelector('[data-temporary="true"]')`, {
    timeout: 10_000,
    label: '退出临时对话',
  })
  const removedTemporary = await waitForApiStatus(driver, {
    method: 'GET',
    url: `/api/projects/__chat__/sessions/${temporarySessionId}`,
  }, 404)
  assert.equal(removedTemporary.status, 404)

  await ui.waitFor(`[data-agent-conv-id="${sourceSessionId}"]`, { timeout: 10_000 })
  await ui.click(`[data-agent-conv-id="${sourceSessionId}"]`)
  await session.evalJs(`await new Promise((resolve) => setTimeout(resolve, 300)); return true;`)
  await fillComposer(session, ui, restartDraft)
  await session.evalJs(`document.querySelector('[data-search-mode="auto"]')?.click(); return true;`)
  await ui.waitFor('[data-search-mode="required"]', { timeout: 5_000 })
  await session.evalJs(`document.querySelector('[data-search-mode="required"]')?.click(); return true;`)
  await ui.waitFor('[data-search-mode="off"]', { timeout: 5_000 })
  await ui.waitUntil(`async () => {
    const { conversationDraftStorageKey } = await import('/src/views/agent/conversationDraft.ts');
    const raw = localStorage.getItem(conversationDraftStorageKey(${JSON.stringify(projectId)}, ${JSON.stringify(sourceSessionId)}));
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
  assert.equal(requests.length, 4)
  assert.match(requestText(requests[3]), new RegExp(restartDraft.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${sourceSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${sourceSessionId}"]`)
  assert.equal(await session.evalJs(`return document.querySelector('[data-testid="agent-message-input"]')?.value || ''`), '')

  console.log('[chat-context-ui-smoke] PASS 全局/项目指令 + 原生移动 + 草稿迁移/重启 + 临时对话清理')
} finally {
  if (session && projectModelId && projectId) {
    await apiJson(session, {
      method: 'DELETE',
      url: `/api/projects/${projectId}/models/${projectModelId}`,
      headers: {}, body: null,
    }).catch(() => null)
  }
  if (session && globalModelId) {
    await apiJson(session, {
      method: 'POST',
      url: '/api/llm_model/delete',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: globalModelId }),
    }).catch(() => null)
  }
  try { await session?.close() } catch { /* ignore */ }
  try { await fakeModel?.close() } catch { /* ignore */ }
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
