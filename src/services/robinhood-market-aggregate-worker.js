const {
  createRobinhoodMarketAggregateRepository,
} = require('../models/robinhood-market-aggregate');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const GRANULARITIES = Object.freeze([5, 15, 30, 60, 240, 1440]);

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function parentBucketTs(sourceBucketMs, granularityMinutes) {
  const widthMs = granularityMinutes * 60_000;
  return new Date(Math.floor(sourceBucketMs / widthMs) * widthMs).toISOString();
}

function createRobinhoodMarketAggregateWorker(deps = {}) {
  const repository = deps.repository || createRobinhoodMarketAggregateRepository();
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  const pending = new Map();
  let options = {};
  let running = false;
  let timer = null;
  let timerDueAt = 0;
  let activeRun = null;
  let activeRecovery = null;
  const status = {
    running: false, queued: 0, coalesced: 0, processed: 0, refreshes: 0,
    retries: 0, failures: 0, dropped: 0, recovered: 0,
    lastRefreshLatencyMs: 0, lastCompletedAt: null, lastError: null,
  };

  function normalizeTarget(payload) {
    if (payload?.type && (payload.type !== 'market:bucket' || payload.chain !== CHAIN)) return null;
    let address;
    try {
      address = normalizeTokenAddress(CHAIN, payload.address || payload.token_address);
    } catch (_) {
      return null;
    }
    const bucketDate = new Date(payload.bucketTs || payload.bucket_ts);
    if (!Number.isFinite(bucketDate.getTime())) return null;
    const sourceBucketMs = Math.floor(bucketDate.getTime() / 60_000) * 60_000;
    return { address, bucketTs: new Date(sourceBucketMs).toISOString(), sourceBucketMs };
  }

  function scheduleFlush(delayMs = options.debounceMs) {
    if (!running || activeRun || pending.size === 0) return;
    const dueAt = now() + Math.max(0, delayMs);
    if (timer && timerDueAt <= dueAt) return;
    if (timer) cancelSchedule(timer);
    timerDueAt = dueAt;
    timer = schedule(() => {
      timer = null;
      timerDueAt = 0;
      void flush().catch((error) => logger.error(
        `[RobinhoodMarketAggregateWorker] ${error.message}`
      ));
    }, Math.max(0, dueAt - now()));
    timer?.unref?.();
  }

  function enqueueTarget(target, recovered = false) {
    const key = `${target.address}:${target.bucketTs}`;
    if (pending.has(key)) {
      status.coalesced += 1;
      return true;
    }
    if (pending.size >= options.maxQueueSize) {
      status.dropped += 1;
      return false;
    }
    pending.set(key, { ...target, key, attempts: 0, enqueuedAt: now(), readyAt: now() });
    status.queued += 1;
    if (recovered) status.recovered += 1;
    scheduleFlush();
    return true;
  }

  function enqueue(payload) {
    if (!running) return false;
    const target = normalizeTarget(payload);
    return target ? enqueueTarget(target) : false;
  }

  function restoreFailed(task, error) {
    status.failures += 1;
    status.lastError = String(error?.message || error).slice(0, 500);
    if (task.attempts >= options.maxRetries) {
      status.dropped += 1;
      return;
    }
    if (!pending.has(task.key)) {
      if (pending.size >= options.maxQueueSize) {
        status.dropped += 1;
        return;
      }
      const attempts = task.attempts + 1;
      pending.set(task.key, {
        ...task,
        attempts,
        readyAt: now() + options.retryMs * (2 ** (attempts - 1)),
      });
      status.retries += 1;
    }
  }

  async function processTask(task) {
    const startedAt = now();
    try {
      for (const granularityMinutes of GRANULARITIES) {
        await repository.refreshBucket({
          tokenAddress: task.address,
          granularityMinutes,
          bucketTs: parentBucketTs(task.sourceBucketMs, granularityMinutes),
        });
        status.refreshes += 1;
      }
      status.processed += 1;
      status.lastError = null;
    } catch (error) {
      restoreFailed(task, error);
    } finally {
      status.lastRefreshLatencyMs = Math.max(0, now() - startedAt);
    }
  }

  async function processTasks(tasks) {
    let nextIndex = 0;
    const workerCount = Math.min(options.concurrency, tasks.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextIndex < tasks.length) {
        const task = tasks[nextIndex];
        nextIndex += 1;
        await processTask(task);
      }
    }));
  }

  function nextPendingDelay() {
    if (!pending.size) return null;
    const earliest = Math.min(...[...pending.values()].map((task) => task.readyAt));
    return Math.max(options.debounceMs, earliest - now());
  }

  async function flush() {
    if (activeRun) return activeRun;
    if (timer) cancelSchedule(timer);
    timer = null;
    timerDueAt = 0;
    if (!running || pending.size === 0) return null;
    const ready = [...pending.values()]
      .filter((task) => task.readyAt <= now())
      .sort((left, right) => left.enqueuedAt - right.enqueuedAt || left.key.localeCompare(right.key))
      .slice(0, options.batchSize);
    for (const task of ready) pending.delete(task.key);
    if (!ready.length) {
      scheduleFlush(nextPendingDelay());
      return null;
    }
    activeRun = processTasks(ready).finally(() => {
      status.lastCompletedAt = new Date(now()).toISOString();
      activeRun = null;
      const delay = nextPendingDelay();
      if (delay != null) scheduleFlush(delay);
    });
    return activeRun;
  }

  async function recover() {
    if (!running || options.recoveryLookbackMinutes <= 0) return 0;
    const rows = await repository.listRecentSourceBuckets({
      since: new Date(now() - options.recoveryLookbackMinutes * 60_000),
      limit: options.recoveryLimit,
    });
    let recovered = 0;
    for (const row of rows) {
      const target = normalizeTarget(row);
      if (target && enqueueTarget(target, true)) recovered += 1;
    }
    return recovered;
  }

  function start(input = {}) {
    if (running || input.enabled !== true) return false;
    options = {
      batchSize: boundedInteger(input.batchSize, 20, 1, 100),
      concurrency: boundedInteger(input.concurrency, 2, 1, 8),
      debounceMs: boundedInteger(input.debounceMs, 50, 0, 5000),
      maxQueueSize: boundedInteger(input.maxQueueSize, 1000, 10, 10_000),
      maxRetries: boundedInteger(input.maxRetries, 3, 0, 8),
      retryMs: boundedInteger(input.retryMs, 500, 25, 60_000),
      recoveryLimit: boundedInteger(input.recoveryLimit, 500, 1, 1000),
      recoveryLookbackMinutes: boundedInteger(input.recoveryLookbackMinutes, 30, 0, 180),
    };
    running = true;
    status.running = true;
    activeRecovery = recover()
      .catch((error) => {
        status.failures += 1;
        status.lastError = String(error?.message || error).slice(0, 500);
        logger.error(`[RobinhoodMarketAggregateWorker] recovery: ${error.message}`);
      })
      .finally(() => { activeRecovery = null; });
    return true;
  }

  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (activeRecovery) await activeRecovery;
    if (activeRun) await activeRun;
    pending.clear();
  }

  function getStatus() {
    const oldest = pending.size
      ? Math.min(...[...pending.values()].map((task) => task.enqueuedAt))
      : null;
    return {
      ...status,
      depth: pending.size,
      oldestPendingAgeMs: oldest == null ? 0 : Math.max(0, now() - oldest),
    };
  }

  return Object.freeze({ enqueue, flush, getStatus, recover, start, stop });
}

const worker = createRobinhoodMarketAggregateWorker();

module.exports = {
  createRobinhoodMarketAggregateWorker,
  enqueue: worker.enqueue,
  flush: worker.flush,
  getStatus: worker.getStatus,
  start: worker.start,
  stop: worker.stop,
  __private: { parentBucketTs },
};
