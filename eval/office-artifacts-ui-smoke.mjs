import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'office-artifacts-ui-smoke-'))
const sourceRoot = path.join(evalHome, 'source')
const projectName = `办公产物验收 ${Date.now()}`
const conversationTitle = '办公产物测试对话'
const fileName = 'launch-report.md'
const v1Needle = `待复核-${Date.now()}`
const v2Needle = `已通过-${Date.now()}`

mkdirSync(sourceRoot, { recursive: true })
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
  const marked = await markVisible(session, selector, 'data-office-artifact-smoke-target')
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
  session = await openSession({ port: 9358 })
  const ui = makeUiDriver(session)
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
        source_folders: [{ path: ${JSON.stringify(sourceRoot)}, name: '测试文件' }]
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
    return {
      projectId,
      sessionId: sessionResponse.json?.data?.id,
      sessionStatus: sessionResponse.status,
      sessionResponse: sessionResponse.json,
    };
  `, { timeoutMs: 20_000 })
  assert.equal(typeof prepared.projectId, 'string', JSON.stringify(prepared))
  assert.equal(typeof prepared.sessionId, 'string', JSON.stringify(prepared))

  // The product intentionally hides empty sessions from history until their first
  // visible user message. Keep the successful DSH session creation as a runtime
  // compatibility assertion, then exercise Office attachments in the project's
  // normal new-conversation draft instead of inventing a sidebar row.
  await session.evalJs(`
    localStorage.setItem('dsh-active-session', JSON.stringify({
      activeWs: ${JSON.stringify(prepared.projectId)},
      activeId: null
    }));
    return true;
  `)
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  const projectSelector = `[data-agent-workspace-id="${prepared.projectId}"]`
  try {
    await ui.waitFor(projectSelector, { timeout: 30_000 })
    await ui.waitUntil(`async () => document.querySelector(${JSON.stringify(projectSelector)})?.className.includes('wsFolderActive')`, {
      timeout: 30_000,
      label: '项目草稿成为当前工作区'
    })
  } catch (error) {
    const diagnostics = await session.evalJs(`
      const projects = await window.electronAPI.apiRequest({ method: 'GET', url: '/api/projects', headers: {}, body: null });
      return {
        location: location.href,
        body: document.body.innerText.slice(0, 4000),
        projectsStatus: projects.status,
        projects: projects.json,
      };
    `, { timeoutMs: 20_000 })
    throw new Error(`项目未进入 Agent 导航：${JSON.stringify(diagnostics)}`, { cause: error })
  }
  try {
    await ui.waitUntil(`async () => /^(true|false)$/.test(
      document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') || ''
    )`, { timeout: 15_000, label: '右侧栏初始化' })
  } catch (error) {
    const diagnostics = await session.evalJs(`
      return {
        location: location.href,
        body: document.body.innerText.slice(0, 4000),
        edgeToggles: [...document.querySelectorAll('[data-edge-toggle]')].map((element) => ({
          edge: element.getAttribute('data-edge-toggle'),
          collapsed: element.getAttribute('data-collapsed')
        })),
        activeWorkspace: document.querySelector(${JSON.stringify(projectSelector)})?.className || null
      };
    `)
    throw new Error(`右侧栏未初始化：${JSON.stringify(diagnostics)}`, { cause: error })
  }
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

  await openWorkbenchTool(session, ui, 'artifacts')
  await ui.waitFor('[data-artifact-action="create-office"]', { timeout: 15_000 })
  await ui.click('[data-artifact-action="create-office"]')
  await ui.waitFor('[data-office-create="markdown"]', { timeout: 5_000 })
  await ui.fill('[data-office-create-field="title"]', '发射报告')
  await ui.fill('[data-office-create-field="name"]', fileName)
  await ui.fill('[data-office-create-field="content"]', `状态：${v1Needle}\n\n负责人：测试组`)
  await ui.click('[data-office-create-action="confirm"]')
  await ui.waitUntil(`async () => {
    const detail = document.querySelector('[data-artifact-detail]');
    return detail?.innerText.includes(${JSON.stringify(fileName)})
      && detail?.innerText.includes(${JSON.stringify(v1Needle)});
  }`, { timeout: 15_000, label: '新建 Markdown 请求完成' })

  const artifactList = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/${encodeURIComponent(prepared.projectId)}/artifacts?q=${encodeURIComponent(fileName)}`,
    headers: {},
    body: null
  })
  const artifact = artifactList?.data?.items?.find((item) => item.name === fileName)
  assert.equal(typeof artifact?.id, 'string', JSON.stringify(artifactList))
  const artifactId = artifact.id
  const version1 = artifact.current_version
  const inspectionV1 = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/${encodeURIComponent(prepared.projectId)}/artifacts/${encodeURIComponent(artifactId)}/office`,
    headers: {},
    body: null
  })
  const originalSection = inspectionV1?.data?.document?.sections?.find((item) => item.text?.includes(v1Needle))
  assert.equal(typeof originalSection?.anchor, 'string', JSON.stringify(inspectionV1))

  await ui.waitUntil(`async () => {
    const detail = document.querySelector('[data-artifact-detail=${JSON.stringify(artifactId)}]');
    return detail?.innerText.includes(${JSON.stringify(v1Needle)})
      && Boolean(detail?.querySelector('[data-artifact-action="edit-office"]'));
  }`, { timeout: 15_000, label: '新建 Markdown v1 自动打开' })
  await ui.click('[data-artifact-action="edit-office"]')
  await ui.waitFor('[data-office-editor="markdown"]', { timeout: 15_000 })
  await ui.clickText(v1Needle, { selector: '[data-office-anchor]', timeout: 8_000 })
  await ui.click('[data-office-action="reference-selection"]')
  await ui.waitUntil(`async () => {
    const input = document.querySelector('[data-testid="agent-message-input"]');
    const attachment = document.querySelector('[data-artifact-id=${JSON.stringify(artifactId)}]');
    return input?.value === ''
      && attachment?.getAttribute('data-artifact-version-id') === ${JSON.stringify(version1.id)}
      && attachment?.getAttribute('data-artifact-selection-count') === '1'
      && attachment?.getAttribute('data-artifact-selection-anchors')?.split('\\n').includes(${JSON.stringify(originalSection.anchor)});
  }`, { timeout: 10_000, label: 'v1 精确选区作为结构化附件进入 DSH 草稿' })

  await ui.waitUntil(`async () => {
    const button = document.querySelector('[data-office-action="close"]');
    if (!button) return false;
    const rect = button.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit?.closest?.('[data-office-action]')?.getAttribute('data-office-action') === 'close';
  }`, { timeout: 10_000, label: '引用通知退场后返回详情按钮可点击' })
  await ui.click('[data-office-action="close"]')
  await ui.waitFor(`[data-artifact-detail="${artifactId}"]`, { timeout: 8_000 })
  const editResponse = await apiJson(session, {
    method: 'POST',
    url: `/api/agent/projects/${encodeURIComponent(prepared.projectId)}/artifacts/${encodeURIComponent(artifactId)}/office/edits`,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      base_version_id: version1.id,
      operations: [{ type: 'replace_text', anchor: originalSection.anchor, text: `状态：${v2Needle}` }],
      change_summary: 'Electron UI 冒烟测试定点修改'
    })
  })
  assert.equal(editResponse?.data?.artifact?.current_version?.version_number, 2, JSON.stringify(editResponse))
  await ui.click('[aria-label="刷新产物详情"]')
  await ui.waitFor('[data-artifact-version="2"]', { timeout: 15_000 })

  const detailV2 = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/${encodeURIComponent(prepared.projectId)}/artifacts/${encodeURIComponent(artifactId)}`,
    headers: {},
    body: null
  })
  assert.equal(detailV2?.data?.current_version?.version_number, 2, JSON.stringify(detailV2))
  assert.equal(detailV2?.data?.versions?.length, 2)
  const version2 = detailV2.data.current_version

  const inspection = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/${encodeURIComponent(prepared.projectId)}/artifacts/${encodeURIComponent(artifactId)}/office`,
    headers: {},
    body: null
  })
  const editedSection = inspection?.data?.document?.sections?.find((item) => item.text?.includes(v2Needle))
  assert.equal(typeof editedSection?.anchor, 'string', JSON.stringify(inspection))

  await ui.click('[data-artifact-version="1"]')
  await ui.clickText('比较', { selector: 'button', exact: true })
  await ui.waitUntil(`async () => {
    const diff = document.querySelector('[data-artifact-diff="office-markdown"]');
    return diff?.innerText.includes(${JSON.stringify(v1Needle)})
      && diff?.innerText.includes(${JSON.stringify(v2Needle)});
  }`, { timeout: 10_000, label: 'Markdown v1 与 v2 语义差异可见' })

  await ui.click('[data-artifact-version="2"]')
  await ui.click('[data-artifact-action="edit-office"]')
  await ui.waitFor('[data-office-editor="markdown"]', { timeout: 8_000 })
  await ui.clickText(v2Needle, { selector: '[data-office-anchor]', timeout: 8_000 })
  await ui.click('[data-office-action="reference-selection"]')
  await ui.waitUntil(`async () => {
    const input = document.querySelector('[data-testid="agent-message-input"]');
    const attachment = document.querySelector('[data-artifact-id=${JSON.stringify(artifactId)}]');
    return input?.value === ''
      && attachment?.getAttribute('data-artifact-version-id') === ${JSON.stringify(version2.id)}
      && attachment?.getAttribute('data-artifact-selection-count') === '1'
      && attachment?.getAttribute('data-artifact-selection-anchors')?.split('\\n').includes(${JSON.stringify(editedSection.anchor)});
  }`, { timeout: 10_000, label: '精确选区和 v2 进入 DSH 草稿' })

  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitUntil(`async () => document.querySelector(${JSON.stringify(projectSelector)})?.className.includes('wsFolderActive')`, {
    timeout: 30_000,
    label: '重载后恢复项目草稿'
  })
  const persisted = await apiJson(session, {
    method: 'GET',
    url: `/api/agent/projects/${encodeURIComponent(prepared.projectId)}/artifacts/${encodeURIComponent(artifactId)}`,
    headers: {},
    body: null
  })
  assert.equal(persisted?.data?.current_version?.id, version2.id)
  assert.equal(persisted?.data?.versions?.length, 2)

  console.log('[office-artifacts-ui-smoke] PASS UI 新建 Markdown v1 + 定点编辑 v2 + 语义差异 + 精确选区作为结构化附件进入 DSH 草稿 + 重载持久化')
} finally {
  try { await session?.close() } catch { /* ignore */ }
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
