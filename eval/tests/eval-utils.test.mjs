import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { extractColumnsFromBlocks } from '../lib/driver.mjs';
import { makeAssert, scoreKddColumns, summarizeResults } from '../lib/runner.mjs';

test('extractColumnsFromBlocks prefers final markdown table over earlier table blocks', () => {
  const blocks = [
    {
      type: 'json',
      title: '中间结果',
      display_type: 'table',
      content: JSON.stringify({ data: [{ city: 'wrong', amount: 1 }] }),
      metadata: { result_role: 'intermediate' },
    },
    {
      type: 'markdown',
      title: '回答',
      content: '| city | amount |\n| --- | ---: |\n| 上海 | 10 |\n| 北京 | 20 |',
      metadata: { answer_status: 'accepted' },
    },
  ];

  assert.deepEqual(extractColumnsFromBlocks(blocks), [
    ['上海', '北京'],
    ['10', '20'],
  ]);
});

test('extractColumnsFromBlocks uses final_result JSON data before fallback tables', () => {
  const blocks = [
    {
      type: 'json',
      title: '中间结果',
      display_type: 'table',
      content: JSON.stringify({ data: [{ value: 'intermediate' }] }),
      metadata: { result_role: 'intermediate' },
    },
    {
      type: 'json',
      title: '查询结果',
      display_type: 'table',
      content: JSON.stringify({
        display_type: 'table',
        fields: [{ name: 'answer' }],
        data: [{ answer: 'final-a' }, { answer: 'final-b' }],
      }),
      metadata: { result_role: 'deliverable' },
    },
  ];

  assert.deepEqual(extractColumnsFromBlocks(blocks), [['final-a', 'final-b']]);
});

test('extractColumnsFromBlocks prefers final_result JSON over later markdown summary', () => {
  const blocks = [
    {
      type: 'json',
      title: '客户交易明细',
      display_type: 'table',
      content: JSON.stringify({
        display_type: 'table',
        data: [{ tx_id: 816173 }, { tx_id: 816174 }, { tx_id: 816175 }, { tx_id: 816181 }],
      }),
      metadata: { result_role: 'deliverable' },
    },
    {
      type: 'markdown',
      title: '回答',
      content: '| tx_id | amount |\n| --- | ---: |\n| 816173 | 800 |\n| 816176 | 1776 |',
      metadata: { answer_status: 'accepted' },
    },
  ];

  assert.deepEqual(extractColumnsFromBlocks(blocks), [[816173, 816174, 816175, 816181]]);
});

test('extractColumnsFromBlocks does not treat intermediate tables as final answer', () => {
  const blocks = [
    {
      type: 'table',
      title: '中间结果：查询 publisher',
      display_type: 'table',
      content: JSON.stringify({ data: [{ content_index: 1, content: 'not final' }] }),
      metadata: { result_role: 'intermediate' },
    },
  ];

  assert.deepEqual(extractColumnsFromBlocks(blocks), []);
});

test('summarizeResults counts KDD tasks without column checks as zero', () => {
  const summary = summarizeResults([
    {
      id: 'kdd-task_a',
      pass: true,
      checks: [{
        ok: true,
        detail: { kind: 'column_match', score: 1, recall: 1 },
      }],
    },
    {
      id: 'kdd-task_b',
      pass: false,
      checks: [],
      error: 'timeout',
    },
  ]);

  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 1);
  assert.equal(summary.columnChecks.total, 2);
  assert.equal(summary.columnChecks.syntheticZero, 1);
  assert.equal(summary.columnChecks.avgScore, 0.5);
  assert.equal(summary.columnChecks.avgRecall, 0.5);
});

test('scoreKddColumns accepts a trailing percent sign as display formatting', () => {
  const result = scoreKddColumns([['52.17%']], [[52.17391304347826]], {
    extraColLambda: 0.3,
    caseSensitive: true,
    roundDecimals: 2,
  });

  assert.equal(result.recall, 1);
  assert.deepEqual(result.matchedCols, [[0, 0]]);
});

test('hasSql recognizes SQL carried in tool trace metadata', () => {
  const appAssert = makeAssert();
  appAssert.hasSql([
    {
      type: 'tool',
      content: 'execute_readonly_sql {"question":"统计订单"}',
      metadata: {
        trace_output: '已查询并存入中间表 r_1\nSQL:\nSELECT COUNT(*) AS n FROM orders',
      },
    },
  ], '产出 SQL');

  assert.equal(appAssert._checks[0].ok, true);
});

test('stream driver reuses the renderer reducer and preserves block content for SQL assertions', () => {
  const src = readFileSync(path.join(process.cwd(), 'eval/lib/driver.mjs'), 'utf8');
  assert.match(src, /import\('\/src\/views\/agent\/stream\/reducer\.ts'\)/);
  assert.match(src, /const patch = reduceStreamEvent\(e\)/);
  assert.match(src, /block\.metadata\?\.mode === 'append'/);
  assert.match(src, /content: b\.content \|\| ''/);
});

test('stream driver supports both durable and legacy governed eval writes', () => {
  const src = readFileSync(path.join(process.cwd(), 'eval/lib/driver.mjs'), 'utf8');
  assert.match(src, /autoApprove = false/);
  assert.match(src, /item\?\.type === 'approval'/);
  assert.match(src, /endsWith\('\/item\/started'\)/);
  assert.match(src, /approvalRequest\.deferred === true/);
  assert.match(src, /\/pending-actions\/.*\/resolve/);
  assert.match(src, /for \(let cursor = 0; cursor < approvalRequests\.length; cursor\+\+\)/);
  assert.match(src, /\/api\/agent\/runtime-threads\//);
  assert.match(src, /decision: 'accept'/);
  assert.match(src, /completedApprovalToolCallIds/);
  assert.match(src, /tool_result_summary: toolResultSummary/);
});

test('eval runner cleanly exits the Electron process it started', () => {
  const cdp = readFileSync(path.join(process.cwd(), 'eval/lib/cdp.mjs'), 'utf8');
  const runner = readFileSync(path.join(process.cwd(), 'eval/run.mjs'), 'utf8');
  assert.match(cdp, /evalQuitApplication/);
  assert.match(cdp, /spawn\(resolveElectronExecutable\(\)/);
  assert.match(cdp, /child\.kill\('SIGKILL'\)/);
  assert.match(cdp, /process\.kill\(-child\.pid, signal\)/);
  assert.match(cdp, /DSH_EVAL_PACKAGED_APP/);
  assert.match(cdp, /resolvePackagedLayout\(packagedAppInput\)/);
  assert.match(runner, /await session\?\.close\?\.\(\{/);
  assert.match(runner, /await session\?\.close\?\.\(\{ preserveData: true \}\)\.catch/);
});
