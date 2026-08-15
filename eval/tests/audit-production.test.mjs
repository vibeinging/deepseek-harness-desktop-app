import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('production audit runs the resolved npm CLI through the current Node process', (t) => {
  const fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-audit-production-'));
  const npmCli = join(fixtureDir, 'npm-cli.js');
  const callsPath = join(fixtureDir, 'calls.jsonl');
  t.after(() => rmSync(fixtureDir, { recursive: true, force: true }));

  writeFileSync(npmCli, `
const { appendFileSync } = require('node:fs');
appendFileSync(process.env.DSH_AUDIT_CALLS_PATH, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');
process.stdout.write(JSON.stringify({ vulnerabilities: {}, metadata: { vulnerabilities: {} } }));
`);

  const result = spawnSync(process.execPath, [join(APP_DIR, 'scripts', 'audit-production.mjs')], {
    cwd: APP_DIR,
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_execpath: npmCli,
      DSH_AUDIT_CALLS_PATH: callsPath,
    },
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /没有未处理的生产依赖高危或严重漏洞/);
  const calls = readFileSync(callsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(calls.map((call) => call.argv), [
    ['audit', '--omit=dev', '--json'],
    ['audit', '--omit=dev', '--json'],
    ['audit', '--omit=dev', '--json'],
  ]);
  assert.deepEqual(calls.map((call) => call.cwd), [
    join(APP_DIR, 'server'),
    join(APP_DIR, 'renderer'),
    join(APP_DIR, 'electron'),
  ]);
});
