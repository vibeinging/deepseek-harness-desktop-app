// Request context: the single boundary between use case layer (L1) and the outside world.
// Replaces req.userId and closure-captured query/queryOne.
// Use cases should only depend on ctx so they stay pure for tests: fn(makeCtx({userId, query: fake}), input).
import { query, queryOne, transaction } from './db.js';

export function makeCtx({ userId = null, signal = null } = {}) {
  return {
    userId, // From transport auth (instead of req.userId)
    query,
    queryOne, // L2 handler, can be replaced in tests
    transaction,
    signal, // AbortSignal for streaming/long tasks (instead of res.on('close'))
    // Heavy services (e.g., MetricService) can add lazy getters when needed
  };
}
