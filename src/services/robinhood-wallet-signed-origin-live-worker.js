const db = require('../models/db');
const { CURSOR_NOTIFY_CHANNEL } = require('../models/robinhood-head-capture');
const {
  createRobinhoodWalletSignedOriginCursorRepository,
} = require('../models/robinhood-wallet-signed-origin-cursor');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');
const { createRobinhoodRpcClient } = require('./robinhood-ingestion-worker');
const { runLiveTick } = require('./robinhood-wallet-signed-origin-live-runner');
const {
  createRobinhoodWalletSignedOriginReader,
} = require('./robinhood-wallet-signed-origin-reader');

const FATAL_CODES = new Set(['configuration_error', 'persistent_reorg', 'source_contract_error']);

function bounded(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback;
}

function normalizeOptions(input = {}) {
  return Object.freeze({ enabled: input.enabled === true,
    intervalMs: bounded(input.intervalMs, 2000, 250, 300_000),
    maxErrorBackoffMs: bounded(input.maxErrorBackoffMs, 60_000, 1000, 300_000),
    maxBlocks: bounded(input.maxBlocks, 100, 1, 200),
    rpcBatchSize: bounded(input.rpcBatchSize, 20, 1, 50),
    concurrency: bounded(input.concurrency, 2, 1, 4),
    timeoutMs: bounded(input.timeoutMs, 15_000, 1000, 60_000),
    circuitFailureThreshold: bounded(input.circuitFailureThreshold, 5, 1, 100),
    circuitResetMs: bounded(input.circuitResetMs, 60_000, 1000, 3_600_000),
    rpcOptions: input.rpcOptions || {}, onFatal: input.onFatal });
}

function publicError(error) {
  return error ? { code: error.code || 'signed_origin_live_error',
    message: String(error.message || error).slice(0, 500), at: new Date().toISOString() } : null;
}

async function buildRuntime(options, deps = {}) {
  const database = deps.database || db;
  const rpcUrl = String((deps.env || process.env).ROBINHOOD_RPC_URL || '').trim();
  if (!rpcUrl) throw Object.assign(new Error('ROBINHOOD_RPC_URL is required for signed-origin LIVE'), {
    code: 'configuration_error', fatal: true,
  });
  const rpcClient = (deps.rpcClientFactory || createRobinhoodRpcClient)({
    ...options.rpcOptions, publicRpcUrl: rpcUrl, useAlchemy: false, useDrpc: false,
    rpcTimeoutMs: options.timeoutMs,
  });
  const repository = (deps.repositoryFactory
    || createRobinhoodWalletSignedOriginCursorRepository)({ database });
  const reader = (deps.readerFactory || createRobinhoodWalletSignedOriginReader)({ rpcClient,
    rpcBatchSize: options.rpcBatchSize, concurrency: options.concurrency,
    maxBlocks: Math.max(options.maxBlocks, options.rpcBatchSize), timeoutMs: options.timeoutMs });
  return Object.freeze({ repository, reader,
    loadSourceFrontier: async () => {
      const row = (await database.query(`SELECT safe_head::text AS safe_head
      FROM robinhood_head_capture_cursors
      WHERE chain = 'robinhood' AND stream = 'discovery'`)).rows[0];
      return row?.safe_head == null ? null : { safeHead: String(row.safe_head) };
    },
    fetchBlockHeader: (number) => rpcClient.request(
      'eth_getBlockByNumber', [`0x${BigInt(number).toString(16)}`, false]
    ), maxBlocks: options.maxBlocks });
}

