// UI driver: performs near-human navigation, clicks, typing, and text checks on a real Electron page.
// Defaults to CDP Input events for mouse/keyboard; reads DOM only while locating elements.

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MODIFIER_BITS = {
  Alt: 1,
  Ctrl: 2,
  Control: 2,
  Meta: 4,
  Cmd: 4,
  Command: 4,
  Shift: 8,
};

const KEY_MAP = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Esc: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
};

function keyInfo(key) {
  if (KEY_MAP[key]) return KEY_MAP[key];
  if (/^[a-z]$/i.test(key)) return { key: key.toLowerCase(), code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(key)) return { key, code: `Digit${key}`, vk: key.charCodeAt(0) };
  return { key, code: key, vk: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
}

function parseShortcut(shortcut) {
  const parts = String(shortcut).split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() || '';
  const modifiers = parts.reduce((bits, part) => bits | (MODIFIER_BITS[part] || 0), 0);
  return { ...keyInfo(key), modifiers };
}

function selectorLiteral(selector) {
  return JSON.stringify(selector);
}

function textLiteral(text) {
  return JSON.stringify(String(text));
}

function testIdSelector(testId) {
  return `[data-testid="${String(testId).replace(/"/g, '\\"')}"]`;
}

function normalizeFiles(files) {
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) throw new Error('setFiles 至少需要一个文件路径');
  return list.map((file) => {
    const path = isAbsolute(String(file)) ? String(file) : resolve(process.cwd(), String(file));
    if (!existsSync(path)) throw new Error(`文件不存在: ${path}`);
    return path;
  });
}

