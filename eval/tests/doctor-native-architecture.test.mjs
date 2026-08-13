import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const doctor = readFileSync(new URL('../../scripts/doctor.mjs', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../../scripts/project-runtime.mjs', import.meta.url), 'utf8');
const bootstrap = readFileSync(new URL('../../scripts/bootstrap.mjs', import.meta.url), 'utf8');
const dev = readFileSync(new URL('../../scripts/dev.mjs', import.meta.url), 'utf8');

test('doctor checks Electron and better-sqlite3 architectures before approving dev startup', () => {
  assert.match(doctor, /electronRequire\('electron'\)/);
  assert.match(doctor, /better_sqlite3\.node/);
  assert.match(doctor, /Electron 架构不匹配/);
  assert.match(doctor, /better-sqlite3 架构不匹配/);
});

test('desktop runtime cannot be pinned to stale x64 dependency metadata on Apple Silicon', () => {
  assert.match(runtime, /env\.DSH_PROJECT_ARCH \|\| macHardwareArch\(\)/);
  assert.doesNotMatch(runtime, /marker\?\.arch \|\| sqliteArch \|\| macHardwareArch\(\)/);
});

test('dev startup repairs native dependency architecture before launching Electron', () => {
  assert.match(bootstrap, /nativeBinariesMatchRuntime/);
  assert.match(bootstrap, /npm_config_arch: process\.arch/);
  assert.match(dev, /ensureDesktopDependencies/);
  assert.match(dev, /bootstrap\.mjs/);
});
