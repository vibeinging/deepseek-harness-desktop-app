import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveNpmCli } from './project-runtime.mjs';

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['server', 'renderer', 'electron'];
const npmCli = resolveNpmCli(process.execPath);

// React Router 7.18.1 only reports this issue for RSC server actions. This app
// uses createHashRouter in an Electron renderer and has no RSC/SSR server.
// image-size: no fixed release exists upstream (latest 2.0.2 is still flagged).
// pptxgenjs declares image-size in package.json but never references it in any
// dist bundle, and dsh-work's PPTX path never calls addImage, so the vulnerable
// ICNS/JXL/HEIF parsers are never loaded at runtime.
const allowedAdvisories = new Set([
  'https://github.com/advisories/GHSA-qwww-vcr4-c8h2',
  'https://github.com/advisories/GHSA-w3rx-r6r6-pgpr',
  'https://github.com/advisories/GHSA-5p2g-fcmc-qvqq',
]);

function severityRank(value) {
  return { info: 0, low: 1, moderate: 2, high: 3, critical: 4 }[value] ?? 5;
}

function advisoryUrls(name, vulnerabilities, seen = new Set()) {
  if (seen.has(name)) return new Set();
  seen.add(name);

  const vulnerability = vulnerabilities[name];
  if (!vulnerability) return new Set([`unknown:${name}`]);

  const urls = new Set();
  for (const item of vulnerability.via ?? []) {
    if (typeof item === 'string') {
      for (const url of advisoryUrls(item, vulnerabilities, seen)) urls.add(url);
    } else if (item?.url) {
      urls.add(item.url);
    } else {
      urls.add(`unknown:${name}`);
    }
  }
  if (urls.size === 0) urls.add(`unknown:${name}`);
  return urls;
}

let failed = false;

for (const target of targets) {
  const result = spawnSync(process.execPath, [npmCli, 'audit', '--omit=dev', '--json'], {
    cwd: join(APP_DIR, target),
    encoding: 'utf8',
    shell: false,
  });

  let report;
  try {
    report = JSON.parse(String(result.stdout || '').replace(/^\uFEFF/, ''));
  } catch {
    console.error(`[audit] ${target}: 无法读取 npm audit 结果`);
    if (result.error) console.error(result.error.message);
    if (result.stderr) console.error(result.stderr.trim());
    failed = true;
    continue;
  }

  const vulnerabilities = report.vulnerabilities ?? {};
  const blocked = [];
  const allowed = [];

  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (severityRank(vulnerability.severity) < severityRank('high')) continue;
    const urls = [...advisoryUrls(name, vulnerabilities)];
    if (urls.length > 0 && urls.every((url) => allowedAdvisories.has(url))) {
      allowed.push(`${name} (${urls.join(', ')})`);
    } else {
      blocked.push(`${name}: ${vulnerability.severity} (${urls.join(', ')})`);
    }
  }

  const counts = report.metadata?.vulnerabilities ?? {};
  console.log(
    `[audit] ${target}: critical=${counts.critical ?? 0}, high=${counts.high ?? 0}, moderate=${counts.moderate ?? 0}`,
  );
  for (const item of allowed) console.log(`[audit] 已确认不适用: ${item}`);
  for (const item of blocked) console.error(`[audit] 阻止发布: ${item}`);
  if (blocked.length > 0) failed = true;
}

if (failed) process.exit(1);
console.log('[audit] 没有未处理的生产依赖高危或严重漏洞');
