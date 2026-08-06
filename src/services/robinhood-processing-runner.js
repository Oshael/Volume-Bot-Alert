/**
 * robinhood-processing consumer loop (Corte 4c).
 *
 * One tick reclaims abandoned leases, claims a batch of pending market captures,
 * decodes each from its frozen evidence (no RPC), values V2/V3 liquidity from the
 * evidence and V4 liquidity from the materialized tick ledger, persists
 * observations/buckets/deltas in a single transaction, and settles the claims.
 *
 * Isolation invariants (evidence contract §7, plan §5.2):
 *  - it never touches the capture cursor;
 *  - a persistence failure retries the affected claims and leaves capture intact;
 *  - head-level rejections and unknown evidence settle as auditable terminals.
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

function createRobinhoodProcessingRunner(deps = {}) {
  const repository = deps.repository;
  const persistence = deps.persistence;
  const decoder = deps.decoder || defaultDecoder;
  const shadowAuditor = deps.shadowAuditor;
  if (typeof repository?.claimCaptures !== 'function') throw new Error('processing repository is required');
  if (typeof persistence?.commitHeadProcessingBatch !== 'function') throw new Error('persistence is required');

  const options = deps.options || {};
  const owner = String(options.owner || `robinhood-processing:${process.pid}`);
  const batchSize = Number(options.batchSize) || DEFAULT_BATCH_SIZE;
  const leaseMs = Number(options.leaseMs) || DEFAULT_LEASE_MS;
  const retentionMs = Number(options.retentionMs) || DEFAULT_RETENTION_MS;
  const maxAttempts = Number(options.maxAttempts) || DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = Number(options.baseBackoffMs) || DEFAULT_BASE_BACKOFF_MS;
  const maxBackoffMs = Number(options.maxBackoffMs) || DEFAULT_MAX_BACKOFF_MS;
  const emitOutbox = options.emitOutbox === true;
  const logger = deps.logger || console;

  // Coverage window end for the derived emit (Corte 5, option A): the processing
  // frontier just below the queue's pending block. Returns null until there is a
  // fully-processed observation to anchor coverage on.
  async function resolveDerivedEmit() {
    const watermark = await repository.getProcessingWatermark('market');
    return persistence.resolveMarketFrontier(watermark.pendingBlock);
  }

  async function valueObservationEntry(decoded, batchState) {
    const observation = decoded.observation;
    if (!observation?.accepted) {
      return { log: decoded.log, event: decoded.swap, observation };
    }
    let v4Ranges = null;
    if (decoded.liquidityInputs?.requiresRanges) {
      const poolId = decoded.swap.poolId;
      if (!batchState.v4RangesByPool.has(poolId)) {
        batchState.v4RangesByPool.set(
          poolId,
          Promise.resolve(persistence.listCurrentV4LiquidityRanges(poolId))
        );
      }
      v4Ranges = await batchState.v4RangesByPool.get(poolId);
    }
    const assessment = decoder.assessLiquidity(decoded.liquidityInputs, { v4Ranges });
    return { log: decoded.log, event: decoded.swap, observation: decoder.attachLiquidity(observation, assessment) };
  }

  // Decodes and values one claimed row, sorting it into a persistable entry or a
  // terminal rejection. A terminal decode error (unknown version, bad protocol)
  // is auditable and non-retryable; anything else propagates so the whole batch
  // retries and the capture cursor stays untouched.
  async function classify(row, buckets, batchState) {
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
    if (decoded.kind === 'rejected') {
      buckets.rejected.push({ ...identityOf(row), reason: decoded.reason });
      return;
    }
    if (decoded.kind === 'liquidity-delta') {
      buckets.persist.push({ row, entry: { log: decoded.log, event: decoded.event } });
      return;
    }
    if (decoded.kind === 'observation') {
      buckets.persist.push({ row, entry: await valueObservationEntry(decoded, batchState) });
      return;
    }
    // Discovery captures are not claimed on the market stream; ignore defensively.
    buckets.rejected.push({ ...identityOf(row), reason: `unexpected_capture_kind:${decoded.kind}` });
  }

  async function runShadowAudit(items) {
    if (typeof shadowAuditor?.compare !== 'function') return null;
    try {
      return await shadowAuditor.compare(items.map((item) => item.entry));
    } catch (error) {
      const lastError = String(error?.message || error).slice(0, 200);
      logger.error?.('[robinhood-processing] shadow audit failed open', lastError);
      return {
        attempted: items.length, compared: 0, matched: 0,
        mismatched: 0, missing: 0, errors: 1, lastError, samples: [],
      };
    }
  }

  async function runOnce() {
    const reclaimed = await repository.reclaimExpiredLeases();
    const rows = await repository.claimCaptures({ owner, limit: batchSize, leaseMs, stream: 'market' });
    if (!rows.length) {
      return { reclaimed, claimed: 0, processed: 0, rejected: 0, retried: 0, blocked: 0 };
    }

    const buckets = { persist: [], rejected: [] };
    // Every V4 swap in this phase reads the same pre-commit materialized ledger.
    // Reuse that snapshot per pool instead of repeating an identical DB query.
    const batchState = { v4RangesByPool: new Map() };
    for (const row of rows) {
      await classify(row, buckets, batchState);
    }
    const shadowAudit = await runShadowAudit(buckets.persist);

    let processed = [];
    let retry = [];
    if (buckets.persist.length) {
      try {
        const emit = emitOutbox ? await resolveDerivedEmit() : null;
        await persistence.commitHeadProcessingBatch({
          entries: buckets.persist.map((item) => item.entry), emit,
        });
        processed = buckets.persist.map((item) => identityOf(item.row));
      } catch (error) {
        logger.error?.('[robinhood-processing] batch commit failed, retrying claims', error?.message || error);
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
    return { reclaimed, claimed: rows.length, ...settlement, shadowAudit };
  }

  return Object.freeze({ runOnce, owner });
}

module.exports = { createRobinhoodProcessingRunner, backoffFor };
