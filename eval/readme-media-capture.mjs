import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const root = path.resolve(import.meta.dirname, '..')
const outputDir = path.join(root, 'docs', 'images', 'readme')
const framesDir = path.join(root, '.playwright-mcp', 'dsh-trajectory-frames')
const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-readme-media-'))
const finalAnswer = '发布检查完成：代码、文档和安装包均已确认。'
const userPrompt = `请只用内置任务清单把“代码检查、文档检查、安装包检查”标为完成，不要读取文件。完成后回复：${finalAnswer}`
const canvasV1 = '# v1.0 发布说明\n\n## 状态\n\n质量门禁：已通过\n\n## 亮点\n\n- DSH 会话与轨迹\n- 项目文件与变更审核\n- Canvas 和本地 Site\n'
const canvasV2 = `${canvasV1}\n## 发布渠道\n\nmacOS 与 Windows 预览版。\n`
const siteV1 = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,"PingFang SC",system-ui;color:#f7f7fb;background:radial-gradient(circle at 85% 5%,#473b72 0,transparent 35%),linear-gradient(145deg,#13111b,#211b32)}
.wrap{padding:36px}.eyebrow{color:#b7a8ff;font-size:12px;letter-spacing:.18em;text-transform:uppercase}.hero{display:flex;align-items:end;justify-content:space-between;gap:24px;margin:18px 0 28px}.hero h1{margin:0;font-size:42px;line-height:1.05}.hero p{max-width:360px;margin:0;color:#bbb5cb;line-height:1.6}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.card{padding:18px;border:1px solid #ffffff17;border-radius:16px;background:#ffffff0b}.card strong{display:block;font-size:25px}.card span{color:#aaa3ba;font-size:12px}.ready{color:#9bf3c7!important}.bar{height:7px;margin-top:14px;overflow:hidden;border-radius:9px;background:#ffffff12}.bar i{display:block;height:100%;width:100%;background:linear-gradient(90deg,#7f6bf2,#b58cff)}
</style></head><body><main class="wrap"><div class="eyebrow">dsh-work release center</div><section class="hero"><h1>v1.0 发布看板</h1><p>用一个本地页面集中查看代码、文档与安装包状态。</p></section><section class="grid"><article class="card"><strong>18</strong><span>检查项</span><div class="bar"><i></i></div></article><article class="card"><strong>3 / 3</strong><span>平台构建</span><div class="bar"><i></i></div></article><article class="card"><strong class="ready">可发布</strong><span>当前结论</span><div class="bar"><i></i></div></article></section></main></body></html>`
const siteV2 = siteV1.replace('18</strong>', '21</strong>')

mkdirSync(outputDir, { recursive: true })
rmSync(framesDir, { recursive: true, force: true })
mkdirSync(framesDir, { recursive: true })
mkdirSync(path.join(projectRoot, 'docs'), { recursive: true })
mkdirSync(path.join(projectRoot, 'src'), { recursive: true })
writeFileSync(path.join(projectRoot, 'README.md'), '# dsh-work Desktop\n\n一个使用 DSH 官方 Web Profile 的本地 Agent 工作台。\n')
writeFileSync(path.join(projectRoot, 'docs', 'release-checklist.md'), '# v1.0 发布检查\n\n- [x] 代码检查\n- [x] 文档检查\n- [x] 安装包检查\n')
writeFileSync(path.join(projectRoot, 'src', 'main.ts'), 'export const releaseChannel = "preview"\n')

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

async function resizeWorkspace(session, minimumWidth = 700) {
  const point = await session.evalJs(`
    const handle = document.querySelector('[data-side="workspace"]');
    if (!handle) return null;
    const rect = handle.getBoundingClientRect();
    const aside = handle.nextElementSibling;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, width: aside?.getBoundingClientRect().width || 0 };
  `)
  if (!point || point.width >= minimumWidth) return
  const targetX = Math.max(440, point.x - (minimumWidth - point.width))
  await session.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
  await session.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', buttons: 1, clickCount: 1 })
  await session.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: targetX, y: point.y, button: 'left', buttons: 1 })
  await session.cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: targetX, y: point.y, button: 'left', buttons: 0, clickCount: 1 })
}

let session = null
let driver = null
let projectId = ''
let sessionId = ''
try {
  session = await openSession({ port: 9372, isolate: false })
  driver = makeDriver(session)
  const ui = makeUiDriver(session)
  await driver.login()
  await session.evalJs(`localStorage.setItem('dsh:onboarding:completed:v1', 'true'); return true;`)

  const project = await driver.raw.api('POST', '/api/projects', {
    name: 'dsh-work Desktop',
    description: '使用 DSH 完成桌面应用的发布准备',
    source_folders: [{ path: projectRoot, name: '产品源码', access_mode: 'write' }],
  })
  assert.equal(project.status, 200, JSON.stringify(project.json))
  projectId = project.json?.data?.id || ''
  assert.ok(projectId)

  const models = await driver.raw.api('GET', `/api/agent/projects/${projectId}/model`)
  assert.equal(models.status, 200, JSON.stringify(models.json))
  const modelRoute = models.json?.data?.model_id || ''
  assert.ok(modelRoute, '当前 DSH Profile 没有可用于真实录制的模型')

  const result = await driver.askAgent(projectId, userPrompt, {
    title: 'v1.0 发布检查',
    model: modelRoute,
    timeoutMs: 120_000,
  })
  sessionId = result.sid
  assert.ok(result.blocks.some((block) => block.type === 'tool'), JSON.stringify(result.blocks))
  assert.ok(result.blocks.some((block) => String(block.content || '').trim() === finalAnswer), JSON.stringify(result.blocks))

  const trajectory = await driver.raw.api(
    'GET',
    `/api/agent/projects/${projectId}/threads/${sessionId}/dsh-trajectory`,
  )
  assert.equal(trajectory.status, 200, JSON.stringify(trajectory.json))
  assert.equal(trajectory.json?.data?.source, 'session.history')
  assert.ok(trajectory.json?.data?.events?.some((entry) => entry?.event?.type === 'tool/call'))
  assert.ok(trajectory.json?.data?.events?.some((entry) => entry?.event?.type === 'tool/result'))

  await ui.goto('/agent')
  await ui.waitFor('[data-agent-window-titlebar]', { timeout: 30_000 })
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 15_000 })
  await ui.waitFor(`[data-agent-workspace-id="${projectId}"]`, { timeout: 30_000 })
  if (!(await ui.exists(`[data-agent-conv-id="${sessionId}"]`))) {
    await ui.click(`[data-agent-workspace-id="${projectId}"]`)
  }
  await ui.waitFor(`[data-agent-conv-id="${sessionId}"]`, { timeout: 30_000 })
  await ui.click(`[data-agent-conv-id="${sessionId}"]`)
  await ui.waitUntil(`async () => {
    const answer = [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1)
    return String(answer?.textContent || '').trim().length > 0
  }`, { timeout: 30_000, label: '真实 DSH 回答显示在对话中' })

  await session.evalJs(`
    for (const button of document.querySelectorAll('[data-agent-block="thinking"][data-expanded="true"] button')) button.click();
    return true;
  `)
  await ui.waitUntil(`() => !document.querySelector('[data-agent-block="thinking"][data-expanded="true"]')`, {
    timeout: 10_000,
    label: '思考过程已收起',
  })

  const workspaceCollapsed = await session.evalJs(`
    return document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') === 'true'
  `)
  if (!workspaceCollapsed) {
    await ui.click('[data-edge-toggle="workspace"]')
    await ui.waitFor('[data-edge-toggle="workspace"][data-collapsed="true"]', { timeout: 10_000 })
  }
  await capture(session, '00-conversation', 'dsh-work-project-session.png')

  const navCollapsed = await session.evalJs(`
    return document.querySelector('[data-edge-toggle="nav"]')?.getAttribute('data-collapsed') === 'true'
  `)
  if (!navCollapsed) {
    await ui.click('[data-edge-toggle="nav"]')
    await ui.waitFor('[data-edge-toggle="nav"][data-collapsed="true"]', { timeout: 10_000 })
  }
  await session.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500 })
  await ui.waitUntil(`async () => {
    const rail = document.querySelector('[data-agent-conv-id]')?.closest('aside')
    if (!rail) return false
    const style = getComputedStyle(rail)
    return rail.getAttribute('data-collapsed') === 'true'
      && rail.getAttribute('data-peeking') !== 'true'
      && rail.getBoundingClientRect().width <= 1
      && Number(style.opacity) <= 0.01
  }`, { timeout: 10_000, label: '左侧栏收起动画和预览已经结束' })
  await ui.fill('[data-testid="agent-message-input"]', '/runs')
  await ui.waitFor('[data-slash-menu]', { timeout: 10_000 })
  await ui.press('Enter')
  await ui.waitFor('[data-dsh-trajectory][data-dsh-trajectory-source="session.history"]', { timeout: 20_000 })
  await ui.waitFor('[data-dsh-trajectory-event][data-dsh-event-type="tool/call"]', { timeout: 20_000 })
  await capture(session, '01-trajectory', 'dsh-trajectory.png')

  await ui.click('[data-dsh-trajectory-event][data-dsh-event-type="tool/call"] button')
  await ui.waitUntil(`async () => Boolean(
    document.querySelector('[data-dsh-trajectory-event][data-dsh-event-type="tool/call"] pre')
  )`, { timeout: 10_000, label: '展开 DSH 工具调用原始事件' })
  await capture(session, '02-tool-call')

  await ui.click('[data-dsh-trajectory-event][data-dsh-event-type="tool/call"] button')
  await ui.click('[data-dsh-trajectory-event][data-dsh-event-type="tool/result"] button')
  await ui.waitUntil(`async () => Boolean(
    document.querySelector('[data-dsh-trajectory-event][data-dsh-event-type="tool/result"] pre')
  )`, { timeout: 10_000, label: '展开 DSH 工具结果原始事件' })
  await capture(session, '03-tool-result')

  await ui.click('[data-workbench-add]')
  await ui.waitFor('[data-workbench-add-option="files"]', { timeout: 10_000 })
  await ui.click('[data-workbench-add-option="files"]')
  await ui.waitFor('[data-workbench-panel="files"]:not([hidden])', { timeout: 15_000 })
  await ui.press('Escape')
  await ui.click('button[title="docs"]')
  await ui.waitFor('button[title="docs/release-checklist.md"]', { timeout: 10_000 })
  await ui.click('button[title="docs/release-checklist.md"]')
  await ui.waitUntil(`async () => document.querySelector('[data-file-scope="project"]')?.textContent?.includes('release-checklist.md')`, {
    timeout: 10_000,
    label: '发布检查文件预览已打开',
  })
  await capture(session, '04-files', 'dsh-work-files.png')

  const createdCanvas = await driver.raw.api('POST', `/api/agent/sessions/${sessionId}/canvases`, {
    title: 'v1.0 发布说明',
    kind: 'document',
    content: canvasV1,
    change_summary: '创建发布说明',
  })
  assert.equal(createdCanvas.status, 200, JSON.stringify(createdCanvas.json))
  let canvas = createdCanvas.json?.data?.canvas
  assert.ok(canvas?.id && canvas?.current_version_id)
  const editedCanvas = await driver.raw.api('POST', `/api/agent/sessions/${sessionId}/canvases/${canvas.id}/edits`, {
    base_version_id: canvas.current_version_id,
    content: canvasV2,
    change_summary: '补充发布渠道',
  })
  assert.equal(editedCanvas.status, 200, JSON.stringify(editedCanvas.json))
  canvas = editedCanvas.json?.data?.canvas
  const selectedText = '质量门禁：已通过'
  const selectedStart = canvasV2.indexOf(selectedText)
  const suggestion = await driver.raw.api('POST', `/api/agent/sessions/${sessionId}/canvases/${canvas.id}/suggestions`, {
    base_version_id: canvas.current_version_id,
    start: selectedStart,
    end: selectedStart + selectedText.length,
    selected_text: selectedText,
    replacement_text: '质量门禁：全部通过',
    instruction: '让发布结论更明确',
  })
  assert.equal(suggestion.status, 200, JSON.stringify(suggestion.json))

  await ui.click('[data-workbench-add]')
  await ui.waitFor('[data-workbench-add-option="artifacts"]', { timeout: 10_000 })
  await ui.click('[data-workbench-add-option="artifacts"]')
  await ui.waitFor('[data-artifact-action="open-canvas"]', { timeout: 15_000 })
  await ui.click('[data-artifact-action="open-canvas"]')
  await ui.waitFor(`[data-canvas-id="${canvas.id}"]`, { timeout: 15_000 })
  await ui.click(`[data-canvas-id="${canvas.id}"]`)
  await ui.waitFor(`[data-canvas-editor="${canvas.id}"]`, { timeout: 15_000 })
  await ui.waitFor('[data-canvas-suggestion]', { timeout: 10_000 })
  await resizeWorkspace(session)
  await capture(session, '05-canvas', 'dsh-work-canvas.png')

  const createdSite = await driver.raw.api('POST', `/api/agent/sessions/${sessionId}/canvases`, {
    title: '团队发布看板',
    kind: 'site',
    language: 'html',
    content: siteV1,
    change_summary: '创建发布看板',
  })
  assert.equal(createdSite.status, 200, JSON.stringify(createdSite.json))
  let site = createdSite.json?.data?.canvas
  assert.ok(site?.id && site?.current_version_id)
  const editedSite = await driver.raw.api('POST', `/api/agent/sessions/${sessionId}/canvases/${site.id}/edits`, {
    base_version_id: site.current_version_id,
    content: siteV2,
    change_summary: '更新发布检查数',
  })
  assert.equal(editedSite.status, 200, JSON.stringify(editedSite.json))
  site = editedSite.json?.data?.canvas

  await ui.click('[data-workbench-add]')
  await ui.waitFor('[data-workbench-add-option="sites"]', { timeout: 10_000 })
  await ui.click('[data-workbench-add-option="sites"]')
  await ui.waitFor(`[data-site-id="${site.id}"]`, { timeout: 15_000 })
  await ui.click(`[data-site-id="${site.id}"]`)
  await ui.waitFor(`[data-site-editor="${site.id}"]`, { timeout: 15_000 })
  await ui.waitFor('[data-site-preview-frame]', { timeout: 10_000 })
  await capture(session, '06-site', 'dsh-work-site.png')

  await ui.click('[data-edge-toggle="nav"]')
  await ui.waitFor('[data-edge-toggle="nav"][data-collapsed="false"]', { timeout: 10_000 })
  await ui.click('[data-agent-nav="plugins"]')
  await ui.waitFor('[data-profile-bundle]', { timeout: 30_000 })
  await ui.click('[data-edge-toggle="nav"]')
  await ui.waitFor('[data-edge-toggle="nav"][data-collapsed="true"]', { timeout: 10_000 })
  await session.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 500 })
  await ui.waitUntil(`() => {
    const rail = document.querySelector('[data-agent-nav="plugins"]')?.closest('aside');
    return rail?.getAttribute('data-collapsed') === 'true'
      && rail?.getAttribute('data-peeking') !== 'true'
      && rail?.getBoundingClientRect().width <= 1
      && Number(getComputedStyle(rail).opacity) <= 0.01;
  }`, { timeout: 10_000, label: '插件页左侧栏已完全收起' })
  await capture(session, '07-profile', 'dsh-profile-bundles.png')

  const productBridgeRow = '[data-profile-bundle="@deepseek-ai/dsh-product-bridge"]'
  await ui.waitFor(productBridgeRow, { timeout: 20_000 })
  await ui.click(`${productBridgeRow} button`)
  await ui.waitUntil(`() => {
    const dialog = document.querySelector('[role="dialog"]');
    return dialog?.textContent?.includes('Canvas') && dialog?.textContent?.includes('安全结构化界面');
  }`, { timeout: 20_000, label: '产品桥 Bundle 详情已打开' })
  await capture(session, '08-product-bridge', 'dsh-product-bridge.png')

  console.log(JSON.stringify({
    source: 'real Electron + current DSH model + session.history',
    framesDir,
    screenshots: [
      path.join(outputDir, 'dsh-work-project-session.png'),
      path.join(outputDir, 'dsh-trajectory.png'),
      path.join(outputDir, 'dsh-work-files.png'),
      path.join(outputDir, 'dsh-work-canvas.png'),
      path.join(outputDir, 'dsh-work-site.png'),
      path.join(outputDir, 'dsh-profile-bundles.png'),
      path.join(outputDir, 'dsh-product-bridge.png'),
    ],
  }, null, 2))
} finally {
  if (driver && projectId && sessionId) {
    await driver.raw.api('DELETE', `/api/projects/${projectId}/sessions/${sessionId}`).catch(() => null)
  }
  if (driver && projectId) {
    await driver.raw.api('DELETE', `/api/projects/${projectId}`).catch(() => null)
  }
  try { await session?.close() } catch { /* ignore */ }
  rmSync(projectRoot, { recursive: true, force: true })
}
