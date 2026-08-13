import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chunkSemanticRows,
  mapSettledWithConcurrency,
  resolveSemanticBatchConcurrency,
  resolveSemanticBatchSize,
  resolveSemanticMinSuccessRatio,
  resolveSemanticRowConcurrency,
  semanticExecutionCoverage,
  semanticLlmRequestOptions,
} from '../../server/src/engine/tools/semantic_row_executor.js';

test('semantic row executor bounds concurrency and preserves input order', async () => {
  let active = 0;
  let peak = 0;
  const settled = await mapSettledWithConcurrency([40, 10, 30, 20, 5], async (value) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, value));
    active -= 1;
    return value / 5;
  }, { concurrency: 2 });

  assert.equal(peak, 2);
  assert.deepEqual(settled.map((item) => item.status), Array(5).fill('fulfilled'));
  assert.deepEqual(settled.map((item) => item.value), [8, 2, 6, 4, 1]);
});

test('semantic row executor keeps per-row failures without stopping the batch', async () => {
  const settled = await mapSettledWithConcurrency([1, 2, 3], async (value) => {
    if (value === 2) throw new Error('row failed');
    return value;
  }, { concurrency: 3 });

  assert.equal(settled[0].status, 'fulfilled');
  assert.equal(settled[1].status, 'rejected');
  assert.match(settled[1].reason.message, /row failed/);
  assert.equal(settled[2].status, 'fulfilled');
});

test('semantic row concurrency comes from runtime limits and is safely capped', () => {
  assert.equal(resolveSemanticRowConcurrency({ input_data: { runtime_limits: { semantic_row_concurrency: 7 } } }), 7);
  assert.equal(resolveSemanticRowConcurrency(null, 999), 32);
  assert.equal(resolveSemanticRowConcurrency(null, 0), 4);
});

test('semantic rows are split into configurable bounded batches', () => {
  assert.deepEqual(chunkSemanticRows([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(resolveSemanticBatchSize({ input_data: { runtime_limits: { semantic_batch_size: 9 } } }), 9);
  assert.equal(resolveSemanticBatchSize(null, 999), 32);
  assert.equal(resolveSemanticBatchConcurrency(), 2);
  assert.equal(resolveSemanticBatchConcurrency(null, 999), 8);
  assert.equal(resolveSemanticMinSuccessRatio(), 0.8);
  assert.equal(resolveSemanticMinSuccessRatio({ input_data: { runtime_limits: { semantic_min_success_ratio: 0.95 } } }), 0.95);
});

test('semantic LLM requests have one bounded attempt by default and accept runtime overrides', () => {
  assert.deepEqual(semanticLlmRequestOptions(), {
    max_tokens: 4096,
    max_retries: 1,
    transport_retries: 0,
    request_retries: 0,
    request_timeout_ms: 60_000,
  });

  assert.deepEqual(semanticLlmRequestOptions({
    input_data: {
      runtime_limits: {
        semantic_max_tokens: 1024,
        semantic_format_attempts: 2,
        semantic_transport_retries: 1,
        semantic_request_retries: 3,
        semantic_request_timeout_ms: 15_000,
      },
    },
  }, { maxTokens: 2048 }), {
    max_tokens: 1024,
    max_retries: 2,
    transport_retries: 1,
    request_retries: 3,
    request_timeout_ms: 15_000,
  });
});

test('semantic execution coverage rejects mostly failed batches instead of treating them as null data', () => {
  assert.deepEqual(semanticExecutionCoverage(50, 48, 0.8), {
    input_rows: 50,
    success_rows: 2,
    failed_rows: 48,
    success_ratio: 0.04,
    minimum_success_ratio: 0.8,
    meets_minimum: false,
  });
  assert.equal(semanticExecutionCoverage(50, 5, 0.8).meets_minimum, true);
});
