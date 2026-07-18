const robinhoodCatalog = require('../models/robinhood-catalog');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const MAX_BATCH_SIZE = 100;

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function createRobinhoodLiveCatalogWorker(deps = {}) {
  const catalog = deps.catalog || robinhoodCatalog;
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const pending = new Map();
  let options = {};
  let running = false;
  let timer = null;
  let activeRun = null;
  const status = {
    running: false, queued: 0, written: 0, batches: 0,
    errors: 0, lastDurationMs: 0, lastCompletedAt: null, lastError: null,
  };

  function normalizeUpdate(payload) {
    if (payload?.type !== 'market:bucket' || payload?.chain !== CHAIN) return null;
    let address;
    try {
      address = normalizeTokenAddress(CHAIN, payload.address);
    } catch (_) {
      return null;
    }
    const observedAt = new Date(payload.valuation?.observedAt || payload.generatedAt);
    if (!Number.isFinite(observedAt.getTime())) return null;
    const metric = (value) => {
      if (value == null) return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    return {
      address,
      observedAt: observedAt.toISOString(),
      observedAtMs: observedAt.getTime(),
      priceUsd: metric(payload.valuation?.priceUsd),
      fdvUsd: metric(payload.valuation?.fdvUsd),
    };
  }

  function queueFlush(delayMs = options.debounceMs) {
    if (!running || timer || activeRun || pending.size === 0) return;
    timer = schedule(() => {
      timer = null;
      void flush().catch((error) => logger.error(`[RobinhoodLiveCatalogWorker] ${error.message}`));
    }, delayMs);
    timer?.unref?.();
  }

  function enqueue(payload) {
    if (!running) return false;
    const snapshot = normalizeUpdate(payload);
    if (!snapshot) return false;
    const previous = pending.get(snapshot.address);
    if (!previous || snapshot.observedAtMs >= previous.observedAtMs) {
      pending.set(snapshot.address, snapshot);
    }
    status.queued += 1;
    queueFlush();
    return true;
  }

  function restoreFailedBatch(batch) {
    for (const snapshot of batch) {
      const current = pending.get(snapshot.address);
      if (!current || snapshot.observedAtMs > current.observedAtMs) {
        pending.set(snapshot.address, snapshot);
      }
    }
  }

  async function flush() {
    if (activeRun) return activeRun;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (!running || pending.size === 0) return null;
    const startedAt = Date.now();
    const batch = [...pending.values()]
      .sort((left, right) => left.address.localeCompare(right.address))
      .slice(0, MAX_BATCH_SIZE);
    for (const snapshot of batch) pending.delete(snapshot.address);
    let failed = false;
    activeRun = catalog.applyLiveSnapshots(batch)
      .then((written) => {
        status.written += Number(written) || 0;
        status.batches += 1;
        status.lastError = null;
        status.lastCompletedAt = new Date().toISOString();
      })
      .catch((error) => {
        failed = true;
        restoreFailedBatch(batch);
        status.errors += 1;
        status.lastError = String(error?.message || error).slice(0, 500);
        throw error;
      })
      .finally(() => {
        status.lastDurationMs = Math.max(0, Date.now() - startedAt);
        activeRun = null;
        queueFlush(failed ? options.retryMs : options.debounceMs);
      });
    return activeRun;
  }

  function start(input = {}) {
    if (running || input.enabled !== true) return false;
    options = {
      debounceMs: boundedInteger(input.debounceMs, 25, 0, 1000),
      retryMs: boundedInteger(input.retryMs, 250, 25, 10_000),
    };
    running = true;
    status.running = true;
    return true;
  }

  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRun) await activeRun.catch(() => {});
    pending.clear();
  }

  return Object.freeze({ enqueue, flush, getStatus: () => ({ ...status, pending: pending.size }), start, stop });
}

const worker = createRobinhoodLiveCatalogWorker();

module.exports = {
  createRobinhoodLiveCatalogWorker,
  enqueue: worker.enqueue,
  flush: worker.flush,
  getStatus: worker.getStatus,
  start: worker.start,
  stop: worker.stop,
};
