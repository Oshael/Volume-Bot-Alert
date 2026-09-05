'use strict';

const { DOMAIN_NOTIFY_CHANNEL } = require('../models/robinhood-chain-capture-journal');
const { createPostgresRealtimeListener } = require('./postgres-realtime-listener');

function componentStatus() {
  return { lastResult: null, lastError: null, totalRuns: 0 };
}

function failure(error) {
  return Object.freeze({
    code: String(error?.code || 'canonical_liquidity_failed').slice(0, 64),
    message: String(error?.message || error).slice(0, 1000),
  });
}

function createRobinhoodCanonicalLiquidityWorker(deps = {}, options = {}) {
  if (!deps.scanner?.scanNextRange || !deps.refresher?.runOnce) {
    throw new Error('canonical liquidity worker dependencies are required');
  }
  const idlePollMs = Number(options.idlePollMs) || 1000;
  const errorPollMs = Number(options.errorPollMs) || 5000;
  const maxScanRanges = Number(options.maxScanRangesPerTick) || 20;
  const refreshBatchSize = Number(options.refreshBatchSize) || 100;
  const schedule = deps.schedule || setTimeout;
  const cancel = deps.cancel || clearTimeout;
  const status = {
    running: false, listening: false, inFlight: false,
    lastTickAt: null, lastNotifyAt: null, totalNotifies: 0, totalErrors: 0,
    scanner: { ...componentStatus(), totalRanges: 0, totalBlocks: 0,
      totalLogs: 0, totalAffected: 0, totalQueued: 0 },
    refresher: { ...componentStatus(), totalClaimed: 0,
      totalCompleted: 0, totalRetried: 0 },
  };
  let timer = null; let listener = null; let tickPromise = null; let wakePending = false;

  async function scanAvailable() {
    const summary = {
      ranges: 0, blocks: 0, logs: 0, affected: 0, queued: 0,
      caughtUp: false, nextBlock: null, safeHead: null,
    };
    for (let index = 0; index < maxScanRanges; index += 1) {
      const result = await deps.scanner.scanNextRange();
      summary.nextBlock = result.nextBlock; summary.safeHead = result.safeHead;
      if (result.status === 'caught_up') { summary.caughtUp = true; break; }
      summary.ranges += 1; summary.blocks += result.blocks;
      summary.logs += result.logs; summary.affected += result.affected;
      summary.queued += result.queued;
    }
    return Object.freeze(summary);
  }

  async function runComponent(name, operation) {
    const current = status[name];
    current.totalRuns += 1;
    try {
      const result = await operation();
      current.lastResult = result; current.lastError = null;
      return result;
    } catch (error) {
      status.totalErrors += 1; current.lastError = failure(error);
      return null;
    }
  }

  function recordTotals(scan, refresh) {
    if (scan) {
      status.scanner.totalRanges += scan.ranges; status.scanner.totalBlocks += scan.blocks;
      status.scanner.totalLogs += scan.logs; status.scanner.totalAffected += scan.affected;
      status.scanner.totalQueued += scan.queued;
    }
    if (refresh) {
      status.refresher.totalClaimed += refresh.claimed || 0;
      status.refresher.totalCompleted += refresh.completed || 0;
      status.refresher.totalRetried += refresh.retried || 0;
    }
  }

  async function runOnce() {
    status.inFlight = true;
    try {
      const [scan, refresh] = await Promise.all([
        runComponent('scanner', scanAvailable),
        runComponent('refresher', () => deps.refresher.runOnce()),
      ]);
      recordTotals(scan, refresh); status.lastTickAt = new Date().toISOString();
      return Object.freeze({ scan, refresh });
    } finally {
      status.inFlight = false;
    }
  }

  function scheduleTick(delayMs) {
    if (!status.running || timer) return;
    timer = schedule(() => {
      timer = null;
      tickPromise = runOnce().then(({ scan, refresh }) => {
        const busy = scan?.ranges >= maxScanRanges
          || (refresh?.claimed || 0) >= refreshBatchSize;
        const failed = scan == null || refresh == null;
        const delay = wakePending || busy ? 0 : failed ? errorPollMs : idlePollMs;
        wakePending = false; scheduleTick(delay);
      }).finally(() => { tickPromise = null; });
    }, delayMs);
    timer?.unref?.();
  }

  function wake() {
    if (!status.running) return;
    if (tickPromise) { wakePending = true; return; }
    if (timer) cancel(timer);
    timer = null; scheduleTick(0);
  }

  async function start() {
    if (status.running) return;
    status.running = true;
    listener = (deps.listenerFactory || createPostgresRealtimeListener)({
      channel: DOMAIN_NOTIFY_CHANNEL, label: 'RobinhoodCanonicalLiquidity',
      pool: deps.pool,
      onNotification: (message) => {
        if (message?.channel !== DOMAIN_NOTIFY_CHANNEL) return;
        status.lastNotifyAt = new Date().toISOString(); status.totalNotifies += 1; wake();
      },
      onConnected: () => { status.listening = true; wake(); },
      onConnectionError: () => { status.listening = false; },
    });
    try { await listener.start(); } catch (error) {
      status.totalErrors += 1; status.scanner.lastError = failure(error);
    }
    scheduleTick(0);
  }

  async function stop() {
    status.running = false; status.listening = false;
    if (timer) cancel(timer);
    timer = null;
    if (listener) await listener.stop().catch(() => {});
    listener = null;
    if (tickPromise) await tickPromise;
  }

  return Object.freeze({ getStatus: () => structuredClone(status), runOnce, start, stop });
}

module.exports = { createRobinhoodCanonicalLiquidityWorker };
