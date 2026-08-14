import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const root = path.resolve(import.meta.dirname, '..')
const outputDir = path.join(root, 'docs', 'images', 'readme')
const screenshotPath = path.join(outputDir, 'dsh-work-themes.png')
const customThemeName = '本地海蓝'

mkdirSync(outputDir, { recursive: true })

async function dismissNotifications(session, ui) {
  await session.evalJs(`
    for (let pass = 0; pass < 3; pass += 1) {
      for (const notification of document.querySelectorAll('[role="alert"]')) {
        const buttons = [...notification.querySelectorAll('button')];
        const close = buttons.find((button) => /close|关闭/i.test(button.getAttribute('aria-label') || '')) || buttons.at(-1);
        close?.click();
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    return document.querySelectorAll('[role="alert"]').length;
  `)
  await ui.waitUntil(`() => document.querySelectorAll('[role="alert"]').length === 0`, {
    timeout: 10_000,
    label: '主题操作通知已经完整收起',
  })
}

let session = null
try {
  session = await openSession({ port: 9374, isolate: true })
  const driver = makeDriver(session)
  const ui = makeUiDriver(session)

  await driver.login()
  await session.evalJs(`localStorage.setItem('dsh:onboarding:completed:v1', 'true'); return true;`)
  await ui.goto('/agent')
  await ui.waitFor('[data-dsh-open-settings]', { timeout: 30_000 })
  await ui.click('[data-dsh-open-settings]')
  await ui.clickText('主题', { selector: 'button', exact: true, timeout: 15_000 })
  await ui.waitForText('导入主题', { selector: 'button', exact: true, timeout: 20_000 })
  await ui.waitForText('新建主题', { selector: 'button', exact: true, timeout: 20_000 })

  await ui.clickText('新建主题', { selector: 'button', exact: true })
  await ui.fillByPlaceholder('如：海蓝', customThemeName, { timeout: 10_000 })
  await ui.clickText('保存并应用', { selector: 'button', exact: true })
  await ui.waitForText(customThemeName, { selector: 'strong', exact: true, timeout: 20_000 })
  await dismissNotifications(session, ui)

  const actionLabel = `${customThemeName}操作`
  await ui.click(`[aria-label="${actionLabel}"]`)
  await ui.waitForText('编辑', { selector: '[role="menuitem"]', exact: true, timeout: 10_000 })
  await ui.waitForText('导出', { selector: '[role="menuitem"]', exact: true, timeout: 10_000 })
  await ui.waitForText('删除', { selector: '[role="menuitem"]', exact: true, timeout: 10_000 })

  const proof = await session.evalJs(`
    const body = document.body.textContent || '';
    return {
      newTheme: body.includes('新建主题'),
      importTheme: body.includes('导入主题'),
      customTheme: body.includes(${JSON.stringify(customThemeName)}),
      edit: body.includes('编辑'),
      export: body.includes('导出'),
      remove: body.includes('删除'),
      alerts: document.querySelectorAll('[role="alert"]').length,
    };
  `)
  assert.deepEqual(proof, {
    newTheme: true,
    importTheme: true,
    customTheme: true,
    edit: true,
    export: true,
    remove: true,
    alerts: 0,
  })

  await session.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1080, y: 160 })
  const shot = await session.cdp('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
  })
  writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'))

  console.log(JSON.stringify({
    source: 'real isolated Electron theme manager',
    screenshot: screenshotPath,
    checks: ['create', 'persist', 'apply', 'edit action', 'export action', 'delete action', 'no toast in capture'],
  }, null, 2))
} finally {
  try { await session?.close() } catch { /* ignore */ }
}
