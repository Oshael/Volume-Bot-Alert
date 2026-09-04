'use strict';

function identity(row) {
  return { domain: 'discovery', blockHash: row.block_hash, logIndex: row.log_index };
}
function backoff(attempt, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, Number(attempt) - 1)));
}

function createRobinhoodCanonicalDiscoveryRunner(deps = {}) {
  const { outbox, capture, headRepository } = deps;
  if (typeof outbox?.claimReady !== 'function') throw new Error('domain outbox is required');
  if (typeof capture?.buildEntries !== 'function') throw new Error('discovery capture is required');
  if (typeof headRepository?.appendCaptureEntries !== 'function') {
    throw new Error('head capture repository is required');
  }
  const options = deps.options || {};
  const owner = String(options.owner || `robinhood-canonical-discovery:${process.pid}`);
  const batchSize = Number(options.batchSize) || 200;
  const leaseMs = Number(options.leaseMs) || 60_000;
  const maxAttempts = Number(options.maxAttempts) || 5;
  const baseBackoffMs = Number(options.baseBackoffMs) || 1000;
  const maxBackoffMs = Number(options.maxBackoffMs) || 60_000;

  async function runOnce() {
    const reclaimed = await outbox.reclaimExpiredLeases();
    const rows = await outbox.claimReady({
      domain: 'discovery', owner, limit: batchSize, leaseMs,
    });
    if (!rows.length) return {
      reclaimed, claimed: 0, inserted: 0, duplicates: 0, completed: 0,
      blocked: 0, retried: 0, throughBlock: null,
    };
    let append;
    try {
      const entries = await capture.buildEntries(rows);
      append = await headRepository.appendCaptureEntries({ entries });
    } catch (error) {
      const retry = rows.map((row) => ({
        ...identity(row), error: { code: error.code || 'capture_failed', message: error.message },
        backoffMs: backoff(row.attempt_count, baseBackoffMs, maxBackoffMs),
      }));
      const settled = await outbox.settle({ owner, retry, maxAttempts });
      return {
        reclaimed, claimed: rows.length, inserted: 0, duplicates: 0,
        completed: 0, ...settled, throughBlock: String(rows.at(-1).block_number),
      };
    }
    const settled = await outbox.settle({
      owner, complete: rows.map(identity), maxAttempts,
    });
    return {
      reclaimed, claimed: rows.length, inserted: append.insertedCaptures,
      duplicates: append.duplicateCaptures, ...settled,
      throughBlock: String(rows.at(-1).block_number),
    };
  }

  return Object.freeze({ owner, runOnce });
}

module.exports = { backoff, createRobinhoodCanonicalDiscoveryRunner };
