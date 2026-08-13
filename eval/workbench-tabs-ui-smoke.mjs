import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const evalHome = mkdtempSync(path.join(os.tmpdir(), 'workbench-tabs-ui-smoke-'))
process.env.DSH_EVAL_ISOLATED = '1'
process.env.DSH_EVAL_HOME = evalHome
process.env.DSH_USER_DATA_DIR = path.join(evalHome, 'electron-user-data')

let session = null
try {
  session = await openSession({ port: 9360 })
  const ui = makeUiDriver(session)

  await session.evalJs(`
    localStorage.setItem('dsh:onboarding:completed:v1', 'true');
    return true;
  `)
  await session.cdp('Page.reload', { ignoreCache: true }, { timeoutMs: 10_000 })
  await ui.waitFor('[data-edge-toggle="workspace"]', { timeout: 30_000 })

  const collapsed = await session.evalJs(`
    return document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed');
  `)
  if (collapsed === 'true') {
    await ui.click('[data-edge-toggle="workspace"]')
    await ui.waitUntil(`async () => document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') === 'false'`, {
      timeout: 10_000,
      label: '右侧栏完成展开'
    })
  }

  await ui.waitFor('[data-workbench-empty]', { timeout: 10_000 })
  const emptyActions = await session.evalJs(`
    return [...document.querySelectorAll('[data-workbench-empty-action]')]
      .map((button) => ({
        id: button.getAttribute('data-workbench-empty-action'),
        source: button.getAttribute('data-workbench-source-bundle'),
      }));
  `)
  assert.deepEqual(emptyActions, ['review', 'browser', 'files', 'artifacts', 'sites'].map((id) => ({
    id,
    source: '@deepseek-ai/dsh-product-bridge',
  })))

  await session.evalJs(`
    document.querySelector('[data-workbench-empty-action="browser"]')?.click();
    return true;
  `)
  await ui.waitUntil(`async () => {
    const state = await window.electronAPI.browserWorkspaceGetState();
    return document.querySelector('[data-workbench-slot-runtime="dsh"]')
      && document.querySelector('[data-workbench-tab="browser"]')?.getAttribute('data-active') === 'true'
      && Boolean(document.querySelector('[data-workbench-panel="browser"]:not([hidden])'))
      && document.querySelector('[data-workbench-panel="browser"]')?.getAttribute('data-workbench-component') === 'dsh-work/browser'
      && document.querySelector('[data-workbench-panel="browser"]')?.getAttribute('data-workbench-source-bundle') === '@deepseek-ai/dsh-product-bridge'
      && state.visible === true;
  }`, { timeout: 10_000, label: '从空状态打开浏览器' })

  await session.evalJs(`
    document.querySelector('[data-workbench-add]')?.click();
    return true;
  `)
  await ui.waitFor('[data-workbench-add-option="files"]', { timeout: 5_000 })
  await ui.waitUntil(`async () => {
    const state = await window.electronAPI.browserWorkspaceGetState();
    const options = [...document.querySelectorAll('[data-workbench-add-option]')];
    return state.visible === false && options.length === 5 && options.every((option) => {
      const rect = option.getBoundingClientRect();
      const style = getComputedStyle(option);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    });
  }`, { timeout: 10_000, label: '添加菜单完整显示且不被浏览器原生视图遮挡' })
  await ui.click('[data-workbench-add-option="files"]')
  await ui.waitUntil(`async () => {
    const state = await window.electronAPI.browserWorkspaceGetState();
    const tabs = [...document.querySelectorAll('[data-workbench-tab]')].map((tab) => ({
      id: tab.getAttribute('data-workbench-tab'),
      active: tab.getAttribute('data-active') === 'true'
    }));
    return JSON.stringify(tabs) === JSON.stringify([
      { id: 'browser', active: false },
      { id: 'files', active: true }
    ]) && Boolean(document.querySelector('[data-workbench-panel="browser"][hidden]'))
      && Boolean(document.querySelector('[data-workbench-panel="files"]:not([hidden])'))
      && state.visible === false;
  }`, { timeout: 10_000, label: '添加文件工具且保留浏览器标签' })

  await ui.click('[data-workbench-tab="files"]')
  await ui.waitUntil(`async () => {
    const state = await window.electronAPI.browserWorkspaceGetState();
    return document.querySelector('[data-workbench-tab="files"]')?.getAttribute('data-active') === 'true'
      && Boolean(document.querySelector('[data-workbench-panel="files"]:not([hidden])'))
      && state.visible === false;
  }`, { timeout: 10_000, label: '点击文件标签只切换当前工具' })

  await ui.click('[data-workbench-tab="browser"]')
  await ui.waitUntil(`async () => {
    const state = await window.electronAPI.browserWorkspaceGetState();
    return document.querySelector('[data-workbench-tab="browser"]')?.getAttribute('data-active') === 'true'
      && Boolean(document.querySelector('[data-workbench-panel="browser"]:not([hidden])'))
      && state.visible === true;
  }`, { timeout: 10_000, label: '点击标签只切换当前工具' })

  await ui.click('[data-edge-toggle="workspace"]')
  await ui.waitUntil(`async () => {
    const state = await window.electronAPI.browserWorkspaceGetState();
    const workbench = document.querySelector('aside[aria-hidden="true"] [data-workbench-tab="browser"]');
    return document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') === 'true'
      && Boolean(workbench)
      && state.visible === false;
  }`, { timeout: 10_000, label: '折叠工作台只隐藏并保留已打开工具' })

  await ui.click('[data-edge-toggle="workspace"]')
  await ui.waitUntil(`async () => {
    const state = await window.electronAPI.browserWorkspaceGetState();
    const aside = document.querySelector('aside [data-workbench-tab="browser"]')?.closest('aside');
    const width = Math.round(aside?.getBoundingClientRect().width || 0);
    const now = performance.now();
    const sample = window.__workbenchSmokeWidthSample;
    if (!sample || sample.width !== width) {
      window.__workbenchSmokeWidthSample = { width, at: now };
      return false;
    }
    return document.querySelector('[data-edge-toggle="workspace"]')?.getAttribute('data-collapsed') === 'false'
      && document.querySelector('[data-workbench-tab="browser"]')?.getAttribute('data-active') === 'true'
      && width >= 300
      && now - sample.at >= 120
      && state.visible === true;
  }`, { timeout: 10_000, label: '重新展开后恢复同一个工作台工具' })

  await ui.click('[data-workbench-close="browser"]')
  await ui.waitUntil(`async () => {
    const state = await window.electronAPI.browserWorkspaceGetState();
    return !document.querySelector('[data-workbench-tab="browser"]')
      && document.querySelector('[data-workbench-tab="files"]')?.getAttribute('data-active') === 'true'
      && !document.querySelector('[data-workbench-empty]')
      && state.visible === false;
  }`, { timeout: 10_000, label: '关闭当前工具后保留相邻标签' })

  await ui.click('[data-workbench-close="files"]')
  await ui.waitFor('[data-workbench-empty]', { timeout: 5_000 })
  assert.equal(await session.evalJs(`return document.querySelectorAll('[data-workbench-tab]').length`), 0)

  console.log('[workbench-tabs-ui-smoke] PASS Profile贡献/官方Slot挂载/添加/切换/折叠保留/逐个关闭/浏览器原生视图显隐')
} finally {
  try { await session?.close() } catch { /* ignore */ }
  try { rmSync(evalHome, { recursive: true, force: true }) } catch { /* ignore */ }
}
