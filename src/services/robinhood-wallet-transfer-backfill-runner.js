const { randomUUID } = require('crypto');
const workerLease = require('../models/worker-lease');
const {
  runRobinhoodWalletTransferBackfillCommit,
} = require('./robinhood-wallet-transfer-backfill-tick');

const LEASE_KEY = 'robinhood-wallet-transfer-backfill-worker';
const TERMINAL_STATUSES = new Set([
  'complete', 'blocked', 'awaiting-context', 'cursor-conflict',
]);

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function ownerId(input) {
  const value = String(
    input || `wallet-transfer-backfill:${process.pid}:${randomUUID()}`
  ).trim();
  if (!value || value.length > 128) throw new Error('ownerId is invalid');
  return value;
}

function leaseMetadata(input, rangesCompleted, lastResult) {
  return {
    worker: 'robinhood-wallet-transfer-backfill',
    maxBlocks: input.maxBlocks,
    maxRanges: input.maxRanges,
    rangesCompleted,
    nextBlock: lastResult?.nextBlock ?? null,
    lastStatus: lastResult?.status ?? null,
  };
}

async function runRobinhoodWalletTransferBackfill(input = {}, deps = {}) {
  const options = Object.freeze({
    maxBlocks: boundedInteger(input.maxBlocks, 250, 1, 5000, 'maxBlocks'),
    maxRanges: boundedInteger(input.maxRanges, 1, 1, 10_000, 'maxRanges'),
    pauseMs: boundedInteger(input.pauseMs, 250, 0, 60_000, 'pauseMs'),
    leaseTtlMs: boundedInteger(input.leaseTtlMs, 120_000, 5000, 600_000, 'leaseTtlMs'),
    heartbeatMs: boundedInteger(input.heartbeatMs, 30_000, 1000, 300_000, 'heartbeatMs'),
    ownerId: ownerId(input.ownerId),
  });
  if (options.heartbeatMs * 2 > options.leaseTtlMs) {
    throw new Error('heartbeatMs must be at most half of leaseTtlMs');
  }
  const leaseStore = deps.leaseStore || workerLease;
  const runCommit = deps.runCommit || runRobinhoodWalletTransferBackfillCommit;
  const delay = deps.sleep || sleep;
  let rangesCompleted = 0;
  let lastResult = null;
  let leaseLost = false;
  let heartbeatTimer = null;
  const acquired = await leaseStore.acquire(LEASE_KEY, options.ownerId, {
    ttlMs: options.leaseTtlMs,
    metadata: leaseMetadata(options, rangesCompleted, lastResult),
  });
  if (!acquired) {
    return Object.freeze({
      status: 'lease-unavailable', rangesCompleted, lastResult,
    });
  }

  async function heartbeat() {
    try {
      const lease = await leaseStore.heartbeat(LEASE_KEY, options.ownerId, {
        ttlMs: options.leaseTtlMs,
        metadata: leaseMetadata(options, rangesCompleted, lastResult),
      });
      if (!lease) leaseLost = true;
    } catch {
      leaseLost = true;
    }
  }

  heartbeatTimer = (deps.setInterval || setInterval)(() => { void heartbeat(); }, options.heartbeatMs);
  heartbeatTimer?.unref?.();
  const tokenAddresses = typeof deps.tickDeps?.source?.listTrackedTokenAddresses === 'function'
    ? await deps.tickDeps.source.listTrackedTokenAddresses().catch(() => undefined)
    : undefined;
  try {
    while (rangesCompleted < options.maxRanges) {
      if (leaseLost) {
        return Object.freeze({ status: 'lease-lost', rangesCompleted, lastResult });
      }
      lastResult = await runCommit(deps.tickDeps, {
        maxBlocks: options.maxBlocks, now: input.now, tokenAddresses,
      });
      rangesCompleted += 1;
      if (TERMINAL_STATUSES.has(lastResult.status)) {
        return Object.freeze({ status: lastResult.status, rangesCompleted, lastResult });
      }
      if (lastResult.status !== 'projected') {
        return Object.freeze({ status: 'unexpected-result', rangesCompleted, lastResult });
      }
      await heartbeat();
      if (leaseLost) {
        return Object.freeze({ status: 'lease-lost', rangesCompleted, lastResult });
      }
      if (rangesCompleted < options.maxRanges) await delay(options.pauseMs);
    }
    return Object.freeze({ status: 'range-limit', rangesCompleted, lastResult });
  } finally {
    (deps.clearInterval || clearInterval)(heartbeatTimer);
    await leaseStore.release(LEASE_KEY, options.ownerId).catch(() => false);
  }
}

module.exports = {
  LEASE_KEY,
  runRobinhoodWalletTransferBackfill,
  __private: { leaseMetadata, ownerId },
};
