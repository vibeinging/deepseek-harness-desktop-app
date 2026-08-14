import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const requireFromServer = createRequire(new URL('../server/package.json', import.meta.url))
const BetterSqlite3 = requireFromServer('better-sqlite3')

const root = path.resolve(import.meta.dirname, '..')
const outputDir = path.join(root, 'docs', 'images', 'readme')
const framesDir = path.join(root, '.playwright-mcp', 'dsh-worktree-frames')
const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-worktree-demo-'))
const projectName = 'dsh-work Desktop'
const branch = 'feature/release-notes'

mkdirSync(outputDir, { recursive: true })
rmSync(framesDir, { recursive: true, force: true })
mkdirSync(framesDir, { recursive: true })
writeFileSync(path.join(projectRoot, 'README.md'), '# dsh-work Desktop\n', 'utf8')
writeFileSync(path.join(projectRoot, 'note.txt'), 'line1\nbefore\nline3\n', 'utf8')
execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot, stdio: 'ignore' })
execFileSync('git', ['config', 'user.email', 'readme@example.com'], { cwd: projectRoot, stdio: 'ignore' })
execFileSync('git', ['config', 'user.name', 'README Capture'], { cwd: projectRoot, stdio: 'ignore' })
execFileSync('git', ['add', '.'], { cwd: projectRoot, stdio: 'ignore' })
execFileSync('git', ['commit', '-m', 'Initial fixture'], { cwd: projectRoot, stdio: 'ignore' })

async function capture(session, name, staticName = '') {
  await session.evalJs(`
    for (let pass = 0; pass < 3; pass += 1) {
      for (const notification of document.querySelectorAll('[role="alert"]')) {
        const buttons = [...notification.querySelectorAll('button')];
        const close = buttons.find((button) => /close|关闭/i.test(button.getAttribute('aria-label') || '')) || buttons.at(-1);
        close?.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return document.querySelectorAll('[role="alert"]').length;
  `)
  await session.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500 })
  const shot = await session.cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  })
  const bytes = Buffer.from(shot.data, 'base64')
  const framePath = path.join(framesDir, `${name}.png`)
  writeFileSync(framePath, bytes)
  if (staticName) writeFileSync(path.join(outputDir, staticName), bytes)
  return framePath
}

async function dismissNotifications(session, ui) {
  await session.evalJs(`
    for (const notification of document.querySelectorAll('[role="alert"]')) {
      const close = notification.querySelector('button');
      if (close) close.click();
    }
    return true;
  `)
  await ui.waitUntil(`() => document.querySelectorAll('[role="alert"]').length === 0`, {
    timeout: 10_000,
    label: '通知已收起',
  }).catch(() => null)
}

