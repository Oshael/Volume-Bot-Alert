const mockTrading = require('./mock-trading-service');

const LOOP_INTERVAL_MS = 3 * 1000;
const DEFAULT_BATCH_LIMIT = 25;

let timer = null;
let running = false;
let activeRunPromise = null;
let status = {
  running: false,
  inFlight: false,
  enabled: true,
  lastRunAt: null,
  lastCompletedAt: null,
  lastRunDurationMs: 0,
  lastScheduledDelayMs: LOOP_INTERVAL_MS,
  lastBatchLimit: DEFAULT_BATCH_LIMIT,
  lastCandidateCount: 0,
  lastTriggered: 0,
  lastSkipped: 0,
  lastCancelled: 0,
  totalTriggered: 0,
  totalSkipped: 0,
  totalCancelled: 0,
  totalErrors: 0,
  lastError: null,
};

function normalizeLimit(value, fallback = DEFAULT_BATCH_LIMIT) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(parsed), 100));
}

function normalizeDelayMs(value, fallback = LOOP_INTERVAL_MS) {
  const delayMs = Number(value);
  if (!Number.isFinite(delayMs)) {
    return fallback;
  }
  return Math.max(1000, Math.round(delayMs));
}

function normalizeOptions(options = {}) {
  return {
    enabled: options.enabled !== false,
    intervalMs: normalizeDelayMs(options.intervalMs, LOOP_INTERVAL_MS),
    batchLimit: normalizeLimit(options.batchLimit, DEFAULT_BATCH_LIMIT),
  };
}

function normalizeErrorMessage(error) {
  const message = String(error?.message || error || '').trim();
  return message ? message.slice(0, 1000) : 'Unknown take profit worker error';
}

function schedule(options = {}) {
  if (!running) return;
  const normalized = normalizeOptions(options);
  timer = setTimeout(async () => {
    try {
      await runOnce(normalized, { ifRunning: 'join' });
    } catch (err) {
      console.error('[MockTradingTakeProfitWorker] Scheduled run failed:', err.message);
    } finally {
      schedule(normalized);
    }
  }, normalized.intervalMs);
}

async function processOrder(orderId, deps = {}) {
  const service = deps.mockTradingService || mockTrading;
  try {
    return await service.executeTakeProfitOrder(orderId, deps);
  } catch (error) {
    status.totalErrors += 1;
    status.lastError = normalizeErrorMessage(error);
    return {
      status: 'error',
      orderId,
      error: status.lastError,
    };
  }
}

async function runOnce(options = {}, meta = {}, deps = {}) {
  const normalized = normalizeOptions(options);
  const ifRunning = String(meta.ifRunning || 'reject').trim().toLowerCase();

  if (activeRunPromise) {
    if (ifRunning === 'join') {
      return activeRunPromise;
    }
    throw new Error('Mock trading take profit worker already has an active run');
  }

  activeRunPromise = (async () => {
    const startedAtMs = Date.now();
    const service = deps.mockTradingService || mockTrading;

    status.inFlight = true;
    status.enabled = normalized.enabled;
    status.lastRunAt = new Date(startedAtMs).toISOString();
    status.lastBatchLimit = normalized.batchLimit;
    status.lastTriggered = 0;
    status.lastSkipped = 0;
    status.lastCancelled = 0;
    status.lastError = null;

    try {
      const orderIds = normalized.enabled
        ? await service.listTriggeredTakeProfitCandidates(normalized.batchLimit, deps.db)
        : [];
      const results = [];

      for (const orderId of orderIds) {
        results.push(await processOrder(orderId, deps));
      }

      status.lastCandidateCount = orderIds.length;
      status.lastTriggered = results.filter((item) => item.status === 'triggered').length;
      status.lastSkipped = results.filter((item) => item.status === 'skipped').length;
      status.lastCancelled = results.filter((item) => item.status === 'cancelled').length;
      status.totalTriggered += status.lastTriggered;
      status.totalSkipped += status.lastSkipped;
      status.totalCancelled += status.lastCancelled;
      status.lastCompletedAt = new Date().toISOString();
      status.lastRunDurationMs = Date.now() - startedAtMs;
      status.lastScheduledDelayMs = Math.max(1000, normalized.intervalMs - status.lastRunDurationMs);

      return {
        startedAt: status.lastRunAt,
        completedAt: status.lastCompletedAt,
        candidateCount: orderIds.length,
        triggered: status.lastTriggered,
        skipped: status.lastSkipped,
        cancelled: status.lastCancelled,
        results,
      };
    } catch (error) {
      status.totalErrors += 1;
      status.lastError = normalizeErrorMessage(error);
      throw error;
    } finally {
      status.inFlight = false;
      activeRunPromise = null;
    }
  })();

  return activeRunPromise;
}

function start(options = {}) {
  if (running) return;
  const normalized = normalizeOptions(options);
  running = true;
  status.running = true;
  status.enabled = normalized.enabled;
  status.lastScheduledDelayMs = normalized.intervalMs;
  schedule(normalized);
}

function stop() {
  running = false;
  status.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function getStatus() {
  return { ...status };
}

module.exports = {
  DEFAULT_BATCH_LIMIT,
  LOOP_INTERVAL_MS,
  getStatus,
  runOnce,
  start,
  stop,
  __private: {
    normalizeOptions,
  },
};
