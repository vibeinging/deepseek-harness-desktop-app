/**
 * Migrated from backend/core/cache.py
 *
 * Desktop single-process in-memory implementation:
 * - No dependency on fastapi-cache2 / Redis; cache stored in process memory (Map)
 * - Keep all public method signatures: service_key_builder, invalidate_cache
 */

import crypto from 'crypto';

// ============================================================
// In-memory cache storage (in-memory Map as Redis KV substitute)
// ============================================================

/** @type {Map<string, {value: any, expireAt: number|null}>} */
const _memCache = new Map();

/**
 * Internal helper: read from in-memory cache.
 * @param {string} key
 * @returns {any|undefined}
 */
function _memGet(key) {
  const entry = _memCache.get(key);
  if (!entry) return undefined;
  if (entry.expireAt !== null && Date.now() > entry.expireAt) {
    _memCache.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Internal helper: write to in-memory cache.
 * @param {string} key
 * @param {any} value
 * @param {number|null} ttlSeconds
 */
function _memSet(key, value, ttlSeconds = null) {
  _memCache.set(key, {
    value,
    expireAt: ttlSeconds !== null ? Date.now() + ttlSeconds * 1000 : null,
  });
}

// ============================================================
// Parameter type names excluded from cache keys (keep aligned with Python version)
// ============================================================

const _EXCLUDED_TYPE_NAMES = new Set(['AsyncSession', 'Session', 'Connection', 'Engine']);

/**
 * Check if value is "primitive serializable" (aligned with Python isinstance check).
 * @param {any} v
 * @returns {boolean}
 */
function _isPrimitive(v) {
  return (
    v === null ||
    typeof v === 'string' ||
    typeof v === 'number' ||
    typeof v === 'boolean' ||
    Array.isArray(v) ||
    (v !== null && typeof v === 'object' && v.constructor === Object)
  );
}

// ============================================================
// service_key_builder
// ============================================================

/**
 * Service layer cache key builder.
 *
 * Key format: {funcName}:{param1}={value1}:{param2}={value2}
 * Automatically excludes non-serializable DB session parameters.
 *
 * @param {Function} func - 被缓存的函数
 * @param {string} namespace - 命名空间（可选，与 fastapi-cache2 签名兼容）
 * @param {Object} options
 * @param {Object} [options.request] - HTTP request (excluded)
 * @param {Object} [options.response] - HTTP response (excluded)
 * @param {Array}  [options.args] - positional arguments
 * @param {Object} [options.kwargs] - 关键字参数
 * @returns {string} 缓存 key
 */
function service_key_builder(func, namespace = '', { request = null, response = null, args = null, kwargs = null } = {}) {
  // Merge keyword args (compatible with Python fastapi-cache wrapper behavior).
  const actualKwargs = { ...(kwargs ?? {}) };
  const actualArgs = args ?? [];

  // Map positional args to parameter names (JS lacks inspect.signature; keep compatibility even though exact names aren't always available).
  // TODO: For exact parameter-name mapping, attach __paramNames on the function.
  const paramNames = func.__paramNames ?? [];
  for (let i = 0; i < actualArgs.length; i++) {
    const paramName = paramNames[i];
    if (paramName && !(paramName in actualKwargs)) {
      actualKwargs[paramName] = actualArgs[i];
    }
  }

  const keyParts = [];
  for (const k of Object.keys(actualKwargs).sort()) {
    const v = actualKwargs[k];
    if (v === null || v === undefined) continue;
    const typeName = v?.constructor?.name ?? 'Unknown';
    if (_EXCLUDED_TYPE_NAMES.has(typeName)) continue;
    // Skip complex objects (custom prototype and not primitive types).
    if (!_isPrimitive(v)) continue;
    keyParts.push(`${k}=${v}`);
  }

  const paramsStr = keyParts.length > 0 ? keyParts.join(':') : '_';
  let key = `${func.name}:${paramsStr}`;

  // If key is too long, hash with MD5 to keep within Python-version 200 char threshold.
  if (key.length > 200) {
    const hash = crypto.createHash('md5').update(paramsStr).digest('hex');
    key = `${func.name}:${hash}`;
  }

  console.debug(`[cache] key: ${key}`);
  return key;
}

// ============================================================
// invalidate_cache (in-memory)
// ============================================================

/**
 * Invalidate function cache (in-memory).
 *
 * Supports two modes:
 * 1. No args: clear all cache entries for the function
 * 2. With match args: clear entries whose key contains those params
 *
 * In-memory path: iterate over _memCache directly.
 *
 * @param {string} funcName - 函数名
 * @param {Object} matchParams - 要匹配的参数（key 中包含即匹配）
 * @returns {Promise<number>} 删除的缓存条数
 */
async function invalidate_cache(funcName, matchParams = {}) {
  const basePrefix = `${funcName}:`;

  if (Object.keys(matchParams).length === 0) {
    return _clearByPrefix(basePrefix);
  }

  // Match params: clear entries containing "k=v" anywhere in the key.
  try {
    let deletedCount = 0;

    // In-memory: iterate _memCache.
    for (const [k, v] of Object.entries(matchParams)) {
      if (v === null || v === undefined) continue;
      const needle = `${k}=${v}`;
      for (const cacheKey of [..._memCache.keys()]) {
        if (cacheKey.startsWith(basePrefix) && cacheKey.includes(needle)) {
          _memCache.delete(cacheKey);
          deletedCount++;
        }
      }
    }

    if (deletedCount > 0) {
      console.info(`[cache clear] ${funcName}, params: ${JSON.stringify(matchParams)}, deleted: ${deletedCount}`);
    }
    return deletedCount;
  } catch (e) {
    console.warn('[cache clear] failed to clear cache:', e);
    return 0;
  }
}

// ============================================================
// _clearByPrefix (internal)
// ============================================================

/**
 * Clear cache by prefix (in-memory iteration over _memCache).
 * @param {string} prefix
 * @returns {Promise<number>}
 */
async function _clearByPrefix(prefix) {
  try {
    let deletedCount = 0;

    // In-memory: direct _memCache iteration.
    for (const cacheKey of [..._memCache.keys()]) {
      if (cacheKey.startsWith(prefix)) {
        _memCache.delete(cacheKey);
        deletedCount++;
      }
    }

    if (deletedCount > 0) {
      console.info(`[cache clear] ${prefix}*, deleted: ${deletedCount}`);
    }
    return deletedCount;
  } catch (e) {
    console.warn('[cache clear] failed to clear cache:', e);
    return 0;
  }
}

// ============================================================
// In-memory cache decorator (replaces @cache, in-memory alternative to fastapi-cache2)
// ============================================================

/**
 * In-memory cache decorator factory.
 *
 * Equivalent to Python @cache(expire=xxx, key_builder=service_key_builder)
 * Usage: wrap async function to cache results automatically.
 *
 * @param {Object} options
 * @param {number} [options.expire=300] - TTL（秒）
 * @param {Function} [options.keyBuilder] - key builder function, defaults to service_key_builder
 * @returns {Function} decorator (accepts function and returns cached wrapper)
 *
 * @example
 * const cachedFn = withCache({ expire: 60 })(async (arg) => { ... });
 */
function withCache({ expire = 300, keyBuilder = null } = {}) {
  return function decorator(fn) {
    async function cached(...args) {
      const kb = keyBuilder ?? service_key_builder;
      const key = kb(fn, '', { args, kwargs: {} });
      const hit = _memGet(key);
      if (hit !== undefined) {
        console.debug(`[缓存] hit: ${key}`);
        return hit;
      }
      const result = await fn(...args);
      _memSet(key, result, expire);
      return result;
    }
    // Forward function name for service_key_builder.
    Object.defineProperty(cached, 'name', { value: fn.name });
    cached.__paramNames = fn.__paramNames ?? [];
    return cached;
  };
}

export {
  service_key_builder,
  invalidate_cache,
  withCache,
  // Exposed for testing.
  _memCache,
  _memGet,
  _memSet,
  _clearByPrefix,
};
