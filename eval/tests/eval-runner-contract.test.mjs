import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { report, runTasks, summarizeResults } from '../lib/runner.mjs';
import { selectEvalTasks } from '../suites.mjs';
import { normalizeEvalTask, validateEvalTaskCatalog } from '../task-schema.mjs';

function task(overrides = {}) {
  const { eval: evalOverrides = {}, ...taskOverrides } = overrides;
  return normalizeEvalTask({
    id: 'contract-task',
    desc: 'runner contract',
    eval: {
      feature: 'eval.contract',
      layer: 'service_integration',
      risk: 'P0',
      interaction: 'none',
      model: 'none',
      data: 'synthetic',
      platforms: ['darwin', 'win32', 'linux'],
      timeoutMs: 1000,
      repeats: 1,
      minPassRate: 1,
      requirements: ['eval.result-honesty'],
      tags: ['pr'],
      criteria: [{ id: 'outcome.correct', description: '结果满足明确判分条件' }],
      scenario: {
        project: { mode: 'new', name: '问数文件导入 Eval' },
        plugins: [{ id: 'ask-data', source: 'builtin', mount: 'project' }],
        files: [{ id: 'orders', path: 'eval/fixtures/orders.csv', selection: 'file_picker', purpose: '导入项目' }],
        turns: [{
          id: 'import-files',
          user: '将这些文件导入项目中。',
          uses: ['plugin:ask-data', 'file:orders'],
          criteria: ['outcome.correct'],
        }],
      },
      ...evalOverrides,
    },
    async run({ assert: evalAssert }) {
      evalAssert.ok(true, '结果正确', { criterion: 'outcome.correct' });
    },
    ...taskOverrides,
  });
}

test('task metadata keeps executable judging criteria', () => {
  const normalized = task();
  assert.equal(normalized.eval.declared, true);
  assert.equal(normalized.eval.feature, 'eval.contract');
  assert.deepEqual(normalized.eval.criteria.map((item) => item.id), ['outcome.correct']);
  assert.equal(normalized.eval.tags.includes('pr'), true);
  assert.deepEqual(normalized.eval.scenario.plugins.map((item) => item.id), ['ask-data']);
  assert.equal(normalized.eval.scenario.files[0].selection, 'file_picker');
  assert.equal(normalized.eval.scenario.turns[0].user, '将这些文件导入项目中。');
});

test('task id supports the existing Chinese fixture names', () => {
  const normalized = normalizeEvalTask({
    id: 'func-task_多轮对话',
    async run() {},
  });
  assert.equal(normalized.id, 'func-task_多轮对话');
});

test('task catalog rejects duplicate task ids and malformed criteria', () => {
  assert.throws(() => validateEvalTaskCatalog([task(), task()]), /id 重复/);
  assert.throws(() => task({ eval: { criteria: [{ id: '', description: 'bad' }] } }), /判分标准 id 无效/);
});

test('scenario rejects undeclared plugins, files, and criteria', () => {
  assert.throws(() => task({
    eval: {
      scenario: {
        turns: [{ id: 'bad', user: '导入文件', uses: ['plugin:missing'], criteria: ['missing'] }],
      },
    },
  }), /未知资源/);
  assert.throws(() => task({
    eval: {
      scenario: {
        turns: [{ id: 'bad', user: '导入文件', criteria: ['missing'] }],
      },
    },
  }), /未知判分标准/);
});

test('suite selection is exact and empty selection fails', () => {
  const normalized = task();
  assert.deepEqual(selectEvalTasks([normalized], { suiteName: 'pr' }).tasks.map((item) => item.id), ['contract-task']);
  assert.throws(
    () => selectEvalTasks([normalized], { suiteName: 'pr', taskIds: ['missing-task'] }),
    /找不到 Eval 任务/,
  );
  assert.throws(() => selectEvalTasks([normalized], { suiteName: 'ui' }), /没有选中任务/);
});

test('blocked is a real result state rather than a passing assertion', async () => {
  const blockedTask = task({
    async run({ assert: evalAssert }) {
      evalAssert.blocked('缺少真实模型');
    },
  });
  const [result] = await runTasks({}, [blockedTask]);
  assert.equal(result.status, 'blocked');
  assert.equal(result.pass, false);
  assert.equal(result.reason, '缺少真实模型');
  const summary = summarizeResults([result]);
  assert.equal(summary.blocked, 1);
  assert.equal(summary.passed, 0);
});

test('required criterion must actually execute', async () => {
  const missingCriterion = task({
    async run({ assert: evalAssert }) {
      evalAssert.ok(true, '只有普通断言，没有绑定判分标准');
    },
  });
  const [result] = await runTasks({}, [missingCriterion]);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.some((check) => /必需判分标准没有执行/.test(check.msg)), true);
});

test('repeated model-style tasks use an explicit minimum pass rate', async () => {
  let attempt = 0;
  const repeated = task({
    eval: { repeats: 3, minPassRate: 2 / 3 },
    async run({ assert: evalAssert }) {
      attempt += 1;
      evalAssert.ok(attempt > 1, `第 ${attempt} 次结果`, { criterion: 'outcome.correct' });
    },
  });
  const [result] = await runTasks({}, [repeated]);
  assert.equal(result.attempts.length, 3);
  assert.equal(result.pass_rate, 2 / 3);
  assert.equal(result.status, 'passed');
});

test('an empty report cannot be green', () => {
  const original = console.log;
  console.log = () => {};
  try {
    assert.equal(report([]), false);
  } finally {
    console.log = original;
  }
});
