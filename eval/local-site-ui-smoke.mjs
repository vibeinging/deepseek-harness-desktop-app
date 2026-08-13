import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'local-site-ui-smoke-'))
const exportPath = path.join(evalHome, 'exports', 'site-export.html')
const conversationTitle = `Site 验收对话 ${Date.now()}`
const siteTitle = `交互页面 ${Date.now()}`
const initialHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;background:#f7f3fb}button{position:absolute;left:24px;top:24px;width:160px;height:48px;border:0;border-radius:10px;color:white;background:#6750a4;font:16px system-ui}</style></head><body><button id="counter" type="button">计数 0</button><script>document.querySelector('#counter').addEventListener('click',(event)=>{const value=Number(event.currentTarget.dataset.count||0)+1;event.currentTarget.dataset.count=String(value);event.currentTarget.textContent='计数 '+value})</script></body></html>`
const editedHtml = initialHtml.replace('计数 0', '版本二').replace("String(value);event.currentTarget.textContent='计数 '+value", "String(value);event.currentTarget.textContent='版本二 '+value")

mkdirSync(path.dirname(exportPath), { recursive: true })

process.env.DSH_EVAL_ISOLATED = '1'
process.env.DSH_EVAL_HOME = evalHome
process.env.DSH_USER_DATA_DIR = path.join(evalHome, 'electron-user-data')
process.env.DSH_EVAL_SITE_EXPORT_PATH = exportPath

async function apiJson(session, request) {
  return session.evalJs(`
    const response = await window.electronAPI.apiRequest(${JSON.stringify(request)});
    return response.json;
  `, { timeoutMs: 20_000 })
}

async function hasVisible(session, selector) {
  return session.evalJs(`
    return [...document.querySelectorAll(${JSON.stringify(selector)})].some((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
  `)
}

async function markVisible(session, selector, marker) {
  return session.evalJs(`
    for (const element of document.querySelectorAll('[' + ${JSON.stringify(marker)} + ']')) element.removeAttribute(${JSON.stringify(marker)});
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    });
    if (!target) return null;
    target.setAttribute(${JSON.stringify(marker)}, 'true');
    return '[' + ${JSON.stringify(marker)} + '="true"]';
  `)
}

async function waitForStableHitTarget(session, ui, selector, label) {
  await session.evalJs(`delete window.__siteSmokeStableTarget; return true;`)
  await ui.waitUntil(`async () => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return false;
    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const now = performance.now();
    const previous = window.__siteSmokeStableTarget;
    const moved = !previous
      || Math.abs(previous.left - rect.left) > 0.5
      || Math.abs(previous.top - rect.top) > 0.5
      || Math.abs(previous.width - rect.width) > 0.5
      || Math.abs(previous.height - rect.height) > 0.5;
    if (moved || !(hit === target || target.contains(hit))) {
      window.__siteSmokeStableTarget = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
        since: now
      };
      return false;
    }
    return now - previous.since >= 200;
  }`, { timeout: 5_000, label })
}

async function openWorkbenchTool(session, ui, name) {
  const tab = `[data-workbench-tab="${name}"]`
  const empty = `[data-workbench-empty-action="${name}"]`
  const option = `[data-workbench-add-option="${name}"]`
  const add = '[data-workbench-add]'
  await ui.waitUntil(`async () => [...document.querySelectorAll(${JSON.stringify(`${tab}, ${empty}, ${add}`)})].some((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })`, { timeout: 10_000, label: `右侧栏 ${name} 入口可见` })
  let selector = tab
  if (!(await hasVisible(session, tab))) {
    if (await hasVisible(session, empty)) {
      selector = empty
    } else {
      await ui.click(add)
      await ui.waitFor(option, { timeout: 5_000 })
      await ui.waitUntil(`async () => {
        const element = document.querySelector(${JSON.stringify(option)})
        if (!element) return false
        const rect = element.getBoundingClientRect()
        const style = getComputedStyle(element)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }`, { timeout: 5_000, label: `右侧栏 ${name} 添加选项可见` })
      selector = option
    }
  }
  const marked = await markVisible(session, selector, 'data-site-smoke-workbench-target')
  if (!marked) throw new Error(`找不到右侧栏入口: ${name}`)
  // Opening the fifth empty-state item through CDP can cross the narrow right-edge
  // collapse hot zone while the panel is still animating. Dispatch the same trusted
  // DOM click, then keep all feature interactions on the normal CDP UI driver.
  await session.evalJs(`document.querySelector(${JSON.stringify(marked)})?.click(); return true;`)
  await ui.waitUntil(`async () => document.querySelector(${JSON.stringify(tab)})?.getAttribute('data-active') === 'true'`, {
    timeout: 5_000,
    label: `右侧栏 ${name} 已打开`
  })
}

