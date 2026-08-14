import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'
import { encodeDshModelRoute } from '../server/src/engine/dsh_runtime/model_route.js'

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'plan-status-ui-smoke-'))
const stamp = Date.now()
const providerId = 'plan-status-eval'
const modelId = 'plan-status-model'
const credentialRef = 'PLAN_STATUS_EVAL_API_KEY'
const requests = []

process.env.DSH_EVAL_ISOLATED = '1'
process.env.DSH_EVAL_HOME = evalHome
process.env.DSH_USER_DATA_DIR = path.join(evalHome, 'electron-user-data')

function chatChunk(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function toolName(body, suffix) {
  return (body.tools || [])
    .map((tool) => String(tool?.function?.name || ''))
    .find((name) => name === suffix || name.endsWith(`__${suffix}`)) || ''
}

function streamToolCall(response, name) {
  chatChunk(response, {
    id: 'chatcmpl_plan_status_tool',
    model: modelId,
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id: 'call_plan_status',
          type: 'function',
          function: {
            name,
            arguments: JSON.stringify({
              todos: [
                { content: '检查数据结构', status: 'completed' },
                { content: '查询目标记录', status: 'in_progress' },
                { content: '核对结果', status: 'pending' },
              ],
            }),
          },
        }],
      },
      finish_reason: null,
    }],
  })
  chatChunk(response, {
    id: 'chatcmpl_plan_status_tool',
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  })
  response.end('data: [DONE]\n\n')
}

function streamAnswer(response) {
  chatChunk(response, {
    id: 'chatcmpl_plan_status_answer',
    model: modelId,
    choices: [{ index: 0, delta: { role: 'assistant', content: '当前检查尚未完成。' }, finish_reason: null }],
  })
  chatChunk(response, {
    id: 'chatcmpl_plan_status_answer',
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
  })
  response.end('data: [DONE]\n\n')
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
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const toolMessages = (body.messages || []).filter((message) => message?.role === 'tool')
    if (!toolMessages.length) {
      const name = toolName(body, 'todo_write')
      assert.ok(name, `todo_write is unavailable: ${JSON.stringify(body.tools || [])}`)
      streamToolCall(response, name)
      return
    }
    streamAnswer(response)
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

let session = null
let fakeModel = null
let providerSaved = false
try {
  fakeModel = await startFakeModel()
  session = await openSession({ port: 9361 })
  const ui = makeUiDriver(session)
  const driver = makeDriver(session)
  await driver.login()
  await session.evalJs(`localStorage.setItem('dsh:onboarding:completed:v1', 'true'); return true;`)

  const projectId = await driver.ensureProjectRecord(`计划浮窗测试 ${stamp}`)
  const snapshot = await driver.raw.api('GET', '/api/dsh/models')
  const namespace = snapshot.json?.data?.namespaces?.find((item) => item.ns === 'llm-pi-ai')
  assert.equal(typeof namespace?.revision, 'number', JSON.stringify(snapshot.json))
  const credential = await driver.raw.api('POST', '/api/dsh/models/credentials', {
    ref: credentialRef,
    value: 'plan-status-key',
  })
  assert.equal(credential.status, 200, JSON.stringify(credential.json))
  const configured = await driver.raw.api('POST', '/api/dsh/models/settings/mutate', {
    ns: 'llm-pi-ai',
    expected_revision: namespace.revision,
    ops: [{
      op: 'set',
      path: ['providers', providerId],
      value: {
        displayName: '计划浮窗假模型',
        apiKeyEnv: credentialRef,
        api: 'openai-completions',
        baseURL: fakeModel.baseUrl,
        models: [{ id: modelId, name: '计划浮窗假模型' }],
      },
    }],
  })
  assert.equal(configured.status, 200, JSON.stringify(configured.json))
  providerSaved = true

  const turn = await driver.askAgent(projectId, '检查计划应该显示在哪里', {
    title: `计划位置检查 ${stamp}`,
    model: encodeDshModelRoute(providerId, modelId),
  })
  assert.equal(requests.length, 2)
  await driver.raw.activateProject(projectId)
  await ui.waitFor(`[data-agent-conv-id="${turn.sid}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${turn.sid}"]`)
  await ui.waitFor('[data-plan-float]', { timeout: 20_000 })

  await ui.click('[data-agent-process-toggle]')
  const placement = await session.evalJs(`
    const assistant = document.querySelector('[data-message-role="assistant"]');
    const planFloat = document.querySelector('[data-plan-float]');
    return {
      floatingSteps: planFloat?.querySelectorAll('li').length || 0,
      inlinePlanLists: assistant?.querySelectorAll('[data-plan-progress], [data-plan-float]').length || 0,
      processText: assistant?.querySelector('[data-agent-process]')?.textContent || '',
      floatText: planFloat?.textContent || ''
    };
  `)
  assert.equal(placement.floatingSteps, 3, JSON.stringify(placement))
  assert.equal(placement.inlinePlanLists, 0, JSON.stringify(placement))
  assert.match(placement.processText, /1\/3 已完成/)
  assert.match(placement.floatText, /查询目标记录/)

  await ui.click('[data-plan-float] button[aria-label="最小化计划浮窗"]')
  assert.equal(
    await session.evalJs(`return document.querySelector('[data-plan-float]')?.getAttribute('data-minimized')`),
    'true'
  )

  console.log('[plan-status-ui-smoke] PASS DSH todo_write 轨迹恢复计划，独立浮窗展示，消息区保留紧凑摘要')
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
