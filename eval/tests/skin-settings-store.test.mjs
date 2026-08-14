import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  MAX_BG_IMAGE_BYTES,
  MAX_USER_SKINS,
  copyValidatedBgImage,
  createSettingsStore,
  readValidatedBgImage,
  saveResult,
} = require('../../electron/skin-settings-store.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skin-settings-'));
  const paths = {
    skinsPath: path.join(root, 'skins.json'),
    brandPath: path.join(root, 'brand.json'),
    appearancePath: path.join(root, 'appearance.json'),
  };
  return {
    root,
    paths,
    store: createSettingsStore({ ...paths, defaultAppName: 'dsh-work' }),
  };
}

function skin(index, extra = {}) {
  return {
    id: `skin-${index}`,
    name: `Skin ${index}`,
    builtIn: false,
    source: 'user',
    vars: { '--el-color-primary': '#123456' },
    ...extra,
  };
}

test('settings load distinguishes missing, corrupt and valid files', () => {
  const { root, paths, store } = fixture();
  try {
    assert.deepEqual(store.loadSkins(), { status: 'missing' });

    fs.writeFileSync(paths.skinsPath, '{not json');
    const corrupt = store.loadSkins();
    assert.equal(corrupt.status, 'corrupt');
    assert.equal(corrupt.error.code, 'SETTINGS_JSON_CORRUPT');

    fs.writeFileSync(paths.skinsPath, JSON.stringify({
      schema_version: 1,
      userSkins: [],
      activeSkinId: 'lighting',
    }));
    const malformedVersioned = store.loadSkins();
    assert.equal(malformedVersioned.status, 'corrupt');
    assert.equal(malformedVersioned.error.code, 'SETTINGS_REVISION_INVALID');

    fs.writeFileSync(paths.skinsPath, JSON.stringify({ userSkins: [skin(1)], activeSkinId: 'skin-1' }));
    const valid = store.loadSkins();
    assert.equal(valid.status, 'valid');
    assert.equal(valid.value.schema_version, 0, 'legacy envelope remains identifiable for conservative Renderer merge');
    assert.equal(valid.value.userSkins.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skins save rejects item 65 instead of truncating a successful response', () => {
  const { root, paths, store } = fixture();
  try {
    const original = store.saveSkins({
      revision: 1,
      updated_at: 1,
      userSkins: [skin(0)],
      activeSkinId: 'skin-0',
    });
    assert.equal(original.userSkins.length, 1);
    const before = fs.readFileSync(paths.skinsPath, 'utf8');

    const result = saveResult(() => store.saveSkins({
      revision: 2,
      updated_at: 2,
      userSkins: Array.from({ length: MAX_USER_SKINS + 1 }, (_, index) => skin(index)),
      activeSkinId: 'skin-0',
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SKINS_COUNT_EXCEEDED');
    assert.equal(fs.readFileSync(paths.skinsPath, 'utf8'), before, 'failed write keeps the previous complete file');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('versioned settings preserve a bounded Profile theme id for startup pending restore', () => {
  const { root, store } = fixture();
  const profileThemeId = 'profile:%40demo%2Ftheme-pack:sunset-orange';
  try {
    store.saveSkins({
      revision: 9,
      updated_at: 90,
      userSkins: [],
      activeSkinId: profileThemeId,
    });
    const loaded = store.loadSkins();
    assert.equal(loaded.status, 'valid');
    assert.equal(loaded.value.activeSkinId, profileThemeId);

    const invalid = saveResult(() => store.saveSkins({
      revision: 10,
      updated_at: 100,
      userSkins: [],
      activeSkinId: 'profile:../../escape:bad',
    }));
    assert.equal(invalid.ok, false);
    assert.equal(invalid.error.code, 'SKINS_ACTIVE_ID_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skins settings always converge fallback to the host foundation', () => {
  const { root, store } = fixture();
  try {
    store.saveSkins({
      revision: 3,
      updated_at: 30,
      userSkins: [],
      activeSkinId: 'profile:%40demo%2Ftheme-pack:ocean',
      fallbackSkinId: 'china-red',
    });
    assert.equal(store.loadSkins().value.fallbackSkinId, 'lighting');

    const normalized = store.saveSkins({
      revision: 4,
      updated_at: 40,
      userSkins: [],
      activeSkinId: 'lighting',
      fallbackSkinId: 'not-a-theme',
    });
    assert.equal(normalized.fallbackSkinId, 'lighting');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('skins save rejects payloads above 2MB and keeps the previous revision', () => {
  const { root, paths, store } = fixture();
  try {
    store.saveSkins({ revision: 3, updated_at: 3, userSkins: [skin(0)], activeSkinId: 'skin-0' });
    const before = fs.readFileSync(paths.skinsPath, 'utf8');
    const result = saveResult(() => store.saveSkins({
      revision: 4,
      updated_at: 4,
      userSkins: [skin(1, { description: 'x'.repeat(2 * 1024 * 1024) })],
      activeSkinId: 'skin-1',
    }));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SETTINGS_FILE_TOO_LARGE');
    assert.equal(fs.readFileSync(paths.skinsPath, 'utf8'), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('atomic write leaves no partial target or temporary file when rename fails', { concurrency: false }, () => {
  const { root, paths, store } = fixture();
  const originalRename = fs.renameSync;
  try {
    store.saveBrand({ revision: 1, updated_at: 1, name: '旧名称' });
    const before = fs.readFileSync(paths.brandPath, 'utf8');
    fs.renameSync = () => {
      const error = new Error('simulated rename failure');
      error.code = 'EIO';
      throw error;
    };
    const result = saveResult(() => store.saveBrand({ revision: 2, updated_at: 2, name: '新名称' }));
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(paths.brandPath, 'utf8'), before);
    assert.deepEqual(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')), []);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('brand and appearance use versioned values without turning damage into empty settings', () => {
  const { root, paths, store } = fixture();
  try {
    store.saveBrand({ revision: 7, updated_at: 70, name: 'Data Agent' });
    store.saveAppearance({ revision: 8, updated_at: 80, appearance: { bgImage: 'aurora' } });
    assert.deepEqual(store.loadBrand(), {
      status: 'valid',
      value: { schema_version: 1, revision: 7, updated_at: 70, name: 'Data Agent' },
    });
    assert.deepEqual(store.loadAppearance(), {
      status: 'valid',
      value: { schema_version: 1, revision: 8, updated_at: 80, appearance: { bgImage: 'aurora' } },
    });

    fs.writeFileSync(paths.appearancePath, JSON.stringify({ appearance: [] }));
    const corrupt = store.loadAppearance();
    assert.equal(corrupt.status, 'corrupt');
    assert.equal(corrupt.error.code, 'APPEARANCE_PAYLOAD_INVALID');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('brand and appearance saves reject invalid IPC values without overwriting prior settings', () => {
  const { root, paths, store } = fixture();
  try {
    store.saveBrand({ revision: 1, updated_at: 1, name: '安全名称' });
    store.saveAppearance({ revision: 1, updated_at: 1, appearance: { bgImage: 'aurora' } });
    const brandBefore = fs.readFileSync(paths.brandPath, 'utf8');
    const appearanceBefore = fs.readFileSync(paths.appearancePath, 'utf8');

    const tooLong = saveResult(() => store.saveBrand({
      revision: 2,
      updated_at: 2,
      name: 'x'.repeat(33),
    }));
    assert.equal(tooLong.ok, false);
    assert.equal(tooLong.error.code, 'BRAND_NAME_TOO_LONG');
    assert.equal(fs.readFileSync(paths.brandPath, 'utf8'), brandBefore);

    const invalidAppearance = saveResult(() => store.saveAppearance({
      revision: 2,
      updated_at: 2,
      appearance: [],
    }));
    assert.equal(invalidAppearance.ok, false);
    assert.equal(invalidAppearance.error.code, 'APPEARANCE_PAYLOAD_INVALID');
    assert.equal(fs.readFileSync(paths.appearancePath, 'utf8'), appearanceBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('background image rejects files above 8MB before reading any bytes', async () => {
  let readCalled = false;
  let closeCalled = false;
  const handle = {
    stat: async () => ({ isFile: () => true, size: MAX_BG_IMAGE_BYTES + 1, mtimeMs: 1 }),
    read: async () => {
      readCalled = true;
      return { bytesRead: 0 };
    },
    close: async () => { closeCalled = true; },
  };

  await assert.rejects(
    readValidatedBgImage('/virtual/too-large.png', {
      declaredMimeType: 'image/png',
      openFile: async () => handle,
    }),
    (error) => error?.code === 'BG_IMAGE_TOO_LARGE',
  );
  assert.equal(readCalled, false);
  assert.equal(closeCalled, true);
});

test('background image rejects a declared MIME type that does not match its signature', async () => {
  const { root } = fixture();
  const filePath = path.join(root, 'pretends-to-be-jpeg.jpg');
  try {
    fs.writeFileSync(filePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x00,
    ]));
    await assert.rejects(
      readValidatedBgImage(filePath, { declaredMimeType: 'image/jpeg' }),
      (error) => error?.code === 'BG_IMAGE_TYPE_MISMATCH',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('background image rejects a file that changes while it is being read', async () => {
  const bytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x00,
  ]);
  let statCalls = 0;
  const handle = {
    stat: async () => ({
      isFile: () => true,
      size: bytes.length,
      mtimeMs: ++statCalls,
    }),
    read: async (target, offset, length) => {
      bytes.copy(target, offset, 0, length);
      return { bytesRead: length };
    },
    close: async () => undefined,
  };

  await assert.rejects(
    readValidatedBgImage('/virtual/changing.png', {
      declaredMimeType: 'image/png',
      openFile: async () => handle,
    }),
    (error) => error?.code === 'BG_IMAGE_CHANGED',
  );
});

test('valid background image is copied to a stable 24-character hash URL', async () => {
  const { root } = fixture();
  const filePath = path.join(root, 'source.png');
  const destinationDir = path.join(root, 'bg-images');
  try {
    fs.writeFileSync(filePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]));
    const url = await copyValidatedBgImage({
      filePath,
      declaredMimeType: 'image/png',
      destinationDir,
    });
    assert.match(url, /^dsh-skin-asset:\/\/[a-f0-9]{24}\.png$/);
    const fileName = url.slice('dsh-skin-asset://'.length);
    assert.equal(fs.existsSync(path.join(destinationDir, fileName)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('all skin and brand IPC handlers reject non-main-window senders', () => {
  const source = fs.readFileSync(path.resolve('electron/main.js'), 'utf8');
  const channels = [
    'skins-load',
    'skins-save',
    'brand-load',
    'brand-save',
    'brand-set-name',
    'brand-appearance-load',
    'brand-appearance-save',
    'brand-copy-bg-image',
  ];
  for (const channel of channels) {
    const marker = `ipcMain.handle('${channel}'`;
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `${channel} handler must exist`);
    const next = source.indexOf('ipcMain.handle(', start + marker.length);
    const handler = source.slice(start, next === -1 ? source.length : next);
    assert.match(handler, /requireTrustedRenderer\(event\);/, `${channel} must check the sender`);
  }
});
