import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { AgentKernel } from '../../server/src/engine/agent_kernel/kernel.js';
import { stopChatCompletionsAdapter } from '../../server/src/engine/agent_kernel/chat_completions_adapter.js';
import { createAgentModelBinding } from '../../server/src/engine/agent_kernel/model_provider.js';
import {
  DSH_WORKSPACE_PERMISSION_PROFILE,
  withWorkspacePermissionProfile,
} from '../../server/src/engine/agents/workspace_permissions.js';

async function listen(server) {
  await new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  return `http://127.0.0.1:${server.address().port}/v1`;
}

function chatChunk(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function sendToolCall(response, { id, name, arguments: args }) {
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'native-multi-root-test-model',
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  });
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'native-multi-root-test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
  });
  response.end('data: [DONE]\n\n');
}

function sendText(response, id, text) {
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'native-multi-root-test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
  });
  chatChunk(response, {
    id: `chatcmpl_${id}`,
    model: 'native-multi-root-test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  response.end('data: [DONE]\n\n');
}

function commandTool(body) {
  return (body.tools || []).find((tool) => {
    const name = String(tool?.function?.name || '');
    return name === 'exec_command' || name.endsWith('__exec_command') || name === 'shell' || name.endsWith('__shell');
  });
}

function commandArguments(tool, argv) {
  const properties = tool?.function?.parameters?.properties || {};
  const shellText = argv.map((value) => JSON.stringify(String(value))).join(' ');
  if (properties.cmd) return { cmd: shellText };
  if (properties.command?.type === 'array') return { command: argv };
  if (properties.command) return { command: shellText };
  throw new Error(`unknown command tool schema: ${JSON.stringify(tool?.function || {})}`);
}

test('the pinned app-server reads declared Skill roots and blocks app-private paths', { timeout: 45_000 }, async (t) => {
  if (process.platform !== 'darwin') {
    t.skip('bundled native app-server sandbox smoke currently runs on macOS');
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
  // Codex 0.147.0 runs command tools under macOS sandbox-exec. In environments
  // where the kernel rejects nested sandbox application (CI agents, harness
  // sandboxes) every command tool fails with "sandbox_apply: Operation not
  // permitted"; skip the sandbox assertions there instead of flaking.
  try {
    execFileSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/bin/true'], { stdio: 'pipe' });
  } catch {
    t.skip('当前环境不支持 sandbox-exec（macOS 沙箱不可用），跳过文件边界断言');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'dsh-native-multi-root-'));
  const runtimeHome = join(root, 'runtime-home');
  const writeRoot = join(root, 'write-target');
  const skillRoot = join(root, 'enabled-skill');
  const privateRoot = join(root, 'app-private');
  const sourcePath = join(skillRoot, 'SKILL.md');
  const privatePath = join(privateRoot, 'local.db');
  const copiedPath = join(writeRoot, 'copied.txt');
  const blockedPath = join(writeRoot, 'leaked-private.db');
  await mkdir(runtimeHome, { recursive: true });
  await mkdir(writeRoot, { recursive: true });
  await mkdir(skillRoot, { recursive: true });
  await mkdir(privateRoot, { recursive: true });
  await writeFile(sourcePath, 'readable-skill', 'utf8');
  await writeFile(privatePath, 'private-database', 'utf8');

  const handlerErrors = [];
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      const serialized = JSON.stringify(body.messages || []);
      const tool = commandTool(body);
      assert.ok(tool, `native command tool missing: ${JSON.stringify(body.tools || [])}`);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (!serialized.includes('call_copy_from_skill_root')) {
        sendToolCall(response, {
          id: 'call_copy_from_skill_root',
          name: tool.function.name,
          arguments: commandArguments(tool, ['/bin/cp', sourcePath, copiedPath]),
        });
        return;
      }
      if (!serialized.includes('call_copy_private_path')) {
        sendToolCall(response, {
          id: 'call_copy_private_path',
          name: tool.function.name,
          arguments: commandArguments(tool, ['/bin/cp', privatePath, blockedPath]),
        });
        return;
      }
      sendText(response, 'done', 'native-root-boundary-complete');
    } catch (error) {
      handlerErrors.push(error);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(error?.stack || error?.message || String(error));
    }
  });

  const baseUrl = await listen(upstream);
  const binding = await createAgentModelBinding({
    id: 'native-multi-root-integration-model',
    model_name: 'native-multi-root-test-model',
    api_base: baseUrl,
    api_key: 'native-multi-root-test-key',
    api_format: 'chat_completions',
  });
  const kernel = new AgentKernel({
    ...binding.kernelOptions,
    binary,
    cwd: writeRoot,
    env: { ...binding.kernelOptions.env, CODEX_HOME: runtimeHome },
    requestTimeoutMs: 30_000,
  });

  try {
    // Codex 0.147.0 gates sandbox writes behind explicit project trust.
    await kernel.setProjectTrustLevel(writeRoot);
    const started = await kernel.startThread({
      cwd: writeRoot,
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      runtimeWorkspaceRoots: [writeRoot],
      ephemeral: true,
      model: binding.threadOptions.model,
      modelProvider: binding.threadOptions.modelProvider,
      config: withWorkspacePermissionProfile(binding.threadOptions.config, {
        readOnlyRoots: [skillRoot],
      }),
    });
    assert.equal(started.cwd, writeRoot);
    assert.deepEqual(started.runtimeWorkspaceRoots, [writeRoot]);

    const result = await kernel.runTurn({
      threadId: started.thread.id,
      input: 'Copy the declared Skill file, then verify that copying the app-private database is blocked.',
    });
    assert.equal(result.completed.turn.status, 'completed');
    assert.deepEqual(handlerErrors, []);
    assert.equal(await readFile(copiedPath, 'utf8'), 'readable-skill');
    assert.equal(existsSync(blockedPath), false);
  } finally {
    await kernel.stop();
    await stopChatCompletionsAdapter();
    upstream.closeAllConnections?.();
    await new Promise((resolvePromise) => upstream.close(resolvePromise));
    await rm(root, { recursive: true, force: true });
  }
});