function createRobinhoodWalletSignedOriginLiveWorker(deps = {}) {
  const schedule = deps.schedule || setTimeout; const cancel = deps.cancelSchedule || clearTimeout;
  const now = deps.now || Date.now; const logger = deps.logger || console;
  const tick = deps.runLiveTick || runLiveTick;
  let options = normalizeOptions(); let runtimePromise; let timer; let listener; let active;
  let running = false;
  const status = { enabled: false, running: false, inFlight: false, halted: false,
    totalRuns: 0, totalBlocks: 0, totalOrigins: 0, wakeups: 0, consecutiveFailures: 0,
    circuitOpenUntil: null, lastResult: null, lastError: null, lastCompletedAt: null };
  const getRuntime = () => (runtimePromise ||= Promise.resolve(
    deps.runtime || buildRuntime(options, deps)
  ).catch((error) => { runtimePromise = null; throw error; }));
  const circuitOpen = () => status.circuitOpenUntil != null
    && now() < Date.parse(status.circuitOpenUntil);

  async function halt(error) {
    running = false; status.running = false; status.halted = true;
    status.lastError = publicError(error); if (timer) cancel(timer); timer = null;
    await Promise.resolve(listener?.stop?.()).catch(() => {});
    try { await options.onFatal?.(error); } catch (cause) {
      logger.error('[RobinhoodSignedOriginLiveWorker] Fatal propagation failed:', cause.message);
    }
  }

  async function execute() {
    if (circuitOpen()) return { status: 'circuit_open', until: status.circuitOpenUntil };
    status.circuitOpenUntil = null; status.inFlight = true; status.totalRuns += 1;
    try {
      const result = await tick(await getRuntime());
      status.lastResult = result; status.lastError = null; status.consecutiveFailures = 0;
      status.totalBlocks += Number(result.blocksCommitted || 0);
      status.totalOrigins += Number(result.originsWritten || 0);
      return result;
    } catch (error) {
      if (error.code === 'signed_origin_seed_incomplete') {
        status.lastResult = { status: 'awaiting_seed' }; status.lastError = null;
        status.consecutiveFailures = 0; return status.lastResult;
      }
      status.consecutiveFailures += 1; status.lastError = publicError(error);
      if (error.fatal === true || FATAL_CODES.has(error.code)) await halt(error);
      else if (status.consecutiveFailures >= options.circuitFailureThreshold) {
        status.circuitOpenUntil = new Date(now() + options.circuitResetMs).toISOString();
      } else logger.warn('[RobinhoodSignedOriginLiveWorker] Tick failed:', error.message);
      return null;
    } finally {
      status.inFlight = false; status.lastCompletedAt = new Date(now()).toISOString();
    }
  }

  async function runOnce() {
    if (active) return active;
    active = execute().finally(() => { active = null; }); return active;
  }
  function queue(delay) {
    if (!running || status.halted || timer) return;
    timer = schedule(async () => { timer = null; await runOnce();
      const delayMs = status.consecutiveFailures
        ? Math.min(options.maxErrorBackoffMs,
          options.intervalMs * (2 ** Math.min(status.consecutiveFailures, 8)))
        : options.intervalMs;
      queue(delayMs);
    }, delay); timer?.unref?.();
  }
  function wake() {
    status.wakeups += 1;
    if (!running || status.halted) return;
    if (timer) cancel(timer); timer = null; queue(0);
  }
  function start(input = {}) {
    if (running) return false; options = normalizeOptions(input); status.enabled = options.enabled;
    if (!options.enabled) return false; running = true; status.running = true; status.halted = false;
    listener = (deps.listenerFactory || createPostgresRealtimeListener)({
      channel: CURSOR_NOTIFY_CHANNEL, label: 'RobinhoodSignedOriginLiveWorker',
      pool: deps.pool || db.pool, onNotification: wake,
    });
    Promise.resolve(listener.start()).catch((error) => { status.lastError = publicError(error); });
    queue(0); return true;
  }
  async function stop() {
    running = false; status.running = false; if (timer) cancel(timer); timer = null;
    await Promise.resolve(listener?.stop?.()).catch(() => {}); if (active) await active.catch(() => {});
  }
  return Object.freeze({ getStatus: () => ({ ...status, circuitOpen: circuitOpen() }),
    runOnce, start, stop });
}

const worker = createRobinhoodWalletSignedOriginLiveWorker();
module.exports = { CURSOR_NOTIFY_CHANNEL, createRobinhoodWalletSignedOriginLiveWorker,
  getStatus: worker.getStatus, start: worker.start, stop: worker.stop,
  __private: { buildRuntime, normalizeOptions } };
