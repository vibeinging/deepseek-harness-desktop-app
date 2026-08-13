import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'native-multi-agent-ui-smoke-'))
const stamp = Date.now()
const conversationTitle = `原生协作验收 ${stamp}`
const parentPrompt = `创建一个原生子任务并等待完成-${stamp}`
const childPrompt = `返回子任务完成口令 child-ui-${stamp}`
const childAnswer = `child-ui-done-${stamp}`
const parentAnswer = `parent-ui-done-${stamp}`

process.env.DSH_EVAL_ISOLATED = '1'
process.env.DSH_EVAL_HOME = evalHome
process.env.DSH_USER_DATA_DIR = path.join(evalHome, 'electron-user-data')

function chatChunk(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return String(content || '')
  return content.map((part) => part?.text || part?.content || '').join('')
}

function lastUserMessage(body) {
  return [...(body.messages || [])].reverse().find((message) => message?.role === 'user')
}

function toolName(body, suffix) {
  return (body.tools || [])
    .map((tool) => tool?.function?.name || '')
    .find((name) => name === suffix || name.endsWith(`__${suffix}`)) || ''
}

function sendToolCall(response, { id, name, arguments: args }) {
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'native-multi-agent-ui-model',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  })
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'native-multi-agent-ui-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  })
  response.end('data: [DONE]\n\n')
}

function sendText(response, id, text) {
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'native-multi-agent-ui-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  })
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'native-multi-agent-ui-model',
    choices: [{
      index: 0,
      delta: {},
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
  })
  response.end('data: [DONE]\n\n')
}

