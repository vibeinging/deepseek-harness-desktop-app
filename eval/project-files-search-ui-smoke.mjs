import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url))
const BetterSqlite3 = requireFromServer('better-sqlite3')

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'project-files-search-ui-smoke-'))
const firstRoot = path.join(evalHome, 'source-main')
const secondRoot = path.join(evalHome, 'source-extra')
const nestedRoot = path.join(firstRoot, 'docs', 'nested')
const projectName = `项目文件验收 ${Date.now()}`
const conversationTitle = '项目文件测试对话'
const bodyNeedle = `project-files-body-${Date.now()}`

function seedVisibleConversation(databasePath, sessionId) {
  const db = new BetterSqlite3(databasePath)
  try {
    db.prepare(`
      INSERT INTO session_messages
        (id, session_id, role, content_items, sequence_number, created_at, updated_at)
      VALUES (?, ?, 'user', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(randomUUID(), sessionId, JSON.stringify([{ type: 'text', text: '项目文件验收' }]))
    db.prepare(`UPDATE sessions SET message_count=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(sessionId)
  } finally {
    db.close()
  }
}

async function markVisible(session, selector, marker) {
  return session.evalJs(`
    const selector = ${JSON.stringify(selector)};
    const marker = ${JSON.stringify(marker)};
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && rect.left >= 0
        && rect.top >= 0
        && rect.right <= window.innerWidth
        && rect.bottom <= window.innerHeight
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number(style.opacity || 1) > 0;
    };
    for (const element of document.querySelectorAll('[' + marker + ']')) {
      element.removeAttribute(marker);
    }
    const element = [...document.querySelectorAll(selector)].find(visible);
    if (!element) return null;
    element.setAttribute(marker, 'true');
    return '[' + marker + '="true"]';
  `)
}

async function hasVisible(session, selector) {
  return session.evalJs(`
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0
        && rect.height > 0
        && rect.left >= 0
        && rect.top >= 0
        && rect.right <= window.innerWidth
        && rect.bottom <= window.innerHeight
        && style.visibility !== 'hidden'
        && style.display !== 'none'
        && Number(style.opacity || 1) > 0;
    };
    return [...document.querySelectorAll(${JSON.stringify(selector)})].some(visible);
  `)
}

mkdirSync(nestedRoot, { recursive: true })
mkdirSync(secondRoot, { recursive: true })
const canonicalFirstRoot = realpathSync(firstRoot)
const canonicalSecondRoot = realpathSync(secondRoot)
writeFileSync(path.join(firstRoot, 'docs', 'plan.md'), `# 交付计划\n${bodyNeedle}\n`, 'utf8')
writeFileSync(path.join(nestedRoot, 'notes.txt'), '按需展开后可见的深层文件', 'utf8')
writeFileSync(path.join(secondRoot, 'extra.txt'), '补充资料', 'utf8')

process.env.DSH_EVAL_ISOLATED = '1'
process.env.DSH_EVAL_HOME = evalHome
process.env.DSH_USER_DATA_DIR = path.join(evalHome, 'electron-user-data')

let session = null
try {
  session = await openSession({ port: 9355 })
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
        source_folders: [
          { path: ${JSON.stringify(firstRoot)}, name: '主要资料' },
          { path: ${JSON.stringify(secondRoot)}, name: '补充资料' }
        ]
      })
    });
    const projectId = projectResponse.json?.data?.id || projectResponse.json?.data?.project_id;
    if (!projectId) return { project: projectResponse.json, projectId: null };
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
    return {
      project: projectResponse.json,
      projectId,
      session: sessionResponse.json,
      sessionId: sessionResponse.json?.data?.id
    };
  `, { timeoutMs: 20_000 })
  assert.equal(typeof prepared.projectId, 'string', JSON.stringify(prepared))
  assert.equal(typeof prepared.sessionId, 'string', JSON.stringify(prepared))
  seedVisibleConversation(path.join(evalHome, '.dsh', 'local.db'), prepared.sessionId)

  const initialFolders = await session.evalJs(`
    const response = await window.electronAPI.apiRequest({
      method: 'GET',
      url: '/api/projects/' + encodeURIComponent(${JSON.stringify(prepared.projectId)}) + '/source-folders',
      headers: {},
      body: null
    });
    return response.json?.data || [];
  `)
  assert.equal(initialFolders.length, 2)
  assert.equal(initialFolders.filter((folder) => folder.write_target).length, 1)
  assert.equal(initialFolders[0].write_target, true)
  const initialIdsByPath = Object.fromEntries(initialFolders.map((folder) => [folder.path, folder.id]))

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
  assert.ok(activation.ids.includes(prepared.sessionId), `权威会话列表缺少文件测试会话: ${JSON.stringify(activation)}`)

  const conversationSelector = `[data-agent-conv-id="${prepared.sessionId}"]`
  await ui.waitFor(conversationSelector, { timeout: 20_000 })
  await ui.click(conversationSelector)
  const workspaceCollapsed = await session.evalJs(`
    return document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed');
  `)
  assert.match(String(workspaceCollapsed), /^(true|false)$/, `右侧栏折叠状态异常: ${String(workspaceCollapsed)}`)
  if (workspaceCollapsed === 'true') {
    await ui.click('[data-edge-toggle="workspace"]')
    await ui.waitUntil(`async () => {
      return document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') === 'false';
    }`, { timeout: 10_000, label: '右侧栏已正式展开' })
  }
  await ui.waitUntil(`async () => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return [...document.querySelectorAll('[data-workbench-tab="files"], [data-workbench-empty-action="files"], [data-workbench-add]')].some(visible);
  }`, { timeout: 15_000, label: 'DSH Profile 文件工具入口已加载' })
  if (!(await hasVisible(session, '[placeholder="搜索文件名或正文"]'))) {
    let filesEntry = '[data-workbench-tab="files"]'
    if (!(await ui.exists(filesEntry))) {
      if (await ui.exists('[data-workbench-empty-action="files"]')) {
        filesEntry = '[data-workbench-empty-action="files"]'
      } else {
        await ui.click('[data-workbench-add]')
        await ui.waitFor('[data-workbench-add-option="files"]', { timeout: 5_000 })
        filesEntry = '[data-workbench-add-option="files"]'
      }
    }
    await ui.waitUntil(`async () => {
      const inViewport = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0
          && rect.height > 0
          && rect.left >= 0
          && rect.top >= 0
          && rect.right <= window.innerWidth
          && rect.bottom <= window.innerHeight
          && style.visibility !== 'hidden'
          && style.display !== 'none';
      };
      return [...document.querySelectorAll(${JSON.stringify(filesEntry)})].some(inViewport);
    }`, { timeout: 10_000, label: '文件工具入口已进入窗口可见区' })
    const filesTarget = await markVisible(
      session,
      filesEntry,
      'data-project-files-smoke-target',
    )
    assert.equal(typeof filesTarget, 'string', '找不到可见的文件工具入口')
    await ui.click(filesTarget, { timeout: 10_000 })
  }
  try {
    await ui.waitUntil(`async () => {
      const visible = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      return [...document.querySelectorAll('[placeholder="搜索文件名或正文"]')].some(visible);
    }`, { timeout: 10_000, label: '文件工具已打开' })
  } catch (error) {
    const state = await session.evalJs(`
      const describe = (element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return {
          tag: element.tagName,
          text: element.textContent?.trim(),
          action: element.getAttribute('data-workbench-empty-action'),
          tab: element.getAttribute('data-workbench-tab'),
          active: element.getAttribute('data-active'),
          collapsed: element.getAttribute('data-collapsed'),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display,
          visibility: style.visibility,
        };
      };
      return {
        toggles: [...document.querySelectorAll('[data-edge-toggle="workspace"]')].map(describe),
        actions: [...document.querySelectorAll('[data-workbench-empty-action]')].map(describe),
        tabs: [...document.querySelectorAll('[data-workbench-tab]')].map(describe),
        inputs: [...document.querySelectorAll('input')].map(describe),
        text: document.body.innerText.slice(-1500),
      };
    `)
    throw new Error(`${error.message}\n右侧栏状态: ${JSON.stringify(state)}`)
  }
  await ui.waitUntil(`async () => document.body.innerText.includes('主要资料') && document.body.innerText.includes('docs')`, {
    timeout: 10_000,
    label: '项目 Sources 和第一层目录可见'
  })
  await ui.waitUntil(`async () => {
    const roots = [...document.querySelectorAll('[class*="wsFileRootMode"]')].map((item) => item.textContent?.trim());
    return roots.includes('写入位置') && roots.includes('只读');
  }`, { timeout: 10_000, label: '项目文件侧栏明确显示写入位置和只读来源' })

  await ui.click('button[title="docs"]')
  await ui.waitUntil(`async () => document.body.innerText.includes('plan.md') && document.body.innerText.includes('nested')`, {
    timeout: 10_000,
    label: '第一层目录按需加载'
  })
  await ui.click('button[title="docs/nested"]')
  await ui.waitUntil(`async () => document.body.innerText.includes('notes.txt')`, {
    timeout: 10_000,
    label: '深层目录按需加载'
  })

  await ui.fill('[placeholder="搜索文件名或正文"]', bodyNeedle)
  await ui.waitUntil(`async () => {
    const list = document.querySelector('[class*="wsFilesList"]');
    return list?.innerText.includes('plan.md') && list?.innerText.includes(${JSON.stringify(bodyNeedle)});
  }`, { timeout: 15_000, label: '侧栏用随包 rg 命中文件正文' })

  await ui.press(process.platform === 'darwin' ? 'Meta+k' : 'Ctrl+k')
  await ui.waitFor('[placeholder="搜索项目、对话、文件、产物或网页来源…"]', { timeout: 5_000 })
  await ui.fill('[placeholder="搜索项目、对话、文件、产物或网页来源…"]', bodyNeedle)
  await ui.click('[aria-label="结果类型"]')
  await ui.clickText('文件', { selector: '[role="option"]', exact: true })
  await ui.click('[aria-label="项目范围"]')
  await ui.clickText(projectName, { selector: '[role="option"]', exact: true })
  await ui.click('[aria-label="更新时间"]')
  await ui.clickText('30 天', { selector: '[role="option"]', exact: true })
  await ui.waitUntil(`async () => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog?.innerText.includes('plan.md') && dialog?.innerText.includes(${JSON.stringify(bodyNeedle)});
  }`, { timeout: 15_000, label: '全局搜索的类型、项目和时间筛选生效' })
  await ui.press('Escape')

  const switchedFolders = await session.evalJs(`
    const response = await window.electronAPI.apiRequest({
      method: 'PUT',
      url: '/api/projects/' + encodeURIComponent(${JSON.stringify(prepared.projectId)}) + '/source-folders',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders: [
        { path: ${JSON.stringify(canonicalFirstRoot)}, name: '主要资料', access_mode: 'read' },
        { path: ${JSON.stringify(canonicalSecondRoot)}, name: '补充资料', write_target: true }
      ] })
    });
    return response.json?.data || [];
  `)
  assert.equal(switchedFolders.filter((folder) => folder.write_target).length, 1)
  assert.equal(switchedFolders[1].write_target, true)
  assert.equal(switchedFolders[0].id, initialIdsByPath[canonicalFirstRoot])
  assert.equal(switchedFolders[1].id, initialIdsByPath[canonicalSecondRoot])

  rmSync(secondRoot, { recursive: true, force: true })
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitUntil(`async () => document.body.innerText.includes(${JSON.stringify(projectName)})`, {
    timeout: 20_000,
    label: '删除一个本地目录后项目仍可加载'
  })
  await ui.waitUntil(`async () => /^(true|false)$/.test(
    document.querySelector('[data-edge-toggle="nav"]')?.getAttribute('data-collapsed') || ''
  )`, { timeout: 10_000, label: '左侧栏初始化完成' })
  const navCollapsed = await session.evalJs(`
    return document.querySelector('[data-edge-toggle="nav"]')?.getAttribute('data-collapsed');
  `)
  assert.match(String(navCollapsed), /^(true|false)$/, `左侧栏折叠状态异常: ${String(navCollapsed)}`)
  if (navCollapsed === 'true') {
    await ui.click('[data-edge-toggle="nav"]')
    await ui.waitUntil(`async () => {
      return document.querySelector('[data-edge-toggle="nav"]')?.getAttribute('data-collapsed') === 'false';
    }`, { timeout: 10_000, label: '左侧栏已展开' })
  }
  const projectMenuSelector = `[aria-label=${JSON.stringify(`查看项目 ${projectName}`)}]`
  await ui.waitUntil(`async () => {
    const element = document.querySelector(${JSON.stringify(projectMenuSelector)});
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
  }`, { timeout: 10_000, label: '项目菜单已进入窗口可见区' })
  await ui.click(projectMenuSelector)
  const settingsSelector = `[aria-label=${JSON.stringify(`打开${projectName}的项目设置`)}]`
  try {
    await ui.waitUntil(`async () => {
      const element = document.querySelector(${JSON.stringify(settingsSelector)});
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
    }`, { timeout: 10_000, label: '项目设置入口已打开' })
  } catch (error) {
    const state = await session.evalJs(`
      const target = document.querySelector(${JSON.stringify(projectMenuSelector)});
      return {
        activeLabel: document.activeElement?.getAttribute('aria-label') || '',
        expanded: target?.getAttribute('aria-expanded'),
        controls: target?.getAttribute('aria-controls'),
        dropdownExists: Boolean(target?.getAttribute('aria-controls') && document.getElementById(target.getAttribute('aria-controls'))),
      };
    `)
    throw new Error(`${error.message}\n项目菜单状态: ${JSON.stringify(state)}`)
  }
  await ui.click(settingsSelector, { timeout: 10_000 })
  await ui.waitFor('[aria-label="文件夹显示名称"]', { timeout: 20_000 })
  await ui.waitUntil(`async () => document.body.innerText.includes('不可用') && document.body.innerText.includes('可用')`, {
    timeout: 10_000,
    label: 'Sources 显示真实可用状态'
  })

  const unavailableTargetState = await session.evalJs(`
    const target = document.querySelector(${JSON.stringify('[aria-label="写入位置 补充资料"]')});
    return { checked: target?.checked, disabled: target?.disabled };
  `)
  assert.deepEqual(unavailableTargetState, { checked: true, disabled: true })
  await ui.click('[aria-label="写入位置 主要资料"]')

  await ui.click('[aria-label="文件夹显示名称"]')
  await ui.press('End')
  for (let index = 0; index < 80; index += 1) await ui.press('Backspace')
  await ui.typeText('主要资料（改名）')
  await ui.click('[aria-label="下移"]')
  await ui.clickText('保存', { exact: true })
  let savedFolders
  try {
    savedFolders = await ui.waitUntil(`async () => {
      const response = await window.electronAPI.apiRequest({
        method: 'GET',
        url: '/api/projects/' + encodeURIComponent(${JSON.stringify(prepared.projectId)}) + '/source-folders',
        headers: {},
        body: null
      });
      const folders = response.json?.data;
      return Array.isArray(folders)
        && folders.length === 2
        && folders[0]?.path === ${JSON.stringify(canonicalSecondRoot)}
        && folders[1]?.name === '主要资料（改名）'
        ? folders
        : false;
    }`, { timeout: 10_000, label: '离线 Source 的改名和排序可保存' })
  } catch (error) {
    const state = await session.evalJs(`
      const response = await window.electronAPI.apiRequest({
        method: 'GET',
        url: '/api/projects/' + encodeURIComponent(${JSON.stringify(prepared.projectId)}) + '/source-folders',
        headers: {},
        body: null
      });
      return { response: response.json, text: document.body.innerText.slice(-1000) };
    `)
    throw new Error(`${error.message}\nSource 保存状态: ${JSON.stringify(state)}`)
  }
  assert.equal(savedFolders[0].available, false)
  assert.equal(savedFolders[0].write_target, false)
  assert.equal(savedFolders[1].write_target, true)
  assert.equal(savedFolders.filter((folder) => folder.write_target).length, 1)
  assert.equal(savedFolders[0].id, initialIdsByPath[canonicalSecondRoot])
  assert.equal(savedFolders[1].id, initialIdsByPath[canonicalFirstRoot])

  await ui.click('[aria-label^="移除文件夹"]')
  await ui.waitUntil(`async () => document.body.innerText.includes('本地文件不会被删除')`, {
    timeout: 5_000,
    label: '移除 Source 前二次确认'
  })
  await ui.clickText('取消', { exact: true })

  const conflict = await session.evalJs(`
    const response = await window.electronAPI.apiRequest({
      method: 'PUT',
      url: '/api/projects/' + encodeURIComponent(${JSON.stringify(prepared.projectId)}) + '/source-folders',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folders: [
        { path: ${JSON.stringify(canonicalFirstRoot)}, name: '父目录' },
        { path: ${JSON.stringify(path.join(canonicalFirstRoot, 'docs'))}, name: '子目录' }
      ] })
    });
    return response.json;
  `)
  assert.equal(conflict?.success, false)
  assert.match(conflict?.message || '', /范围重叠/)

  console.log('[project-files-search-ui-smoke] PASS Sources 唯一写入目标/稳定 ID/状态/改名/排序/移除确认/冲突 + 目录按需展开 + 正文搜索 + 全局筛选')
} finally {
  try { await session?.close() } catch { /* ignore */ }
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
