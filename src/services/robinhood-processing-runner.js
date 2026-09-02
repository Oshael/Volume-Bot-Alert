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
const config = require('../../config');
const { evaluateFdvBand } = require('./robinhood-price-spike-guard');
const { commitErrorMessage, persistWithFailureIsolation } = require('./robinhood-processing-commit');

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_RETENTION_MS = 86_400_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BASE_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 300_000;
const DEFAULT_V4_CONTINUATION_ROUNDS = 8;
const DEFAULT_V4_CONTINUATION_POOL_LIMIT = 8;
const DEFAULT_V4_SWAP_PREFIX_LIMIT = 512;

function identityOf(row) {
  return { transactionHash: row.transaction_hash, logIndex: String(row.log_index) };
}

function backoffFor(attempt, baseMs, maxMs) {
  const exponential = baseMs * 2 ** Math.max(0, Number(attempt) - 1);
  return Math.max(1, Math.min(maxMs, exponential));
}

function normalizeV4ContinuationRounds(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(0, Math.min(parsed, 100))
    : DEFAULT_V4_CONTINUATION_ROUNDS;
}

function normalizeV4ContinuationPoolLimit(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(1, Math.min(parsed, 64))
    : DEFAULT_V4_CONTINUATION_POOL_LIMIT;
}

function normalizeV4SwapPrefixLimit(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.max(1, Math.min(parsed, 2000))
    : DEFAULT_V4_SWAP_PREFIX_LIMIT;
}

// Dead-pool guard applier: reject an accepted observation whose fdv is a per-token
// relative outlier (dead / near-zero-liquidity pool). Flipping accepted->false makes
// the batch persist it as status='rejected' (kept as evidence, excluded from buckets).
// The token reference is loaded once per token per batch (like v4RangesByPool).
function createDeadPoolGuardApplier(persistence, guardConfig = {}) {
  const enabled = guardConfig.enabled !== false;
  const maxMultiple = Number(guardConfig.maxMultiple) || 5;
  const sampleSize = Number(guardConfig.sampleSize) || 500;
  const minVolumeUsd = Number(guardConfig.minVolumeUsd) || 100;
  return async function applyDeadPoolGuard(observation, batchState) {
    if (!enabled || observation.fdvUsd == null
      || (typeof persistence.loadTokenFdvReference !== 'function'
        && typeof persistence.loadTokenFdvReferences !== 'function')) return observation;
    const token = String(observation.tokenAddress).toLowerCase();
    if (!batchState.tokenRefByAddress.has(token)) {
      batchState.tokenRefByAddress.set(
        token, typeof persistence.loadTokenFdvReference === 'function'
          ? Promise.resolve(persistence.loadTokenFdvReference(token, sampleSize))
          : null
      );
    }
    const reference = await batchState.tokenRefByAddress.get(token);
    const verdict = evaluateFdvBand({
      fdvUsd: observation.fdvUsd, reference, maxMultiple,
      volumeUsd: observation.volumeUsd, minVolumeUsd,
    });
    return verdict.outlier ? { ...observation, accepted: false, reason: verdict.reason } : observation;
  };
}

async function loadBatchFdvReferences(persistence, tokenAddresses, sampleSize) {
  if (!tokenAddresses.length) return new Map();
  if (typeof persistence.loadTokenFdvReferences === 'function') {
    return persistence.loadTokenFdvReferences(tokenAddresses, sampleSize);
  }
  if (typeof persistence.loadTokenFdvReference !== 'function') return new Map();
  return new Map(await Promise.all(tokenAddresses.map(async (address) => [
    address, await persistence.loadTokenFdvReference(address, sampleSize),
  ])));
}

