function bounded(value, fallback, minimum, maximum, label) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function normalizeOptions(input = {}) {
  return Object.freeze({
    enabled: input.enabled === true,
    intervalMs: bounded(input.intervalMs, 10_000, 1000, 300_000, 'intervalMs'),
    refreshMs: bounded(input.refreshMs, 300_000, 10_000, 86_400_000, 'refreshMs'),
    batchSize: bounded(input.batchSize, 50, 1, 500, 'batchSize'),
    concurrency: bounded(input.concurrency, 5, 1, 20, 'concurrency'),
    maxErrorBackoffMs: bounded(
      input.maxErrorBackoffMs, 60_000, 1000, 3_600_000, 'maxErrorBackoffMs'
    ),
  });
}

function unavailableError(result) {
  const error = new Error(`liquidity unavailable: ${result?.status || 'unknown'}`);
  error.code = 'liquidity_unavailable';
  return error;
}

async function mapConcurrent(items, concurrency, operation) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await operation(items[index]);
    }
  }));
  return output;
}

async function runLiquidityTick(deps, options, now = Date.now) {
  const anchorBlock = await deps.repository.resolveAnchorBlock();
  if (anchorBlock == null) throw new Error('market processing frontier is unavailable');
  const anchor = await deps.reader.readAnchor(`0x${BigInt(anchorBlock).toString(16)}`);
  const nowMs = now();
  const checkedAt = new Date(nowMs).toISOString();
  const dueBefore = new Date(nowMs - options.refreshMs).toISOString();
  const pools = await deps.repository.listDuePools({ dueBefore, limit: options.batchSize });
  const outcomes = await mapConcurrent(pools, options.concurrency, async (pool) => {
    try {
      const result = await deps.reader.valuePool(pool, anchor);
      if (result.liquidityUsd == null) throw unavailableError(result);
      const saved = await deps.repository.recordSnapshot({
        protocol: pool.protocol, marketKey: pool.marketKey,
        blockNumber: result.number, blockHash: result.hash,
        observedAt: result.observedAt, checkedAt,
        liquidityUsd: result.liquidityUsd, liquidityRaw: result.liquidityRaw,
        liquidityStatus: result.status, liquidityConfidence: result.confidence,
        liquidityWarning: result.warning,
      });
      return { saved: saved ? 1 : 0, failed: 0 };
    } catch (error) {
      await deps.repository.recordFailure({
        protocol: pool.protocol, marketKey: pool.marketKey, checkedAt, error,
      });
      return { saved: 0, failed: 1, errorCode: error.code || 'liquidity_snapshot_error' };
    }
  });
  return Object.freeze({
    status: pools.length === options.batchSize ? 'draining' : 'caught-up',
    anchorBlock: anchor.number, checked: pools.length,
    saved: outcomes.reduce((sum, item) => sum + item.saved, 0),
    failed: outcomes.reduce((sum, item) => sum + item.failed, 0),
  });
}

function createRobinhoodPoolLiquidityWorker(deps = {}) {
  if (!deps.reader || !deps.repository) throw new Error('reader and repository are required');
  const schedule = deps.schedule || setTimeout;
  const cancel = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  const now = deps.now || Date.now;
  let options = normalizeOptions();
  let timer = null;
  let active = null;
  let running = false;
  const status = {
    enabled: false, running: false, inFlight: false,
    totalRuns: 0, totalChecked: 0, totalSaved: 0, totalFailed: 0,
    consecutiveErrors: 0, lastResult: null, lastError: null, lastCompletedAt: null,
  };

  async function execute() {
    status.inFlight = true;
    status.totalRuns += 1;
    try {
      const result = await runLiquidityTick(deps, options, now);
      status.lastResult = result;
      status.totalChecked += result.checked;
      status.totalSaved += result.saved;
      status.totalFailed += result.failed;
      status.consecutiveErrors = 0;
      status.lastError = null;
      return result;
    } catch (error) {
      status.consecutiveErrors += 1;
      status.lastError = { code: error.code || 'liquidity_worker_error', message: error.message };
      logger.warn('[RobinhoodPoolLiquidityWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false;
      status.lastCompletedAt = new Date(now()).toISOString();
    }
  }

  async function runOnce() {
    if (active) return active;
    active = execute().finally(() => { active = null; });
    return active;
  }

  function queue(delay) {
    if (!running) return;
    timer = schedule(async () => {
      await runOnce();
      const backoff = options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8));
      queue(Math.min(options.maxErrorBackoffMs, backoff));
    }, delay);
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    running = true;
    status.running = true;
    queue(0);
    return true;
  }

  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancel(timer);
    timer = null;
    if (active) await active;
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

module.exports = {
  createRobinhoodPoolLiquidityWorker,
  runLiquidityTick,
  __private: { mapConcurrent, normalizeOptions },
};
