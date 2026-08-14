import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  loadOrCreateRendererSurfacePort,
  normalizePort,
} = require('../../electron/renderer-surface-port.js');

function fixture() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-renderer-port-'));
}

test('renderer surface port remains stable for one Electron user data directory', () => {
  const root = fixture();
  try {
    const first = loadOrCreateRendererSurfacePort({ userDataPath: root, env: {}, choosePort: () => 31_337 });
    const second = loadOrCreateRendererSurfacePort({ userDataPath: root, env: {}, choosePort: () => 42_424 });

    assert.equal(first, 31_337);
    assert.equal(second, first);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(root, 'renderer-surface-port.json'), 'utf8')),
      { version: 1, port: 31_337 },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('explicit renderer surface port is validated and does not require a settings file', () => {
  const root = fixture();
  try {
    assert.equal(loadOrCreateRendererSurfacePort({
      userDataPath: root,
      env: { DSH_DESKTOP_WEB_PORT: '45678' },
    }), 45_678);
    assert.equal(fs.existsSync(path.join(root, 'renderer-surface-port.json')), false);
    assert.throws(
      () => loadOrCreateRendererSurfacePort({
        userDataPath: root,
        env: { DSH_DESKTOP_WEB_PORT: '0' },
      }),
      /1024 到 65535/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('port normalization rejects privileged, fractional, and out-of-range values', () => {
  assert.equal(normalizePort(1_024), 1_024);
  assert.equal(normalizePort(65_535), 65_535);
  assert.equal(normalizePort(80), null);
  assert.equal(normalizePort(20_000.5), null);
  assert.equal(normalizePort(65_536), null);
});
