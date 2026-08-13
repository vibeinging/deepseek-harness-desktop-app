#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openSession } from './lib/cdp.mjs';
import { makeDriver } from './lib/driver.mjs';

const appPath = path.resolve(process.argv[2] || 'release/mac-arm64/dsh-work.app');
const root = mkdtempSync(path.join(tmpdir(), 'dsh-packaged-faults-'));
const resultsDir = path.resolve(process.env.EVAL_REPORT_DIR || 'eval/results');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(resultsDir, `${runId}-agent-packaged-fault-matrix.json`);
const checks = [];
let firstSession = null;
let secondSession = null;

function check(ok, name, detail = null) {
  checks.push({ ok: Boolean(ok), name, detail });
  if (!ok) throw new Error(`${name}${detail ? `: ${JSON.stringify(detail)}` : ''}`);
}

function processAlive(pid) {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function waitUntil(fn, { timeoutMs = 60_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = { error: error?.message || String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`等待条件超时: ${JSON.stringify(last)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function save(status, error = null) {
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(reportPath, JSON.stringify({
    runId,
    appPath,
    status,
    error,
    summary: {
      total: checks.length,
      passed: checks.filter((item) => item.ok).length,
      failed: checks.filter((item) => !item.ok).length,
    },
    checks,
  }, null, 2));
}

process.env.DSH_EVAL_PACKAGED_APP = appPath;
process.env.DSH_EVAL_HOME = path.join(root, 'home');
process.env.DSH_EVAL_ISOLATED = '1';
process.env.DSH_DATA_ROOT = path.join(root, 'data');
process.env.DSH_AGENT_RUNTIME_HOME = path.join(root, 'agent_runtime');
process.env.DSH_SKILLS_ROOT = path.join(root, 'data', 'skills');
process.env.DSH_USER_DATA_DIR = path.join(root, 'user-data');
mkdirSync(process.env.DSH_EVAL_HOME, { recursive: true });
mkdirSync(process.env.DSH_USER_DATA_DIR, { recursive: true });

try {
  const firstPort = await freePort();
  firstSession = await openSession({ port: firstPort });
  const first = makeDriver(firstSession);
  await first.login();
  const firstSnapshot = await first.raw.ev('return await window.electronAPI.evalProcessSnapshot()');
  check(firstSnapshot?.backend_state === 'ready', '打包 App 的 Server 已就绪', firstSnapshot);
  check(Number(firstSnapshot?.electron_pid) > 0 && Number(firstSnapshot?.backend_pid) > 0, '记录打包 App 和 Server 真实 pid', firstSnapshot);

  const pid = await first.ensureProjectRecord('agent-packaged-fault-matrix-eval');
  const sessionResponse = await first.raw.api('POST', `/api/projects/${pid}/sessions`, {
    title: 'agent-packaged-fault-matrix-eval',
    source_type: 'agent',
    source_id: pid,
    action_type: 'agentic_chat',
  });
  const sid = sessionResponse.json?.data?.id || sessionResponse.json?.data?.session_id || '';
  check(sessionResponse.status === 200 && Boolean(sid), '打包 App 可创建故障诊断会话', { status: sessionResponse.status, sid });

  const runningResponse = await first.raw.api('POST', '/api/agents/recovery/diagnostics/prepare-running-exit', {
    project_id: pid,
    session_id: sid,
  });
  const running = runningResponse.json?.data || {};
  check(runningResponse.status === 200 && Boolean(running.run_id), '打包 App 创建运行中的真实 Runner 任务', {
    status: runningResponse.status,
    run_id: running.run_id,
  });
  check(processAlive(Number(running.runner_pid)), 'Electron 故障前 Runner 仍在运行', { pid: running.runner_pid });
  check(processAlive(Number(running.command_pid)), 'Electron 故障前命令进程组仍在运行', { pid: running.command_pid });

  process.kill(Number(firstSnapshot.electron_pid), 'SIGKILL');
  await firstSession.close().catch(() => {});
  firstSession = null;
  await waitUntil(() => !processAlive(Number(firstSnapshot.electron_pid)), { timeoutMs: 10_000 });
  await waitUntil(() => !processAlive(Number(firstSnapshot.backend_pid)), { timeoutMs: 10_000 });
  await waitUntil(() => !processAlive(Number(running.runner_pid)), { timeoutMs: 10_000 });
  await waitUntil(() => !processAlive(Number(running.command_pid)), { timeoutMs: 10_000 });
  check(true, '强杀 Electron 后 Server、Runner 和命令进程组均已退出', {
    electron_pid: firstSnapshot.electron_pid,
    backend_pid: firstSnapshot.backend_pid,
    runner_pid: running.runner_pid,
    command_pid: running.command_pid,
  });

  const secondPort = await freePort();
  secondSession = await openSession({ port: secondPort });
  const second = makeDriver(secondSession);
  await second.login();
  const secondSnapshot = await second.raw.ev('return await window.electronAPI.evalProcessSnapshot()');
  check(
    secondSnapshot?.backend_state === 'ready' && secondSnapshot.backend_pid !== firstSnapshot.backend_pid,
    '同一打包 App 重启后启动了新的 Server',
    { before: firstSnapshot, after: secondSnapshot },
  );

  const recovered = await waitUntil(async () => {
    const response = await second.raw.api('GET', `/api/agents/runs/${encodeURIComponent(running.run_id)}`);
    return response.status === 200 && response.json?.data?.run?.status === 'completed' ? response : null;
  });
  const recoveredFacts = recovered.json?.data || {};
  check(recoveredFacts.run?.status === 'completed', 'Electron 异常退出后的原 run_id 自动恢复完成');
  const originalWrite = (recoveredFacts.tools || []).find((tool) => tool.call_id === running.call_id);
  check(Number(originalWrite?.attempt_count) === 1, 'Electron 重启恢复没有重复执行已完成写调用', originalWrite);
  const recoveredEvents = new Set((recoveredFacts.events || []).map((event) => event.event_type));
  check(
    ['run_recovery_ready', 'run_recovery_dispatched', 'run_recovery_completed'].every((name) => recoveredEvents.has(name)),
    'Electron 重启后保留完整自动恢复事件',
    [...recoveredEvents],
  );

  const serverPrepared = await second.raw.api('POST', '/api/agents/recovery/diagnostics/prepare', {
    project_id: pid,
    session_id: sid,
  });
  const serverRun = serverPrepared.json?.data || {};
  check(serverPrepared.status === 200 && Boolean(serverRun.run_id), '打包 App 准备 Server 故障恢复运行');
  const restart = await second.raw.ev('return await window.electronAPI.evalRestartBackend()');
  check(Number(restart?.pid) === Number(secondSnapshot.backend_pid) && restart?.signal === 'SIGKILL', '打包 App 真实强杀当前 Server', restart);
  const serverRecovered = await waitUntil(async () => {
    const response = await second.raw.api('GET', `/api/agents/runs/${encodeURIComponent(serverRun.run_id)}`).catch(() => null);
    return response?.status === 200 && response.json?.data?.run?.status === 'completed' ? response : null;
  });
  const restartedSnapshot = await second.raw.ev('return await window.electronAPI.evalProcessSnapshot()');
  check(restartedSnapshot.backend_pid !== secondSnapshot.backend_pid, 'Electron 自动拉起新的 Server 子进程', restartedSnapshot);
  const serverWrite = (serverRecovered.json?.data?.tools || []).find((tool) => tool.call_id === serverRun.call_id);
  check(Number(serverWrite?.attempt_count) === 1, 'Server 重启没有重复执行已完成写调用', serverWrite);

  const runnerFault = await second.raw.api('POST', '/api/agents/runner/fault-diagnostics', {});
  check(runnerFault.status === 200 && runnerFault.json?.data?.passed === true, '打包 App 内 Runner 故障和孤儿进程检查通过', runnerFault.json?.data);

  await second.raw.api('DELETE', `/api/projects/${pid}/sessions/${sid}`).catch(() => {});
  const finalSnapshot = await second.raw.ev('return await window.electronAPI.evalProcessSnapshot()');
  await secondSession.close();
  secondSession = null;
  await waitUntil(() => !processAlive(Number(finalSnapshot.backend_pid)), { timeoutMs: 10_000 });
  check(true, '正常退出打包 App 后 Server 无残留', finalSnapshot);

  save('passed');
  console.log(`\n[packaged-faults] ${checks.length}/${checks.length} 检查通过`);
  console.log(`[packaged-faults] 报告: ${reportPath}`);
} catch (error) {
  save('failed', error?.stack || error?.message || String(error));
  console.error(`[packaged-faults] 失败: ${error?.stack || error}`);
  console.error(`[packaged-faults] 报告: ${reportPath}`);
  process.exitCode = 1;
} finally {
  await firstSession?.close?.().catch(() => {});
  await secondSession?.close?.().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}
