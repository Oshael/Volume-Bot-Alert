const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const catalogWorker = require('../src/services/catalog-worker');
const tokenCatalog = require('../src/models/token-catalog');
const tokenAlertRuleState = require('../src/models/token-alert-rule-state');
const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../src/models/token-market-volume-bucket-1m');
const adminBlockedToken = require('../src/models/admin-blocked-token');
const dexscreener = require('../src/services/dexscreener');
const highCapDumpAlert = require('../src/services/high-cap-dump-alert');
const userAlertMatcher = require('../src/services/user-alert-matcher');

const TOKEN_A = 'So11111111111111111111111111111111111111112';
const TOKEN_B = 'So11111111111111111111111111111111111111113';

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

  it('applies the 3m low-activity cooldown to dex-unavailable high and normal retries', () => {
    const highRetryMs = catalogWorker.__private.getDexUnavailableRetryMs({
      monitor_priority: 'high',
      last_mcap: 250000,
      last_vol_24h: 4500,
    }, { throttleMode: 'normal' });
    const normalRetryMs = catalogWorker.__private.getDexUnavailableRetryMs({
      monitor_priority: 'normal',
      last_mcap: 60000,
      last_vol_24h: 4800,
    }, { throttleMode: 'normal' });

    assert.equal(highRetryMs, 3 * 60 * 1000);
    assert.equal(normalRetryMs, 3 * 60 * 1000);
  });

  it('applies the 3m low-activity cooldown to rate-limited high retries', () => {
    const retryMs = catalogWorker.__private.getDexUnavailableRetryMs({
      monitor_priority: 'high',
      last_mcap: 250000,
      last_vol_24h: 1200,
    }, { throttleMode: 'recovery' });

    assert.equal(retryMs, 3 * 60 * 1000);
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

  it('keeps migrated unknown-mcap bootstrap tokens off the dormant retry path during migration grace', () => {
    const token = {
      source: 'pumpfun-migrated',
      monitor_priority: 'dormant',
      last_mcap: 0,
      migration_grace_until: new Date(Date.now() + catalogWorker.__private.MIGRATION_GRACE_FLOOR_MS).toISOString(),
    };

    assert.equal(catalogWorker.__private.isLowDustProtectedByMigrationGrace(token, 0), true);
    assert.equal(catalogWorker.__private.getThrottleTokenBucket(token), 'low-near');
    assert.equal(catalogWorker.__private.getDexPriorityHint(token), 'low-near');
    assert.equal(catalogWorker.__private.getDexUnavailableRetryMs(token), 15 * 1000);
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

  it('suppresses low-activity auto tokens from monitoring and slows migrated grace retries to 3m', () => {
    const now = Date.now();
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 9000,
      volume: { h24: 1200 },
      priceChange: {},
    }, {
      source: 'pumpfun-migrated',
      migration_grace_until: new Date(now + catalogWorker.__private.MIGRATION_GRACE_FLOOR_MS).toISOString(),
    });

    const nextMs = snapshot.nextEvaluationAt.getTime() - now;
    assert.equal(snapshot.monitorPriority, 'low');
    assert.equal(snapshot.eligibleForMonitoring, false);
    assert.equal(snapshot.suppressedReason, 'low_activity_24h');
    assert.ok(nextMs >= 3 * 60 * 1000 && nextMs <= 4 * 60 * 1000, `expected 3m low-activity cadence with jitter, got ${nextMs}ms`);
  });

  it('suppresses auto high-cap tokens below 5k volume24h and slows them to at least 3m', () => {
    const now = Date.now();
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 250000,
      volume: { h24: 4500, h6: 60000 },
      priceChange: {},
    });

    const nextMs = snapshot.nextEvaluationAt.getTime() - now;
    assert.equal(snapshot.monitorPriority, 'low');
    assert.equal(snapshot.eligibleForMonitoring, false);
    assert.equal(snapshot.eligibilityState, 'dex-low-activity');
    assert.equal(snapshot.suppressedReason, 'low_activity_24h');
    assert.ok(nextMs >= 3 * 60 * 1000 && nextMs <= 4 * 60 * 1000, `expected 3m low-activity cadence with jitter, got ${nextMs}ms`);
  });

  it('does not accelerate low-dust auto tokens that are already slower than 3m', () => {
    const now = Date.now();
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 9000,
      volume: { h24: 1000 },
      priceChange: {},
    });

    const nextMs = snapshot.nextEvaluationAt.getTime() - now;
    assert.equal(snapshot.monitorPriority, 'low');
    assert.equal(snapshot.eligibleForMonitoring, false);
    assert.equal(snapshot.suppressedReason, 'low_activity_24h');
    assert.ok(nextMs >= 10 * 60 * 1000, `expected existing low-dust cadence to remain slower than 3m, got ${nextMs}ms`);
  });

  it('keeps manual tokens eligible even when volume24h is below 5k', () => {
    const now = Date.now();
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 65000,
      volume: { h24: 4200, h6: 18000 },
      priceChange: {},
    }, {
      source: 'user-manual',
    });

    const nextMs = snapshot.nextEvaluationAt.getTime() - now;
    assert.equal(snapshot.monitorPriority, 'normal');
    assert.equal(snapshot.eligibleForMonitoring, true);
    assert.equal(snapshot.suppressedReason, null);
    assert.ok(nextMs < 3 * 60 * 1000, `expected manual token to keep normal cadence, got ${nextMs}ms`);
  });

  it('fills young Dex 6h and 24h volume windows from shorter available volume', () => {
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 140000,
      pairCreatedAt: Date.now() - (25 * 60 * 1000),
      volume: {
        m5: 58000,
        h1: 751000,
        h6: 0,
        h24: 0,
      },
      priceChange: {},
    });

    assert.equal(snapshot.vol6h, 751000);
    assert.equal(snapshot.vol24h, 751000);
    assert.equal(snapshot.monitorPriority, 'high');
    assert.equal(snapshot.eligibleForMonitoring, true);
  });

  it('treats low-activity auto tokens as low-dust for throttle and as low-activity for Dex cache TTL', () => {
    const token = {
      source: 'dexscreener-discovery',
      monitor_priority: 'high',
      last_mcap: 180000,
      last_vol_24h: 4200,
      last_vol_6h: 80000,
    };

    assert.equal(catalogWorker.__private.getThrottleTokenBucket(token), 'low-dust');
    assert.equal(catalogWorker.__private.getDexPriorityHint(token), 'low-activity');
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
    const originalGetState = tokenAlertRuleState.getState;
    const originalListDetections = tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses;
    const originalEvaluateDetection = highCapDumpAlert.evaluateDetection;
    const listedAddresses = [];
    const queryOptions = [];
    const evaluatedAddresses = [];

    tokenAlertRuleState.getState = async (_ruleKey, tokenAddress) => ({
      metadata: {
        pinnedPairAddress: tokenAddress === TOKEN_A ? 'pair-a' : null,
      },
    });
    tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses = async (addresses, options) => {
      listedAddresses.push(addresses);
      queryOptions.push(options);
      return [
        { tokenAddress: TOKEN_A, baselineMcap: 8000000, currentTs: '2026-04-05T18:05:00.000Z', currentCloseMcap: 4200000, windowLowMcap: 3200000, bucketCount: 5, latestBucketAgeMs: 12000, dumpPct: -60 },
        { tokenAddress: TOKEN_B, baselineMcap: 7000000, currentTs: '2026-04-05T18:05:00.000Z', currentCloseMcap: 6100000, windowLowMcap: 6000000, bucketCount: 5, latestBucketAgeMs: 12000, dumpPct: -14.29 },
      ];
    };
    highCapDumpAlert.evaluateDetection = async (detection) => {
      evaluatedAddresses.push(detection.tokenAddress);
      return {
        action: detection.tokenAddress === TOKEN_A ? 'triggered' : 'suppressed',
        emitted: detection.tokenAddress === TOKEN_A,
        rearmed: false,
      };
    };

    try {
      const summary = await catalogWorker.__private.processHighCapDumpAlertsForAddresses([TOKEN_A, TOKEN_B, TOKEN_A], {
        now: new Date('2026-04-05T18:05:10.000Z'),
      });

      assert.deepEqual(listedAddresses, [[TOKEN_A, TOKEN_B]]);
      assert.deepEqual(queryOptions, [{
        referenceTs: new Date('2026-04-05T18:05:10.000Z'),
        pinnedPairByAddress: {
          [TOKEN_A]: 'pair-a',
          [TOKEN_B]: null,
        },
      }]);
      assert.deepEqual(evaluatedAddresses.sort(), [TOKEN_A, TOKEN_B]);
      assert.deepEqual(summary, {
        evaluated: 2,
        emitted: 1,
        rearmed: 0,
        suppressed: 1,
        errors: 0,
      });
    } finally {
      tokenAlertRuleState.getState = originalGetState;
      tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses = originalListDetections;
      highCapDumpAlert.evaluateDetection = originalEvaluateDetection;
    }
  });

  it('keeps the batch alive when one high-cap dump evaluation fails', async () => {
    const originalGetState = tokenAlertRuleState.getState;
    const originalListDetections = tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses;
    const originalEvaluateDetection = highCapDumpAlert.evaluateDetection;

    tokenAlertRuleState.getState = async () => null;
    tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses = async () => ([
      { tokenAddress: TOKEN_A, baselineMcap: 8000000, currentTs: '2026-04-05T18:05:00.000Z', currentCloseMcap: 4200000, windowLowMcap: 3200000, bucketCount: 5, latestBucketAgeMs: 12000, dumpPct: -60 },
      { tokenAddress: TOKEN_B, baselineMcap: 7000000, currentTs: '2026-04-05T18:05:00.000Z', currentCloseMcap: 3500000, windowLowMcap: 3000000, bucketCount: 5, latestBucketAgeMs: 12000, dumpPct: -50 },
    ]);
    highCapDumpAlert.evaluateDetection = async (detection) => {
      if (detection.tokenAddress === TOKEN_A) {
        throw new Error('boom');
      }
      return { action: 'retriggered', emitted: true, rearmed: true };
    };

    try {
      const summary = await catalogWorker.__private.processHighCapDumpAlertsForAddresses([TOKEN_A, TOKEN_B], {
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
      tokenAlertRuleState.getState = originalGetState;
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

  it('suppresses the first young extreme churn alert and auto-blocks on confirmation', async () => {
    const originalGetBestPair = dexscreener.getBestPair;
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const originalUpsertMarketBucket = tokenMarketBucket1m.upsertSnapshotBucket;
    const originalUpsertVolumeBucket = tokenMarketVolumeBucket1m.upsertSnapshotBucket;
    const originalGetInitialBucket = tokenMarketBucket1m.getInitialBucketByAddress;
    const originalAdminBlockAdd = adminBlockedToken.add;
    const originalEvaluateUpdatedToken = userAlertMatcher.evaluateUpdatedToken;
    const tokenBefore = {
      address: TOKEN_A,
      chain: 'solana',
      source: 'dexscreener-discovery',
      last_mcap: 25000,
      last_vol_5m: 0,
      eligible_for_monitoring: true,
      monitor_priority: 'normal',
    };
    const updatedToken = {
      ...tokenBefore,
      symbol: 'ROAF',
      name: 'Russian Oil Asset Fund',
      last_pair_address: 'pair-1',
      last_vol_5m: 120000,
      last_mcap: 33000,
      last_token_created_at_ms: Date.now() - (3 * 60 * 1000),
    };
    const blockedToken = {
      ...updatedToken,
      source: 'admin-blocked',
      eligible_for_monitoring: false,
      eligibility_state: 'admin-blocked',
      suppressed_reason: 'admin_blocked',
    };
    const labels = [];
    let applyCalls = 0;

    catalogWorker.__private.clearYoungExtremeChurnState(tokenBefore.address);
    dexscreener.getBestPair = () => ({
      marketCap: 33000,
      pairAddress: 'pair-1',
      priceUsd: '0.0001',
      url: 'https://dex.example/pair-1',
      dexId: 'meteora',
      baseToken: { symbol: 'ROAF', name: 'Russian Oil Asset Fund' },
      volume: { m5: 120000, h1: 130000, h6: 130000, h24: 130000 },
      priceChange: { h1: 15, h6: 15, h24: 15 },
      liquidity: { usd: 50000 },
      txns: { h1: { buys: 20, sells: 10 }, h24: { buys: 200, sells: 120 } },
      pairCreatedAt: Date.now() - (3 * 60 * 1000),
    });
    tokenCatalog.applyEvaluationResult = async (_address, payload) => {
      applyCalls += 1;
      if (applyCalls <= 2) {
        assert.equal(payload.vol5m, 120000);
        return updatedToken;
      }

      assert.equal(payload.eligibilityState, 'admin-blocked');
      assert.equal(payload.suppressedReason, 'admin_blocked');
      return blockedToken;
    };
    tokenMarketBucket1m.upsertSnapshotBucket = async (payload) => payload;
    tokenMarketVolumeBucket1m.upsertSnapshotBucket = async (payload) => payload;
    tokenMarketBucket1m.getInitialBucketByAddress = async () => ({
      openMcap: 33000,
      closeMcap: 33000,
    });
    adminBlockedToken.add = async (payload) => {
      labels.push(payload.label);
      return payload;
    };
    userAlertMatcher.evaluateUpdatedToken = async () => {
      throw new Error('matcher should not run for young extreme churn auto-blocks');
    };

    try {
      const firstResult = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, { pairs: [{}] });
      const secondResult = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, { pairs: [{}] });

      assert.equal(firstResult, updatedToken);
      assert.equal(secondResult, blockedToken);
      assert.equal(applyCalls, 3);
      assert.equal(labels.length, 1);
      assert.match(labels[0], /^catalog-volume:young-extreme-churn:33000:33000:120000:3\.6x$/);
    } finally {
      catalogWorker.__private.clearYoungExtremeChurnState(tokenBefore.address);
      dexscreener.getBestPair = originalGetBestPair;
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      tokenMarketBucket1m.upsertSnapshotBucket = originalUpsertMarketBucket;
      tokenMarketVolumeBucket1m.upsertSnapshotBucket = originalUpsertVolumeBucket;
      tokenMarketBucket1m.getInitialBucketByAddress = originalGetInitialBucket;
      adminBlockedToken.add = originalAdminBlockAdd;
      userAlertMatcher.evaluateUpdatedToken = originalEvaluateUpdatedToken;
    }
  });

  it('does not apply the young extreme churn block to pump-like pairs', () => {
    const assessment = catalogWorker.__private.assessYoungExtremeChurn(
      { source: 'dexscreener-discovery' },
      { dexId: 'pumpfun', pairCreatedAt: Date.now() - 60000 },
      { marketCap: 33000, vol5m: 120000 },
      { openMcap: 33000 }
    );

    assert.equal(assessment.shouldBlock, false);
    assert.equal(assessment.reason, 'trusted-source');
  });
});
