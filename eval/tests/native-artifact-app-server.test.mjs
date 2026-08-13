import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { AgentKernel } from '../../server/src/engine/agent_kernel/kernel.js';
import { createProductTools } from '../../server/src/engine/agents/product_tools.js';

test('the pinned app-server accepts the real artifact_publish dynamic tool contract', { timeout: 30_000 }, async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('bundled native app-server smoke currently runs on macOS');
    return;
  }
  const binary = [
    resolve('server/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex'),
    resolve('server/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex'),
  ].find(existsSync);
  if (!binary) {
    t.skip('bundled app-server binary is unavailable');
    return;
  }

  const runtimeHome = await mkdtemp(join(tmpdir(), 'dsh-native-artifact-'));
  const tools = createProductTools({
    db: { async query() { return []; }, async queryOne() { return null; } },
    project_id: 'artifact-project',
    user_id: 'artifact-user',
    workspace_roots: [process.cwd()],
  }).filter((tool) => tool.name === 'artifact_publish');
  assert.equal(tools.length, 1);

  const kernel = new AgentKernel({
    binary,
    cwd: process.cwd(),
    env: { ...process.env, CODEX_HOME: runtimeHome },
    requestTimeoutMs: 15_000,
  });
  try {
    const started = await kernel.startThread({
      ephemeral: true,
      tools,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      sandbox: 'workspace-write',
      runtimeWorkspaceRoots: [process.cwd()],
      developerInstructions: 'Completed local outputs may be registered with artifact_publish.',
    });
    assert.ok(started.thread.id);
    const read = await kernel.readThread(started.thread.id, { includeTurns: false });
    assert.equal(read.thread.id, started.thread.id);
  } finally {
    await kernel.stop();
    await rm(runtimeHome, { recursive: true, force: true });
  }
});
