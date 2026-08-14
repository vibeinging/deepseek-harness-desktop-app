import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url))
const BetterSqlite3 = requireFromServer('better-sqlite3')

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'canvas-workspace-ui-smoke-'))
const conversationTitle = `Canvas 验收对话 ${Date.now()}`
const canvasTitle = `发布草稿 ${Date.now()}`
const v1Needle = `准备中-${Date.now()}`
const v2Needle = `可以发布-${Date.now()}`
const suggestedTitle = `正式发布说明-${Date.now()}`
const localDiscardNeedle = `本地待丢弃-${Date.now()}`
const remoteV5Needle = `远端版本五-${Date.now()}`
const localKeepNeedle = `本地保留稿-${Date.now()}`
const remoteV6Needle = `远端版本六-${Date.now()}`
const initialContent = `# 发布说明\n\n状态：${v1Needle}\n\n负责人：测试组`
const editedContent = `# 发布说明\n\n状态：${v2Needle}\n\n负责人：测试组`
const readmeScreenshot = String(process.env.DSH_README_SCREENSHOT || '').trim()

async function captureReadmeScreenshot(session) {
  if (!readmeScreenshot) return
  const shot = await session.cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true
  })
  writeFileSync(path.resolve(readmeScreenshot), Buffer.from(shot.data, 'base64'))
}

function seedVisibleConversation(databasePath, sessionId) {
  const db = new BetterSqlite3(databasePath)
  try {
    db.prepare(`
      INSERT INTO session_messages
        (id, session_id, role, content_items, sequence_number, created_at, updated_at)
      VALUES (?, ?, 'user', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(randomUUID(), sessionId, JSON.stringify([{ type: 'text', text: 'Canvas 验收' }]))
    db.prepare(`UPDATE sessions SET message_count=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(sessionId)
  } finally {
    db.close()
  }
}

process.env.DSH_EVAL_ISOLATED = '1'
process.env.DSH_EVAL_HOME = evalHome
process.env.DSH_USER_DATA_DIR = path.join(evalHome, 'electron-user-data')

async function hasVisible(session, selector) {
  return session.evalJs(`
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
        && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return [...document.querySelectorAll(${JSON.stringify(selector)})].some(visible);
  `)
}

async function markVisible(session, selector, marker) {
  return session.evalJs(`
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
        && style.visibility !== 'hidden' && style.display !== 'none';
    };
    for (const element of document.querySelectorAll('[' + ${JSON.stringify(marker)} + ']')) {
      element.removeAttribute(${JSON.stringify(marker)});
    }
    const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find(visible);
    if (!target) return null;
    target.setAttribute(${JSON.stringify(marker)}, 'true');
    return '[' + ${JSON.stringify(marker)} + '="true"]';
  `)
}

async function waitInteractable(session, ui, selector, label) {
  await ui.waitUntil(`async () => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target || target.disabled || getComputedStyle(target).pointerEvents === 'none') return false;
    target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === target || target.contains(hit);
  }`, { timeout: 8_000, label })
}

async function fillExact(session, ui, selector, value, label) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitInteractable(session, ui, selector, `${label}可编辑`)
    await ui.fill(selector, value)
    const exact = await session.evalJs(`return document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`)
    if (exact) return
  }
  const actual = await session.evalJs(`return document.querySelector(${JSON.stringify(selector)})?.value || ''`)
  throw new Error(`${label}未能完成全选替换: ${JSON.stringify(actual)}`)
}

async function openWorkbenchTool(session, ui, name) {
  const tab = `[data-workbench-tab="${name}"]`
  const empty = `[data-workbench-empty-action="${name}"]`
  const option = `[data-workbench-add-option="${name}"]`
  const add = '[data-workbench-add]'
  await ui.waitUntil(`async () => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && rect.left >= 0 && rect.top >= 0
        && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight
        && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return [...document.querySelectorAll(${JSON.stringify(`${tab}, ${empty}, ${add}`)})].some(visible);
  }`, {
    timeout: 10_000,
    label: `右侧栏 ${name} 入口进入窗口`
  })
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
  const marked = await markVisible(session, selector, 'data-canvas-smoke-workbench-target')
  if (!marked) throw new Error(`找不到可见的右侧栏入口: ${name}`)
  await ui.click(marked, { timeout: 10_000 })
}

