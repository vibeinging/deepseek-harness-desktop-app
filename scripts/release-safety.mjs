#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');
const TEXT_EXTENSIONS = new Set(['.cjs', '.js', '.json', '.jsx', '.mjs', '.ts', '.tsx', '.vue']);

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function readJson(path) {
  try { return JSON.parse(readText(path)); } catch { return null; }
}

function check(id, status, detail, evidence = null) {
  return { id, status, detail, evidence };
}

function walkFiles(path, output = []) {
  if (!existsSync(path)) return output;
  const info = statSync(path);
  if (info.isFile()) {
    output.push(path);
    return output;
  }
  for (const name of readdirSync(path)) {
    if (new Set(['node_modules', 'dist', 'release', '.desktop-build']).has(name)) continue;
    walkFiles(join(path, name), output);
  }
  return output;
}

export function findVendorRuntimeUsage(root) {
  const paths = [
    join(root, 'server', 'src'),
    join(root, 'renderer', 'src'),
    join(root, 'electron', 'main.js'),
    join(root, 'electron', 'preload.js'),
    join(root, 'server', 'package.json'),
    join(root, 'renderer', 'package.json'),
    join(root, 'electron', 'package.json'),
  ];
  const pattern = /(?:github\.com\/openai\/codex|@openai\/codex|codex-rs|codex-cli)/i;
  return paths.flatMap((path) => walkFiles(path))
    .filter((path) => TEXT_EXTENSIONS.has(path.slice(path.lastIndexOf('.'))))
    .flatMap((path) => {
      const text = readText(path);
      return pattern.test(text) ? [path.slice(root.length + 1)] : [];
    });
}

export function hasVexDistributionAuthorization(root) {
  const vendor = join(root, 'server', 'vendor', 'vexdb_lite');
  const license = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
    .map((name) => readText(join(vendor, name)))
    .find(Boolean) || '';
  const authorization = readText(join(vendor, 'DISTRIBUTION-AUTHORIZATION.md'));
  const provenance = readText(join(vendor, 'RELEASE-PROVENANCE.md'));
  const checksums = readText(join(vendor, 'SHA256SUMS'));
  const hasDistributionTerms = (
    license.includes('Permission is hereby granted')
    && license.includes('distribute')
  ) || authorization.length > 0;
  return hasDistributionTerms
    && provenance.includes('VexDB-THU/VexDB-Lite/releases/tag/v0.0.17')
    && checksums.includes('macos/vexdb_lite.dylib')
    && checksums.includes('windows-x64/vexdb_lite.dll');
}