async function expandWorkspace(session, ui) {
  await ui.waitUntil(`async () => /^(true|false)$/.test(
    document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') || ''
  )`, { timeout: 10_000, label: '右侧栏初始化' })
  const collapsed = await session.evalJs(`return document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed')`)
  if (collapsed === 'true') {
    await ui.click('[data-edge-toggle="workspace"]')
    await ui.waitUntil(`async () => document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') === 'false'`, {
      timeout: 10_000,
      label: '右侧栏展开'
    })
  }
}

async function fillExact(session, ui, selector, value, label) {
  await ui.fill(selector, value)
  const exact = await session.evalJs(`return document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
  if (!exact) throw new Error(`${label}没有完整写入`)
}

async function clickPreviewPoint(session, xOffset, yOffset) {
  const point = await session.evalJs(`
    const frame = document.querySelector('[data-site-preview-frame]');
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    return { x: rect.left + ${Number(xOffset)}, y: rect.top + ${Number(yOffset)} };
  `)
  if (!point) throw new Error('找不到 Site 预览 frame')
  await session.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y, button: 'none', buttons: 0, pointerType: 'mouse' })
  await session.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' })
  await session.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' })
}

async function openConversation(session, ui, sessionId) {
  await session.evalJs(`localStorage.setItem('dsh:onboarding:completed:v1', 'true'); return true;`)
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(`[data-agent-conv-id="${sessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${sessionId}"]`)
  await ui.waitUntil(`async () => document.querySelector('[data-empty-conversation="existing"]') !== null`, {
    timeout: 10_000,
    label: '目标对话已进入中间栏'
  })
  await session.evalJs(`
    window.__siteSmokeErrors = [];
    window.addEventListener('error', (event) => window.__siteSmokeErrors.push(String(event.error?.stack || event.message || event.error || 'window error')));
    window.addEventListener('unhandledrejection', (event) => window.__siteSmokeErrors.push(String(event.reason?.stack || event.reason || 'unhandled rejection')));
    return true;
  `)
  await expandWorkspace(session, ui)
  await openWorkbenchTool(session, ui, 'sites')
}

let session = null
try {
  session = await openSession({ port: 9367 })
  let ui = makeUiDriver(session)
  await session.evalJs(`localStorage.setItem('dsh:onboarding:completed:v1', 'true'); return true;`)
  const prepared = await apiJson(session, {
    method: 'POST',
    url: '/api/projects/__chat__/sessions',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: conversationTitle,
      source_type: 'agent',
      source_id: '__chat__',
      action_type: 'agentic_chat'
    })
  })
  const sessionId = prepared?.data?.id
  assert.equal(typeof sessionId, 'string', JSON.stringify(prepared))

  await openConversation(session, ui, sessionId)
  try {
    await ui.waitFor(`[data-site-library="${sessionId}"]`, { timeout: 15_000 })
  } catch (error) {
    const state = await session.evalJs(`return {
      body: document.body.innerText.slice(-1800),
      workspaces: [...document.querySelectorAll('[data-site-workspace]')].map((node) => ({
        workspace: node.getAttribute('data-site-workspace'),
        library: node.getAttribute('data-site-library'),
        text: node.textContent?.trim().slice(0, 600)
      })),
      tabs: [...document.querySelectorAll('[data-workbench-tab], [data-workbench-empty-action]')].map((node) => ({
        tab: node.getAttribute('data-workbench-tab'),
        action: node.getAttribute('data-workbench-empty-action'),
        active: node.getAttribute('data-active')
      })),
      edgeCollapsed: document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') || null,
      errors: window.__siteSmokeErrors || [],
      centerState: document.querySelector('[data-empty-conversation]')?.getAttribute('data-empty-conversation') || null
    }`)
    console.error('[local-site-ui-smoke] Site 列表未出现', JSON.stringify(state))
    throw error
  }
  await ui.click('[aria-label="新建 Site"]')
  await ui.waitFor('[data-site-create]', { timeout: 5_000 })
  await fillExact(session, ui, '[data-site-create-field="title"]', siteTitle, 'Site 标题')
  await fillExact(session, ui, '[data-site-create-field="content"]', initialHtml, 'Site HTML')
  await ui.click('[data-site-create-action="confirm"]')
  await ui.waitFor('[data-site-editor]', { timeout: 15_000 })
  await ui.waitFor('[data-site-preview-frame]', { timeout: 10_000 })

  const list = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases`,
    headers: {}, body: null
  })
  const site = list?.data?.items?.find((item) => item.title === siteTitle)
  assert.equal(site?.kind, 'site', JSON.stringify(list))
  const siteId = site.id

  // The original page script runs while annotation is off.
  await clickPreviewPoint(session, 105, 50)
  await ui.click('[data-site-action="annotate"]')
  await ui.waitUntil(`async () => document.querySelector('[data-site-action="annotate"]')?.getAttribute('data-active') === 'true'`, {
    timeout: 5_000,
    label: '元素选择模式开启'
  })
  await clickPreviewPoint(session, 105, 50)
  await ui.waitUntil(`async () => {
    const selected = document.querySelector('[data-site-selection="#counter"]');
    return selected?.innerText.includes('计数 1');
  }`, { timeout: 8_000, label: '交互后的按钮可被准确标注' })
  await ui.click('[data-site-action="ask"]')
  await ui.waitUntil(`async () => {
    const input = document.querySelector('[data-testid="agent-message-input"]');
    return input?.value.includes(${JSON.stringify(siteId)})
      && input.value.includes('canvas_inspect')
      && input.value.includes('canvas_edit')
      && input.value.includes('#counter');
  }`, { timeout: 10_000, label: '标注进入 DSH 草稿且未自动发送' })

  await ui.click('[data-site-view="source"]')
  await ui.waitFor('[data-site-source-editor]', { timeout: 5_000 })
  await fillExact(session, ui, '[data-site-source-editor]', editedHtml, '第二版源码')
  await ui.click('[data-site-action="save"]')
  await ui.waitUntil(`async () => {
    const current = document.querySelector('[data-site-version="2"]');
    const editor = document.querySelector('[data-site-source-editor]');
    return current?.getAttribute('data-active') === 'true' && editor?.value.includes('版本二');
  }`, { timeout: 15_000, label: '源码保存为 v2' })

  await ui.click('[data-site-version="1"]')
  await ui.waitUntil(`async () => document.querySelector('[data-site-version="1"]')?.getAttribute('data-active') === 'true'`, {
    timeout: 10_000,
    label: '打开 v1 历史版本'
  })
  await ui.waitUntil(`async () => document.querySelector('[data-site-source-editor]')?.readOnly === true
    && document.querySelector('[data-site-source-editor]')?.value.includes('计数 0')`, {
    timeout: 5_000,
    label: '历史源码只读且内容正确'
  })
  await ui.click('[data-site-action="restore"]')
  await ui.waitFor('[data-site-confirm-restore="true"]', { timeout: 5_000 })
  await session.evalJs(`document.querySelector('[data-site-confirm-restore="true"]')?.click(); return true;`)
  try {
    await ui.waitUntil(`async () => document.querySelector('[data-site-version="3"]')?.getAttribute('data-active') === 'true'`, {
      timeout: 15_000,
      label: '恢复 v1 创建 v3'
    })
  } catch (error) {
    const [apiState, domState] = await Promise.all([
      apiJson(session, {
        method: 'GET',
        url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(siteId)}`,
        headers: {}, body: null
      }),
      session.evalJs(`return {
        versions: [...document.querySelectorAll('[data-site-version]')].map((node) => ({
          version: node.getAttribute('data-site-version'),
          active: node.getAttribute('data-active'),
          text: node.textContent?.trim()
        })),
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => node.textContent?.trim()),
        notifications: [...document.querySelectorAll('[data-notification-id]')].map((node) => node.textContent?.trim()),
        errors: window.__siteSmokeErrors || []
      }`)
    ])
    console.error('[local-site-ui-smoke] 恢复状态', JSON.stringify({ apiState, domState }))
    throw error
  }

  await ui.waitUntil(`async () => {
    if (document.querySelector('[role="dialog"]')) return false;
    const button = document.querySelector('[data-site-action="export"]');
    if (!button || button.disabled) return false;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === button || button.contains(hit);
  }`, { timeout: 8_000, label: '恢复弹窗关闭且导出按钮可点击' })
  await ui.click('[data-site-action="export"]')
  const exportDeadline = Date.now() + 10_000
  while (!existsSync(exportPath) && Date.now() < exportDeadline) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(existsSync(exportPath), true, '导出文件应由 Electron 原生桥写入')
  assert.equal(readFileSync(exportPath, 'utf8'), initialHtml, '导出必须是原始 HTML，不能包含预览注入内容')

  const restored = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(siteId)}`,
    headers: {}, body: null
  })
  assert.equal(restored?.data?.current_version?.version_number, 3, JSON.stringify(restored))
  assert.equal(restored?.data?.content, initialHtml)

  await session.close({ preserveData: true })
  session = await openSession({ port: 9367 })
  ui = makeUiDriver(session)
  await openConversation(session, ui, sessionId)
  await ui.waitFor(`[data-site-id="${siteId}"]`, { timeout: 15_000 })
  await waitForStableHitTarget(
    session,
    ui,
    `[data-site-id="${siteId}"]`,
    'App 重启后 Site 卡片位置稳定且可点击'
  )
  await ui.click(`[data-site-id="${siteId}"]`)
  try {
    await ui.waitUntil(`async () => {
      const editor = document.querySelector('[data-site-editor=${JSON.stringify(siteId)}]');
      return Boolean(editor?.innerText.includes('v3') && document.querySelector('[data-site-preview-frame]'));
    }`, { timeout: 15_000, label: 'App 重启后 Site 和 v3 持久存在' })
  } catch (error) {
    const [apiState, domState] = await Promise.all([
      apiJson(session, {
        method: 'GET',
        url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(siteId)}`,
        headers: {}, body: null
      }),
      session.evalJs(`
        const card = document.querySelector('[data-site-id=${JSON.stringify(siteId)}]');
        const rect = card?.getBoundingClientRect();
        const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
        return {
          card: card ? { text: card.textContent?.trim(), hit: hit === card || card.contains(hit) } : null,
          editor: document.querySelector('[data-site-editor]')?.getAttribute('data-site-editor') || null,
          editorText: document.querySelector('[data-site-editor]')?.innerText?.slice(0, 600) || '',
          preview: Boolean(document.querySelector('[data-site-preview-frame]')),
          activeTab: document.querySelector('[data-workbench-tab="sites"]')?.getAttribute('data-active') || null,
          workspaceCollapsed: document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') || null,
          errors: window.__siteSmokeErrors || []
        };
      `)
    ])
    console.error('[local-site-ui-smoke] 重启恢复状态', JSON.stringify({ apiState, domState }))
    throw error
  }

  console.log('[local-site-ui-smoke] PASS', JSON.stringify({ sessionId, siteId, versions: 3, exportPath }))
} finally {
  if (session) await session.close().catch(() => undefined)
  rmSync(evalHome, { recursive: true, force: true })
}
