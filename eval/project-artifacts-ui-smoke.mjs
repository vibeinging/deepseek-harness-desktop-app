import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url))
const BetterSqlite3 = requireFromServer('better-sqlite3')

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'project-artifacts-ui-smoke-'))
const sourceRoot = path.join(evalHome, 'source')
const reportPath = path.join(sourceRoot, 'artifact-report.md')
const projectName = `项目产物验收 ${Date.now()}`
const conversationTitle = '项目产物测试对话'
const v1Needle = `artifact-v1-${Date.now()}`
const v2Needle = `artifact-v2-${Date.now()}`

function seedVisibleConversation(databasePath, sessionId) {
  const db = new BetterSqlite3(databasePath)
  try {
    db.prepare(`
      INSERT INTO session_messages
        (id, session_id, role, content_items, sequence_number, created_at, updated_at)
      VALUES (?, ?, 'user', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(randomUUID(), sessionId, JSON.stringify([{ type: 'text', text: '项目产物验收' }]))
    db.prepare(`UPDATE sessions SET message_count=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(sessionId)
  } finally {
    db.close()
  }
}

mkdirSync(sourceRoot, { recursive: true })
writeFileSync(reportPath, `# 项目报告\n\n${v1Needle}\n`, 'utf8')

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
  }`, { timeout: 10_000, label: `右侧栏 ${name} 入口进入窗口` })
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
  const target = await markVisible(session, selector, 'data-project-artifact-smoke-target')
  if (typeof target !== 'string') {
    const state = await session.evalJs(`
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          text: element.textContent?.trim(),
          tab: element.getAttribute('data-workbench-tab'),
          action: element.getAttribute('data-workbench-empty-action'),
          collapsed: element.getAttribute('data-collapsed'),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility
        };
      };
      return {
        viewport: { width: innerWidth, height: innerHeight },
        toggles: [...document.querySelectorAll('[data-edge-toggle]')].map(describe),
        actions: [...document.querySelectorAll('[data-workbench-empty-action]')].map(describe),
        tabs: [...document.querySelectorAll('[data-workbench-tab]')].map(describe),
        body: document.body.innerText.slice(-1200)
      };
    `)
    throw new Error(`找不到可见的右侧栏工具入口: ${name}\n${JSON.stringify(state)}`)
  }
  await ui.click(target, { timeout: 10_000 })
}

async function apiJson(session, request) {
  return session.evalJs(`
    const response = await window.electronAPI.apiRequest(${JSON.stringify(request)});
    return response.json;
  `, { timeoutMs: 20_000 })
}

let session = null
try {
  session = await openSession({ port: 9357 })
  const ui = makeUiDriver(session)
  const driver = makeDriver(session)
  await driver.login()
  await session.evalJs(`
    localStorage.setItem('dsh:onboarding:completed:v1', 'true');
    return true;
  `)

  const prepared = await session.evalJs(`
    const projectResponse = await window.electronAPI.apiRequest({
      method: 'POST',
      url: '/api/projects',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: ${JSON.stringify(projectName)},
        source_folders: [{ path: ${JSON.stringify(sourceRoot)}, name: '交付文件' }]
      })
    });
    const projectId = projectResponse.json?.data?.id || projectResponse.json?.data?.project_id;
    const sessionResponse = await window.electronAPI.apiRequest({
      method: 'POST',
      url: '/api/projects/' + encodeURIComponent(projectId) + '/sessions',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: ${JSON.stringify(conversationTitle)},
        source_type: 'agent',
        source_id: projectId,
        action_type: 'agentic_chat'
      })
    });
    return { projectId, sessionId: sessionResponse.json?.data?.id };
  `, { timeoutMs: 20_000 })
  assert.equal(typeof prepared.projectId, 'string', JSON.stringify(prepared))
  assert.equal(typeof prepared.sessionId, 'string', JSON.stringify(prepared))
  seedVisibleConversation(path.join(evalHome, '.dsh', 'local.db'), prepared.sessionId)

  await ui.goto('/agent')
  await ui.waitUntil(`async () => Boolean(
    window.electronAPI?.apiRequest && document.querySelector('[data-edge-toggle="workspace"]')
  )`, { timeout: 30_000, label: '真实桌面已就绪' })
  const activation = await session.evalJs(`
    const pid = ${JSON.stringify(prepared.projectId)};
    const sid = ${JSON.stringify(prepared.sessionId)};
    const detail = await window.electronAPI.apiRequest({
      method: 'GET',
      url: '/api/projects/' + encodeURIComponent(pid),
      headers: { 'Content-Type': 'application/json' },
      body: null,
    });
    const { useProjectStore } = await import('/src/store/project.ts');
    const { eventBus, EVENT_TYPES } = await import('/src/utils/eventBus.ts');
    useProjectStore.getState().setCurrentProject(detail?.json?.data);
    eventBus.emit(EVENT_TYPES.NEW_session_CREATED, { sessionId: sid, workspaceId: pid, projectId: pid });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const listed = await window.electronAPI.apiRequest({
      method: 'GET',
      url: '/api/agent/projects/' + encodeURIComponent(pid) + '/sessions',
      headers: { 'Content-Type': 'application/json' },
      body: null,
    });
    const data = listed?.json?.data;
    return {
      response: listed?.json,
      ids: (Array.isArray(data) ? data : data?.items || []).map((item) => item.id),
    };
  `, { timeoutMs: 20_000 })
  assert.ok(activation.ids.includes(prepared.sessionId), `权威会话列表缺少产物测试会话: ${JSON.stringify(activation)}`)
  const conversationSelector = `[data-agent-conv-id="${prepared.sessionId}"]`
  await ui.waitFor(conversationSelector, { timeout: 30_000 })
  await ui.click(conversationSelector)

  await ui.waitUntil(`async () => /^(true|false)$/.test(
    document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') || ''
  )`, { timeout: 10_000, label: '右侧栏初始化' })
  const workspaceCollapsed = await session.evalJs(`
    return document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed');
  `)
  if (workspaceCollapsed === 'true') {
    await ui.click('[data-edge-toggle="workspace"]')
    await ui.waitUntil(`async () => document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') === 'false'`, {
      timeout: 10_000,
      label: '右侧栏展开'
    })
  }

  await openWorkbenchTool(session, ui, 'files')
  await ui.waitFor('[placeholder="搜索文件名或正文"]', { timeout: 15_000 })
  await ui.click('button[title="artifact-report.md"]')
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(v1Needle)})`, {
    timeout: 10_000,
    label: '文件 v1 预览可见'
  })
  await ui.click('[data-file-action="publish-artifact"]')
  await ui.waitFor('[data-artifact-detail]', { timeout: 15_000 })

  let artifactList = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/${encodeURIComponent(prepared.projectId)}/artifacts`,
    headers: {},
    body: null
  })
  const artifactId = artifactList?.data?.items?.[0]?.id
  assert.equal(typeof artifactId, 'string', JSON.stringify(artifactList))
  await ui.waitUntil(`async () => {
    const detail = document.querySelector('[data-artifact-detail=${JSON.stringify(artifactId)}]');
    return detail?.innerText.includes('1 个版本') && detail?.innerText.includes(${JSON.stringify(v1Needle)});
  }`, { timeout: 15_000, label: '加入文件后自动打开产物 v1' })

  writeFileSync(reportPath, `# 项目报告\n\n${v2Needle}\n新增结论\n`, 'utf8')
  await openWorkbenchTool(session, ui, 'files')
  await ui.waitFor('[placeholder="搜索文件名或正文"]', { timeout: 10_000 })
  await ui.click('button[title="artifact-report.md"]')
  await ui.click('[data-file-action="publish-artifact"]')
  try {
    await ui.waitUntil(`async () => {
      const detail = document.querySelector('[data-artifact-detail=${JSON.stringify(artifactId)}]');
      return detail?.innerText.includes('2 个版本')
        && detail?.querySelector('[data-artifact-version="2"][data-active="true"]')
        && detail?.innerText.includes(${JSON.stringify(v2Needle)});
    }`, { timeout: 15_000, label: '同一文件形成稳定产物 v2' })
  } catch (error) {
    const state = await session.evalJs(`
      const list = await window.electronAPI.apiRequest({
        method: 'GET',
        url: ${JSON.stringify(`/api/agent/projects/${encodeURIComponent(prepared.projectId)}/artifacts`)},
        headers: {},
        body: null,
      });
      return {
        list: list?.json,
        detail: document.querySelector('[data-artifact-detail]')?.innerText || '',
        filePreview: document.querySelector('[data-project-file-preview]')?.innerText || '',
        tail: document.body.innerText.slice(-1200),
      };
    `)
    throw new Error(`${error.message}\n产物 v2 状态: ${JSON.stringify(state)}`)
  }

  await ui.click('[data-artifact-version="1"]')
  await ui.waitUntil(`async () => {
    const detail = document.querySelector('[data-artifact-detail=${JSON.stringify(artifactId)}]');
    return detail?.querySelector('[data-artifact-version="1"][data-active="true"]')
      && detail?.innerText.includes(${JSON.stringify(v1Needle)});
  }`, { timeout: 10_000, label: '历史 v1 可预览' })
  await ui.clickText('比较', { selector: 'button', exact: true })
  await ui.waitUntil(`async () => {
    const diff = document.querySelector('[data-artifact-diff="office-markdown"]');
    return diff?.innerText.includes(${JSON.stringify(v1Needle)})
      && diff?.innerText.includes(${JSON.stringify(v2Needle)});
  }`, { timeout: 10_000, label: 'v1 与当前版本差异可见' })

  await ui.click('[data-artifact-action="restore"]')
  await ui.waitUntil(`async () => document.body.innerText.includes('恢复会创建一个新的当前版本，已有历史不会被覆盖。')`, {
    timeout: 5_000,
    label: '恢复版本确认说明可见'
  })
  await ui.clickText('恢复为新版本', { selector: 'button', exact: true })
  await ui.waitUntil(`async () => {
    const detail = document.querySelector('[data-artifact-detail=${JSON.stringify(artifactId)}]');
    return detail?.innerText.includes('3 个版本')
      && detail?.querySelector('[data-artifact-version="3"][data-active="true"]')
      && detail?.innerText.includes(${JSON.stringify(v1Needle)});
  }`, { timeout: 15_000, label: '恢复 v1 后创建 v3 且历史仍在' })
  await ui.waitUntil(`async () => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== 'hidden' && style.display !== 'none'
        && Number(style.opacity || 1) > 0;
    };
    return ![...document.querySelectorAll('[role="dialog"]')].some(visible);
  }`, { timeout: 5_000, label: '恢复确认弹窗关闭' })

  const detailResponse = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/${encodeURIComponent(prepared.projectId)}/artifacts/${encodeURIComponent(artifactId)}`,
    headers: {},
    body: null
  })
  const currentVersion = detailResponse?.data?.current_version
  assert.equal(currentVersion?.version_number, 3, JSON.stringify(detailResponse))
  assert.equal(detailResponse?.data?.versions?.length, 3)

  await ui.waitUntil(`async () => {
    const button = document.querySelector('[data-artifact-action="reference"]');
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit?.closest?.('[data-artifact-action]')?.getAttribute('data-artifact-action') === 'reference';
  }`, { timeout: 10_000, label: '通知退场后引用按钮可点击' })
  await ui.click('[data-artifact-action="reference"]')
  try {
    await ui.waitUntil(`async () => {
      const input = document.querySelector('[data-testid="agent-message-input"]');
      const attachment = document.querySelector('[data-artifact-id=${JSON.stringify(artifactId)}]');
      return input?.value === ''
        && attachment?.getAttribute('data-artifact-version-id') === ${JSON.stringify(currentVersion.id)}
        && attachment?.getAttribute('data-artifact-version-number') === '3';
    }`, { timeout: 10_000, label: '精确 v3 引用进入草稿且没有自动发送' })
  } catch (error) {
    const state = await session.evalJs(`
      const reference = document.querySelector('[data-artifact-action="reference"]');
      const rect = reference?.getBoundingClientRect();
      const hit = rect ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null;
      return {
        input: document.querySelector('[data-testid="agent-message-input"]')?.value || '',
        reference: reference ? {
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          disabled: reference.disabled,
          pointerEvents: getComputedStyle(reference).pointerEvents,
          active: document.activeElement === reference,
          hitTag: hit?.tagName,
          hitAction: hit?.closest?.('[data-artifact-action]')?.getAttribute('data-artifact-action') || null,
          hitText: hit?.textContent?.trim() || ''
        } : null,
        attachments: [...document.querySelectorAll('[data-artifact-id]')].map((element) => ({
          artifactId: element.getAttribute('data-artifact-id'),
          versionId: element.getAttribute('data-artifact-version-id'),
          versionNumber: element.getAttribute('data-artifact-version-number'),
          title: element.getAttribute('title'),
          text: element.textContent?.trim()
        })),
        detail: document.querySelector('[data-artifact-detail]')?.innerText || '',
        tail: document.body.innerText.slice(-1000)
      };
    `)
    throw new Error(`${error.message}\n引用状态: ${JSON.stringify(state)}`)
  }

  const persistedDraft = await session.evalJs(`
    await new Promise((resolve) => setTimeout(resolve, 100));
    const key = 'dsh-conversation-draft:v1:' + encodeURIComponent(${JSON.stringify(`${prepared.projectId}:${prepared.sessionId}`)});
    return JSON.parse(localStorage.getItem(key) || '{}');
  `)
  assert.equal(persistedDraft.attachments?.[0]?.artifactId, artifactId)
  assert.equal(persistedDraft.attachments?.[0]?.artifactVersionId, currentVersion.id)
  assert.equal(persistedDraft.attachments?.[0]?.artifactVersionNumber, 3)

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor(conversationSelector, { timeout: 30_000 })
  await ui.click(conversationSelector)
  await ui.waitUntil(`async () => {
    const input = document.querySelector('[data-testid="agent-message-input"]');
    const attachment = document.querySelector('[data-artifact-id=${JSON.stringify(artifactId)}]');
    return input?.value === ''
      && attachment?.getAttribute('data-artifact-version-id') === ${JSON.stringify(currentVersion.id)};
  }`, { timeout: 10_000, label: 'App 重载后仍保留精确产物版本引用' })

  const reloadedWorkspaceCollapsed = await session.evalJs(`
    return document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed');
  `)
  if (reloadedWorkspaceCollapsed === 'true') await ui.click('[data-edge-toggle="workspace"]')
  await openWorkbenchTool(session, ui, 'files')
  await ui.waitFor('[placeholder="搜索文件名或正文"]', { timeout: 10_000 })

  await ui.press(process.platform === 'darwin' ? 'Meta+k' : 'Ctrl+k')
  const searchInput = '[placeholder="搜索项目、对话、文件、产物或网页来源…"]'
  await ui.waitFor(searchInput, { timeout: 5_000 })
  await ui.fill(searchInput, 'artifact-report')
  await ui.click('[aria-label="结果类型"]')
  await ui.clickText('产物', { selector: '[role="option"]', exact: true })
  await ui.click('[aria-label="项目范围"]')
  await ui.clickText(projectName, { selector: '[role="option"]', exact: true })
  await ui.waitUntil(`async () => {
    const result = document.querySelector('[data-search-result-kind="artifact"]');
    return result?.innerText.includes('artifact-report.md') && result?.innerText.includes('v3');
  }`, { timeout: 15_000, label: '全局搜索命中授权项目产物' })
  await ui.click('[data-search-result-kind="artifact"]')
  await ui.waitUntil(`async () => {
    const detail = document.querySelector('[data-artifact-detail=${JSON.stringify(artifactId)}]');
    return detail?.innerText.includes('3 个版本');
  }`, { timeout: 10_000, label: '全局搜索结果打开产物详情' })

  const openedTabs = await session.evalJs(`
    return [...document.querySelectorAll('[data-workbench-tab]')].map((tab) => ({
      id: tab.getAttribute('data-workbench-tab'),
      active: tab.getAttribute('data-active') === 'true'
    }));
  `)
  assert.deepEqual(openedTabs, [
    { id: 'files', active: false },
    { id: 'artifacts', active: true }
  ], '添加产物工具后必须保留文件标签')

  await ui.click('[data-workbench-tab="files"]')
  await ui.waitUntil(`async () => {
    return document.querySelector('[data-workbench-tab="files"]')?.getAttribute('data-active') === 'true'
      && Boolean(document.querySelector('[data-workbench-panel="files"]:not([hidden])'));
  }`, { timeout: 5_000, label: '切换回文件工具' })
  await ui.click('[data-workbench-tab="artifacts"]')
  await ui.waitUntil(`async () => {
    return document.querySelector('[data-workbench-tab="artifacts"]')?.getAttribute('data-active') === 'true'
      && Boolean(document.querySelector('[data-workbench-panel="artifacts"]:not([hidden])'));
  }`, { timeout: 5_000, label: '切换回产物工具' })

  await ui.click('[data-workbench-close="artifacts"]')
  await ui.waitUntil(`async () => {
    return !document.querySelector('[data-workbench-tab="artifacts"]')
      && document.querySelector('[data-workbench-tab="files"]')?.getAttribute('data-active') === 'true'
      && !document.querySelector('[data-workbench-empty]');
  }`, { timeout: 5_000, label: '关闭产物后保留文件工具' })
  await ui.click('[data-workbench-close="files"]')
  await ui.waitFor('[data-workbench-empty]', { timeout: 5_000 })

  console.log('[project-artifacts-ui-smoke] PASS UI 发布 v1/v2 + 预览/差异 + 恢复为 v3 + 精确引用持久化 + 全局搜索 + 多工具标签生命周期')
} finally {
  try { await session?.close() } catch { /* ignore */ }
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
