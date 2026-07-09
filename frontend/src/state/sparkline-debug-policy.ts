export type SparklineDebugDecision = {
  persist: boolean;
  trigger: boolean;
  reason?: string;
};

const ALWAYS_TRIGGER_EVENTS = new Set([
  'cache.clear',
  'loading.clear',
  'metadata.fetch-error',
  'payload.empty-or-partial',
  'refresh.batch-error',
  'refresh.error',
  'refresh.queued-in-flight',
]);

function getNestedValue(source: Record<string, unknown>, path: string[]) {
  let current: unknown = source;
  for (const key of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseFiniteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function evaluateSparklineDebugEvent(
  event: string,
  meta: Record<string, unknown>,
  options: {
    now: number;
    captureUntil: number;
    lowRemainingThreshold: number;
  },
): SparklineDebugDecision {
  if (options.captureUntil > options.now) {
    return { persist: true, trigger: false };
  }

  if (ALWAYS_TRIGGER_EVENTS.has(event)) {
    return { persist: true, trigger: true, reason: event };
  }

  if (meta.force === true) {
    return { persist: true, trigger: true, reason: 'force-true' };
  }

  if (event !== 'http.response') {
    return { persist: false, trigger: false };
  }

  const status = parseFiniteNumber(getNestedValue(meta, ['response', 'status']));
  if (status != null && status >= 400) {
    return { persist: true, trigger: true, reason: `http-${status}` };
  }

  const retryAfter = getNestedValue(meta, ['response', 'retryAfter']);
  if (retryAfter != null && String(retryAfter).trim()) {
    return { persist: true, trigger: true, reason: 'retry-after' };
  }

  const remaining = parseFiniteNumber(getNestedValue(meta, ['response', 'rateLimitRemaining']));
  if (remaining != null && remaining <= options.lowRemainingThreshold) {
    return { persist: true, trigger: true, reason: 'rate-limit-low' };
  }

  return { persist: false, trigger: false };
}
