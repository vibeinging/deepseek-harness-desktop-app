function normalizeForFingerprint(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) throw new TypeError('Cannot fingerprint circular tool arguments');
  seen.add(value);
  if (Array.isArray(value)) {
    const out = value.map((item) => normalizeForFingerprint(item, seen));
    seen.delete(value);
    return out;
  }
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = normalizeForFingerprint(value[key], seen);
  }
  seen.delete(value);
  return out;
}

export function toolCallFingerprint(toolName, params = {}) {
  return `${String(toolName || '')}:${JSON.stringify(normalizeForFingerprint(params))}`;
}

function replayResult(result, fingerprint) {
  const content = Array.isArray(result?.content) ? result.content : [];
  return {
    ...(result || {}),
    content: [
      {
        type: 'text',
        text: '[已复用] 相同参数的成功动作已执行过，以下是已有结果。请基于该产物校验或回答，不要再次调用相同动作。',
      },
      ...content,
    ],
    details: {
      ...(result?.details || {}),
      replayed: true,
      replay_fingerprint: fingerprint,
    },
  };
}

export function createSuccessfulToolReplayCache() {
  const successful = new Map();
  const inFlight = new Map();
  let replayCount = 0;

  return {
    async execute(toolName, params, run) {
      const fingerprint = toolCallFingerprint(toolName, params);
      if (successful.has(fingerprint)) {
        replayCount += 1;
        return replayResult(successful.get(fingerprint), fingerprint);
      }
      if (inFlight.has(fingerprint)) {
        const result = await inFlight.get(fingerprint);
        if (result && result.isError !== true) {
          replayCount += 1;
          return replayResult(result, fingerprint);
        }
        return result;
      }

      const pending = Promise.resolve().then(run);
      inFlight.set(fingerprint, pending);
      try {
        const result = await pending;
        if (result && result.isError !== true) successful.set(fingerprint, result);
        return result;
      } finally {
        inFlight.delete(fingerprint);
      }
    },
    stats() {
      return { successful_action_count: successful.size, replay_count: replayCount };
    },
  };
}