export function hasAgentSandboxDefault(root) {
  const workspaceAgent = readText(join(root, 'server', 'src', 'engine', 'agents', 'workspace_agent.js'));
  const desktopProfile = readText(join(root, 'server', 'src', 'engine', 'dsh_runtime', 'desktop_web.patch.yml'));
  const approvalMode = readText(join(root, 'server', 'src', 'engine', 'agents', 'approval_mode.js'));
  // Since the 2026-08 DSH runtime migration, app conversations execute through
  // the DSH Web profile, whose defaults are on-request approval and a
  // workspace-write sandbox. The app-level gate therefore asserts that the
  // agent path routes through DshWorkspaceRuntime, the desktop profile overlay
  // does not relax those defaults, and the local fallback default stays "ask".
  const routesThroughDshRuntime = /DshWorkspaceRuntime/.test(workspaceAgent)
    && /runtime\.execute\(\{ agentContext, streamCallback, cwd \}\)/.test(workspaceAgent);
  const profileDoesNotRelaxSandbox = !/approvalPolicy:\s*["']never["']/.test(desktopProfile)
    && !/sandbox:\s*["'](?:unrestricted|host)["']/.test(desktopProfile)
    && !/["'](?:unattended|full)["']/.test(desktopProfile);
  const localDefaultStaysAsk = /return Object\.hasOwn\(APPROVAL_MODE_SETTINGS, mode\) \? mode : "ask"/.test(approvalMode)
    && /ask: Object\.freeze\(\{[\s\S]*?approvalPolicy:\s*["']on-request["'][\s\S]*?sandbox:\s*["']workspace-write["']/.test(approvalMode);
  return routesThroughDshRuntime && profileDoesNotRelaxSandbox && localDefaultStaysAsk;
}

export function classifyMacSignatureOutput(output) {
  const text = String(output || '');
  const team = text.match(/TeamIdentifier=([^\s]+)/)?.[1] || '';
  const adhoc = /Signature=adhoc|flags=.*adhoc/i.test(text);
  return {
    signed_for_distribution: Boolean(team && team !== 'not' && !adhoc),
    team_identifier: team && team !== 'not' ? team : null,
    adhoc,
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false });
  return {
    ok: result.status === 0,
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim(),
  };
}

function staticChecks(root, scope) {
  const checks = [];
  const privacy = readText(join(root, 'PRIVACY.md'));
  const security = readText(join(root, 'SECURITY.md'));
  const notices = readText(join(root, 'THIRD_PARTY_NOTICES.md'));
  const electronPackage = readJson(join(root, 'electron', 'package.json')) || {};
  const build = electronPackage.build || {};
  const mac = build.mac || {};
  const scripts = electronPackage.scripts || {};
  const extraResources = Array.isArray(build.extraResources) ? build.extraResources : [];
  const packagedLegal = new Set(extraResources.map((item) => item?.to).filter(Boolean));

  checks.push(check(
    'privacy_notice',
    privacy.includes('~/.dsh') && privacy.includes('workspace-write') && privacy.includes('on-request') ? 'pass' : 'block',
    '说明本地文件、联网边界、保留和删除规则',
    'PRIVACY.md',
  ));
  checks.push(check(
    'security_contact',
    security.includes('私下联系维护者') ? 'pass' : 'block',
    '提供不公开敏感信息的安全反馈入口',
    'SECURITY.md',
  ));
  checks.push(check(
    'third_party_notices',
    notices.includes('OpenAI Agent Runtime') && notices.includes('VexDB Lite') ? 'pass' : 'block',
    '记录关键第三方组件、运行时使用情况和二进制限制',
    'THIRD_PARTY_NOTICES.md',
  ));
  const vendorRuntimeUsage = findVendorRuntimeUsage(root);
  const vendorRuntimeLicense = join(root, 'legal', 'openai-agent-runtime-LICENSE.txt');
  const vendorRuntimeDistributionReady = vendorRuntimeUsage.length === 0 || (
    existsSync(vendorRuntimeLicense)
    && notices.includes('OpenAI Agent Runtime | 0.147.0 | Apache-2.0')
  );
  checks.push(check(
    'vendor_runtime_distribution',
    vendorRuntimeDistributionReady ? 'pass' : 'block',
    vendorRuntimeUsage.length === 0
      ? '生产代码未复制或链接第三方 Agent 运行时源码或二进制'
      : vendorRuntimeDistributionReady
        ? `第三方 Agent 运行时分发已记录并包含 Apache-2.0 许可证：${vendorRuntimeUsage.join(', ')}`
        : `第三方 Agent 运行时已进入生产依赖，但缺少 Apache-2.0 分发材料：${vendorRuntimeUsage.join(', ')}`,
    { usage: vendorRuntimeUsage, license: vendorRuntimeLicense },
  ));
  checks.push(check(
    'vexdb_lite_distribution',
    hasVexDistributionAuthorization(root) ? 'pass' : 'block',
    'VexDB Lite 必须同时保留许可证或分发授权、发行来源和随包文件 SHA-256',
    'server/vendor/vexdb_lite',
  ));
  checks.push(check(
    'legal_files_packaged',
    ['legal/LICENSE', 'legal/PRIVACY.md', 'legal/SECURITY.md', 'legal/THIRD_PARTY_NOTICES.md', 'legal/openai-agent-runtime-LICENSE.txt']
      .every((name) => packagedLegal.has(name)) ? 'pass' : 'block',
    '安装包包含许可证、隐私、安全和第三方说明',
    'electron/package.json#build.extraResources',
  ));
  checks.push(check(
    'agent_sandbox_default',
    hasAgentSandboxDefault(root) ? 'pass' : 'block',
    'Agent 默认使用受控工作区权限和按需审批',
    [
      'server/src/engine/agents/approval_mode.js',
      'server/src/engine/agents/workspace_agent.js',
      'server/src/engine/dsh_runtime/desktop_web.patch.yml',
    ],
  ));

  if (scope === 'all' || scope === 'macos') {
    checks.push(check(
      'mac_release_configuration',
      mac.hardenedRuntime === true
        && mac.notarize === true
        && String(scripts['package:mac:project'] || '').includes('forceCodeSigning=true')
        ? 'pass' : 'block',
      '正式 macOS 构建强制 Developer ID 签名、Hardened Runtime 和公证',
      'electron/package.json',
    ));
  }
  if (scope === 'all' || scope === 'windows') {
    checks.push(check(
      'windows_release_configuration',
      String(scripts['package:win:project'] || '').includes('forceCodeSigning=true') ? 'pass' : 'block',
      '正式 Windows 构建强制代码签名',
      'electron/package.json',
    ));
  }
  return checks;
}

function inspectMacBundle(appPath) {
  if (!appPath || !existsSync(appPath)) {
    return [check('mac_artifact', 'block', '找不到待发布 macOS .app', appPath || null)];
  }
  const signatureDetail = run('codesign', ['-dv', '--verbose=4', appPath]);
  const signature = classifyMacSignatureOutput(signatureDetail.output);
  const strict = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
  const gatekeeper = run('spctl', ['--assess', '--type', 'execute', '--verbose=4', appPath]);
  const stapler = run('xcrun', ['stapler', 'validate', appPath]);
  return [
    check(
      'mac_developer_id_signature',
      signature.signed_for_distribution ? 'pass' : 'block',
      signature.signed_for_distribution
        ? `Developer ID 签名，Team ${signature.team_identifier}`
        : signature.adhoc ? '当前产物只有 adhoc 临时签名' : '当前产物没有可确认的 Developer ID 签名',
      signatureDetail.output.slice(0, 1_000),
    ),
    check('mac_signature_integrity', strict.ok ? 'pass' : 'block', 'codesign 严格校验', strict.output.slice(0, 1_000)),
    check('mac_gatekeeper', gatekeeper.ok ? 'pass' : 'block', 'Gatekeeper 接受待发布 App', gatekeeper.output.slice(0, 1_000)),
    check('mac_notarization_ticket', stapler.ok ? 'pass' : 'block', 'Apple 公证票据已附加或可验证', stapler.output.slice(0, 1_000)),
  ];
}

function inspectWindowsBundle(root, appPath) {
  const receiptPath = join(root, 'release', 'windows-x64-acceptance.json');
  const receipt = readJson(receiptPath);
  const checks = [check(
    'windows_real_machine_acceptance',
    receipt?.passed === true && receipt?.platform === 'win32' && receipt?.arch === 'x64' ? 'pass' : 'block',
    'Windows x64 实机需要保存安装、启动、沙箱、清理和卸载验收回执',
    receiptPath,
  )];
  if (process.platform !== 'win32') {
    checks.push(check('windows_code_signature', 'manual', 'Windows 签名只能在 Windows 产物或实机上验证', appPath || null));
    return checks;
  }
  if (!appPath || !existsSync(appPath)) {
    checks.push(check('windows_code_signature', 'block', '找不到待发布 Windows 可执行文件', appPath || null));
    return checks;
  }
  const command = `(Get-AuthenticodeSignature -FilePath '${String(appPath).replaceAll("'", "''")}').Status`;
  const signature = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);
  checks.push(check(
    'windows_code_signature',
    signature.ok && /Valid/i.test(signature.output) ? 'pass' : 'block',
    'Windows Authenticode 签名有效',
    signature.output,
  ));
  return checks;
}

export function inspectReleaseSafety({
  root = DEFAULT_ROOT,
  scope = 'all',
  staticOnly = false,
  appPath = null,
} = {}) {
  const normalizedRoot = resolve(root);
  const checks = staticChecks(normalizedRoot, scope);
  if (!staticOnly && (scope === 'all' || scope === 'macos')) {
    checks.push(...inspectMacBundle(resolve(appPath || join(normalizedRoot, 'release', 'mac-arm64', 'dsh-work.app'))));
  }
  if (!staticOnly && (scope === 'all' || scope === 'windows')) {
    checks.push(...inspectWindowsBundle(normalizedRoot, appPath ? resolve(appPath) : null));
  }
  const summary = {
    pass: checks.filter((item) => item.status === 'pass').length,
    block: checks.filter((item) => item.status === 'block').length,
    manual: checks.filter((item) => item.status === 'manual').length,
  };
  return {
    version: 'dsh.release-safety.v1',
    checked_at: new Date().toISOString(),
    scope,
    static_only: staticOnly,
    ready: summary.block === 0 && summary.manual === 0,
    summary,
    checks,
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(arg('root', DEFAULT_ROOT));
  const scope = arg('scope', 'all');
  if (!new Set(['all', 'macos', 'windows']).has(scope)) throw new Error(`未知检查范围：${scope}`);
  const report = inspectReleaseSafety({
    root,
    scope,
    staticOnly: hasFlag('static'),
    appPath: arg('app'),
  });
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready && !hasFlag('allow-blockers')) process.exitCode = 1;
}
