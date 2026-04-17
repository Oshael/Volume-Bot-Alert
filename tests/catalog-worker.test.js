const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const catalogWorker = require('../src/services/catalog-worker');
const tokenCatalog = require('../src/models/token-catalog');
const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../src/models/token-market-volume-bucket-1m');
const dexscreener = require('../src/services/dexscreener');
const highCapDumpAlert = require('../src/services/high-cap-dump-alert');
const userAlertMatcher = require('../src/services/user-alert-matcher');

describe('catalog worker drift compensation', () => {
  it('reduces the next delay when the cycle finishes early', () => {
    assert.equal(catalogWorker.__private.computeNextDelayMs(1300), 700);
  });

  it('schedules the next cycle immediately after an overrun', () => {
    assert.equal(catalogWorker.__private.computeNextDelayMs(3500), 0);
  });

  it('clamps invalid delay inputs to a safe non-negative value', () => {
    assert.equal(catalogWorker.__private.normalizeDelayMs(-125), 0);
    assert.equal(catalogWorker.__private.normalizeDelayMs(Number.NaN), 2000);
  });

  it('adds bounded jitter to low-priority delays', () => {
    assert.equal(catalogWorker.__private.addPriorityJitter(15000, 3000, 0), 15000);
    assert.equal(catalogWorker.__private.addPriorityJitter(15000, 3000, 1), 18000);
    assert.equal(catalogWorker.__private.addPriorityJitter(15000, 3000, 0.5), 16500);
  });

  it('uses slower retries for low-dust tokens during rate-limit outages', () => {
    const lowNearRetryMs = catalogWorker.__private.getDexUnavailableRetryMs({
      monitor_priority: 'low',
      last_mcap: 20000,
    }, { throttleMode: 'recovery' });
    const lowDustRetryMs = catalogWorker.__private.getDexUnavailableRetryMs({
      monitor_priority: 'low',
      last_mcap: 9000,
    }, { throttleMode: 'recovery' });

    assert.equal(lowNearRetryMs, 3 * 60 * 1000);
    assert.equal(lowDustRetryMs, 2 * 60 * 1000);
  });

  it('applies the 30s low-activity cooldown to dex-unavailable high and normal retries', () => {
    const highRetryMs = catalogWorker.__private.getDexUnavailableRetryMs({
      monitor_priority: 'high',
      last_mcap: 250000,
      last_vol_24h: 2500,
    }, { throttleMode: 'normal' });
    const normalRetryMs = catalogWorker.__private.getDexUnavailableRetryMs({
      monitor_priority: 'normal',
      last_mcap: 60000,
      last_vol_24h: 2800,
    }, { throttleMode: 'normal' });

    assert.equal(highRetryMs, 30 * 1000);
    assert.equal(normalRetryMs, 30 * 1000);
  });

  it('applies the 30s low-activity cooldown to rate-limited high retries', () => {
    const retryMs = catalogWorker.__private.getDexUnavailableRetryMs({
      monitor_priority: 'high',
      last_mcap: 250000,
      last_vol_24h: 1200,
    }, { throttleMode: 'recovery' });

    assert.equal(retryMs, 30 * 1000);
  });

  it('keeps migrated low-dust tokens on the low-near path during migration grace', () => {
    const token = {
      source: 'pumpfun-migrated',
      monitor_priority: 'low',
      last_mcap: 9000,
      migration_grace_until: new Date(Date.now() + catalogWorker.__private.MIGRATION_GRACE_FLOOR_MS).toISOString(),
    };

    assert.equal(catalogWorker.__private.isMigrationGraceActive(token), true);
    assert.equal(catalogWorker.__private.isLowDustProtectedByMigrationGrace(token, 9000), true);
    assert.equal(catalogWorker.__private.getThrottleTokenBucket(token), 'low-near');
    assert.equal(catalogWorker.__private.getDexPriorityHint(token), 'low-near');
    assert.equal(catalogWorker.__private.getRateLimitedRetryMs(token), 3 * 60 * 1000);
  });

  it('returns migrated low-dust tokens to normal low-dust handling after grace expires', () => {
    const token = {
      source: 'pumpfun-migrated',
      monitor_priority: 'low',
      last_mcap: 9000,
      migration_grace_until: new Date(Date.now() - 1000).toISOString(),
    };

    assert.equal(catalogWorker.__private.isMigrationGraceActive(token), false);
    assert.equal(catalogWorker.__private.isLowDustProtectedByMigrationGrace(token, 9000), false);
    assert.equal(catalogWorker.__private.getThrottleTokenBucket(token), 'low-dust');
    assert.equal(catalogWorker.__private.getDexPriorityHint(token), 'low-dust');
    assert.equal(catalogWorker.__private.getRateLimitedRetryMs(token), 2 * 60 * 1000);
  });

  it('still honors the 30s low-activity cooldown for migrated low-dust snapshots during grace', () => {
    const now = Date.now();
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 9000,
      volume: {},
      priceChange: {},
    }, {
      source: 'pumpfun-migrated',
      migration_grace_until: new Date(now + catalogWorker.__private.MIGRATION_GRACE_FLOOR_MS).toISOString(),
    });

    const nextMs = snapshot.nextEvaluationAt.getTime() - now;
    assert.equal(snapshot.monitorPriority, 'low');
    assert.equal(snapshot.eligibleForMonitoring, true);
    assert.ok(nextMs >= 30000 && nextMs <= 30100, `expected low-activity cooldown, got ${nextMs}ms`);
  });

  it('slows high-activity buckets to at least 30s when 24h volume is below 3k', () => {
    const now = Date.now();
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 250000,
      volume: { h24: 2500, h6: 60000 },
      priceChange: {},
    });

    const nextMs = snapshot.nextEvaluationAt.getTime() - now;
    assert.equal(snapshot.monitorPriority, 'high');
    assert.equal(snapshot.eligibleForMonitoring, true);
    assert.ok(nextMs >= 30000 && nextMs <= 30100, `expected low-activity cooldown, got ${nextMs}ms`);
  });

  it('does not accelerate low-dust tokens that are already slower than 30s', () => {
    const now = Date.now();
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 9000,
      volume: { h24: 1000 },
      priceChange: {},
    });

    const nextMs = snapshot.nextEvaluationAt.getTime() - now;
    assert.equal(snapshot.monitorPriority, 'low');
    assert.equal(snapshot.eligibleForMonitoring, true);
    assert.ok(nextMs >= 10 * 60 * 1000, `expected existing low-dust cadence to remain slower than 30s, got ${nextMs}ms`);
  });

  it('keeps only high and manual tokens during cooldown', () => {
    const ordered = catalogWorker.__private.prioritizeTokensForThrottle([
      { address: 'A', source: 'dexscreener-discovery', monitor_priority: 'normal', last_mcap: 60000, next_evaluation_at: '2026-03-25T12:00:00.000Z' },
      { address: 'B', source: 'user-manual', monitor_priority: 'low', last_mcap: 9000, next_evaluation_at: '2026-03-25T12:00:00.000Z' },
      { address: 'C', source: 'dexscreener-discovery', monitor_priority: 'high', last_mcap: 200000, next_evaluation_at: '2026-03-25T12:00:00.000Z' },
    ], { mode: 'cooldown' }, 3);

    assert.deepEqual(ordered.map((item) => item.address), ['B', 'C']);
  });

  it('releases normal before low-near and low-dust during recovery', () => {
    const ordered = catalogWorker.__private.prioritizeTokensForThrottle([
      { address: 'A', source: 'dexscreener-discovery', monitor_priority: 'normal', last_mcap: 60000, next_evaluation_at: '2026-03-25T12:00:00.000Z' },
      { address: 'B', source: 'dexscreener-discovery', monitor_priority: 'low', last_mcap: 9000, next_evaluation_at: '2026-03-25T12:00:00.000Z' },
      { address: 'C', source: 'dexscreener-discovery', monitor_priority: 'low', last_mcap: 20000, next_evaluation_at: '2026-03-25T12:00:00.000Z' },
      { address: 'D', source: 'user-manual', monitor_priority: 'low', last_mcap: 12000, next_evaluation_at: '2026-03-25T12:00:00.000Z' },
    ], { mode: 'recovery', recoveryPhase: 'normal' }, 4);

    assert.deepEqual(ordered.map((item) => item.address), ['D', 'A']);
  });

  it('evaluates high-cap dump alerts in batch using the just-processed addresses', async () => {
    const originalListDetections = tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses;
    const originalEvaluateDetection = highCapDumpAlert.evaluateDetection;
    const listedAddresses = [];
    const evaluatedAddresses = [];

    tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses = async (addresses) => {
      listedAddresses.push(addresses);
      return [
        { tokenAddress: 'A', baselineMcap: 8000000, currentTs: '2026-04-05T18:05:00.000Z', currentCloseMcap: 4200000, windowLowMcap: 3200000, bucketCount: 5, latestBucketAgeMs: 12000, dumpPct: -60 },
        { tokenAddress: 'B', baselineMcap: 7000000, currentTs: '2026-04-05T18:05:00.000Z', currentCloseMcap: 6100000, windowLowMcap: 6000000, bucketCount: 5, latestBucketAgeMs: 12000, dumpPct: -14.29 },
      ];
    };
    highCapDumpAlert.evaluateDetection = async (detection) => {
      evaluatedAddresses.push(detection.tokenAddress);
      return {
        action: detection.tokenAddress === 'A' ? 'triggered' : 'suppressed',
        emitted: detection.tokenAddress === 'A',
        rearmed: false,
      };
    };

    try {
      const summary = await catalogWorker.__private.processHighCapDumpAlertsForAddresses(['A', 'B', 'A'], {
        now: new Date('2026-04-05T18:05:10.000Z'),
      });

      assert.deepEqual(listedAddresses, [['A', 'B']]);
      assert.deepEqual(evaluatedAddresses.sort(), ['A', 'B']);
      assert.deepEqual(summary, {
        evaluated: 2,
        emitted: 1,
        rearmed: 0,
        suppressed: 1,
        errors: 0,
      });
    } finally {
      tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses = originalListDetections;
      highCapDumpAlert.evaluateDetection = originalEvaluateDetection;
    }
  });

  it('keeps the batch alive when one high-cap dump evaluation fails', async () => {
    const originalListDetections = tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses;
    const originalEvaluateDetection = highCapDumpAlert.evaluateDetection;

    tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses = async () => ([
      { tokenAddress: 'A', baselineMcap: 8000000, currentTs: '2026-04-05T18:05:00.000Z', currentCloseMcap: 4200000, windowLowMcap: 3200000, bucketCount: 5, latestBucketAgeMs: 12000, dumpPct: -60 },
      { tokenAddress: 'B', baselineMcap: 7000000, currentTs: '2026-04-05T18:05:00.000Z', currentCloseMcap: 3500000, windowLowMcap: 3000000, bucketCount: 5, latestBucketAgeMs: 12000, dumpPct: -50 },
    ]);
    highCapDumpAlert.evaluateDetection = async (detection) => {
      if (detection.tokenAddress === 'A') {
        throw new Error('boom');
      }
      return { action: 'retriggered', emitted: true, rearmed: true };
    };

    try {
      const summary = await catalogWorker.__private.processHighCapDumpAlertsForAddresses(['A', 'B'], {
        now: new Date('2026-04-05T18:05:10.000Z'),
      });

      assert.deepEqual(summary, {
        evaluated: 2,
        emitted: 1,
        rearmed: 1,
        suppressed: 0,
        errors: 1,
      });
    } finally {
      tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses = originalListDetections;
      highCapDumpAlert.evaluateDetection = originalEvaluateDetection;
    }
  });

  it('evaluates per-user matcher only after persisting the updated token and market snapshots', async () => {
    const originalGetBestPair = dexscreener.getBestPair;
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const originalUpsertMarketBucket = tokenMarketBucket1m.upsertSnapshotBucket;
    const originalUpsertVolumeBucket = tokenMarketVolumeBucket1m.upsertSnapshotBucket;
    const originalEvaluateUpdatedToken = userAlertMatcher.evaluateUpdatedToken;
    const callOrder = [];
    const tokenBefore = {
      address: 'So11111111111111111111111111111111111111112',
      chain: 'solana',
      source: 'dexscreener-discovery',
      last_mcap: 250000,
      last_vol_5m: 10000,
      eligible_for_monitoring: true,
      monitor_priority: 'high',
    };
    const updatedToken = {
      ...tokenBefore,
      symbol: 'WSOL',
      name: 'Wrapped SOL',
      last_pair_address: 'pair-1',
      last_vol_5m: 18000,
      last_vol_1h: 50000,
      last_vol_6h: 120000,
      last_vol_24h: 350000,
      last_mcap: 300000,
      last_token_created_at_ms: Date.UTC(2026, 3, 16, 10, 0, 0),
    };

    dexscreener.getBestPair = () => ({
      marketCap: 300000,
      pairAddress: 'pair-1',
      priceUsd: '0.42',
      url: 'https://dex.example/pair-1',
      baseToken: { symbol: 'WSOL', name: 'Wrapped SOL' },
      info: {
        imageUrl: 'https://img.example/wsol.png',
        socials: [{ type: 'twitter', url: 'https://x.com/wsol' }],
      },
      volume: { m5: 18000, h1: 50000, h6: 120000, h24: 350000 },
      priceChange: { h1: 15, h6: 50, h24: 90 },
      liquidity: { usd: 100000 },
      txns: { h1: { buys: 20, sells: 10 }, h24: { buys: 200, sells: 120 } },
      pairCreatedAt: Date.UTC(2026, 3, 16, 10, 0, 0),
    });
    tokenCatalog.applyEvaluationResult = async (_address, payload) => {
      callOrder.push('applyEvaluationResult');
      assert.equal(payload.vol5m, 18000);
      return updatedToken;
    };
    tokenMarketBucket1m.upsertSnapshotBucket = async (payload) => {
      callOrder.push('marketBucket');
      assert.equal(payload.tokenAddress, tokenBefore.address);
      assert.equal(payload.vol5m, 18000);
      return payload;
    };
    tokenMarketVolumeBucket1m.upsertSnapshotBucket = async (payload) => {
      callOrder.push('volumeBucket');
      assert.equal(payload.tokenAddress, tokenBefore.address);
      assert.equal(payload.vol24h, 350000);
      return payload;
    };
    userAlertMatcher.evaluateUpdatedToken = async (payload) => {
      callOrder.push('matcher');
      assert.equal(payload.tokenBefore, tokenBefore);
      assert.equal(payload.tokenAfter, updatedToken);
      return { emitted: 1 };
    };

    try {
      const result = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, { pairs: [{}] });

      assert.equal(result, updatedToken);
      assert.deepEqual(callOrder, [
        'applyEvaluationResult',
        'marketBucket',
        'volumeBucket',
        'matcher',
      ]);
    } finally {
      dexscreener.getBestPair = originalGetBestPair;
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      tokenMarketBucket1m.upsertSnapshotBucket = originalUpsertMarketBucket;
      tokenMarketVolumeBucket1m.upsertSnapshotBucket = originalUpsertVolumeBucket;
      userAlertMatcher.evaluateUpdatedToken = originalEvaluateUpdatedToken;
    }
  });
});
