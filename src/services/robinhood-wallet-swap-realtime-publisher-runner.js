'use strict';

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;

function backoffFor(attempt, baseMs, maxMs) {
  return Math.max(1, Math.min(maxMs, baseMs * 2 ** Math.max(0, Number(attempt) - 1)));
}

function createRobinhoodWalletSwapRealtimePublisherRunner(deps = {}) {
  const repository = deps.repository;
  if (typeof repository?.claimPublication !== 'function'
      || typeof repository?.settlePublication !== 'function'
      || typeof repository?.reclaimExpiredPublicationLeases !== 'function') {
    throw new Error('trade lifecycle publication repository is required');
  }
  if (typeof deps.publishRows !== 'function') {
    throw new Error('trade lifecycle publisher is required');
  }
  const options = deps.options || {};
  const owner = String(options.owner || `robinhood-trade-publisher:${process.pid}`);
  const batchSize = Number(options.batchSize) || DEFAULT_BATCH_SIZE;
  const leaseMs = Number(options.leaseMs) || DEFAULT_LEASE_MS;
  const maxAttempts = Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = Number(options.baseBackoffMs) || DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = Number(options.maxBackoffMs) || DEFAULT_MAX_BACKOFF_MS;

  function retry(row, error) {
    return {
      transactionHash: row.transactionHash, logIndex: row.logIndex,
      blockHash: row.blockHash, eventKind: row.eventKind,
      error: String(error?.message || error).slice(0, 4000),
      backoffMs: backoffFor(row.attemptCount, baseBackoffMs, maxBackoffMs),
    };
  }

  async function runOnce(input = {}) {
    const observedEnabled = input.observedEnabled === true;
    const reclaimed = await repository.reclaimExpiredPublicationLeases();
    const rows = await repository.claimPublication({
      owner, limit: batchSize, leaseMs, observedEnabled,
    });
    if (!rows.length) {
      return { status: 'idle', observedEnabled, reclaimed,
        claimed: 0, delivered: 0, retried: 0, blocked: 0 };
    }
    let delivered = rows;
    let retryRows = [];
    try {
      const published = await deps.publishRows(rows.map(({ payload }) => payload));
      if (published !== true) throw new Error('trade lifecycle publisher rejected the batch');
    } catch (error) {
      delivered = [];
      retryRows = rows.map((row) => retry(row, error));
    }
    const settled = await repository.settlePublication({
      owner, maxAttempts, delivered, retry: retryRows,
    });
    return {
      status: settled.blocked ? 'blocked' : (settled.retried ? 'retrying' : 'delivered'),
      observedEnabled, reclaimed, claimed: rows.length, ...settled,
    };
  }

  return Object.freeze({ owner, runOnce });
}

module.exports = { backoffFor, createRobinhoodWalletSwapRealtimePublisherRunner };
