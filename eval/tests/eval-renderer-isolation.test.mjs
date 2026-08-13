import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  createRendererRevisionMonitor,
  resolveRendererLaunchMode,
} from '../lib/cdp.mjs';
import { isConversationTurnComplete } from '../lib/driver.mjs';
import { report, runTasks, summarizeResults } from '../lib/runner.mjs';

function runnerTask(overrides = {}) {
  return {
    id: 'renderer-isolation-contract',
    desc: 'renderer isolation contract',
    eval: { repeats: 1, minPassRate: 1, timeoutMs: 1000, criteria: [] },
    async run({ assert: evalAssert }) {
      evalAssert.ok(true, 'task completed');
    },
    ...overrides,
  };
}

test('isolated eval never selects an already-running default Vite renderer', () => {
  assert.equal(resolveRendererLaunchMode({ isolate: true, defaultRendererReady: true }), 'dedicated-dev-server');
  assert.equal(resolveRendererLaunchMode({ isolate: false, defaultRendererReady: true }), 'shared-dev-server');
  assert.equal(resolveRendererLaunchMode({ isolate: true, hasExplicitRendererUrl: true }), 'explicit-renderer-url');
  assert.equal(resolveRendererLaunchMode({ isolate: true, packagedApp: true }), 'packaged-app');
});

test('eval uses canonical Vite URLs for renderer singleton modules', () => {
  const driver = readFileSync(new URL('../lib/driver.mjs', import.meta.url), 'utf8');
  const uiDriver = readFileSync(new URL('../lib/ui-driver.mjs', import.meta.url), 'utf8');
  const singletonSources = driver;

  for (const path of ['/src/store/project', '/src/utils/eventBus']) {
    assert.doesNotMatch(singletonSources, new RegExp(`import\\('${path.replaceAll('/', '\\/')}'\\)`));
  }
  assert.match(singletonSources, /import\('\/src\/store\/project\.ts'\)/);
  assert.match(singletonSources, /import\('\/src\/utils\/eventBus\.ts'\)/);
  assert.doesNotMatch(uiDriver, /import\('\/src\/router'\)/);
  assert.match(uiDriver, /import\('\/src\/router\/index\.tsx'\)/);
});

test('renderer revision monitor identifies HMR by source hash or Vite timestamp', () => {
  let timestamp = 1000;
  const monitor = createRendererRevisionMonitor({
    rendererUrl: 'http://127.0.0.1:52732/#/agent',
    now: () => timestamp++,
  });
  monitor.observeScriptParsed({
    scriptId: '1',
    url: 'http://127.0.0.1:52732/src/views/agent/AgentConversation.tsx?t=100',
    hash: 'hash-a',
  });
  const checkpoint = monitor.checkpoint();
  monitor.observeScriptParsed({
    scriptId: '2',
    url: 'http://127.0.0.1:52732/src/views/agent/AgentConversation.tsx?t=200',
    hash: 'hash-b',
  });
  monitor.observeScriptParsed({
    scriptId: '3',
    url: 'http://127.0.0.1:52732/node_modules/react/index.js?t=200',
    hash: 'react-hash',
  });

  const pollution = monitor.pollutionSince(checkpoint);
  assert.equal(pollution.polluted, true);
  assert.equal(pollution.code, 'EVAL_RENDERER_SOURCE_CHANGED');
  assert.equal(pollution.changes.length, 1);
  assert.equal(pollution.changes[0].source_changed, true);
  assert.equal(pollution.changes[0].hmr_token_changed, true);
  assert.match(pollution.changes[0].module, /AgentConversation\.tsx$/);
  assert.equal(monitor.pollutionSince(monitor.checkpoint()).polluted, false);
});

test('conversation completion requires both a terminal Turn and stopped runtime', () => {
  assert.equal(isConversationTurnComplete({
    busy: false,
    runtimeRunning: true,
    turnStatus: 'inProgress',
  }, { capturedRunning: true }), false);
  assert.equal(isConversationTurnComplete({
    busy: false,
    runtimeRunning: false,
    turnStatus: 'inProgress',
  }, { capturedRunning: true }), false);
  assert.equal(isConversationTurnComplete({
    busy: false,
    runtimeRunning: false,
    turnStatus: 'completed',
  }, { capturedRunning: true }), true);
  assert.equal(isConversationTurnComplete({
    busy: false,
    runtimeRunning: false,
    turnStatus: 'interrupted',
  }, { capturedRunning: false }), false);
});

test('runner marks source revision changes as infrastructure pollution and does not retry', async () => {
  let attempts = 0;
  const driver = {
    raw: {
      infrastructureCheckpoint: () => 2,
      infrastructurePollutionSince: (checkpoint) => ({
        polluted: true,
        code: 'EVAL_RENDERER_SOURCE_CHANGED',
        changes: [{
          type: 'renderer-source-revision-changed',
          module: 'http://127.0.0.1:52732/src/views/agent/AgentConversation.tsx',
          checkpoint,
        }],
      }),
    },
  };
  const [result] = await runTasks(driver, [runnerTask({
    eval: { repeats: 3, minPassRate: 1, timeoutMs: 1000, criteria: [] },
    async run({ assert: evalAssert }) {
      attempts += 1;
      evalAssert.ok(true, 'product behavior passed');
    },
  })]);

  assert.equal(attempts, 1);
  assert.equal(result.status, 'infra-polluted');
  assert.equal(result.pass, false);
  assert.equal(result.infrastructure_pollution.code, 'EVAL_RENDERER_SOURCE_CHANGED');
  assert.equal(result.attempts[0].status, 'infra-polluted');
  assert.equal(summarizeResults([result]).infraPolluted, 1);

  const originalLog = console.log;
  console.log = () => {};
  try {
    assert.equal(report([result]), false);
  } finally {
    console.log = originalLog;
  }
});
