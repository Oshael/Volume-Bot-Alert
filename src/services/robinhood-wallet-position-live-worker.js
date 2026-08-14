const {
  createRobinhoodWalletPositionRepository,
} = require('../models/robinhood-wallet-position');
const {
  createRobinhoodWalletSwapCursorRepository,
} = require('../models/robinhood-wallet-swap-cursor');
const {
  DEFAULT_PROJECTION_VERSION,
  createRobinhoodWalletPositionProjector,
} = require('./robinhood-wallet-position-projector');

function boundedInteger(value, fallback, min, max) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) ? Math.max(min, Math.min(parsed, max)) : fallback;
}

function normalizeOptions(input = {}) {
  return {
    enabled: input.enabled === true,
    intervalMs: boundedInteger(input.intervalMs, 2000, 250, 300_000),
    maxErrorBackoffMs: boundedInteger(input.maxErrorBackoffMs, 30_000, 1000, 300_000),
    maxBlocks: boundedInteger(input.maxBlocks, 200, 1, 500),
    projectionVersion: input.projectionVersion || DEFAULT_PROJECTION_VERSION,
  };
}

function durableSourceThrough(source) {
  if (!source || source.lifecycleState !== 'running' || source.nextBlock == null
      || BigInt(source.nextBlock) === 0n || !source.checkpointTimestamp) return null;
  return (BigInt(source.nextBlock) - 1n).toString();
}

function sourceRegression(message) {
  return Object.assign(new Error(message), { code: 'source_frontier_regressed' });
}

async function runPositionLiveTick(deps, options) {
  const source = await deps.sourceCursors.loadCursor('live');
  const sourceThrough = durableSourceThrough(source);
  if (sourceThrough == null) {
    return { status: 'awaiting-source', sourceNextBlock: source?.nextBlock || null };
  }
  const seed = await deps.positions.loadCursor(options.projectionVersion, 'seed');
  if (!seed || seed.lifecycleState !== 'complete') {
    return { status: 'awaiting-seed', seedState: seed?.lifecycleState || 'missing' };
  }
  if (BigInt(seed.nextBlock) > BigInt(source.nextBlock)) {
    throw sourceRegression('wallet position seed is ahead of the durable wallet-swap source');
  }
  let live = await deps.positions.loadCursor(options.projectionVersion, 'live');
  if (!live) {
    live = await deps.positions.initCursor({
      projectionVersion: options.projectionVersion,
      stream: 'live',
      nextBlock: seed.nextBlock,
      nextBlockTime: seed.nextBlockTime,
      safeHead: sourceThrough,
    });
  }
  if (BigInt(live.nextBlock) > BigInt(source.nextBlock)) {
    throw sourceRegression('wallet position live cursor is ahead of its durable source');
  }
  const report = await deps.projector.runBatch({
    projectionVersion: options.projectionVersion,
    stream: 'live',
    cursor: { ...live, safeHead: sourceThrough },
    emptyNextBlockTime: source.checkpointTimestamp,
    maxBlocks: options.maxBlocks,
    includeTouched: true,
    commit: true,
  });
  if (report.complete) {
    return { status: 'caught-up', sourceThrough, ...report };
  }
  if (report.persisted?.committed !== true) {
    return { status: 'cursor-conflict', sourceThrough, ...report };
  }
  const projectionThrough = (BigInt(report.persisted.cursor.nextBlock) - 1n).toString();
  const reconciliation = await deps.positions.reconcileTouchedPositions(
    options.projectionVersion,
    report.touched,
    projectionThrough
  );
  const quality = reconciliation.mismatched > 0
    ? 'provisional-transfer-gap'
    : (reconciliation.aligned > 0 ? 'aligned' : 'awaiting-holder-alignment');
  return { status: 'projected', sourceThrough, projectionThrough, quality, reconciliation, ...report };
}

function createRobinhoodWalletPositionLiveWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout;
  const cancelSchedule = deps.cancelSchedule || clearTimeout;
  const logger = deps.logger || console;
  let options = normalizeOptions();
  let timer = null;
  let active = null;
  let running = false;
  let runtime = null;
  const status = {
    enabled: false, running: false, inFlight: false, batches: 0,
    consecutiveErrors: 0, lastResult: null, lastError: null, lastCompletedAt: null,
  };

  function getRuntime() {
    if (!runtime) {
      const positions = (deps.positionRepositoryFactory
        || createRobinhoodWalletPositionRepository)();
      runtime = {
        positions,
        sourceCursors: (deps.sourceCursorRepositoryFactory
          || createRobinhoodWalletSwapCursorRepository)(),
        projector: (deps.projectorFactory || createRobinhoodWalletPositionProjector)({
          repository: positions,
        }),
      };
    }
    return runtime;
  }

  async function execute() {
    status.inFlight = true;
    try {
      const result = await (deps.runTick || runPositionLiveTick)(getRuntime(), options);
      const { touched: _touched, ...boundedResult } = result;
      status.lastResult = boundedResult;
      status.lastError = null;
      status.consecutiveErrors = 0;
      status.batches += 1;
      return result;
    } catch (error) {
      status.consecutiveErrors += 1;
      status.lastError = { code: error.code || 'position_live_error', message: error.message };
      logger.warn('[RobinhoodWalletPositionLiveWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false;
      status.lastCompletedAt = new Date().toISOString();
    }
  }

  async function runOnce() {
    if (active) return active;
    active = execute().finally(() => { active = null; });
    return active;
  }

  function queueNext(delay) {
    if (!running) return;
    timer = schedule(async () => {
      await runOnce();
      const backoff = Math.min(
        options.maxErrorBackoffMs,
        options.intervalMs * (2 ** Math.min(status.consecutiveErrors, 8))
      );
      queueNext(status.consecutiveErrors ? backoff : options.intervalMs);
    }, delay);
  }

  function start(input = {}) {
    if (running) return false;
    options = normalizeOptions(input);
    status.enabled = options.enabled;
    if (!options.enabled) return false;
    running = true;
    status.running = true;
    queueNext(0);
    return true;
  }

  async function stop() {
    running = false;
    status.running = false;
    if (timer) cancelSchedule(timer);
    timer = null;
    if (active) await active.catch(() => {});
  }

  return Object.freeze({ getStatus: () => ({ ...status }), runOnce, start, stop });
}

const worker = createRobinhoodWalletPositionLiveWorker();

module.exports = {
  createRobinhoodWalletPositionLiveWorker,
  getStatus: worker.getStatus,
  runOnce: worker.runOnce,
  start: worker.start,
  stop: worker.stop,
  __private: { durableSourceThrough, normalizeOptions, runPositionLiveTick },
};