function seedVisibleConversation(databasePath, sessionId) {
  const db = new BetterSqlite3(databasePath)
  try {
    db.prepare(`
      INSERT INTO session_messages
        (id, session_id, role, content_items, sequence_number, created_at, updated_at)
      VALUES (?, ?, 'user', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).run(randomUUID(), sessionId, JSON.stringify([{ type: 'text', text: '已在独立 Worktree 中更新发布说明，请审核当前变更。' }]))
    db.prepare(`UPDATE sessions SET message_count=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(sessionId)
  } finally {
    db.close()
  }
}

let session = null
let driver = null
let projectId = ''
let appSessionId = ''
let worktreeId = ''
let worktreePath = ''
try {
  session = await openSession({ port: 9373 })
  driver = makeDriver(session)
  const ui = makeUiDriver(session)
  await driver.login()
  await session.evalJs(`localStorage.setItem('dsh:onboarding:completed:v1', 'true'); return true;`)

  const project = await driver.raw.api('POST', '/api/projects', {
    name: projectName,
    description: '用独立分支安全准备发布说明',
    source_folders: [{ path: projectRoot, name: '主仓库', access_mode: 'write' }],
  })
  assert.equal(project.status, 200, JSON.stringify(project.json))
  projectId = project.json?.data?.id || ''
  assert.ok(projectId)

  await ui.goto('/agent')
  await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 30_000 })
  await ui.waitForText(projectName, { selector: '[title],button,[aria-label]', timeout: 30_000 })
  const menuSelector = `[aria-label="查看项目 ${projectName}"]`
  await ui.click(menuSelector, { timeout: 10_000 })
  await ui.click(`[aria-label="打开${projectName}的项目设置"]`, { timeout: 10_000 })
  await ui.waitFor('[data-testid="worktree-section"]', { timeout: 20_000 })
  await session.evalJs(`document.querySelector('[data-testid="worktree-section"]')?.scrollIntoView({ block: 'center' }); return true;`)
  await ui.waitUntil(
    `() => !document.querySelector('[data-testid="worktree-create-open"]')?.disabled`,
    { timeout: 20_000, label: 'Worktree 创建入口可用' },
  )

  await ui.click('[data-testid="worktree-create-open"]')
  await ui.waitFor('[data-testid="worktree-branch-input"]', { timeout: 10_000 })
  await ui.fill('[data-testid="worktree-branch-input"]', branch)
  await capture(session, '00-create')
  await ui.click('[data-testid="worktree-create-submit"]')

  const created = await session.evalJs(`
    const projectId = ${JSON.stringify(projectId)};
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const response = await window.electronAPI.apiRequest({
        method: 'GET',
        url: '/api/projects/' + encodeURIComponent(projectId) + '/worktrees',
        headers: {},
        body: null,
      });
      const item = response?.json?.data?.items?.[0];
      if (response?.status === 200 && item) return item;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  `, { timeoutMs: 25_000 })
  worktreeId = created?.id || ''
  worktreePath = created?.path || ''
  assert.ok(worktreeId && worktreePath, JSON.stringify(created))
  await ui.waitFor(`[data-testid="worktree-activate-${worktreeId}"]`, { timeout: 15_000 })
  await dismissNotifications(session, ui)
  await ui.waitUntil(
    `() => !document.querySelector(${JSON.stringify(`[data-testid="worktree-activate-${worktreeId}"]`)})?.disabled`,
    { timeout: 15_000, label: 'Worktree 启用按钮可用' },
  )
  await session.evalJs(`document.querySelector(${JSON.stringify(`[data-testid="worktree-activate-${worktreeId}"]`)})?.scrollIntoView({ block: 'center' }); return true;`)
  await capture(session, '01-created')

  await session.evalJs(`document.querySelector(${JSON.stringify(`[data-testid="worktree-activate-${worktreeId}"]`)})?.click(); return true;`)
  const activated = await session.evalJs(`
    const projectId = ${JSON.stringify(projectId)};
    const worktreeId = ${JSON.stringify(worktreeId)};
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const response = await window.electronAPI.apiRequest({
        method: 'GET',
        url: '/api/projects/' + encodeURIComponent(projectId) + '/worktrees',
        headers: {},
        body: null,
      });
      if (response?.json?.data?.items?.find((item) => item.id === worktreeId)?.active === true) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  `, { timeoutMs: 25_000 })
  assert.equal(activated, true, 'Worktree API 应标记为已启用')
  await ui.waitFor('[data-testid="worktree-active"]', { timeout: 15_000 })
  const active = await driver.raw.api('GET', `/api/projects/${projectId}/worktrees`)
  assert.equal(active.json?.data?.items?.find((item) => item.id === worktreeId)?.active, true)

  writeFileSync(path.join(worktreePath, 'note.txt'), 'line1\nchanged in Worktree\nline3\n', 'utf8')
  const appSession = await driver.raw.api('POST', `/api/projects/${projectId}/sessions`, {
    title: '审阅发布说明变更',
    source_type: 'agent',
    source_id: projectId,
    action_type: 'agentic_chat',
  })
  assert.equal(appSession.status, 200, JSON.stringify(appSession.json))
  appSessionId = appSession.json?.data?.id || ''
  assert.ok(appSessionId)
  seedVisibleConversation(session.info.database_path, appSessionId)
  const diff = await driver.raw.api('GET', `/api/agent/threads/${appSessionId}/workspace-diff`)
  assert.equal(diff.status, 200, JSON.stringify(diff.json))
  assert.equal(diff.json?.data?.workspaceRoot, worktreePath)
  assert.match(String(diff.json?.data?.diff || ''), /changed in Worktree/)
  assert.equal(readFileSync(path.join(projectRoot, 'note.txt'), 'utf8'), 'line1\nbefore\nline3\n')
  await dismissNotifications(session, ui)
  await capture(session, '02-active')

  await ui.goto('/agent')
  await ui.waitFor('[data-testid="agent-message-input"]', { timeout: 30_000 })
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 15_000 })
  await ui.waitFor(`[data-agent-workspace-id="${projectId}"]`, { timeout: 30_000 })
  if (!(await ui.exists(`[data-agent-conv-id="${appSessionId}"]`))) {
    await ui.click(`[data-agent-workspace-id="${projectId}"]`)
  }
  await ui.waitFor(`[data-agent-conv-id="${appSessionId}"]`, { timeout: 20_000 })
  await ui.click(`[data-agent-conv-id="${appSessionId}"]`)
  await ui.waitFor('[data-testid="workspace-changes-open"]', { timeout: 15_000 })
  await ui.click('[data-testid="workspace-changes-open"]')
  await ui.waitFor('[data-testid="workspace-changes-panel"]', { timeout: 10_000 })
  await ui.waitUntil(`() => document.querySelector('[data-testid="workspace-changes-panel"]')?.textContent?.includes('changed in Worktree')`, {
    timeout: 10_000,
    label: 'Worktree Diff 已显示',
  })
  await dismissNotifications(session, ui)
  await capture(session, '03-diff', 'dsh-work-worktree.png')

  await ui.click('[data-testid="workspace-changes-close"]')
  await ui.waitUntil(`() => !document.querySelector('[data-testid="workspace-changes-panel"]')`, {
    timeout: 10_000,
    label: '变更审核面板已关闭',
  })
  await ui.click(`[aria-label="查看项目 ${projectName}"]`, { timeout: 10_000 })
  await ui.click(`[aria-label="打开${projectName}的项目设置"]`, { timeout: 10_000 })
  await ui.waitFor('[data-testid="worktree-section"]', { timeout: 20_000 })

  await ui.waitUntil(
    `() => !document.querySelector(${JSON.stringify(`[data-testid="worktree-deactivate-${worktreeId}"]`)})?.disabled`,
    { timeout: 15_000, label: 'Worktree 停用按钮可用' },
  )
  await session.evalJs(`document.querySelector(${JSON.stringify(`[data-testid="worktree-deactivate-${worktreeId}"]`)})?.scrollIntoView({ block: 'center' }); return true;`)
  await session.evalJs(`document.querySelector(${JSON.stringify(`[data-testid="worktree-deactivate-${worktreeId}"]`)})?.click(); return true;`)
  await ui.waitFor(`[data-testid="worktree-activate-${worktreeId}"]`, { timeout: 15_000 })
  const deactivated = await driver.raw.api('GET', `/api/projects/${projectId}/worktrees`)
  assert.equal(deactivated.json?.data?.items?.find((item) => item.id === worktreeId)?.active, false)
  await dismissNotifications(session, ui)
  await capture(session, '04-main-checkout')

  await ui.waitUntil(
    `() => !document.querySelector(${JSON.stringify(`[data-testid="worktree-remove-${worktreeId}"]`)})?.disabled`,
    { timeout: 15_000, label: 'Worktree 删除按钮可用' },
  )
  await session.evalJs(`document.querySelector(${JSON.stringify(`[data-testid="worktree-remove-${worktreeId}"]`)})?.scrollIntoView({ block: 'center' }); return true;`)
  await session.evalJs(`document.querySelector(${JSON.stringify(`[data-testid="worktree-remove-${worktreeId}"]`)})?.click(); return true;`)
  await ui.waitFor(`[data-testid="worktree-remove-confirm-${worktreeId}"]`, { timeout: 10_000 })
  await capture(session, '05-remove-confirm')
  await ui.click(`[data-testid="worktree-remove-confirm-${worktreeId}"]`)
  await ui.waitFor('[data-testid="worktree-empty"]', { timeout: 15_000 })
  const removed = await driver.raw.api('GET', `/api/projects/${projectId}/worktrees`)
  assert.deepEqual(removed.json?.data?.items, [])
  assert.match(execFileSync('git', ['branch', '--list', branch], { cwd: projectRoot, encoding: 'utf8' }), new RegExp(branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  worktreeId = ''
  await dismissNotifications(session, ui)
  await capture(session, '06-removed')

  console.log(JSON.stringify({
    source: 'real Electron + temporary local Git repository; no model call',
    framesDir,
    screenshot: path.join(outputDir, 'dsh-work-worktree.png'),
    checks: ['create', 'activate', 'active Diff root', 'main checkout unchanged', 'deactivate', 'remove', 'branch retained'],
  }, null, 2))
} finally {
  if (driver && projectId && worktreeId) {
    await driver.raw.api('POST', `/api/projects/${projectId}/worktrees/deactivate`).catch(() => null)
    await driver.raw.api('DELETE', `/api/projects/${projectId}/worktrees/${worktreeId}`).catch(() => null)
  }
  if (driver && projectId && appSessionId) {
    await driver.raw.api('DELETE', `/api/projects/${projectId}/sessions/${appSessionId}`).catch(() => null)
  }
  if (driver && projectId) await driver.raw.api('DELETE', `/api/projects/${projectId}`).catch(() => null)
  try { await session?.close() } catch { /* ignore */ }
  rmSync(projectRoot, { recursive: true, force: true })
}
