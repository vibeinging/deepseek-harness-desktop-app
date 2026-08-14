import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'
import { encodeDshModelRoute } from '../server/src/engine/dsh_runtime/model_route.js'

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const evalHome = mkdtempSync(path.join(os.tmpdir(), 'web-image-ui-smoke-'))
const stamp = Date.now()
const webQuestion = `联网验收-${stamp}：example.com 是做什么的？`
const imageQuestion = `图片验收-${stamp}：请确认已经看到这张图片。`
const modelRequests = []
const searchRequests = []
const providerId = 'web-image-eval'
const modelId = 'web-image-smoke-model'
const modelCredentialRef = 'WEB_IMAGE_EVAL_API_KEY'
const searchCredentialRef = 'DEEPSEEK_API_KEY'
const modelRoute = encodeDshModelRoute(providerId, modelId)

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

    if (request.method === 'POST' && request.url === '/anthropic/v1/messages') {
      const body = JSON.parse(rawBody || '{}')
      searchRequests.push(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        id: 'msg_web_search_fixture',
        type: 'message',
        role: 'assistant',
        model: 'web-search-fixture',
        content: [
          {
            type: 'web_search_tool_result',
            tool_use_id: 'server_web_search_1',
            content: [{
              type: 'web_search_result',
              title: 'Example Domain',
              url: 'https://example.com/',
              page_age: '2026-08-13',
            }],
          },
          {
            type: 'text',
            text: 'Example Domain is reserved for documentation examples.',
            citations: [{
              type: 'web_search_result_location',
              title: 'Example Domain',
              url: 'https://example.com/',
              cited_text: 'Example Domain is reserved for documentation examples.',
            }],
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 8 },
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
        argumentsText: JSON.stringify({ query: 'Example Domain purpose' }),
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
    searchBaseUrl: `${origin}/anthropic/v1`,
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
let modelProviderSaved = false
let webSessionId = ''
try {
  fixtureServer = await startFixtureServer()
  process.env.DEEPSEEK_SEARCH_BASE_URL = fixtureServer.searchBaseUrl
  mkdirSync(process.env.DSH_USER_DATA_DIR, { recursive: true })

  session = await openSession({ port: 9375 })
  let driver = makeDriver(session)
  let ui = makeUiDriver(session)
  await driver.login()
  await session.evalJs(`localStorage.setItem('dsh:onboarding:completed:v1', 'true'); return true;`)

  const snapshot = await driver.raw.api('GET', '/api/dsh/models')
  const llmNamespace = snapshot.json?.data?.namespaces?.find((item) => item.ns === 'llm-pi-ai')
  assert.equal(typeof llmNamespace?.revision, 'number', JSON.stringify(snapshot.json))
  for (const [ref, value] of [
    [modelCredentialRef, 'web-image-model-key'],
    [searchCredentialRef, 'web-image-search-key'],
  ]) {
    const credential = await driver.raw.api('POST', '/api/dsh/models/credentials', { ref, value })
    assert.equal(credential.status, 200, JSON.stringify(credential.json))
  }
  const configuredModel = await driver.raw.api('POST', '/api/dsh/models/settings/mutate', {
    ns: 'llm-pi-ai',
    expected_revision: llmNamespace.revision,
    ops: [{
      op: 'set',
      path: ['providers', providerId],
      value: {
        displayName: '联网图片验收模型',
        apiKeyEnv: modelCredentialRef,
        api: 'openai-completions',
        baseURL: fixtureServer.modelBaseUrl,
        models: [{ id: modelId, name: '联网图片验收模型', input: ['text', 'image'] }],
      },
    }],
  })
  assert.equal(configuredModel.status, 200, JSON.stringify(configuredModel.json))
  modelProviderSaved = true

  const webTurn = await driver.askAgent('__chat__', webQuestion, {
    title: `联网图片验收 ${stamp}`,
    model: modelRoute,
    searchMode: 'required',
    timeoutMs: 90_000,
  })
  webSessionId = webTurn.sid
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${webSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${webSessionId}"]`)
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(`不需要事先申请使用。【S1】${stamp}`)})`, {
    timeout: 90_000,
    label: '联网回答完成',
  })
  await ui.waitFor('[data-web-sources]', { timeout: 10_000 })
  assert.equal(searchRequests.length, 1)
  assert.match(searchRequests[0].messages[0].content[0].text, /Example Domain purpose/)
  assert.equal(modelRequests.length, 2)
  const webUi = await session.evalJs(`return {
    sourceTitle: document.querySelector('#dsh-web-source-S1 strong')?.textContent || '',
    sourceHref: document.querySelector('#dsh-web-source-S1')?.getAttribute('href') || '',
    citationHref: document.querySelector('a[href="#dsh-web-source-S1"]')?.getAttribute('href') || '',
  }`)
  assert.equal(webUi.sourceTitle, 'Example Domain')
  assert.equal(webUi.sourceHref, 'https://example.com/')
  assert.equal(webUi.citationHref, '#dsh-web-source-S1')
  assert.equal(await session.evalJs(`return document.body.innerText.includes('缺少联网来源')`), false)

  await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 10_000 })
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
  assert.equal(managedImagePath.startsWith(path.join(evalHome, '.dsh', 'attachments', '__chat__')), true)
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

  const imageSessionId = webSessionId
  const trajectory = await driver.raw.api('GET', `/api/agent/projects/__chat__/threads/${imageSessionId}/dsh-trajectory`)
  const imageEvent = (trajectory.json?.data?.events || []).find((entry) => (
    entry?.event?.type === 'user/message'
    && entry.event.data?.content?.some?.((block) => block?.type === 'image')
  ))
  const attachmentId = imageEvent?.event?.data?.content?.find((block) => block?.type === 'image')?.attachment?.attachmentId
  assert.match(String(attachmentId || ''), /^sha256:/)
  const dshAttachmentPath = `dsh-attachment:${attachmentId}`
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${imageSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${imageSessionId}"]`)
  await ui.waitFor('[data-message-role="user"]', { timeout: 10_000 })
  await ui.waitUntil(`async () => [...document.querySelectorAll('[data-message-role="user"] [data-attachment-path]')]
    .some((element) => element.getAttribute('data-attachment-path') === ${JSON.stringify(dshAttachmentPath)} && Boolean(element.querySelector('img')))`, {
    timeout: 10_000,
    label: 'DSH 内容寻址附件首次恢复',
  })
  const restoredImage = await session.evalJs(`return [...document.querySelectorAll('[data-message-role="user"] [data-attachment-path]')].map((element) => ({
    path: element.getAttribute('data-attachment-path') || '',
    name: element.getAttribute('data-attachment-name') || '',
    hasImage: Boolean(element.querySelector('img')),
    text: element.textContent || '',
  })).find((item) => item.path === ${JSON.stringify(dshAttachmentPath)}) || null`)
  if (!restoredImage) {
    const persistedMessages = await driver.raw.api('GET', `/api/projects/__chat__/sessions/${imageSessionId}/messages`).catch(() => null)
    console.error('[web-image-ui-smoke] missing restored image', JSON.stringify({ persistedMessages: persistedMessages?.json }))
  }
  assert.equal(restoredImage?.path, dshAttachmentPath)
  assert.equal(restoredImage?.hasImage, true)

  rmSync(canonicalImagePath)
  assert.equal(existsSync(canonicalImagePath), false)
  await session.cdp('Network.clearBrowserCache', {}, { timeoutMs: 10_000 }).catch(() => null)
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${imageSessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${imageSessionId}"]`)
  await ui.waitUntil(`async () => [...document.querySelectorAll('[data-message-role="user"] [data-attachment-path]')]
    .some((element) => Boolean(element.querySelector('img')))`, {
    timeout: 10_000,
    label: 'DSH 内容寻址附件在原始托管文件删除后仍可恢复',
  })
  assert.equal(await session.evalJs(`return document.body.innerText.includes('原图不存在')`), false)

  console.log('[web-image-ui-smoke] PASS DSH web_search + 来源引用 + 图片粘贴/理解 + DSH 内容寻址恢复')
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
    for (const ref of [modelCredentialRef, searchCredentialRef]) {
      await driver.raw.api('DELETE', `/api/dsh/models/credentials/${encodeURIComponent(ref)}`).catch(() => null)
    }
  }
  try { await session?.close() } catch { /* ignore */ }
  try { await fixtureServer?.close() } catch { /* ignore */ }
  delete process.env.DEEPSEEK_SEARCH_BASE_URL
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