async function apiJson(session, request) {
  return session.evalJs(`
    const response = await window.electronAPI.apiRequest(${JSON.stringify(request)});
    return response.json;
  `, { timeoutMs: 20_000 })
}

let session = null
try {
  session = await openSession({ port: 9359 })
  const ui = makeUiDriver(session)
  const driver = makeDriver(session)
  await driver.login()
  await session.evalJs(`
    localStorage.setItem('dsh:onboarding:completed:v1', 'true');
    return true;
  `)

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
  seedVisibleConversation(path.join(evalHome, '.dsh', 'local.db'), sessionId)

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  const conversationSelector = `[data-agent-conv-id="${sessionId}"]`
  await ui.waitFor(conversationSelector, { timeout: 30_000 })
  await ui.click(conversationSelector)
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
  await openWorkbenchTool(session, ui, 'artifacts')
  await ui.waitFor('[data-artifact-action="open-canvas"]', { timeout: 15_000 })
  await ui.click('[data-artifact-action="open-canvas"]')

  try {
    await ui.waitFor(`[data-canvas-library="${sessionId}"]`, { timeout: 15_000 })
  } catch (error) {
    const state = await session.evalJs(`
      return {
        body: document.body.innerText.slice(-1800),
        artifactTabs: [...document.querySelectorAll('[data-workbench-tab], [data-workbench-empty-action]')].map((node) => ({
          tab: node.getAttribute('data-workbench-tab'),
          action: node.getAttribute('data-workbench-empty-action'),
          active: node.getAttribute('data-active'),
          rect: node.getBoundingClientRect().toJSON()
        })),
        canvasLibraries: [...document.querySelectorAll('[data-canvas-library]')].map((node) => node.getAttribute('data-canvas-library')),
        artifactStates: [...document.querySelectorAll('[data-artifact-library], [data-artifact-empty]')].map((node) => ({
          library: node.getAttribute('data-artifact-library'),
          empty: node.getAttribute('data-artifact-empty'),
          text: node.textContent?.trim().slice(0, 500)
        })),
        conversation: document.querySelector('[data-agent-conv-id].active, [data-agent-conv-id][data-active="true"]')?.getAttribute('data-agent-conv-id') || null
      };
    `)
    console.error('[canvas-workspace-ui-smoke] Canvas 列表未出现', JSON.stringify(state))
    throw error
  }
  await ui.click('[aria-label="新建 Canvas"]')
  await ui.waitFor('[data-canvas-create="document"]', { timeout: 5_000 })
  await ui.fill('[data-canvas-create-field="title"]', canvasTitle)
  await ui.fill('[data-canvas-create-field="content"]', initialContent)
  await ui.click('[data-canvas-create-action="confirm"]')
  await ui.waitUntil(`async () => {
    const editor = document.querySelector('[data-canvas-editor]');
    const input = editor?.querySelector('[data-canvas-kind="document"]');
    return editor?.innerText.includes(${JSON.stringify(canvasTitle)})
      && input?.value.includes(${JSON.stringify(v1Needle)});
  }`, { timeout: 15_000, label: '新建 Canvas v1 自动打开' })

  let list = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases`,
    headers: {}, body: null
  })
  const canvas = list?.data?.items?.find((item) => item.title === canvasTitle)
  assert.equal(typeof canvas?.id, 'string', JSON.stringify(list))
  const canvasId = canvas.id
  const version1 = canvas.current_version

  await ui.fill('[data-canvas-kind="document"]', editedContent)
  await ui.click('[data-canvas-action="save"]')
  await ui.waitUntil(`async () => {
    const editor = document.querySelector('[data-canvas-editor=${JSON.stringify(canvasId)}]');
    return editor?.innerText.includes('v2')
      && editor?.querySelector('[data-canvas-kind="document"]')?.value.includes(${JSON.stringify(v2Needle)});
  }`, { timeout: 15_000, label: '直接编辑保存为 v2' })

  let detail = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(canvasId)}`,
    headers: {}, body: null
  })
  assert.equal(detail?.data?.current_version?.version_number, 2, JSON.stringify(detail))
  assert.equal(detail?.data?.content, editedContent, '直接编辑必须替换全文，不能追加到旧正文')
  const version2 = detail.data.current_version
  const v2Content = detail.data.content

  await session.evalJs(`
    const editor = document.querySelector('[data-canvas-kind="document"]');
    editor.focus();
    editor.setSelectionRange(0, 6);
    editor.dispatchEvent(new Event('select', { bubbles: true }));
    editor.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
    return { start: editor.selectionStart, end: editor.selectionEnd };
  `)
  await ui.waitFor('[data-canvas-selection="0:6"]', { timeout: 5_000 })
  const redundantActionCount = await session.evalJs(`return document.querySelectorAll('[data-canvas-action="ask"]').length`)
  assert.equal(redundantActionCount, 0, 'Canvas 不应再显示全文或选区改写快捷按钮')
  await ui.click('[data-canvas-action="suggest"]')
  await ui.waitUntil(`async () => {
    const input = document.querySelector('[data-testid="agent-message-input"]');
    return input?.value.includes('canvas_inspect')
      && input?.value.includes('canvas_suggest')
      && input?.value.includes(${JSON.stringify(canvasId)})
      && input?.value.includes('start=0，end=6');
  }`, { timeout: 10_000, label: '精确选区以行内建议进入 DSH 草稿且未自动发送' })

  const selected = v2Content.slice(0, 6)
  const suggestionResponse = await apiJson(session, {
    method: 'POST',
    url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(canvasId)}/suggestions`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_version_id: version2.id,
      start: 0,
      end: 6,
      selected_text: selected,
      replacement_text: `# ${suggestedTitle}`,
      instruction: '标题更明确'
    })
  })
  assert.equal(suggestionResponse?.data?.suggestion?.status, 'pending', JSON.stringify(suggestionResponse))
  await ui.click('[data-canvas-editor] [aria-label="刷新 Canvas"]')
  await ui.waitFor('[data-canvas-suggestion]', { timeout: 10_000 })
  await ui.click('[data-canvas-suggestion-action="accept"]')
  await ui.waitUntil(`async () => {
    const editor = document.querySelector('[data-canvas-editor=${JSON.stringify(canvasId)}]');
    return editor?.innerText.includes('v3')
      && editor?.querySelector('[data-canvas-kind="document"]')?.value.startsWith(${JSON.stringify(`# ${suggestedTitle}`)});
  }`, { timeout: 15_000, label: '接受建议保存为 v3' })

  await ui.click('[data-canvas-version="1"]')
  await ui.waitFor('[data-canvas-version-preview="1"]', { timeout: 10_000 })
  await ui.waitUntil(`async () => {
    const preview = document.querySelector('[data-canvas-version-preview="1"]');
    return preview?.innerText.includes(${JSON.stringify(v1Needle)})
      && preview?.innerText.includes(${JSON.stringify(suggestedTitle)});
  }`, { timeout: 8_000, label: 'v1 与当前版本差异可见' })
  await ui.click('[data-canvas-action="restore"]')
  await ui.waitUntil(`async () => document.body.innerText.includes('恢复会创建一个新的当前版本，现有历史不会被覆盖。')`, {
    timeout: 5_000,
    label: '恢复说明可见'
  })
  await ui.waitUntil(`async () => {
    const button = document.querySelector('[data-canvas-confirm-restore="true"]');
    if (!button || button.disabled || getComputedStyle(button).pointerEvents === 'none') return false;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === button || button.contains(hit);
  }`, { timeout: 5_000, label: '恢复确认按钮可点击' })
  await ui.click('[data-canvas-confirm-restore="true"]')
  try {
    await ui.waitUntil(`async () => {
      const editor = document.querySelector('[data-canvas-editor=${JSON.stringify(canvasId)}]');
      return editor?.innerText.includes('v4')
        && editor?.querySelector('[data-canvas-kind="document"]')?.value.includes(${JSON.stringify(v1Needle)});
    }`, { timeout: 15_000, label: '恢复 v1 创建 v4' })
  } catch (error) {
    const [apiState, domState] = await Promise.all([
      apiJson(session, {
        method: 'GET',
        url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(canvasId)}`,
        headers: {}, body: null
      }),
      session.evalJs(`
        const editor = document.querySelector('[data-canvas-editor=${JSON.stringify(canvasId)}]');
        return {
          text: editor?.innerText.slice(0, 1500) || '',
          value: editor?.querySelector('[data-canvas-kind="document"]')?.value || '',
          dialogs: [...document.querySelectorAll('[role="dialog"]')].map((node) => node.innerText.slice(0, 600)),
          notifications: [...document.querySelectorAll('[data-notification-id]')].map((node) => node.textContent?.trim())
        };
      `)
    ])
    console.error('[canvas-workspace-ui-smoke] 恢复状态', JSON.stringify({ apiState, domState }))
    throw error
  }

  await ui.waitUntil(`async () => {
    if (document.querySelector('[role="dialog"]')) return false;
    const editor = document.querySelector('[data-canvas-kind="document"]');
    if (!editor) return false;
    const rect = editor.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 120));
    return hit === editor;
  }`, { timeout: 5_000, label: '恢复弹窗关闭且编辑器可点击' })

  const restoredDetail = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(canvasId)}`,
    headers: {}, body: null
  })
  assert.equal(restoredDetail?.data?.current_version?.version_number, 4, JSON.stringify(restoredDetail))

  await fillExact(session, ui, '[data-canvas-kind="document"]', `# ${localDiscardNeedle}\n\n这份本地稿将主动改用最新版本。`, '第一份本地稿')
  await ui.waitUntil(`async () => {
    const root = document.querySelector('[data-canvas-editor=${JSON.stringify(canvasId)}]');
    return root?.querySelector('[data-canvas-action="save"]')?.disabled === false
      && root?.querySelector('[data-canvas-kind="document"]')?.value.includes(${JSON.stringify(localDiscardNeedle)});
  }`, { timeout: 5_000, label: '第一份本地稿进入未保存状态' })
  const remoteV5 = await apiJson(session, {
    method: 'POST',
    url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(canvasId)}/edits`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_version_id: restoredDetail.data.current_version.id,
      content: `# ${remoteV5Needle}\n\n服务端已保存新版本。`,
      change_summary: '并发远端更新 v5'
    })
  })
  assert.equal(remoteV5?.data?.canvas?.current_version?.version_number, 5, JSON.stringify(remoteV5))
  await waitInteractable(session, ui, '[data-canvas-action="save"]', '第一次冲突保存按钮可点击')
  await ui.click('[data-canvas-action="save"]')
  try {
    await ui.waitUntil(`async () => {
      const conflict = document.querySelector('[data-canvas-conflict="5"]');
      const editor = document.querySelector('[data-canvas-kind="document"]');
      return conflict && editor?.value.includes(${JSON.stringify(localDiscardNeedle)});
    }`, { timeout: 10_000, label: '旧基线冲突保留本地稿' })
  } catch (error) {
    const [rawConflict, domState] = await Promise.all([
      session.evalJs(`return await window.electronAPI.apiRequest(${JSON.stringify({
        method: 'POST',
        url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(canvasId)}/edits`,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base_version_id: restoredDetail.data.current_version.id,
          content: `# ${localDiscardNeedle}\n\n这份本地稿将主动改用最新版本。`,
          change_summary: '冲突诊断'
        })
      })})`),
      session.evalJs(`
        const root = document.querySelector('[data-canvas-editor=${JSON.stringify(canvasId)}]');
        const save = root?.querySelector('[data-canvas-action="save"]');
        const editor = root?.querySelector('[data-canvas-kind="document"]');
        return {
          rootText: root?.innerText.slice(0, 1200) || '',
          editorValue: editor?.value || '',
          saveDisabled: save?.disabled,
          saveText: save?.innerText || '',
          conflicts: [...document.querySelectorAll('[data-canvas-conflict]')].map((node) => node.outerHTML.slice(0, 800)),
          notifications: [...document.querySelectorAll('[data-notification-id]')].map((node) => node.textContent?.trim())
        };
      `)
    ])
    console.error('[canvas-workspace-ui-smoke] 冲突状态', JSON.stringify({ rawConflict, domState }))
    throw error
  }
  await ui.click('[data-canvas-conflict-action="latest"]')
  await ui.waitUntil(`async () => {
    const editor = document.querySelector('[data-canvas-editor=${JSON.stringify(canvasId)}]');
    return !editor?.querySelector('[data-canvas-conflict]')
      && editor?.innerText.includes('v5')
      && editor?.querySelector('[data-canvas-kind="document"]')?.value.includes(${JSON.stringify(remoteV5Needle)});
  }`, { timeout: 8_000, label: '冲突时明确采用最新版本' })

  await fillExact(session, ui, '[data-canvas-kind="document"]', `# ${localKeepNeedle}\n\n这份本地稿将明确另存新版本。`, '第二份本地稿')
  await ui.waitUntil(`async () => {
    const root = document.querySelector('[data-canvas-editor=${JSON.stringify(canvasId)}]');
    return root?.querySelector('[data-canvas-action="save"]')?.disabled === false
      && root?.querySelector('[data-canvas-kind="document"]')?.value.includes(${JSON.stringify(localKeepNeedle)});
  }`, { timeout: 5_000, label: '第二份本地稿进入未保存状态' })
  const remoteV6 = await apiJson(session, {
    method: 'POST',
    url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(canvasId)}/edits`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_version_id: remoteV5.data.canvas.current_version.id,
      content: `# ${remoteV6Needle}\n\n服务端再次产生新版本。`,
      change_summary: '并发远端更新 v6'
    })
  })
  assert.equal(remoteV6?.data?.canvas?.current_version?.version_number, 6, JSON.stringify(remoteV6))
  await waitInteractable(session, ui, '[data-canvas-action="save"]', '第二次冲突保存按钮可点击')
  await ui.click('[data-canvas-action="save"]')
  try {
    await ui.waitFor('[data-canvas-conflict="6"]', { timeout: 10_000 })
  } catch (error) {
    const [current, domState] = await Promise.all([
      apiJson(session, {
        method: 'GET',
        url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(canvasId)}`,
        headers: {}, body: null
      }),
      session.evalJs(`
        const root = document.querySelector('[data-canvas-editor=${JSON.stringify(canvasId)}]');
        const save = root?.querySelector('[data-canvas-action="save"]');
        const editor = root?.querySelector('[data-canvas-kind="document"]');
        return {
          rootText: root?.innerText.slice(0, 1200) || '',
          editorValue: editor?.value || '',
          saveDisabled: save?.disabled,
          conflicts: [...document.querySelectorAll('[data-canvas-conflict]')].map((node) => node.outerHTML.slice(0, 800)),
          notifications: [...document.querySelectorAll('[data-notification-id]')].map((node) => node.textContent?.trim())
        };
      `)
    ])
    console.error('[canvas-workspace-ui-smoke] 第二次冲突状态', JSON.stringify({ current, domState }))
    throw error
  }
  await ui.click('[data-canvas-conflict-action="local"]')
  await ui.waitUntil(`async () => {
    const editor = document.querySelector('[data-canvas-editor=${JSON.stringify(canvasId)}]');
    return !editor?.querySelector('[data-canvas-conflict]')
      && editor?.innerText.includes('v7')
      && editor?.querySelector('[data-canvas-kind="document"]')?.value.includes(${JSON.stringify(localKeepNeedle)});
  }`, { timeout: 12_000, label: '冲突时本地稿另存为 v7' })
  await captureReadmeScreenshot(session)

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(conversationSelector, { timeout: 30_000 })
  const persisted = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/sessions/${encodeURIComponent(sessionId)}/canvases/${encodeURIComponent(canvasId)}`,
    headers: {}, body: null
  })
  assert.equal(persisted?.data?.current_version?.version_number, 7, JSON.stringify(persisted))
  assert.equal(persisted?.data?.versions?.length, 7)
  assert.match(persisted?.data?.content || '', new RegExp(localKeepNeedle))

  console.log('[canvas-workspace-ui-smoke] PASS Canvas 新建、编辑、选区、建议、恢复、并发冲突双分支、v7 重载持久化')
} finally {
  try { await session?.close() } catch { /* ignore */ }
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
