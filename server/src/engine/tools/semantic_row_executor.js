const DEFAULT_SEMANTIC_ROW_CONCURRENCY = 4;
const MAX_SEMANTIC_ROW_CONCURRENCY = 32;
const DEFAULT_SEMANTIC_BATCH_CONCURRENCY = 2;
const MAX_SEMANTIC_BATCH_CONCURRENCY = 8;
const DEFAULT_SEMANTIC_BATCH_SIZE = 4;
const MAX_SEMANTIC_BATCH_SIZE = 32;
const DEFAULT_SEMANTIC_MIN_SUCCESS_RATIO = 0.8;

function toPositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.trunc(parsed);
}

function toNonNegativeInteger(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

export function resolveSemanticRowConcurrency(context = null, explicitValue = null) {
  const configured = toPositiveInteger(explicitValue)
    ?? toPositiveInteger(context?.input_data?.runtime_limits?.semantic_row_concurrency)
    ?? toPositiveInteger(process.env.DSH_SEMANTIC_ROW_CONCURRENCY)
    ?? DEFAULT_SEMANTIC_ROW_CONCURRENCY;
  return Math.min(configured, MAX_SEMANTIC_ROW_CONCURRENCY);
}

export function resolveSemanticBatchSize(context = null, explicitValue = null) {
  const configured = toPositiveInteger(explicitValue)
    ?? toPositiveInteger(context?.input_data?.runtime_limits?.semantic_batch_size)
    ?? toPositiveInteger(process.env.DSH_SEMANTIC_BATCH_SIZE)
    ?? DEFAULT_SEMANTIC_BATCH_SIZE;
  return Math.min(configured, MAX_SEMANTIC_BATCH_SIZE);
}

export function resolveSemanticBatchConcurrency(context = null, explicitValue = null) {
  const configured = toPositiveInteger(explicitValue)
    ?? toPositiveInteger(context?.input_data?.runtime_limits?.semantic_batch_concurrency)
    ?? toPositiveInteger(process.env.DSH_SEMANTIC_BATCH_CONCURRENCY)
    ?? DEFAULT_SEMANTIC_BATCH_CONCURRENCY;
  return Math.min(configured, MAX_SEMANTIC_BATCH_CONCURRENCY);
}

export function resolveSemanticMinSuccessRatio(context = null, explicitValue = null) {
  const configured = Number(
    explicitValue
      ?? context?.input_data?.runtime_limits?.semantic_min_success_ratio
      ?? process.env.DSH_SEMANTIC_MIN_SUCCESS_RATIO,
  );
  if (!Number.isFinite(configured)) return DEFAULT_SEMANTIC_MIN_SUCCESS_RATIO;
  return Math.max(0, Math.min(1, configured));
}

export function semanticExecutionCoverage(totalRows, failedRows, minimumSuccessRatio = DEFAULT_SEMANTIC_MIN_SUCCESS_RATIO) {
  const inputRows = Math.max(0, Math.trunc(Number(totalRows) || 0));
  const failed = Math.max(0, Math.min(inputRows, Math.trunc(Number(failedRows) || 0)));
  const successRows = inputRows - failed;
  const required = Math.max(0, Math.min(1, Number(minimumSuccessRatio) || 0));
  const successRatio = inputRows ? successRows / inputRows : 1;
  return {
    input_rows: inputRows,
    success_rows: successRows,
    failed_rows: failed,
    success_ratio: successRatio,
    minimum_success_ratio: required,
    meets_minimum: successRatio >= required,
  };
}

export function chunkSemanticRows(rows, batchSize = DEFAULT_SEMANTIC_BATCH_SIZE) {
  const source = Array.from(rows || []);
  const size = Math.max(1, Math.min(toPositiveInteger(batchSize) ?? DEFAULT_SEMANTIC_BATCH_SIZE, MAX_SEMANTIC_BATCH_SIZE));
  const batches = [];
  for (let index = 0; index < source.length; index += size) {
    batches.push(source.slice(index, index + size));
  }
  return batches;
}

export function semanticLlmRequestOptions(context = null, { maxTokens = 4096 } = {}) {
  const limits = context?.input_data?.runtime_limits || {};
  return {
    max_tokens: toPositiveInteger(limits.semantic_max_tokens) ?? maxTokens,
    max_retries: toPositiveInteger(limits.semantic_format_attempts) ?? 1,
    transport_retries: toNonNegativeInteger(limits.semantic_transport_retries) ?? 0,
    request_retries: toNonNegativeInteger(limits.semantic_request_retries) ?? 0,
    request_timeout_ms: toPositiveInteger(limits.semantic_request_timeout_ms) ?? 60_000,
  };
}

function abortError(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason ? String(reason) : 'Semantic row execution aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * Promise.allSettled 的受控并发版本。
 *
 * - 结果与输入顺序一致；
 * - 单行失败不会中断其他行；
 * - signal 触发后不再启动新任务，尚未启动的行记为 rejected；
 * - concurrency 来自运行配置，不与问题、表或字段绑定。
 */
export async function mapSettledWithConcurrency(
  items,
  mapper,
  { concurrency = DEFAULT_SEMANTIC_ROW_CONCURRENCY, signal = null } = {},
) {
  const source = Array.from(items || []);
  if (!source.length) return [];
  if (typeof mapper !== 'function') throw new TypeError('mapper must be a function');

  const workerCount = Math.min(
    source.length,
    Math.max(1, Math.min(toPositiveInteger(concurrency) ?? DEFAULT_SEMANTIC_ROW_CONCURRENCY, MAX_SEMANTIC_ROW_CONCURRENCY)),
  );
  const results = new Array(source.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < source.length) {
      if (signal?.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      try {
        const value = await mapper(source[index], index, signal);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  for (let index = 0; index < results.length; index += 1) {
    if (!results[index]) results[index] = { status: 'rejected', reason: abortError(signal) };
  }
  return results;
}

export {
  DEFAULT_SEMANTIC_BATCH_CONCURRENCY,
  DEFAULT_SEMANTIC_BATCH_SIZE,
  DEFAULT_SEMANTIC_MIN_SUCCESS_RATIO,
  DEFAULT_SEMANTIC_ROW_CONCURRENCY,
  MAX_SEMANTIC_BATCH_CONCURRENCY,
  MAX_SEMANTIC_BATCH_SIZE,
  MAX_SEMANTIC_ROW_CONCURRENCY,
};