function createFdvReferenceCache(options = {}) {
  const ttlMs = Math.max(1000, Number(options.ttlMs) || 60_000);
  const maxEntries = Math.max(1, Number(options.maxEntries) || 5000);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const entries = new Map();
  return Object.freeze({
    get(address) {
      const cached = entries.get(address);
      if (!cached || cached.expiresAt <= now()) {
        entries.delete(address);
        return { hit: false, value: null };
      }
      entries.delete(address);
      entries.set(address, cached);
      return { hit: true, value: cached.value };
    },
    set(address, value) {
      entries.delete(address);
      entries.set(address, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    get size() { return entries.size; },
  });
}

async function loadCachedFdvReferences(persistence, addresses, sampleSize, cache) {
  const values = new Map();
  const misses = [];
  let hits = 0;
  for (const address of addresses) {
    const cached = cache.get(address);
    if (cached.hit) {
      hits += 1;
      values.set(address, cached.value);
    } else {
      misses.push(address);
    }
  }
  const loaded = await loadBatchFdvReferences(persistence, misses, sampleSize);
  for (const address of misses) {
    const value = loaded.has(address) ? loaded.get(address) : null;
    cache.set(address, value);
    values.set(address, value);
  }
  return { values, hits, misses: misses.length };
}

async function loadBatchV4Ranges(persistence, poolIds) {
  if (!poolIds.length) return new Map();
  if (typeof persistence.listCurrentV4LiquidityRangesByPoolIds === 'function') {
    return persistence.listCurrentV4LiquidityRangesByPoolIds(poolIds);
  }
  return new Map(await Promise.all(poolIds.map(async (poolId) => [
    poolId, await persistence.listCurrentV4LiquidityRanges(poolId),
  ])));
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
  const v4ContinuationRounds = normalizeV4ContinuationRounds(options.v4ContinuationRounds);
  const v4ContinuationPoolLimit = normalizeV4ContinuationPoolLimit(
    options.v4ContinuationPoolLimit
  );
  const v4SwapPrefixLimit = normalizeV4SwapPrefixLimit(options.v4SwapPrefixLimit);
  const emitOutbox = options.emitOutbox === true;
  const logger = deps.logger || console;
  const deadPoolGuardConfig = options.deadPoolGuard || config.robinhoodDeadPoolGuard || {};
  const applyDeadPoolGuard = createDeadPoolGuardApplier(persistence, deadPoolGuardConfig);
  const fdvReferenceCache = createFdvReferenceCache({
    ttlMs: deadPoolGuardConfig.cacheTtlMs,
    maxEntries: deadPoolGuardConfig.cacheMaxEntries,
    now: deps.now,
  });

  // Coverage window end for the derived emit (Corte 5, option A): the processing
  // frontier just below the queue's pending block. Returns null until there is a
  // fully-processed observation to anchor coverage on.
  async function resolveDerivedEmit() {
    const active = await repository.getOldestActiveCapture('market');
    return persistence.resolveMarketFrontier(active?.blockNumber ?? null);
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
    const withLiquidity = decoder.attachLiquidity(observation, assessment);
    const guarded = await applyDeadPoolGuard(withLiquidity, batchState);
    return { log: decoded.log, event: decoded.swap, observation: guarded };
  }

  // Decodes and values one claimed row, sorting it into a persistable entry or a
  // terminal rejection. A terminal decode error (unknown version, bad protocol)
  // is auditable and non-retryable; anything else propagates so the whole batch
  // retries and the capture cursor stays untouched.
  function decode(row, buckets) {
    let decoded;
    try {
      decoded = decoder.decodeCapture(row);
    } catch (error) {
      if (error?.terminal === true) {
        buckets.rejected.push({ ...identityOf(row), reason: String(error.message).slice(0, 200) });
        return null;
      }
      throw error;
    }
    if (decoded.kind === 'rejected') {
      buckets.rejected.push({ ...identityOf(row), reason: decoded.reason });
      return null;
    }
    return decoded;
  }

  async function preloadBatchState(decodedRows) {
    const tokenAddresses = new Set();
    const poolIds = new Set();
    const guardEnabled = deadPoolGuardConfig.enabled !== false;
    for (const { decoded } of decodedRows) {
      if (decoded.kind !== 'observation') continue;
      if (guardEnabled && decoded.observation?.accepted && decoded.observation.fdvUsd != null) {
        tokenAddresses.add(String(decoded.observation.tokenAddress).toLowerCase());
      }
      if (decoded.liquidityInputs?.requiresRanges && decoded.swap?.poolId) {
        poolIds.add(decoded.swap.poolId);
      }
    }
    const [fdvReferences, v4RangesByPool] = await Promise.all([
      loadCachedFdvReferences(
        persistence, [...tokenAddresses], Number(deadPoolGuardConfig.sampleSize) || 500,
        fdvReferenceCache
      ),
      loadBatchV4Ranges(persistence, [...poolIds]),
    ]);
    return {
      tokenRefByAddress: fdvReferences.values,
      v4RangesByPool,
      fdvCacheHits: fdvReferences.hits,
      fdvCacheMisses: fdvReferences.misses,
    };
  }

  async function classifyDecoded(row, decoded, buckets, batchState) {
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

  async function processClaimedRows(rows) {
    let phaseStartedAt = Date.now();
    const buckets = { persist: [], rejected: [] };
    const decodedRows = rows.flatMap((row) => {
      const decoded = decode(row, buckets);
      return decoded ? [{ row, decoded }] : [];
    });
    // Read every token reference and V4 pool ledger in two set-based round trips.
    // All rows in this phase intentionally see the same pre-commit snapshot.
    const batchState = await preloadBatchState(decodedRows);
    for (const { row, decoded } of decodedRows) {
      await classifyDecoded(row, decoded, buckets, batchState);
    }
    const prepareMs = Date.now() - phaseStartedAt;
    phaseStartedAt = Date.now();
    const shadowAudit = await runShadowAudit(buckets.persist);
    const shadowMs = Date.now() - phaseStartedAt;

    let processed = [];
    let retry = [];
    let frontierMs = 0;
    let persistMs = 0;
    if (buckets.persist.length) {
      phaseStartedAt = Date.now();
      const emit = emitOutbox ? await resolveDerivedEmit() : null;
      frontierMs = Date.now() - phaseStartedAt;
      phaseStartedAt = Date.now();
      const outcome = await persistWithFailureIsolation(
        buckets.persist,
        (items) => persistence.commitHeadProcessingBatch({
          entries: items.map((item) => item.entry), emit,
        })
      );
      persistMs = Date.now() - phaseStartedAt;
      processed = outcome.processed.map((item) => identityOf(item.row));
      retry = outcome.failed.map(({ item, error }) => ({
        ...identityOf(item.row),
        error: commitErrorMessage(error),
        backoffMs: backoffFor(item.row.attempt_count, baseBackoffMs, maxBackoffMs),
      }));
      if (retry.length) {
        logger.error?.(
          '[robinhood-processing] commit failure isolated for retry',
          { failed: retry.length, processed: processed.length, error: retry[0].error }
        );
      }
    }

    phaseStartedAt = Date.now();
    const settlement = await repository.settleClaims({
      owner, retentionMs, maxAttempts,
      processed, rejected: buckets.rejected, retry,
    });
    const settleMs = Date.now() - phaseStartedAt;
    const settlementComplete = settlement.processed === processed.length
      && settlement.rejected === buckets.rejected.length;
    const failed = new Set(retry.map((item) => `${item.transactionHash}:${item.logIndex}`));
    const continuationMarketKeys = settlementComplete ? [...new Set(rows
      .filter((row) => row.protocol === 'uniswap-v4'
        && row.market_key && !failed.has(`${row.transaction_hash}:${row.log_index}`))
      .map((row) => row.market_key))] : [];
    return {
      claimed: rows.length, ...settlement, shadowAudit, continuationMarketKeys,
      timing: {
        prepareMs, shadowMs, frontierMs, persistMs, settleMs,
        fdvCacheHits: batchState.fdvCacheHits,
        fdvCacheMisses: batchState.fdvCacheMisses,
      },
    };
  }

  function mergeShadowAudit(current, next) {
    if (!next) return current;
    if (!current) return next;
    const merged = { ...current };
    for (const field of ['attempted', 'compared', 'matched', 'mismatched', 'missing', 'errors']) {
      merged[field] = Number(current[field] || 0) + Number(next[field] || 0);
    }
    merged.lastError = next.lastError || current.lastError || null;
    merged.samples = [...(current.samples || []), ...(next.samples || [])].slice(0, 20);
    return merged;
  }

  async function runOnce() {
    const tickStartedAt = Date.now();
    let phaseStartedAt = tickStartedAt;
    const reclaimed = await repository.reclaimExpiredLeases();
    const timing = {
      reclaimMs: Date.now() - phaseStartedAt,
      claimMs: 0, prepareMs: 0, shadowMs: 0, frontierMs: 0, persistMs: 0,
      settleMs: 0, fdvCacheHits: 0, fdvCacheMisses: 0,
    };
    phaseStartedAt = Date.now();
    let rows = await repository.claimCaptures({ owner, limit: batchSize, leaseMs, stream: 'market' });
    timing.claimMs += Date.now() - phaseStartedAt;
    const totals = {
      claimed: 0, processed: 0, rejected: 0, retried: 0, blocked: 0,
      continuationRounds: 0, continuationClaimed: 0, continuationPools: 0,
    };
    let shadowAudit = null;
    let targetedMarketKeys = null;

    while (rows.length) {
      const round = await processClaimedRows(rows);
      for (const field of ['claimed', 'processed', 'rejected', 'retried', 'blocked']) {
        totals[field] += Number(round[field] || 0);
      }
      for (const field of [
        'prepareMs', 'shadowMs', 'frontierMs', 'persistMs', 'settleMs',
        'fdvCacheHits', 'fdvCacheMisses',
      ]) timing[field] += Number(round.timing[field] || 0);
      shadowAudit = mergeShadowAudit(shadowAudit, round.shadowAudit);
      if (targetedMarketKeys === null) {
        // rows are in on-chain order, so this freezes the oldest successfully
        // settled V4 frontiers for the whole tick instead of rescanning every pool.
        targetedMarketKeys = round.continuationMarketKeys.slice(0, v4ContinuationPoolLimit);
        totals.continuationPools = targetedMarketKeys.length;
      } else {
        const stillEligible = new Set(round.continuationMarketKeys);
        targetedMarketKeys = targetedMarketKeys.filter((key) => stillEligible.has(key));
      }
      if (totals.continuationRounds >= v4ContinuationRounds
          || !targetedMarketKeys.length
          || typeof repository.claimV4Continuations !== 'function') break;
      phaseStartedAt = Date.now();
      rows = await repository.claimV4Continuations({
        owner, marketKeys: targetedMarketKeys,
        limit: batchSize, perPoolLimit: v4SwapPrefixLimit, leaseMs,
      });
      timing.claimMs += Date.now() - phaseStartedAt;
      if (!rows.length) break;
      totals.continuationRounds += 1;
      totals.continuationClaimed += rows.length;
    }

    const totalMs = Date.now() - tickStartedAt;
    return {
      reclaimed, ...totals, shadowAudit,
      timing: {
        totalMs, ...timing,
        claimedPerSecond: totalMs > 0
          ? Math.round((totals.claimed * 1000) / totalMs) : totals.claimed,
        fdvCacheSize: fdvReferenceCache.size,
      },
    };
  }

  return Object.freeze({ runOnce, owner });
}

module.exports = {
  DEFAULT_V4_CONTINUATION_POOL_LIMIT,
  DEFAULT_V4_CONTINUATION_ROUNDS,
  DEFAULT_V4_SWAP_PREFIX_LIMIT,
  createRobinhoodProcessingRunner,
  backoffFor,
  __private: {
    createFdvReferenceCache, normalizeV4ContinuationRounds, normalizeV4ContinuationPoolLimit,
  },
};