export function makeUiDriver(session) {
  const ev = session.evalJs;
  const cdp = session.cdp;

  const requireCdp = () => {
    if (!cdp) throw new Error('UI driver 需要 openSession 返回 cdp 命令通道');
    return cdp;
  };

  const elementBox = async (selector, { visible = true } = {}) =>
    ev(`
      const selector = ${selectorLiteral(selector)};
      const visible = ${JSON.stringify(visible)};
      const el = document.querySelector(selector);
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const isVisible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || 1) > 0;
      if (visible && !isVisible) return null;
      return {
        selector,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        visible: isVisible,
      };
    `);

  const markByText = async (text, { selector = 'button,a,label,[role="button"],input,textarea,[title],[aria-label]', exact = false } = {}) =>
    ev(`
      const needle = ${textLiteral(text)}.trim().replace(/\\s+/g, ' ');
      const selector = ${selectorLiteral(selector)};
      const exact = ${JSON.stringify(exact)};
      const normalize = (v) => String(v || '').trim().replace(/\\s+/g, ' ');
      const textOf = (el) => normalize([
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
        el.getAttribute('placeholder'),
        el.value,
      ].filter(Boolean).join(' '));
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
      };
      const nodes = [...document.querySelectorAll(selector)];
      const hit = nodes.find((el) => {
        if (!visible(el)) return false;
        const t = textOf(el);
        return exact ? t === needle : t.includes(needle);
      });
      if (!hit) return null;
      const token = 'dsh-eval-' + Math.random().toString(36).slice(2);
      hit.setAttribute('data-dsh-eval-target', token);
      return '[data-dsh-eval-target="' + token + '"]';
    `);

  const waitFor = async (selector, { timeout = 5000, visible = true } = {}) => {
    const deadline = Date.now() + timeout;
    let last = null;
    while (Date.now() <= deadline) {
      last = await elementBox(selector, { visible }).catch(() => null);
      if (last) return last;
      await sleep(100);
    }
    throw new Error(`等待元素超时: ${selector}`);
  };

  const waitForText = async (text, opts = {}) => {
    const deadline = Date.now() + (opts.timeout ?? 5000);
    let marked = null;
    while (Date.now() <= deadline) {
      marked = await markByText(text, opts).catch(() => null);
      if (marked) return marked;
      await sleep(100);
    }
    throw new Error(`等待文本超时: ${text}`);
  };

  const waitUntil = async (predicate, opts = {}) => {
    const deadline = Date.now() + (opts.timeout ?? 5000);
    const source = typeof predicate === 'function' ? `(${predicate.toString()})` : String(predicate);
    let last = null;
    let lastError = '';
    while (Date.now() <= deadline) {
      try {
        last = await ev(`
          const fn = ${source};
          return await fn();
        `, { timeoutMs: opts.evalTimeoutMs ?? 5000 });
        if (last) return last;
      } catch (error) {
        lastError = error?.message || String(error);
      }
      await sleep(opts.interval ?? 100);
    }
    throw new Error(`等待条件超时: ${opts.label || source.slice(0, 80)}${lastError ? `；页面错误: ${lastError}` : ''}`);
  };

  const waitForFileInput = async (selector, { timeout = 5000 } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() <= deadline) {
      const result = await ev(`
        const el = document.querySelector(${selectorLiteral(selector)});
        if (!el) return { found: false };
        return {
          found: true,
          isFileInput: el.tagName === 'INPUT' && String(el.type || '').toLowerCase() === 'file',
          multiple: !!el.multiple,
        };
      `).catch(() => null);
      if (result?.isFileInput) return result;
      if (result?.found && !result.isFileInput) throw new Error(`元素不是文件输入框: ${selector}`);
      await sleep(100);
    }
    throw new Error(`等待文件输入框超时: ${selector}`);
  };

  const mouseClick = async (x, y) => {
    const call = requireCdp();
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, pointerType: 'mouse' });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  };

  const press = async (shortcut) => {
    const call = requireCdp();
    const info = parseShortcut(shortcut);
    const payload = {
      key: info.key,
      code: info.code,
      windowsVirtualKeyCode: info.vk,
      nativeVirtualKeyCode: info.vk,
      modifiers: info.modifiers,
    };
    const editingCommands = info.key.toLowerCase() === 'a' && (info.modifiers & (MODIFIER_BITS.Ctrl | MODIFIER_BITS.Meta))
      ? ['selectAll']
      : undefined;
    await call('Input.dispatchKeyEvent', { ...payload, type: 'keyDown', ...(editingCommands ? { commands: editingCommands } : {}) });
    await call('Input.dispatchKeyEvent', { ...payload, type: 'keyUp' });
  };

  const click = async (selector, opts = {}) => {
    const box = await waitFor(selector, opts);
    await mouseClick(box.x, box.y);
    return box;
  };

  const clickText = async (text, opts = {}) => {
    const selector = await waitForText(text, opts);
    return click(selector, opts);
  };

  const clickByTestId = async (testId, opts = {}) => click(testIdSelector(testId), opts);

  const typeText = async (text) => {
    await requireCdp()('Input.insertText', { text: String(text) });
  };

  const fill = async (selector, value, opts = {}) => {
    await click(selector, opts);
    await press(process.platform === 'darwin' ? 'Meta+A' : 'Ctrl+A');
    await press('Backspace');
    if (value !== '') await typeText(value);
    return value;
  };

  const fillByPlaceholder = async (placeholder, value, opts = {}) => {
    const selector = await waitForText(placeholder, {
      selector: 'input,textarea',
      exact: true,
      ...opts,
    });
    return fill(selector, value, opts);
  };

  const fillByTestId = async (testId, value, opts = {}) => {
    const root = testIdSelector(testId);
    const selector = opts.inputSelector
      ? `${root} ${opts.inputSelector}`
      : `${root} input, ${root} textarea, ${root}`;
    return fill(selector, value, opts);
  };

  const setFiles = async (selector, files, opts = {}) => {
    const paths = normalizeFiles(files);
    const input = await waitForFileInput(selector, opts);
    if (paths.length > 1 && !input.multiple && opts.allowSingleInputMultiple !== true) {
      throw new Error(`文件输入框不支持多选: ${selector}`);
    }

    const call = requireCdp();
    await call('DOM.enable', {}, { timeoutMs: 5000 }).catch(() => {});
    const doc = await call('DOM.getDocument', { depth: -1, pierce: true }, { timeoutMs: opts.timeoutMs ?? 5000 });
    const { nodeId } = await call('DOM.querySelector', { nodeId: doc.root.nodeId, selector }, { timeoutMs: opts.timeoutMs ?? 5000 });
    if (!nodeId) throw new Error(`找不到文件输入框: ${selector}`);
    await call('DOM.setFileInputFiles', { nodeId, files: paths }, { timeoutMs: opts.timeoutMs ?? 10000 });

    return ev(`
      const el = document.querySelector(${selectorLiteral(selector)});
      if (!el) return null;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return [...el.files].map((file) => ({
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      }));
    `, { timeoutMs: opts.timeoutMs ?? 5000 });
  };

  const setFilesByTestId = async (testId, files, opts = {}) => {
    const root = testIdSelector(testId);
    const selector = opts.inputSelector ? `${root} ${opts.inputSelector}` : `${root} input[type=file]`;
    return setFiles(selector, files, opts);
  };

  const selectByTestId = async (testId, value, opts = {}) => {
    const root = testIdSelector(testId);
    const input = opts.inputSelector ? `${root} ${opts.inputSelector}` : `${root} input`;
    await fill(input, value, opts);
    await press('Enter');
    return value;
  };

  const text = async (selector) =>
    ev(`
      const el = document.querySelector(${selectorLiteral(selector)});
      return el ? String(el.textContent || el.value || '').trim() : null;
    `);

  const exists = async (selector, opts = {}) => Boolean(await elementBox(selector, opts).catch(() => null));

  const goto = async (path, opts = {}) => {
    const target = await ev(`
      const input = ${JSON.stringify(path)};
      if (/^[a-z]+:\\/\\//i.test(input)) return { url: input, hard: location.protocol !== 'file:' };
      const origin = location.origin && location.origin !== 'null' ? location.origin : '';
      return { url: origin ? new URL(input, origin).href : input, hard: !!origin && location.protocol !== 'file:' };
    `);

    if (!opts.soft && target?.hard && cdp) {
      await requireCdp()('Page.navigate', { url: target.url }, { timeoutMs: opts.timeoutMs ?? 10000 });
      const deadline = Date.now() + (opts.timeout ?? 20000);
      while (Date.now() <= deadline) {
        const ready = await ev(`
          return document.readyState !== 'loading' && !!(window.electronAPI && window.electronAPI.apiRequest);
        `, { timeoutMs: 1500 }).catch(() => false);
        if (ready) break;
        await sleep(100);
      }
      return ev(`return location.pathname + location.search + location.hash;`);
    }

    return ev(`
      const path = ${JSON.stringify(path)};
      const { router } = await import('/src/router/index.tsx');
      await router.navigate(path);
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return location.pathname + location.search + location.hash;
    `);
  };

  const location = async () =>
    ev(`
      return {
        href: window.location.href,
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      };
    `);

  const waitForUrl = async (pattern, opts = {}) => {
    const timeout = opts.timeout ?? 5000;
    const matcher = pattern instanceof RegExp
      ? `(url) => ${pattern.toString()}.test(url)`
      : `(url) => url.includes(${JSON.stringify(String(pattern))})`;
    return waitUntil(
      `async () => {
        const url = location.pathname + location.search + location.hash;
        return (${matcher})(url) ? url : false;
      }`,
      { timeout, interval: opts.interval, label: `URL ${String(pattern)}` },
    );
  };

  const screenshot = async () => {
    const r = await requireCdp()('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    return r.data;
  };

  return {
    waitFor,
    waitForText,
    exists,
    text,
    goto,
    click,
    clickText,
    clickByTestId,
    fill,
    fillByPlaceholder,
    fillByTestId,
    setFiles,
    setFilesByTestId,
    selectByTestId,
    waitUntil,
    waitForUrl,
    location,
    press,
    typeText,
    screenshot,
    raw: { elementBox, markByText, mouseClick },
  };
}
