import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  canCopyTextContent,
  copyTextContent,
  createArtifactContextMenu,
  listMacApplicationsForFile,
} = require('../../electron/artifact-context-menu.js');

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-artifact-menu-'));
  const filePath = join(root, 'report.txt');
  const defaultApp = join(root, 'Default Reader.app');
  const secondApp = join(root, 'Second Reader.app');
  writeFileSync(filePath, 'hello artifact');
  mkdirSync(defaultApp);
  mkdirSync(secondApp);
  return { root, filePath, defaultApp, secondApp };
}

test('macOS application discovery uses NSWorkspace output and filters invalid app paths', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  const applications = await listMacApplicationsForFile(data.filePath, {
    platform: 'darwin',
    execute: async (_command, args) => {
      assert.equal(args.at(-1), data.filePath);
      return { stdout: JSON.stringify([
        { path: data.defaultApp, name: 'Default Reader' },
        { path: '/tmp/not-an-app', name: 'Invalid' },
      ]) };
    },
  });
  assert.deepEqual(applications, [{ path: data.defaultApp, name: 'Default Reader' }]);
});

test('text content copy is capped and stays in the trusted main-process helper', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  let copied = '';
  assert.equal(canCopyTextContent(data.filePath), true);
  assert.equal(copyTextContent(data.filePath, { writeText: (value) => { copied = value; } }), true);
  assert.equal(copied, 'hello artifact');
  assert.equal(canCopyTextContent(join(data.root, 'archive.zip')), false);
});

test('file menu contains default app, open-with submenu, copy actions and Finder reveal', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  const Menu = { buildFromTemplate: (template) => ({ template }) };
  const menu = await createArtifactContextMenu({
    app: {
      getApplicationInfoForProtocol: async () => ({ path: data.defaultApp, name: 'Default Reader.app', icon: 'default-icon' }),
      getFileIcon: async () => 'app-icon',
    },
    Menu,
    shell: { openPath: async () => '', showItemInFolder: () => {} },
    clipboard: { writeText: () => {}, writeImage: () => {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    filePath: data.filePath,
    kind: 'document',
    platform: 'darwin',
    listApplications: async () => [
      { path: data.defaultApp, name: 'Default Reader' },
      { path: data.secondApp, name: 'Second Reader' },
    ],
  });
  assert.deepEqual(menu.template.map((item) => item.label || item.type), [
    '打开文件',
    '在 Default Reader 中打开',
    '打开方式',
    'separator',
    '复制路径',
    '复制文件内容',
    '在 Finder 中显示',
  ]);
  assert.deepEqual(menu.template[2].submenu.map((item) => item.label), ['Default Reader', 'Second Reader']);
  assert.equal(menu.template[5].enabled, true);
});

test('image files keep the compact native reveal and copy menu', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  const imagePath = join(data.root, 'image.png');
  writeFileSync(imagePath, 'image');
  const menu = await createArtifactContextMenu({
    app: {},
    Menu: { buildFromTemplate: (template) => ({ template }) },
    shell: { showItemInFolder: () => {} },
    clipboard: { writeImage: () => {} },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    filePath: imagePath,
    kind: 'image',
  });
  assert.deepEqual(menu.template.map((item) => item.label), ['在 Finder 中显示', '复制图片']);
});
