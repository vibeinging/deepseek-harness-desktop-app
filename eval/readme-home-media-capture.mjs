import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { openSession } from './lib/cdp.mjs'
import { makeDriver } from './lib/driver.mjs'
import { makeUiDriver } from './lib/ui-driver.mjs'

const root = path.resolve(import.meta.dirname, '..')
const outputDir = path.join(root, 'docs', 'images', 'readme')
const screenshotPaths = {
  light: path.join(outputDir, 'dsh-work-home-professional-light.png'),
  dark: path.join(outputDir, 'dsh-work-home-professional-dark.png'),
}

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
    label: '首页通知已经完整收起',
  })
}

let session = null
try {
  session = await openSession({ port: 9375, isolate: true })
  const driver = makeDriver(session)
  const ui = makeUiDriver(session)

  await driver.login()
  await session.evalJs(`localStorage.setItem('dsh:onboarding:completed:v1', 'true'); return true;`)
  await ui.goto('/agent')
  await ui.waitFor('[data-dsh-open-settings]', { timeout: 30_000 })

  await ui.click('[data-dsh-open-settings]')
  await ui.clickText('主题', { selector: 'button', exact: true, timeout: 15_000 })
  await ui.waitForText('专业蓝', { selector: 'strong', exact: true, timeout: 20_000 })

  const professionalCard = await session.evalJs(`
    const cards = [...document.querySelectorAll('button[aria-label]')];
    const card = cards.find((button) => /专业蓝/.test(button.getAttribute('aria-label') || ''));
    return card ? {
      label: card.getAttribute('aria-label') || '',
      selector: (() => {
        const token = 'dsh-readme-professional-theme';
        card.setAttribute('data-dsh-readme-target', token);
        return '[data-dsh-readme-target="' + token + '"]';
      })(),
    } : null;
  `)
  assert.ok(professionalCard, '主题库中没有专业蓝主题')
  if (professionalCard.label.startsWith('切换到：')) {
    await ui.click(professionalCard.selector)
  }
  await ui.waitFor('[aria-label="当前主题：专业蓝"]', { timeout: 20_000 })

  const captures = []
  for (const [scheme, label] of [['light', '亮色'], ['dark', '暗色']]) {
    await ui.clickText(label, { selector: 'button', exact: true, timeout: 10_000 })
    await ui.waitUntil(`() => {
      const group = document.querySelector('[role="group"][aria-label="选择外观模式"]');
      const target = [...(group?.querySelectorAll('button') || [])]
        .find((button) => button.textContent?.trim() === ${JSON.stringify(label)});
      return target?.getAttribute('aria-pressed') === 'true'
        && document.documentElement.getAttribute('data-agent-scheme') === ${JSON.stringify(scheme)};
    }`, { timeout: 10_000, label: `专业蓝${label}模式已生效` })
    await dismissNotifications(session, ui)

    await ui.clickText('返回项目', { selector: 'button', exact: true, timeout: 10_000 })
    await ui.waitFor('[data-show-character="false"]', { timeout: 20_000 })
    await ui.waitForText('今天想处理什么？', { selector: 'h1', exact: true, timeout: 20_000 })
    await dismissNotifications(session, ui)

    const proof = await session.evalJs(`
      const home = document.querySelector('[data-show-character="false"]');
      const title = home?.querySelector('h1');
      const subtitle = home?.querySelector('p');
      const probe = document.createElement('span');
      probe.style.position = 'fixed';
      probe.style.visibility = 'hidden';
      document.body.append(probe);
      probe.style.color = 'var(--dsh-text)';
      const primaryTextColor = getComputedStyle(probe).color;
      probe.style.color = 'var(--dsh-text-soft)';
      const secondaryTextColor = getComputedStyle(probe).color;
      probe.remove();
      return {
        formalHome: Boolean(home),
        title: title?.textContent?.trim() || '',
        subtitle: subtitle?.textContent?.trim() || '',
        scheme: document.documentElement.getAttribute('data-agent-scheme'),
        character: Boolean(document.querySelector('[data-show-character="true"]')),
        dialog: Boolean(document.querySelector('[role="dialog"]')),
        menu: Boolean(document.querySelector('[role="menu"]')),
        alerts: document.querySelectorAll('[role="alert"]').length,
        composer: Boolean(document.querySelector('textarea, [contenteditable="true"]')),
        titleColor: title ? getComputedStyle(title).color : '',
        subtitleColor: subtitle ? getComputedStyle(subtitle).color : '',
        primaryTextColor,
        secondaryTextColor,
      };
    `)
    assert.deepEqual({
      formalHome: proof.formalHome,
      title: proof.title,
      subtitle: proof.subtitle,
      scheme: proof.scheme,
      character: proof.character,
      dialog: proof.dialog,
      menu: proof.menu,
      alerts: proof.alerts,
      composer: proof.composer,
    }, {
      formalHome: true,
      title: '今天想处理什么？',
      subtitle: '可以聊天、查看图片、联网搜索，或处理本地文件',
      scheme,
      character: false,
      dialog: false,
      menu: false,
      alerts: 0,
      composer: true,
    })
    assert.equal(proof.titleColor, proof.primaryTextColor, `${label}首页标题没有使用主文字色`)
    assert.equal(proof.subtitleColor, proof.secondaryTextColor, `${label}首页副标题没有使用次级文字色`)

    await session.cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1380, y: 880 })
    const shot = await session.cdp('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })
    const screenshotPath = screenshotPaths[scheme]
    writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'))
    captures.push({ scheme, screenshot: screenshotPath, titleColor: proof.titleColor, subtitleColor: proof.subtitleColor })

    if (scheme === 'light') {
      await ui.click('[data-dsh-open-settings]')
      await ui.clickText('主题', { selector: 'button', exact: true, timeout: 15_000 })
      await ui.waitFor('[aria-label="当前主题：专业蓝"]', { timeout: 20_000 })
    }
  }

  console.log(JSON.stringify({
    source: 'real isolated Electron professional-blue home',
    captures,
    checks: ['professional-blue selected', 'light and dark modes selected', 'primary and secondary home text', 'no character', 'no dialog or menu', 'no toast'],
  }, null, 2))
} finally {
  try { await session?.close() } catch { /* ignore */ }
}
