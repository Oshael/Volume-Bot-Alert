const DEFAULT_INTERVAL_MS = 10 * 1000;
const DEFAULT_TOKEN_LIMIT = 5;
const DEFAULT_PASSED_TTL_MS = 10 * 60 * 1000;
const MAX_QUEUE_SIZE = 5000;

let timer = null;
let running = false;
let activeRunPromise = null;
const queuedByAddress = new Map();
const passedByAddress = new Map();
const status = {
  running: false,
  inFlight: false,
  queuedCount: 0,
  freshPassedCount: 0,
  lastRunAt: null,
  lastCompletedAt: null,
  lastRunDurationMs: 0,
  lastTokenLimit: DEFAULT_TOKEN_LIMIT,
  lastProcessed: 0,
  lastPassed: 0,
  lastAutoBlocked: 0,
  lastErrors: 0,
  totalEnqueued: 0,
  totalDeduped: 0,
  totalProcessed: 0,
  totalPassed: 0,
  totalAutoBlocked: 0,
  totalErrors: 0,
  lastError: null,
};

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizeOptions(options = {}) {
  return {
    intervalMs: parsePositiveInteger(options.intervalMs || process.env.GMGN_RISK_REVIEW_QUEUE_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    tokenLimit: parseNonNegativeInteger(options.tokenLimit ?? process.env.GMGN_RISK_REVIEW_QUEUE_TOKEN_LIMIT, DEFAULT_TOKEN_LIMIT),
    passedTtlMs: parsePositiveInteger(options.passedTtlMs || process.env.GMGN_PRELIMINARY_REVIEW_TTL_MS, DEFAULT_PASSED_TTL_MS),
    processor: options.processor,
  };
}

function normalizeAddress(value) {
  return String(value || '').trim();
}

function nowMs() {
  return Date.now();
}

function prunePassed(referenceMs = nowMs()) {
  for (const [address, entry] of passedByAddress.entries()) {
    if (!entry || entry.expiresAt <= referenceMs) {
      passedByAddress.delete(address);
    }
  }
}

function updateCounts() {
  prunePassed();
  status.queuedCount = queuedByAddress.size;
  status.freshPassedCount = passedByAddress.size;
}

function hasFreshPassedReview(address, referenceMs = nowMs()) {
  const normalized = normalizeAddress(address);
  const entry = normalized ? passedByAddress.get(normalized) : null;
  if (!entry || entry.expiresAt <= referenceMs) {
    if (normalized) {
      passedByAddress.delete(normalized);
    }
    updateCounts();
    return false;
  }
  return true;
}

function markPassed(address, options = {}) {
  const normalized = normalizeAddress(address);
  if (!normalized) {
    return false;
  }
  const resolved = normalizeOptions(options);
  const referenceMs = nowMs();
  passedByAddress.set(normalized, {
    passedAt: new Date(referenceMs).toISOString(),
    expiresAt: referenceMs + resolved.passedTtlMs,
  });
  updateCounts();
  return true;
}

function enqueue(task = {}) {
  const address = normalizeAddress(task.address);
  if (!address) {
    return { queued: false, reason: 'invalid-address' };
  }
  if (hasFreshPassedReview(address)) {
    return { queued: false, reason: 'fresh-passed' };
  }
  if (queuedByAddress.has(address)) {
    status.totalDeduped += 1;
    updateCounts();
    return { queued: false, reason: 'already-queued' };
  }
  if (queuedByAddress.size >= MAX_QUEUE_SIZE) {
    return { queued: false, reason: 'queue-full' };
  }

  queuedByAddress.set(address, {
    ...task,
    address,
    enqueuedAt: new Date().toISOString(),
  });
  status.totalEnqueued += 1;
  updateCounts();
  return { queued: true, reason: 'queued' };
}

function takeBatch(limit) {
  const batch = [];
  const safeLimit = parseNonNegativeInteger(limit, DEFAULT_TOKEN_LIMIT);
  for (const [address, task] of queuedByAddress.entries()) {
    if (batch.length >= safeLimit) {
      break;
    }
    queuedByAddress.delete(address);
    batch.push(task);
  }
  updateCounts();
  return batch;
}

async function runOnce(options = {}) {
  const resolved = normalizeOptions(options);
  if (activeRunPromise) {
    return activeRunPromise;
  }
  if (typeof resolved.processor !== 'function') {
    return {
      skipped: true,
      reason: 'missing-processor',
      processed: 0,
    };
  }

  activeRunPromise = (async () => {
    const startedAtMs = nowMs();
    const batch = takeBatch(resolved.tokenLimit);
    status.inFlight = true;
    status.lastRunAt = new Date(startedAtMs).toISOString();
    status.lastTokenLimit = resolved.tokenLimit;
    status.lastProcessed = 0;
    status.lastPassed = 0;
    status.lastAutoBlocked = 0;
    status.lastErrors = 0;
    status.lastError = null;

    try {
      for (const task of batch) {
        try {
          const result = await resolved.processor(task, resolved);
          status.lastProcessed += 1;
          status.totalProcessed += 1;
          if (result?.autoBlocked) {
            status.lastAutoBlocked += 1;
            status.totalAutoBlocked += 1;
          } else if (result?.passed) {
            markPassed(task.address, resolved);
            status.lastPassed += 1;
            status.totalPassed += 1;
          }
        } catch (error) {
          status.lastErrors += 1;
          status.totalErrors += 1;
          status.lastError = String(error?.message || error || 'Unknown GMGN risk review queue error');
        }
      }

      return {
        processed: status.lastProcessed,
        passed: status.lastPassed,
        autoBlocked: status.lastAutoBlocked,
        errors: status.lastErrors,
      };
    } finally {
      status.inFlight = false;
      status.lastCompletedAt = new Date().toISOString();
      status.lastRunDurationMs = nowMs() - startedAtMs;
      activeRunPromise = null;
      updateCounts();
    }
  })();

  return activeRunPromise;
}

function schedule(options = {}) {
  if (!running) return;
  const resolved = normalizeOptions(options);
  timer = setTimeout(async () => {
    try {
      await runOnce(resolved);
    } finally {
      schedule(resolved);
    }
  }, resolved.intervalMs);
}

function start(options = {}) {
  if (running) return;
  const resolved = normalizeOptions(options);
  running = true;
  status.running = true;
  status.lastTokenLimit = resolved.tokenLimit;
  schedule(resolved);
}

function stop() {
  running = false;
  status.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function clear() {
  queuedByAddress.clear();
  passedByAddress.clear();
  updateCounts();
}

function getStatus() {
  updateCounts();
  return { ...status };
}

module.exports = {
  clear,
  enqueue,
  getStatus,
  hasFreshPassedReview,
  markPassed,
  runOnce,
  start,
  stop,
  __private: {
    normalizeOptions,
    takeBatch,
  },
};
