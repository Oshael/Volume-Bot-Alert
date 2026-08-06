/**
 * robinhood-discovery consumer loop.
 *
 * Discovery-stream counterpart of robinhood-processing-runner. One tick claims a
 * batch of pending discovery captures, decodes each pool/launch event from its
 * frozen evidence (no RPC), registers the pool in a single transaction, and
 * settles the claims. It carries the same isolation invariants as the market
 * consumer but drops market valuation/liquidity/outbox: discovery only registers
 * pools (evidence contract §7).
 *
 * Isolation invariants:
 *  - it never touches the capture cursor;
 *  - a persistence failure retries the affected claims and leaves capture intact;
 *  - an unsupported evidence version or unexpected kind settles as an auditable
 *    terminal rejection.
 *
 * Lease reclaim is intentionally NOT run here: reclaimExpiredLeases is chain-wide
 * (not stream-scoped), so the co-located market runner's reclaim already returns
 * abandoned discovery leases. Enable it (options.reclaim) only when this runner
 * owns its own process.
 */
const defaultDecoder = require('./robinhood-head-processing-decoder');

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETENTION_MS = 86_400_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;

function identityOf(row) {
  return { transactionHash: row.transaction_hash, logIndex: String(row.log_index) };
}

function backoffFor(attempt, baseMs, maxMs) {
  const exponential = baseMs * 2 ** Math.max(0, Number(attempt) - 1);
  return Math.max(1, Math.min(maxMs, exponential));
}

function createRobinhoodDiscoveryProcessingRunner(deps = {}) {
  const repository = deps.repository;
  const persistence = deps.persistence;
  const decoder = deps.decoder || defaultDecoder;
  if (typeof repository?.claimCaptures !== 'function') throw new Error('processing repository is required');
  if (typeof persistence?.commitDiscoveryProcessingBatch !== 'function') throw new Error('persistence is required');

  const options = deps.options || {};
  const owner = String(options.owner || `robinhood-discovery:${process.pid}`);
  const batchSize = Number(options.batchSize) || DEFAULT_BATCH_SIZE;
  const leaseMs = Number(options.leaseMs) || DEFAULT_LEASE_MS;
  const retentionMs = Number(options.retentionMs) || DEFAULT_RETENTION_MS;
  const maxAttempts = Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = Number(options.baseBackoffMs) || DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = Number(options.maxBackoffMs) || DEFAULT_MAX_BACKOFF_MS;
  const reclaim = options.reclaim === true;
  const logger = deps.logger || console;

  // Decodes one claimed row into a persistable {log,event} entry or a terminal
  // rejection. A terminal decode error (unsupported evidence version) is
  // auditable and non-retryable; anything else propagates so the whole batch
  // retries and the capture cursor stays untouched.
  function classify(row, buckets) {
    let decoded;
    try {
      decoded = decoder.decodeCapture(row);
    } catch (error) {
      if (error?.terminal === true) {
        buckets.rejected.push({ ...identityOf(row), reason: String(error.message).slice(0, 200) });
        return;
      }
      throw error;
    }
    if (decoded.kind !== 'discovery') {
      buckets.rejected.push({ ...identityOf(row), reason: `unexpected_capture_kind:${decoded.kind}` });
      return;
    }
    buckets.persist.push({ row, entry: { log: decoded.log, event: decoded.event } });
  }

  async function runOnce() {
    const reclaimed = reclaim ? await repository.reclaimExpiredLeases() : 0;
    const rows = await repository.claimCaptures({ owner, limit: batchSize, leaseMs, stream: 'discovery' });
    if (!rows.length) {
      return { reclaimed, claimed: 0, processed: 0, rejected: 0, retried: 0, blocked: 0 };
    }

    const buckets = { persist: [], rejected: [] };
    for (const row of rows) {
      classify(row, buckets);
    }

    let processed = [];
    let retry = [];
    if (buckets.persist.length) {
      try {
        await persistence.commitDiscoveryProcessingBatch({
          entries: buckets.persist.map((item) => item.entry),
        });
        processed = buckets.persist.map((item) => identityOf(item.row));
      } catch (error) {
        logger.error?.('[robinhood-discovery] batch commit failed, retrying claims', error?.message || error);
        retry = buckets.persist.map((item) => ({
          ...identityOf(item.row),
          error: String(error?.message || error).slice(0, 200),
          backoffMs: backoffFor(item.row.attempt_count, baseBackoffMs, maxBackoffMs),
        }));
      }
    }

    const settlement = await repository.settleClaims({
      owner, retentionMs, maxAttempts,
      processed, rejected: buckets.rejected, retry,
    });
    return { reclaimed, claimed: rows.length, ...settlement };
  }

  return Object.freeze({ runOnce, owner });
}

module.exports = { createRobinhoodDiscoveryProcessingRunner, backoffFor };
