'use strict';

const { valuePoolsAtBlock } = require('./robinhood-pool-liquidity-events');

function integer(value, fallback, minimum, maximum) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RangeError(`value must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function owner(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 160) throw new Error('owner is invalid');
  return normalized;
}

function candidate(row) {
  return Object.freeze({
    protocol: row.protocol,
    marketKey: row.market_key,
    poolAddress: row.pool_address,
    poolId: row.pool_id,
    originAddress: row.origin_address,
    tokenAddress: row.token_address,
    quoteAddress: row.quote_address,
    currency0: row.currency0,
    currency1: row.currency1,
    discoveredAt: row.discovered_at,
  });
}

function retryDelay(attemptCount, baseMs, maximumMs) {
  return Math.min(maximumMs, baseMs * (2 ** Math.min(10, Math.max(0, attemptCount - 1))));
}

function createRobinhoodCanonicalLiquidityRefresher(deps = {}, input = {}) {
  if (!deps.reader || !deps.snapshotRepository?.resolveAnchorBlock
    || !deps.refreshQueue?.claim || !deps.refreshQueue?.complete
    || !deps.refreshQueue?.retry || !deps.refreshQueue?.reclaimExpired) {
    throw new Error('canonical liquidity refresher dependencies are required');
  }
  const options = {
    owner: owner(input.owner),
    limit: integer(input.limit, 100, 1, 500),
    leaseMs: integer(input.leaseMs, 600_000, 1_000, 3_600_000),
    concurrency: integer(input.concurrency, 10, 1, 20),
    retryBaseMs: integer(input.retryBaseMs, 5_000, 1, 3_600_000),
    retryMaxMs: integer(input.retryMaxMs, 60_000, 1, 86_400_000),
  };
  if (options.retryMaxMs < options.retryBaseMs) {
    throw new Error('retryMaxMs must be greater than or equal to retryBaseMs');
  }
  const valuePools = deps.valuePools || valuePoolsAtBlock;

  async function reschedule(rows, errors) {
    let retried = 0;
    for (const row of rows) {
      const error = errors.get(`${row.protocol}:${row.market_key}`)
        || new Error('liquidity refresh result is missing');
      const changed = await deps.refreshQueue.retry({
        owner: options.owner,
        protocol: row.protocol,
        marketKey: row.market_key,
        generation: row.generation,
        retryMs: retryDelay(row.attempt_count, options.retryBaseMs, options.retryMaxMs),
        error,
      });
      if (changed) retried += 1;
    }
    return retried;
  }

  async function runOnce() {
    const reclaimed = await deps.refreshQueue.reclaimExpired();
    const anchorBlock = await deps.snapshotRepository.resolveAnchorBlock();
    if (anchorBlock == null) return Object.freeze({
      status: 'frontier_unavailable', reclaimed, claimed: 0, completed: 0, retried: 0,
    });
    const rows = await deps.refreshQueue.claim({
      owner: options.owner, limit: options.limit, leaseMs: options.leaseMs,
    });
    if (!rows.length) return Object.freeze({
      status: 'idle', anchorBlock, reclaimed, claimed: 0, completed: 0, retried: 0,
    });
    let valuation;
    try {
      valuation = await valuePools({ reader: deps.reader, repository: deps.snapshotRepository },
        rows.map(candidate), anchorBlock, {
          concurrency: options.concurrency, now: deps.now, includePoolResults: true,
        });
    } catch (error) {
      await reschedule(rows, new Map(rows.map((row) => [
        `${row.protocol}:${row.market_key}`, error,
      ])));
      throw error;
    }
    const results = new Map(valuation.poolResults.map((result) => [
      `${result.protocol}:${result.marketKey}`, result,
    ]));
    let completed = 0;
    const failed = [];
    for (const row of rows) {
      const result = results.get(`${row.protocol}:${row.market_key}`);
      if (result?.status !== 'completed') {
        failed.push(row);
        continue;
      }
      const settled = await deps.refreshQueue.complete({
        owner: options.owner, protocol: row.protocol, marketKey: row.market_key,
        generation: row.generation,
      });
      if (settled.removed || settled.requeued) completed += 1;
    }
    const errors = new Map(valuation.poolResults
      .filter((result) => result.status === 'failed')
      .map((result) => [`${result.protocol}:${result.marketKey}`, result.error]));
    const retried = await reschedule(failed, errors);
    return Object.freeze({
      status: 'processed', anchorBlock: valuation.anchorBlock, reclaimed,
      claimed: rows.length, completed, retried, valuation,
    });
  }

  return Object.freeze({ runOnce });
}

module.exports = { createRobinhoodCanonicalLiquidityRefresher };
