import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const evalHome = mkdtempSync(path.join(os.tmpdir(), 'web-image-ui-smoke-'))
const stamp = Date.now()
const webQuestion = `联网验收-${stamp}：example.com 是做什么的？`
const imageQuestion = `图片验收-${stamp}：请确认已经看到这张图片。`
const modelRequests = []
const searchRequests = []

process.env.DSH_EVAL_ISOLATED = '1'
process.env.DSH_EVAL_VERBOSE = '1'
process.env.DSH_EVAL_HOME = evalHome
process.env.DSH_USER_DATA_DIR = path.join(evalHome, 'electron-user-data')

function chatChunk(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function requestHasImage(body) {
  return (body?.messages || []).some((message) => (
    Array.isArray(message?.content)
    && message.content.some((part) => part?.type === 'image_url' && /^data:image\//.test(String(part?.image_url?.url || '')))
  ))
}

function dynamicToolName(body, expectedName) {
  const tool = (body?.tools || []).find((item) => {
    const name = String(item?.function?.name || '')
    const description = String(item?.function?.description || '')
    return name === expectedName
      || name.endsWith(`__${expectedName}`)
      || description.includes(expectedName === 'web_search' ? '搜索最新网页' : '打开搜索结果')
  })
  return String(tool?.function?.name || '')
}

function streamToolCall(response, { id, name, argumentsText }) {
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'web-image-smoke-model',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: argumentsText },
        }],
      },
      finish_reason: null,
    }],
  })
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'web-image-smoke-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  })
  response.end('data: [DONE]\n\n')
}

function streamAnswer(response, id, content) {
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'web-image-smoke-model',
    choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
  })
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'web-image-smoke-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 },
  })
  response.end('data: [DONE]\n\n')
}