async function startFakeModel() {
  const requests = []
  const handlerErrors = []
  let childThreadId = ''
  const server = createServer(async (request, response) => {
    try {
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

      const lastUser = messageText(lastUserMessage(body)?.content)
      const serializedMessages = JSON.stringify(body.messages || [])
      if (lastUser.includes(childPrompt)) {
        sendText(response, 'child_ui_done', childAnswer)
        return
      }

      assert.ok(serializedMessages.includes(parentPrompt), `unexpected model request: ${serializedMessages}`)
      if (!serializedMessages.includes('call_spawn_ui_child')) {
        const spawnAgent = toolName(body, 'spawn_agent')
        assert.ok(spawnAgent, `spawn_agent is unavailable: ${JSON.stringify(body.tools || [])}`)
        sendToolCall(response, {
          id: 'call_spawn_ui_child',
          name: spawnAgent,
          arguments: { message: childPrompt, fork_context: true },
        })
        return
      }

      if (!serializedMessages.includes('call_wait_ui_child')) {
        const spawnOutput = (body.messages || []).find((message) => (
          message?.role === 'tool' && message?.tool_call_id === 'call_spawn_ui_child'
        ))
        const spawnContent = String(spawnOutput?.content || '')
        assert.doesNotMatch(spawnContent, /collab spawn failed/i, spawnContent)
        childThreadId = JSON.parse(spawnContent)?.agent_id || ''
        assert.ok(childThreadId, `spawn_agent did not return agent_id: ${spawnContent}`)
        const waitAgent = toolName(body, 'wait_agent')
        assert.ok(waitAgent, `wait_agent is unavailable: ${JSON.stringify(body.tools || [])}`)
        sendToolCall(response, {
          id: 'call_wait_ui_child',
          name: waitAgent,
          arguments: { targets: [childThreadId], timeout_ms: 10_000 },
        })
        return
      }

      const waitOutput = (body.messages || []).find((message) => (
        message?.role === 'tool' && message?.tool_call_id === 'call_wait_ui_child'
      ))
      assert.match(String(waitOutput?.content || ''), new RegExp(childAnswer))
      sendText(response, 'parent_ui_done', parentAnswer)
    } catch (error) {
      handlerErrors.push(error)
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' })
      response.end(error?.stack || error?.message || String(error))
    }
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    handlerErrors,
    childThreadId: () => childThreadId,
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

let session = null
let fakeModel = null
try {
  fakeModel = await startFakeModel()
  session = await openSession({ port: 9368 })
  const driver = makeDriver(session)
  const ui = makeUiDriver(session)
  await driver.login()
  await session.evalJs(`
    localStorage.setItem('dsh:onboarding:completed:v1', 'true')
    return true
  `)

  const model = await driver.raw.api('POST', '/api/llm_model/create', {
    model_name: 'native-multi-agent-ui-model',
    display_name: '原生协作桌面假模型',
    category: 'PRIMARY',
    api_base: fakeModel.baseUrl,
    api_key: 'native-multi-agent-ui-key',
    api_format: 'chat_completions',
    supports_streaming: true,
  })
  assert.equal(model.status, 200, JSON.stringify(model.json))

  const result = await driver.askAgent('__chat__', parentPrompt, {
    title: conversationTitle,
    timeoutMs: 30_000,
  })
  assert.deepEqual(fakeModel.handlerErrors, [])
  assert.equal(fakeModel.requests.length, 4)
  const childThreadId = fakeModel.childThreadId()
  assert.ok(childThreadId)
  assert.ok(result.blocks.some((block) => {
    if (block.type !== 'delegated_subtask') return false
    try {
      const payload = JSON.parse(block.content)
      return payload.source === 'app-server' && payload.child_thread_ids?.includes(childThreadId)
    } catch {
      return false
    }
  }), JSON.stringify(result.blocks))
  assert.ok(result.blocks.some((block) => String(block.content || '').includes(parentAnswer)))

  const runs = await driver.raw.api('GET', `/api/agents/projects/__chat__/runs?session_id=${encodeURIComponent(result.sid)}`)
  assert.equal(runs.status, 200, JSON.stringify(runs.json))
  const runId = runs.json?.data?.items?.[0]?.id || ''
  assert.ok(runId)
  const detail = await driver.raw.api('GET', `/api/agents/runs/${runId}`)
  assert.equal(detail.status, 200, JSON.stringify(detail.json))
  const subagent = (detail.json?.data?.subagents || []).find((item) => item.thread_id === childThreadId)
  assert.equal(subagent?.status, 'completed')
  assert.equal(subagent?.message, childAnswer)
  const childDetail = await driver.raw.api('GET', `/api/agents/runs/${runId}/subagents/${childThreadId}`)
  assert.equal(childDetail.status, 200, JSON.stringify(childDetail.json))
  assert.match(JSON.stringify(childDetail.json?.data?.thread || {}), new RegExp(childAnswer))

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${result.sid}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${result.sid}"]`)
  try {
    await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(parentAnswer)})`, {
      timeout: 15_000,
      label: '对话显示原生协作最终回答',
    })
    const processSelector = await session.evalJs(`
      const button = [...document.querySelectorAll('[data-message-role="assistant"] button')]
        .find((item) => item.textContent?.includes('已处理') && item.getAttribute('aria-expanded') === 'false')
      if (!button) return null
      button.setAttribute('data-native-collaboration-process', 'true')
      return '[data-native-collaboration-process="true"]'
    `)
    assert.equal(typeof processSelector, 'string')
    await ui.click(processSelector)
    await ui.waitFor('[data-native-collaboration="true"]', { timeout: 10_000 })
  } catch (error) {
    const messages = await driver.raw.api('GET', `/api/projects/__chat__/sessions/${result.sid}/messages`).catch(() => null)
    const page = await session.evalJs(`return {
      text: document.body.innerText.slice(0, 8000),
      collaboration: [...document.querySelectorAll('[data-native-collaboration]')].map((item) => item.outerHTML),
      sessionId: document.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id') || null,
    }`).catch(() => null)
    console.error('[native-multi-agent-ui-smoke] replay diagnostics', JSON.stringify({ messages: messages?.json, page }))
    throw error
  }

  await session.evalJs(`
    const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts')
    eventBus.emit(EVENT_TYPES.OPEN_AGENT_REVIEW, { view: 'runs', runId: ${JSON.stringify(runId)} })
    return true
  `)
  await ui.waitFor('[data-run-center]', { timeout: 15_000 })
  await ui.waitFor(`[data-run-id="${runId}"]`, { timeout: 15_000 })
  await ui.waitFor(`[data-subagent-thread-id="${childThreadId}"][data-subagent-status="completed"]`, { timeout: 15_000 })

  const inspectClicked = await session.evalJs(`
    const card = document.querySelector('[data-subagent-thread-id="${childThreadId}"]')
    const button = [...(card?.querySelectorAll('button') || [])].find((item) => item.textContent?.trim() === '查看')
    if (!button) return false
    button.click()
    return true
  `)
  assert.equal(inspectClicked, true)
  try {
    await ui.waitUntil(`async () => {
      const detail = document.querySelector('[data-native-subagent-detail]')
      return Boolean(detail && detail.textContent?.includes(${JSON.stringify(childAnswer)}))
    }`, { timeout: 10_000, label: '运行中心可回查子任务结果' })
  } catch (error) {
    const page = await session.evalJs(`return {
      text: document.body.innerText.slice(-8000),
      detail: document.querySelector('[data-native-subagent-detail]')?.outerHTML || null,
    }`).catch(() => null)
    console.error('[native-multi-agent-ui-smoke] subagent detail diagnostics', JSON.stringify({ child: childDetail.json, page }))
    throw error
  }

  console.log('[native-multi-agent-ui-smoke] PASS 原生创建/等待/父子 Thread/对话状态/运行中心回查')
} finally {
  try { await session?.close() } catch { /* ignore */ }
  try { await fakeModel?.close() } catch { /* ignore */ }
  rmSync(evalHome, { recursive: true, force: true })
}
