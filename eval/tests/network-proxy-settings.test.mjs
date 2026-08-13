import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { normalizeProxyUrl, proxyLogLabel } = require('../../electron/network-proxy-settings.js');
const ROOT = resolve(import.meta.dirname, '../..');

test('authenticated proxy URLs fail closed and never produce a persisted value', () => {
  assert.equal(normalizeProxyUrl('http://alice:secret@proxy.example:8080'), '');
  assert.throws(
    () => normalizeProxyUrl('http://alice:secret@proxy.example:8080', { strict: true }),
    (error) => error.code === 'NETWORK_PROXY_INVALID' && !error.message.includes('secret'),
  );
  assert.equal(normalizeProxyUrl('proxy.example:8080', { strict: true }), 'http://proxy.example:8080');
});

test('proxy log labels omit userinfo, paths, queries and fragments', () => {
  const label = proxyLogLabel('http://alice:secret@proxy.example:8080/private?token=x#y');
  assert.equal(label, 'http://proxy.example:8080');
  assert.doesNotMatch(label, /alice|secret|private|token/);
});

test('server startup logs never print proxy credentials from inherited environment variables', () => {
  const secret = 'proxy-password-must-not-leak';
  const result = spawnSync(process.execPath, ['-e', 'import("./server/src/config/network.js")'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HTTPS_PROXY: `http://alice:${secret}@proxy.example:8080`,
      HTTP_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: 'localhost',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.doesNotMatch(output, new RegExp(secret));
  assert.doesNotMatch(output, /alice/);
  assert.match(output, /HTTP proxy enabled: http:\/\/proxy\.example:8080/);
});