async function startFixtureServer() {
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const rawBody = Buffer.concat(chunks).toString('utf8')

    if (request.method === 'POST' && request.url === '/search') {
      const body = JSON.parse(rawBody || '{}')
      searchRequests.push(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        results: [{
          title: 'Example Domain',
          url: 'https://example.com/',
          content: 'Example Domain is reserved for documentation examples.',
        }],
      }))
      return
    }

    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }

    const body = JSON.parse(rawBody || '{}')
    modelRequests.push(body)
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })

    if (requestHasImage(body)) {
      streamAnswer(response, 'image_final', `已看到这张图片，它是 1×1 像素的 PNG。${stamp}`)
      return
    }

    const toolMessages = (body.messages || []).filter((message) => message?.role === 'tool')
    if (toolMessages.length === 0) {
      const name = dynamicToolName(body, 'web_search')
      assert.ok(name, '模型请求缺少 web_search 工具')
      streamToolCall(response, {
        id: 'call_web_search',
        name,
        argumentsText: JSON.stringify({ query: 'Example Domain purpose', max_results: 1 }),
      })
      return
    }
    if (toolMessages.length === 1) {
      const name = dynamicToolName(body, 'web_open')
      assert.ok(name, '模型请求缺少 web_open 工具')
      streamToolCall(response, {
        id: 'call_web_open',
        name,
        argumentsText: JSON.stringify({ result_id: 'R1' }),
      })
      return
    }
    streamAnswer(response, 'web_final', `Example Domain 用于文档和示例，不需要事先申请使用。【S1】${stamp}`)
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const origin = `http://127.0.0.1:${server.address().port}`
  return {
    modelBaseUrl: `${origin}/v1`,
    searchUrl: `${origin}/search`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function fillComposer(session, ui, value) {
  await ui.fill('[data-testid="agent-message-input"]', value)
  await ui.waitUntil(`async () => document.querySelector('[data-testid="agent-message-input"]')?.value === ${JSON.stringify(value)}`, {
    timeout: 5_000,
    label: '输入框写入完成',
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

async function pasteFixtureImage(session, ui) {
  await session.evalJs(`
    const input = document.querySelector('[data-testid="agent-message-input"]');
    if (!input) throw new Error('找不到输入框');
    const raw = atob(${JSON.stringify(ONE_PIXEL_PNG_BASE64)});
    const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
    const file = new File([bytes], 'fixture.png', { type: 'image/png' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
    return true;
  `)
  await ui.waitFor('[data-attachment-path]', { timeout: 10_000 })
  return session.evalJs(`return document.querySelector('[data-attachment-path]')?.getAttribute('data-attachment-path') || ''`)
}

let fixtureServer = null
let session = null
let modelId = ''
try {
  fixtureServer = await startFixtureServer()
  mkdirSync(process.env.DSH_USER_DATA_DIR, { recursive: true })
  writeFileSync(
    path.join(process.env.DSH_USER_DATA_DIR, 'agent-network-settings.json'),
    JSON.stringify({
      webSearchApiUrl: fixtureServer.searchUrl,
      webSearchApiKey: 'web-image-search-key',
    }),
    { mode: 0o600 },
  )

  session = await openSession({ port: 9375 })
  let driver = makeDriver(session)
  let ui = makeUiDriver(session)
  await driver.login()
  await session.evalJs(`localStorage.setItem('dsh:onboarding:completed:v1', 'true'); return true;`)

  const created = await driver.raw.api('POST', '/api/llm_model/create', {
    model_name: 'web-image-smoke-model',
    display_name: '联网图片验收模型',
    category: 'PRIMARY',
    api_base: fixtureServer.modelBaseUrl,
    api_key: 'web-image-model-key',
    api_format: 'chat_completions',
    supports_streaming: true,
    extra_config: { supports_image_input: true },
  })
  assert.equal(created.status, 200, JSON.stringify(created.json))
  modelId = created.json?.data?.id || ''

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 30_000 })
  await ui.click('[data-search-mode="auto"]')
  await ui.waitFor('[data-search-mode="required"]', { timeout: 5_000 })
  await fillComposer(session, ui, webQuestion)
  await submitComposer(session, ui)
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(`不需要事先申请使用。【S1】${stamp}`)})`, {
    timeout: 90_000,
    label: '联网回答完成',
  })
  await ui.waitFor('[data-web-sources]', { timeout: 10_000 })
  assert.equal(searchRequests.length, 1)
  assert.equal(searchRequests[0].query, 'Example Domain purpose')
  assert.equal(modelRequests.length, 3)
  const webUi = await session.evalJs(`return {
    sourceTitle: document.querySelector('#dsh-web-source-S1 strong')?.textContent || '',
    sourceHref: document.querySelector('#dsh-web-source-S1')?.getAttribute('href') || '',
    citationHref: document.querySelector('a[href="#dsh-web-source-S1"]')?.getAttribute('href') || '',
  }`)
  assert.equal(webUi.sourceTitle, 'Example Domain')
  assert.equal(webUi.sourceHref, 'https://example.com/')
  assert.equal(webUi.citationHref, '#dsh-web-source-S1')

  await ui.click('[title="新建对话"]')
  await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 10_000 })
  await ui.waitUntil(`async () => !document.querySelector('[data-agent-session-id]')`, {
    timeout: 5_000,
    label: '新对话已脱离上一个会话',
  })
  const currentSearchMode = await session.evalJs(`return document.querySelector('[data-search-mode]')?.getAttribute('data-search-mode') || ''`)
  if (currentSearchMode === 'auto') {
    await ui.click('[data-search-mode="auto"]')
    await ui.waitFor('[data-search-mode="required"]', { timeout: 5_000 })
  }
  if (currentSearchMode !== 'off') {
    await ui.click('[data-search-mode="required"]')
    await ui.waitFor('[data-search-mode="off"]', { timeout: 5_000 })
  }
  const managedImagePath = await pasteFixtureImage(session, ui)
  assert.ok(managedImagePath)
  assert.equal(managedImagePath.startsWith(path.join(evalHome, '.dsh', 'attachments', '__chat__', 'draft')), true)
  assert.equal(existsSync(managedImagePath), true)
  const canonicalImagePath = realpathSync(managedImagePath)

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-attachment-path="${managedImagePath}"]`, { timeout: 30_000 })
  await fillComposer(session, ui, imageQuestion)
  await submitComposer(session, ui)
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(`已看到这张图片，它是 1×1 像素的 PNG。${stamp}`)})`, {
    timeout: 60_000,
    label: '图片理解回答完成',
  })
  const imageRequest = modelRequests.find(requestHasImage)
  assert.ok(imageRequest, '模型没有收到图片数据')
  const imageMessage = imageRequest.messages.find((message) => (
    message?.role === 'user' && Array.isArray(message.content)
    && message.content.some((part) => part?.type === 'image_url')
  ))
  const questionIndex = imageMessage.content.findIndex((part) => part?.type === 'text' && String(part.text || '').includes(imageQuestion))
  const imageIndex = imageMessage.content.findIndex((part) => part?.type === 'image_url')
  assert.equal(questionIndex >= 0, true)
  assert.equal(imageIndex > questionIndex, true)
  assert.equal(imageMessage.content.filter((part) => part?.type === 'image_url').length, 1)
  assert.match(imageMessage.content[imageIndex].image_url.url, /^data:image\/png;base64,/)

  const imageSessionId = await session.evalJs(`return document.querySelector('[data-agent-session-id]')?.getAttribute('data-agent-session-id') || ''`)
  assert.ok(imageSessionId)
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${imageSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${imageSessionId}"]`)
  await ui.waitFor('[data-message-role="user"]', { timeout: 10_000 })
  const restoredImage = await session.evalJs(`return [...document.querySelectorAll('[data-message-role="user"] [data-attachment-path]')].map((element) => ({
    path: element.getAttribute('data-attachment-path') || '',
    name: element.getAttribute('data-attachment-name') || '',
    hasImage: Boolean(element.querySelector('img')),
    text: element.textContent || '',
  })).find((item) => item.path === ${JSON.stringify(canonicalImagePath)}) || null`)
  if (!restoredImage) {
    const persistedMessages = await driver.raw.api('GET', `/api/projects/__chat__/sessions/${imageSessionId}/messages`).catch(() => null)
    console.error('[web-image-ui-smoke] missing restored image', JSON.stringify({ persistedMessages: persistedMessages?.json }))
  }
  assert.equal(restoredImage?.path, canonicalImagePath)
  assert.equal(restoredImage?.hasImage, true)

  rmSync(canonicalImagePath)
  assert.equal(existsSync(canonicalImagePath), false)
  await session.cdp('Network.clearBrowserCache', {}, { timeoutMs: 10_000 }).catch(() => null)
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${imageSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${imageSessionId}"]`)
  await ui.waitForText('原图不存在', { timeout: 10_000 })

  console.log('[web-image-ui-smoke] PASS 必须联网 + web_search/web_open + 来源引用 + 图片粘贴/恢复/理解/缺失态')
} finally {
  if (session && modelId) {
    const driver = makeDriver(session)
    await driver.raw.api('POST', '/api/llm_model/delete', { model_id: modelId }).catch(() => null)
  }
  try { await session?.close() } catch { /* ignore */ }
  try { await fixtureServer?.close() } catch { /* ignore */ }
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
