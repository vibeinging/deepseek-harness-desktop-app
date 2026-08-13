// Migrated from backend/dsh_kernel/semantic_catalogs/database/utils/similarity_filter.py
//
// Similarity filter utility: dynamic thresholding by top gap + absolute threshold + smart fallback.
// Dependency of schema_retrieval_service.js (ported together with the Python utils in the same directory).
//
// Diff from Python version: named params (Python kwargs) -> JS options object with destructuring;
// exported function name remains filter_by_relative_threshold.

/**
 * Double-pass similarity filtering based on top-gap and absolute threshold, with smart fallback.
 *
 * Algorithm:
 * 1. Strict pass: max(absolute_threshold, top_score - relative_threshold)
 * 2. Fallback pass: use relative_threshold when strict pass is empty and top_score < absolute_threshold
 *
 * @param {Array<object>} results Result list
 * @param {object} opts
 * @param {string} opts.score_key Score field name (for example, 'similarity' or 'distance')
 * @param {number} [opts.threshold=0.3] Max allowed drop from top score
 * @param {boolean} [opts.higher_is_better=true] true if higher score is better, false if lower is better
 * @param {number} [opts.min_absolute_threshold=0.0] Absolute threshold (0.0 disables)
 * @returns {Array<object>} Filtered result list (may be empty)
 */
export function filter_by_relative_threshold(results, {
  score_key, threshold = 0.3, higher_is_better = true, min_absolute_threshold = 0.0,
} = {}) {
  if (!results || !results.length) return [];

  // Filter out results that do not have a score value.
  const validResults = results.filter(
    (r) => Object.prototype.hasOwnProperty.call(r, score_key) && r[score_key] != null,
  );
  if (!validResults.length) {
    console.warn(`所有结果都缺少 ${score_key} 字段`);
    return [];
  }

  // Sort by score.
  const sortedResults = [...validResults].sort((a, b) => (
    higher_is_better ? (b[score_key] - a[score_key]) : (a[score_key] - b[score_key])
  ));

  // Top-gap filtering.
  const topScore = sortedResults[0][score_key];

  // Compute relative lower bound.
  let relativeMin;
  if (higher_is_better) {
    relativeMin = topScore - threshold;
    relativeMin = Math.max(0.0, relativeMin); // Avoid negative lower bound.
  } else {
    relativeMin = topScore + threshold;
  }

  // Two-pass filtering: compute strict threshold as the tighter of absolute and relative bounds.
  let strictMin;
  if (higher_is_better) {
    strictMin = Math.max(min_absolute_threshold, relativeMin);
  } else {
    strictMin = min_absolute_threshold > 0 ? Math.min(min_absolute_threshold, relativeMin) : relativeMin;
  }

  // Step 1: apply strict filtering first (fallback only after this result set is empty).
  let filtered = [];
  for (const result of sortedResults) {
    const score = result[score_key];
    const pass = higher_is_better ? (score >= strictMin) : (score <= strictMin);
    if (pass) {
      filtered.push(result);
    } else {
      break; // Sorted, so remaining items cannot pass; break early.
    }
  }

  // Step 2: if strict filter returns empty, fall back to relative threshold.
  if (!filtered.length && min_absolute_threshold > 0) {
    console.log(
      `严格模式结果为空，降级使用相对阈值: strict_min=${strictMin.toFixed(3)} → relative_min=${relativeMin.toFixed(3)}`,
    );
    filtered = [];
    for (const result of sortedResults) {
      const score = result[score_key];
      const pass = higher_is_better ? (score >= relativeMin) : (score <= relativeMin);
      if (pass) {
        filtered.push(result);
      } else {
        break;
      }
    }
  }

  console.log(
    `Top差距过滤: 原始=${results.length}, `
    + `最高相似度(top_score)=${topScore.toFixed(3)}, threshold=${threshold}, `
    + `min_absolute=${min_absolute_threshold}, 过滤后=${filtered.length}`,
  );

  return filtered;
}

export default filter_by_relative_threshold;
