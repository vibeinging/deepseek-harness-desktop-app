import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'
import { encodeDshModelRoute } from '../server/src/engine/dsh_runtime/model_route.js'

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'native-multi-agent-ui-smoke-'))
const stamp = Date.now()
const conversationTitle = `DSH 协作验收 ${stamp}`
const parentPrompt = `委派一个子任务并等待它完成-${stamp}`
const childPrompt = `只返回子任务完成口令 child-ui-${stamp}`
const childAnswer = `child-ui-done-${stamp}`
const parentAnswer = `parent-ui-done-${stamp}`
const providerId = 'native-multi-agent-ui-eval'
const modelId = 'native-multi-agent-ui-model'
const credentialRef = 'NATIVE_MULTI_AGENT_UI_API_KEY'
const modelRoute = encodeDshModelRoute(providerId, modelId)

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
    model: modelId,
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
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  })
  response.end('data: [DONE]\n\n')
}

function sendText(response, id, value) {
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: modelId,
    choices: [{ index: 0, delta: { role: 'assistant', content: value }, finish_reason: null }],
  })
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
  })
  response.end('data: [DONE]\n\n')
}

async function startFakeModel() {
  const requests = []
  const handlerErrors = []
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

      const serializedMessages = JSON.stringify(body.messages || [])
      if (serializedMessages.includes(childPrompt) && !serializedMessages.includes(parentPrompt)) {
        sendText(response, 'child_ui_done', childAnswer)
        return
      }

      assert.ok(serializedMessages.includes(parentPrompt), `unexpected model request: ${serializedMessages}`)
      if (!serializedMessages.includes('call_dsh_subagent')) {
        const subagent = toolName(body, 'subagent')
        assert.ok(subagent, `DSH subagent tool is unavailable: ${JSON.stringify(body.tools || [])}`)
        sendToolCall(response, {
          id: 'call_dsh_subagent',
          name: subagent,
          arguments: {
            description: '桌面协作验收',
            prompt: childPrompt,
            run_in_background: false,
          },
        })
        return
      }

      const toolOutput = (body.messages || []).find((message) => (
        message?.role === 'tool' && message?.tool_call_id === 'call_dsh_subagent'
      ))
      const toolContent = String(toolOutput?.content || '')
      sendText(response, 'parent_ui_done', toolContent.includes(childAnswer) ? parentAnswer : `parent-ui-child-error:${toolContent}`)
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
    close: async () => {
      server.closeAllConnections?.()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

let session = null
let fakeModel = null
let modelProviderSaved = false
try {
  fakeModel = await startFakeModel()
  session = await openSession({ port: 9368 })
  const driver = makeDriver(session)
  const ui = makeUiDriver(session)
  await driver.login()
  await session.evalJs(`localStorage.setItem('dsh:onboarding:completed:v1', 'true'); return true;`)

  const snapshot = await driver.raw.api('GET', '/api/dsh/models')
  const llmNamespace = snapshot.json?.data?.namespaces?.find((item) => item.ns === 'llm-pi-ai')
  assert.equal(typeof llmNamespace?.revision, 'number', JSON.stringify(snapshot.json))
  const credential = await driver.raw.api('POST', '/api/dsh/models/credentials', {
    ref: credentialRef,
    value: 'native-multi-agent-ui-key',
  })
  assert.equal(credential.status, 200, JSON.stringify(credential.json))
  const configuredModel = await driver.raw.api('POST', '/api/dsh/models/settings/mutate', {
    ns: 'llm-pi-ai',
    expected_revision: llmNamespace.revision,
    ops: [{
      op: 'set',
      path: ['providers', providerId],
      value: {
        displayName: 'DSH 协作桌面假模型',
        apiKeyEnv: credentialRef,
        api: 'openai-completions',
        baseURL: fakeModel.baseUrl,
        models: [{ id: modelId, name: 'DSH 协作桌面假模型' }],
      },
    }],
  })
  assert.equal(configuredModel.status, 200, JSON.stringify(configuredModel.json))
  modelProviderSaved = true

  const result = await driver.askAgent('__chat__', parentPrompt, {
    title: conversationTitle,
    model: modelRoute,
    timeoutMs: 45_000,
  })
  assert.deepEqual(fakeModel.handlerErrors, [])
  assert.equal(fakeModel.requests.length, 3, JSON.stringify(fakeModel.requests.map((request) => ({
    messages: (request.messages || []).map((message) => ({ role: message.role, text: messageText(message.content).slice(0, 200) })),
  }))))
  const childRequest = fakeModel.requests.find((request) => (
    JSON.stringify(request.messages || []).includes(childPrompt)
    && !JSON.stringify(request.messages || []).includes(parentPrompt)
  ))
  assert.equal(childRequest?.model, modelId)
  assert.ok(result.blocks.some((block) => (
    block.type === 'tool' && block.metadata?.tool_name === 'subagent'
    && String(block.metadata?.resultText || '').includes(childAnswer)
  )), JSON.stringify(result.blocks))
  assert.ok(result.blocks.some((block) => String(block.content || '').includes(parentAnswer)), JSON.stringify(result.blocks))

  const trajectory = await driver.raw.api('GET', `/api/agent/projects/__chat__/threads/${result.sid}/dsh-trajectory`)
  assert.equal(trajectory.status, 200, JSON.stringify(trajectory.json))
  assert.equal(trajectory.json?.data?.source, 'session.history')
  const events = trajectory.json?.data?.events || []
  assert.ok(events.some((entry) => entry?.event?.type === 'tool/call' && entry.event.data?.name === 'subagent'))
  assert.ok(events.some((entry) => (
    entry?.event?.type === 'tool/result'
    && JSON.stringify(entry.event.data || '').includes(childAnswer)
  )), JSON.stringify(events))

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${result.sid}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${result.sid}"]`)
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(parentAnswer)})`, {
    timeout: 15_000,
    label: '对话显示 DSH 协作最终回答',
  })
  await ui.fill('[data-testid="agent-message-input"]', '/runs')
  await ui.waitFor('[data-slash-menu]', { timeout: 10_000 })
  await session.evalJs(`
    const command = [...document.querySelectorAll('[data-slash-menu] button')]
      .find((button) => button.innerText.includes('/runs'));
    if (!command) throw new Error('找不到 /runs 命令');
    command.click();
    return true;
  `)
  await ui.waitFor('[data-dsh-trajectory][data-dsh-trajectory-source="session.history"]', { timeout: 15_000 })
  await ui.waitFor('[data-dsh-trajectory-event][data-dsh-event-type="tool/call"]', { timeout: 15_000 })
  await ui.waitFor('[data-dsh-trajectory-event][data-dsh-event-type="tool/result"]', { timeout: 15_000 })
  assert.equal(await session.evalJs(`return document.querySelector('[data-dsh-trajectory]')?.innerText.includes('subagent') || false`), true)

  console.log('[native-multi-agent-ui-smoke] PASS DSH 子任务委派/等待/父级回答/session.history 轨迹')
} finally {
  if (session && modelProviderSaved) {
    const driver = makeDriver(session)
    await driver.raw.api('POST', '/api/dsh/models/settings/mutate', {
      ns: 'llm-pi-ai',
      ops: [{ op: 'unset', path: ['providers', providerId] }],
    }).catch(() => null)
  }
  if (session) {
    const driver = makeDriver(session)
    await driver.raw.api('DELETE', `/api/dsh/models/credentials/${encodeURIComponent(credentialRef)}`).catch(() => null)
  }
  try { await session?.close() } catch { /* ignore */ }
  try { await fakeModel?.close() } catch { /* ignore */ }
  if (process.env.DSH_EVAL_RETAIN !== '1') rmSync(evalHome, { recursive: true, force: true })
}
