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

function stubLiveManualAddress(value = true) {
  const originalHasUserManualAddress = tokenCatalog.hasUserManualAddress;
  const originalDemoteFormerManualAddress = tokenCatalog.demoteFormerManualAddress;
  tokenCatalog.hasUserManualAddress = async () => value;
  tokenCatalog.demoteFormerManualAddress = async () => null;
  catalogWorker.__private.clearManualGmgnCachesForTest();
  return () => {
    tokenCatalog.hasUserManualAddress = originalHasUserManualAddress;
    tokenCatalog.demoteFormerManualAddress = originalDemoteFormerManualAddress;
    catalogWorker.__private.clearManualGmgnCachesForTest();
  };
}

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

  it('keeps already monitored tokens eligible when evaluation fails transiently', () => {
    const nowMs = Date.parse('2026-05-24T17:52:00Z');
    const result = catalogWorker.__private.buildEvaluationErrorResult({
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      evaluation_error_count: 2,
    }, new Error('dex timeout'), nowMs);

    assert.equal(result.eligibilityState, 'evaluation-error');
    assert.equal(result.eligibleForMonitoring, true);
    assert.equal(result.suppressedReason, null);
    assert.equal(result.monitorPriority, 'high');
    assert.equal(result.lastEvaluationError, 'dex timeout');
    assert.equal(result.evaluationErrorCount, 3);
    assert.ok(result.nextEvaluationAt instanceof Date);
    assert.ok(result.nextEvaluationAt.getTime() > nowMs);
  });

  it('keeps non-monitored tokens suppressed when evaluation fails before eligibility', () => {
    const nowMs = Date.parse('2026-05-24T17:52:00Z');
    const result = catalogWorker.__private.buildEvaluationErrorResult({
      eligible_for_monitoring: false,
      evaluation_error_count: 0,
    }, new Error('bad response'), nowMs);

    assert.equal(result.eligibilityState, 'evaluation-error');
    assert.equal(result.eligibleForMonitoring, false);
    assert.equal(result.suppressedReason, 'evaluation_error');
    assert.equal(result.monitorPriority, 'dormant');
    assert.equal(result.lastEvaluationError, 'bad response');
    assert.equal(result.evaluationErrorCount, 1);
    assert.ok(result.nextEvaluationAt instanceof Date);
    assert.ok(result.nextEvaluationAt.getTime() > nowMs);
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

  it('identifies stale GMGN dex-unavailable zombies without catching manual or transient rows', () => {
    assert.equal(catalogWorker.__private.isGmgnDexUnavailableZombie({
      source: 'gmgn',
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      last_mcap: 122550,
      last_vol_5m: 0,
      suppressed_reason: 'dex_unavailable',
      last_evaluation_error: 'dex_unavailable',
      evaluation_error_count: 30,
    }), true);

    assert.equal(catalogWorker.__private.isGmgnDexUnavailableZombie({
      source: 'user-manual',
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      last_mcap: 122550,
      last_vol_5m: 0,
      suppressed_reason: 'dex_unavailable',
      last_evaluation_error: 'dex_unavailable',
      evaluation_error_count: 30,
    }), false);

    assert.equal(catalogWorker.__private.isGmgnDexUnavailableZombie({
      source: 'gmgn',
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      last_mcap: 122550,
      last_vol_5m: 0,
      suppressed_reason: 'dex_unavailable',
      last_evaluation_error: 'dex_unavailable',
      evaluation_error_count: 29,
    }), false);

    assert.equal(catalogWorker.__private.isGmgnDexUnavailableZombie({
      source: 'gmgn',
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      last_mcap: 122550,
      last_vol_5m: 7500,
      suppressed_reason: 'dex_unavailable',
      last_evaluation_error: 'dex_unavailable',
      evaluation_error_count: 30,
    }), false);

    assert.equal(catalogWorker.__private.isGmgnDexUnavailableZombie({
      source: 'gmgn',
      eligible_for_monitoring: false,
      monitor_priority: 'low',
      last_mcap: 4398,
      last_vol_5m: 0,
      suppressed_reason: 'dex_unavailable',
      last_evaluation_error: 'dex_unavailable',
      evaluation_error_count: 30,
    }), true);

    assert.equal(catalogWorker.__private.isGmgnDexUnavailableZombie({
      source: 'dexscreener-discovery',
      eligible_for_monitoring: false,
      monitor_priority: 'low',
      last_mcap: 91929,
      last_vol_5m: 0,
      suppressed_reason: 'dex_unavailable',
      last_evaluation_error: 'dex_unavailable',
      evaluation_error_count: 30,
    }), true);

    for (const suffix of ['pump', 'bonk', 'brrr', 'bags']) {
      assert.equal(catalogWorker.__private.isGmgnDexUnavailableZombie({
        address: `2gXeM4einZoLMSQ5K7s6rHzCAeksU2hRFouBpqSo${suffix}`,
        source: 'gmgn',
        eligible_for_monitoring: false,
        monitor_priority: 'low',
        last_mcap: 91929,
        last_vol_5m: 0,
        suppressed_reason: 'dex_unavailable',
        last_evaluation_error: 'dex_unavailable',
        evaluation_error_count: 30,
      }), false);
    }
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

  it('suppresses auto high-cap tokens below 5k coherent volume24h and slows them to at least 3m', () => {
    const now = Date.now();
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 250000,
      volume: { h24: 4500, h6: 3200, h1: 900 },
      priceChange: {},
    });

    const nextMs = snapshot.nextEvaluationAt.getTime() - now;
    assert.equal(snapshot.monitorPriority, 'low');
    assert.equal(snapshot.eligibleForMonitoring, false);
    assert.equal(snapshot.eligibilityState, 'dex-low-activity');
    assert.equal(snapshot.suppressedReason, 'low_activity_24h');
    assert.ok(nextMs >= 3 * 60 * 1000 && nextMs <= 4 * 60 * 1000, `expected 3m low-activity cadence with jitter, got ${nextMs}ms`);
  });

  it('does not suppress active auto tokens when volume24h is lower than shorter windows', () => {
    const now = Date.now();
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 250000,
      volume: { h24: 4500, h6: 60000, h1: 12000 },
      priceChange: {},
    });

    const nextMs = snapshot.nextEvaluationAt.getTime() - now;
    assert.equal(snapshot.monitorPriority, 'high');
    assert.equal(snapshot.eligibleForMonitoring, true);
    assert.equal(snapshot.eligibilityState, 'dex-high');
    assert.equal(snapshot.suppressedReason, null);
    assert.equal(snapshot.vol24h, 60000);
    assert.ok(nextMs < 3 * 60 * 1000, `expected active high-cap cadence without low-activity cooldown, got ${nextMs}ms`);
  });

  it('preserves stronger existing cumulative volume windows when Dex reports incoherent lower windows', () => {
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 250000,
      volume: { h24: 1200, h6: 1200, h1: 64000 },
      priceChange: {},
    }, {
      source: 'gmgn',
      last_vol_6h: 360000,
      last_vol_24h: 1760000,
    });

    assert.equal(snapshot.vol6h, 360000);
    assert.equal(snapshot.vol24h, 1760000);
    assert.equal(snapshot.monitorPriority, 'high');
    assert.equal(snapshot.eligibleForMonitoring, true);
    assert.equal(snapshot.suppressedReason, null);
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

  it('keeps low-mcap manual tokens on fast Dex cadence', () => {
    const now = Date.now();
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 9000,
      volume: { h24: 1000 },
      priceChange: {},
    }, {
      source: 'user-manual',
    });

    const nextMs = snapshot.nextEvaluationAt.getTime() - now;
    assert.equal(snapshot.monitorPriority, 'low');
    assert.equal(snapshot.eligibleForMonitoring, true);
    assert.equal(snapshot.suppressedReason, null);
    assert.ok(nextMs >= 15 * 1000 && nextMs < 20 * 1000, `expected fast manual low-mcap cadence, got ${nextMs}ms`);
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

  it('normalizes missing Dex volume windows to zero so stale volume is cleared', () => {
    const snapshot = catalogWorker.__private.derivePrioritySnapshot({
      marketCap: 140000,
      volume: {},
      priceChange: {},
    });

    assert.equal(snapshot.vol5m, 0);
    assert.equal(snapshot.vol1h, 0);
    assert.equal(snapshot.vol6h, 0);
    assert.equal(snapshot.vol24h, 0);
  });

  it('treats low-activity auto tokens as low-dust for throttle and as low-activity for Dex cache TTL', () => {
    const token = {
      source: 'dexscreener-discovery',
      monitor_priority: 'high',
      last_mcap: 180000,
      last_vol_24h: 4200,
      last_vol_6h: 3200,
      last_vol_1h: 900,
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

  it('auto-blocks non-launch-suffix tokens under 48h when Dex liquidity is at or below 1k', async () => {
    const originalGetBestPair = dexscreener.getBestPair;
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const originalUpsertMarketBucket = tokenMarketBucket1m.upsertSnapshotBucket;
    const originalUpsertVolumeBucket = tokenMarketVolumeBucket1m.upsertSnapshotBucket;
    const originalAdminBlockAdd = adminBlockedToken.add;
    const originalEvaluateUpdatedToken = userAlertMatcher.evaluateUpdatedToken;
    const callOrder = [];
    const createdAtMs = Date.now() - (25 * 60 * 60 * 1000);
    const tokenBefore = {
      address: TOKEN_A,
      chain: 'solana',
      source: 'gmgn',
      risk_review_label: 'valid',
      risk_review_source: 'auto',
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      last_mcap: 107480,
    };
    const updatedToken = {
      ...tokenBefore,
      symbol: 'LOWLIQ',
      name: 'Low Liquidity',
      last_mcap: 107480,
      last_liquidity_usd: 1000,
      last_token_created_at_ms: createdAtMs,
    };
    const blockedToken = {
      ...updatedToken,
      eligibility_state: 'admin-blocked',
      eligible_for_monitoring: false,
      suppressed_reason: 'admin_blocked',
    };

    dexscreener.getBestPair = () => ({
      marketCap: 107480,
      pairAddress: 'pair-low-liq',
      priceUsd: '0.0001',
      url: 'https://dexscreener.com/solana/pair-low-liq',
      baseToken: { symbol: 'LOWLIQ', name: 'Low Liquidity' },
      volume: { m5: 100, h1: 5000, h6: 5000, h24: 5000 },
      priceChange: {},
      liquidity: { usd: 1000 },
      pairCreatedAt: createdAtMs,
    });
    tokenCatalog.applyEvaluationResult = async (_address, payload) => {
      if (payload.eligibilityState === 'admin-blocked') {
        callOrder.push('blockCatalog');
        assert.equal(payload.lastEvaluationError, null);
        assert.equal(payload.evaluationErrorCount, 0);
        return blockedToken;
      }
      callOrder.push('applyEvaluationResult');
      assert.equal(payload.liquidityUsd, 1000);
      return updatedToken;
    };
    tokenMarketBucket1m.upsertSnapshotBucket = async (payload) => {
      callOrder.push('marketBucket');
      assert.equal(payload.tokenAddress, tokenBefore.address);
      return payload;
    };
    tokenMarketVolumeBucket1m.upsertSnapshotBucket = async (payload) => {
      callOrder.push('volumeBucket');
      assert.equal(payload.tokenAddress, tokenBefore.address);
      return payload;
    };
    adminBlockedToken.add = async (payload) => {
      callOrder.push('adminBlock');
      assert.equal(payload.address, tokenBefore.address);
      assert.equal(payload.label, 'catalog-liquidity:under-1k-48h:1000:107480');
      assert.equal(payload.allowAutoValidOverride, true);
      assert.equal(payload.evidence.pipeline, 'catalog-worker:young-low-liquidity');
      assert.equal(payload.evidence.marketSnapshot.liquidityUsd, 1000);
      assert.equal(payload.evidence.catalogSnapshot.riskReviewLabel, 'valid');
      assert.equal(payload.evidence.catalogSnapshot.riskReviewSource, 'auto');
      return payload;
    };
    userAlertMatcher.evaluateUpdatedToken = async () => {
      throw new Error('matcher should not run for young low-liquidity auto-blocks');
    };

    try {
      const result = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, { pairs: [{}] });

      assert.equal(result, blockedToken);
      assert.deepEqual(callOrder, [
        'applyEvaluationResult',
        'marketBucket',
        'volumeBucket',
        'adminBlock',
        'blockCatalog',
      ]);
    } finally {
      dexscreener.getBestPair = originalGetBestPair;
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      tokenMarketBucket1m.upsertSnapshotBucket = originalUpsertMarketBucket;
      tokenMarketVolumeBucket1m.upsertSnapshotBucket = originalUpsertVolumeBucket;
      adminBlockedToken.add = originalAdminBlockAdd;
      userAlertMatcher.evaluateUpdatedToken = originalEvaluateUpdatedToken;
    }
  });

  it('exempts pump, bags, and bonk suffixes from the young low-liquidity block', () => {
    const baseToken = {
      source: 'gmgn',
      last_token_created_at_ms: Date.now() - (2 * 60 * 60 * 1000),
    };
    const pair = {
      liquidity: { usd: 200 },
      marketCap: 50000,
    };

    for (const suffix of ['pump', 'bags', 'bonk']) {
      const assessment = catalogWorker.__private.assessYoungLowLiquidity(
        { ...baseToken, address: `2gXeM4einZoLMSQ5K7s6rHzCAeksU2hRFouBpqSo${suffix}` },
        pair,
        { liquidityUsd: 200, marketCap: 50000 }
      );
      assert.equal(assessment.shouldBlock, false);
      assert.equal(assessment.reason, 'launch-suffix');
    }

    const nonExemptAssessment = catalogWorker.__private.assessYoungLowLiquidity(
      { ...baseToken, address: '2gXeM4einZoLMSQ5K7s6rHzCAeksU2hRFouBpqSo1111' },
      pair,
      { liquidityUsd: 200, marketCap: 50000 }
    );
    assert.equal(nonExemptAssessment.shouldBlock, true);
  });

  it('uses GMGN token info before Dex for manual pre-migration launchpad tokens', async () => {
    const originalGetBestPair = dexscreener.getBestPair;
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const originalUpsertMarketBucket = tokenMarketBucket1m.upsertSnapshotBucket;
    const originalUpsertVolumeBucket = tokenMarketVolumeBucket1m.upsertSnapshotBucket;
    const restoreLiveManual = stubLiveManualAddress(true);
    const writes = [];
    const tokenBefore = {
      address: TOKEN_B,
      chain: 'solana',
      source: 'user-manual',
      eligibility_state: 'pending',
      eligible_for_monitoring: false,
      monitor_priority: 'dormant',
    };
    const updatedToken = {
      ...tokenBefore,
      symbol: 'STAR',
      last_mcap: 6615.91,
      last_vol_5m: 4363.13,
      eligible_for_monitoring: true,
    };

    dexscreener.getBestPair = () => {
      throw new Error('Dex should not be used while GMGN reports pre-migration launchpad state');
    };
    catalogWorker.__private.setDefaultGmgnClientForTest({
      fetchTokenInfo: async (request) => {
        assert.equal(request.address, TOKEN_B);
        assert.equal(request.skipCache, true);
        return {
          address: TOKEN_B,
          symbol: 'STAR',
          name: 'Starships',
          pairAddress: 'AAYLLw7gW2GYs8kUx5MrCuhntW9otZH8Lnbvp7gka1gV',
          pairUrl: `https://gmgn.ai/sol/token/${TOKEN_B}`,
          imageUrl: 'https://gmgn.ai/star.webp',
          launchpad: 'pump',
          launchpadPlatform: 'Pump.fun',
          launchpadStatus: 0,
          launchpadProgress: 0.5294,
          marketCap: 6615.91,
          price: 0.00000661591,
          vol1m: 1015.61,
          vol5m: 4363.13,
          vol1h: 51278.17,
          vol6h: 51278.17,
          vol24h: 51278.17,
          liquidityUsd: 8643.03,
          tokenCreatedAt: '2026-05-22T22:57:18.000Z',
        };
      },
    });
    tokenCatalog.applyEvaluationResult = async (address, payload) => {
      writes.push(['catalog', payload]);
      const nextDelayMs = payload.nextEvaluationAt.getTime() - Date.now();
      assert.equal(address, TOKEN_B);
      assert.equal(payload.evaluationSource, 'gmgn');
      assert.equal(payload.eligibilityState, 'gmgn-low');
      assert.equal(payload.eligibleForMonitoring, true);
      assert.equal(payload.monitorPriority, 'low');
      assert.equal(payload.symbol, 'STAR');
      assert.equal(payload.mcap, 6615.91);
      assert.equal(payload.vol5m, 4363.13);
      assert.equal(payload.liquidityUsd, 8643.03);
      assert.ok(payload.nextEvaluationAt instanceof Date);
      assert.ok(nextDelayMs > 0 && nextDelayMs <= 5000);
      return updatedToken;
    };
    tokenMarketBucket1m.upsertSnapshotBucket = async (payload) => {
      writes.push(['market', payload]);
      assert.equal(payload.tokenAddress, TOKEN_B);
      assert.equal(payload.mcap, 6615.91);
      assert.equal(payload.price, 0.00000661591);
      assert.equal(payload.source, 'gmgn');
      return payload;
    };
    tokenMarketVolumeBucket1m.upsertSnapshotBucket = async (payload) => {
      writes.push(['volume', payload]);
      assert.equal(payload.tokenAddress, TOKEN_B);
      assert.equal(payload.vol1m, 1015.61);
      assert.equal(payload.vol5m, 4363.13);
      assert.equal(payload.vol24h, 51278.17);
      assert.equal(payload.source, 'gmgn');
      return payload;
    };

    try {
      const result = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, { pairs: [{}] });

      assert.equal(result, updatedToken);
      assert.deepEqual(writes.map(([kind]) => kind), ['catalog', 'market', 'volume']);
    } finally {
      dexscreener.getBestPair = originalGetBestPair;
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      tokenMarketBucket1m.upsertSnapshotBucket = originalUpsertMarketBucket;
      tokenMarketVolumeBucket1m.upsertSnapshotBucket = originalUpsertVolumeBucket;
      catalogWorker.__private.setDefaultGmgnClientForTest(null);
      restoreLiveManual();
    }
  });

  it('lets Dex take over manual launchpad tokens after GMGN reports migration', async () => {
    const originalGetBestPair = dexscreener.getBestPair;
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const originalUpsertMarketBucket = tokenMarketBucket1m.upsertSnapshotBucket;
    const originalUpsertVolumeBucket = tokenMarketVolumeBucket1m.upsertSnapshotBucket;
    const restoreLiveManual = stubLiveManualAddress(true);
    const tokenBefore = {
      address: TOKEN_B,
      chain: 'solana',
      source: 'user-manual',
      eligibility_state: 'gmgn-low',
      eligible_for_monitoring: true,
      monitor_priority: 'normal',
    };
    const updatedToken = {
      ...tokenBefore,
      last_mcap: 150000,
      last_vol_5m: 12000,
    };
    let dexUsed = false;

    catalogWorker.__private.setDefaultGmgnClientForTest({
      fetchTokenInfo: async (request) => {
        assert.equal(request.address, TOKEN_B);
        assert.equal(request.skipCache, true);
        return {
          address: TOKEN_B,
          launchpad: 'pump',
          launchpadPlatform: 'Pump.fun',
          migratedTimestamp: '2026-05-23T00:00:00.000Z',
          migratedPool: 'pool-migrated',
          marketCap: 6400,
        };
      },
    });
    dexscreener.getBestPair = () => {
      dexUsed = true;
      return {
        marketCap: 150000,
        priceUsd: '0.00015',
        pairAddress: 'pair-1',
        url: 'https://dexscreener.com/solana/pair-1',
        baseToken: { symbol: 'STAR', name: 'Starships' },
        volume: { m5: 12000, h1: 25000, h6: 50000, h24: 75000 },
        priceChange: {},
        liquidity: { usd: 55000 },
      };
    };
    tokenCatalog.applyEvaluationResult = async (_address, payload) => {
      assert.equal(payload.evaluationSource, 'dexscreener');
      assert.equal(payload.mcap, 150000);
      return updatedToken;
    };
    tokenMarketBucket1m.upsertSnapshotBucket = async (payload) => payload;
    tokenMarketVolumeBucket1m.upsertSnapshotBucket = async (payload) => payload;

    try {
      const result = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, { pairs: [{}] });

      assert.equal(result, updatedToken);
      assert.equal(dexUsed, true);
    } finally {
      dexscreener.getBestPair = originalGetBestPair;
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      tokenMarketBucket1m.upsertSnapshotBucket = originalUpsertMarketBucket;
      tokenMarketVolumeBucket1m.upsertSnapshotBucket = originalUpsertVolumeBucket;
      catalogWorker.__private.setDefaultGmgnClientForTest(null);
      restoreLiveManual();
    }
  });

  it('does not call GMGN before Dex for migrated manual tokens with a Dex pair snapshot', async () => {
    const originalGetBestPair = dexscreener.getBestPair;
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const originalUpsertMarketBucket = tokenMarketBucket1m.upsertSnapshotBucket;
    const originalUpsertVolumeBucket = tokenMarketVolumeBucket1m.upsertSnapshotBucket;
    const restoreLiveManual = stubLiveManualAddress(true);
    const tokenBefore = {
      address: TOKEN_B,
      chain: 'solana',
      source: 'user-manual',
      eligibility_state: 'dex-low',
      eligible_for_monitoring: true,
      monitor_priority: 'low',
      last_mcap: 12000,
      last_pair_address: 'pair-1',
      last_pair_url: 'https://dexscreener.com/solana/pair-1',
    };
    const updatedToken = {
      ...tokenBefore,
      last_mcap: 14000,
    };

    catalogWorker.__private.setDefaultGmgnClientForTest({
      fetchTokenInfo: async () => {
        throw new Error('GMGN should not be called before Dex for a Dex-confirmed manual token');
      },
    });
    dexscreener.getBestPair = () => ({
      marketCap: 14000,
      priceUsd: '0.000014',
      pairAddress: 'pair-1',
      url: 'https://dexscreener.com/solana/pair-1',
      baseToken: { symbol: 'STAR', name: 'Starships' },
      volume: { m5: 9000, h1: 12000, h6: 12000, h24: 12000 },
      priceChange: {},
      liquidity: { usd: 8000 },
    });
    tokenCatalog.applyEvaluationResult = async (_address, payload) => {
      const nextDelayMs = payload.nextEvaluationAt.getTime() - Date.now();
      assert.equal(payload.evaluationSource, 'dexscreener');
      assert.equal(payload.eligibilityState, 'dex-low');
      assert.equal(payload.mcap, 14000);
      assert.ok(nextDelayMs >= 15 * 1000 && nextDelayMs < 20 * 1000);
      return updatedToken;
    };
    tokenMarketBucket1m.upsertSnapshotBucket = async (payload) => payload;
    tokenMarketVolumeBucket1m.upsertSnapshotBucket = async (payload) => payload;

    try {
      const result = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, { pairs: [{}] });

      assert.equal(result, updatedToken);
    } finally {
      dexscreener.getBestPair = originalGetBestPair;
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      tokenMarketBucket1m.upsertSnapshotBucket = originalUpsertMarketBucket;
      tokenMarketVolumeBucket1m.upsertSnapshotBucket = originalUpsertVolumeBucket;
      catalogWorker.__private.setDefaultGmgnClientForTest(null);
      restoreLiveManual();
    }
  });

  it('does not use GMGN for catalog rows that are no longer live manual tokens', async () => {
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const originalHasUserManualAddress = tokenCatalog.hasUserManualAddress;
    const originalDemoteFormerManualAddress = tokenCatalog.demoteFormerManualAddress;
    let demotedAddress = null;
    const tokenBefore = {
      address: TOKEN_B,
      chain: 'solana',
      source: 'user-manual',
      eligibility_state: 'pending',
      eligible_for_monitoring: false,
      monitor_priority: 'dormant',
    };
    const updatedToken = {
      ...tokenBefore,
      source: 'dexscreener-discovery',
      eligibility_state: 'dex-unavailable',
    };

    catalogWorker.__private.clearManualGmgnCachesForTest();
    tokenCatalog.hasUserManualAddress = async () => false;
    tokenCatalog.demoteFormerManualAddress = async (address) => {
      demotedAddress = address;
      return { ...tokenBefore, source: 'dexscreener-discovery' };
    };
    catalogWorker.__private.setDefaultGmgnClientForTest({
      fetchTokenInfo: async () => {
        throw new Error('stale manual catalog rows must not call GMGN token info');
      },
    });
    tokenCatalog.applyEvaluationResult = async (_address, payload) => {
      assert.equal(payload.eligibilityState, 'dex-unavailable');
      return updatedToken;
    };

    try {
      const result = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, null);

      assert.equal(result, updatedToken);
      assert.equal(demotedAddress, TOKEN_B);
    } finally {
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      tokenCatalog.hasUserManualAddress = originalHasUserManualAddress;
      tokenCatalog.demoteFormerManualAddress = originalDemoteFormerManualAddress;
      catalogWorker.__private.setDefaultGmgnClientForTest(null);
      catalogWorker.__private.clearManualGmgnCachesForTest();
    }
  });

  it('keeps using GMGN for manual launchpad tokens after migration when Dex has no pair yet', async () => {
    const originalGetBestPair = dexscreener.getBestPair;
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const originalUpsertMarketBucket = tokenMarketBucket1m.upsertSnapshotBucket;
    const originalUpsertVolumeBucket = tokenMarketVolumeBucket1m.upsertSnapshotBucket;
    const restoreLiveManual = stubLiveManualAddress(true);
    const writes = [];
    const tokenBefore = {
      address: TOKEN_B,
      chain: 'solana',
      source: 'user-manual',
      eligible_for_monitoring: true,
      monitor_priority: 'normal',
      last_mcap: 6400,
    };
    const updatedToken = {
      ...tokenBefore,
      last_mcap: 12400,
      last_vol_5m: 9200,
    };

    catalogWorker.__private.setDefaultGmgnClientForTest({
      fetchTokenInfo: async (request) => {
        assert.equal(request.address, TOKEN_B);
        assert.equal(request.skipCache, true);
        return {
          address: TOKEN_B,
          symbol: 'STAR',
          name: 'Starships',
          pairAddress: 'AAYLLw7gW2GYs8kUx5MrCuhntW9otZH8Lnbvp7gka1gV',
          pairUrl: `https://gmgn.ai/sol/token/${TOKEN_B}`,
          launchpad: 'pump',
          launchpadPlatform: 'Pump.fun',
          migratedTimestamp: '2026-05-23T00:00:00.000Z',
          migratedPool: 'pool-migrated',
          marketCap: 12400,
          price: 0.0000124,
          vol1m: 2100,
          vol5m: 9200,
          vol1h: 22000,
          vol6h: 22000,
          vol24h: 22000,
          liquidityUsd: 10400,
          tokenCreatedAt: '2026-05-23T00:00:00.000Z',
        };
      },
    });
    dexscreener.getBestPair = () => null;
    tokenCatalog.applyEvaluationResult = async (address, payload) => {
      writes.push(['catalog', payload]);
      assert.equal(address, TOKEN_B);
      assert.equal(payload.evaluationSource, 'gmgn');
      assert.equal(payload.eligibilityState, 'gmgn-low');
      assert.equal(payload.eligibleForMonitoring, true);
      assert.equal(payload.monitorPriority, 'low');
      assert.equal(payload.mcap, 12400);
      assert.equal(payload.vol5m, 9200);
      assert.equal(payload.lastEvaluationError, null);
      assert.equal(payload.evaluationErrorCount, 0);
      assert.ok(payload.nextEvaluationAt instanceof Date);
      return updatedToken;
    };
    tokenMarketBucket1m.upsertSnapshotBucket = async (payload) => {
      writes.push(['market', payload]);
      assert.equal(payload.tokenAddress, TOKEN_B);
      assert.equal(payload.source, 'gmgn');
      assert.equal(payload.mcap, 12400);
      return payload;
    };
    tokenMarketVolumeBucket1m.upsertSnapshotBucket = async (payload) => {
      writes.push(['volume', payload]);
      assert.equal(payload.tokenAddress, TOKEN_B);
      assert.equal(payload.source, 'gmgn');
      assert.equal(payload.vol5m, 9200);
      return payload;
    };

    try {
      const result = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, { pairs: [{}] });

      assert.equal(result, updatedToken);
      assert.deepEqual(writes.map(([kind]) => kind), ['catalog', 'market', 'volume']);
    } finally {
      dexscreener.getBestPair = originalGetBestPair;
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      tokenMarketBucket1m.upsertSnapshotBucket = originalUpsertMarketBucket;
      tokenMarketVolumeBucket1m.upsertSnapshotBucket = originalUpsertVolumeBucket;
      catalogWorker.__private.setDefaultGmgnClientForTest(null);
      restoreLiveManual();
    }
  });

  it('demotes persistent GMGN dex-unavailable zombies instead of preserving high priority', async () => {
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const tokenBefore = {
      address: TOKEN_A,
      chain: 'solana',
      source: 'gmgn',
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      last_mcap: 122550,
      last_vol_5m: 0,
      suppressed_reason: 'dex_unavailable',
      last_evaluation_error: 'dex_unavailable',
      evaluation_error_count: 300,
    };
    const demotedToken = { ...tokenBefore, monitor_priority: 'dormant', eligible_for_monitoring: false };
    catalogWorker.__private.setDefaultGmgnClientForTest({
      fetchTokenInfo: async () => ({
        address: tokenBefore.address,
        liquidityUsd: 2500,
        marketCap: 122550,
      }),
    });

    tokenCatalog.applyEvaluationResult = async (address, payload) => {
      assert.equal(address, tokenBefore.address);
      assert.equal(payload.eligibilityState, 'gmgn-dex-unavailable-zombie');
      assert.equal(payload.eligibleForMonitoring, false);
      assert.equal(payload.suppressedReason, 'gmgn_dex_unavailable_zombie');
      assert.equal(payload.monitorPriority, 'dormant');
      assert.equal(payload.lastEvaluationError, 'dex_unavailable');
      assert.equal(payload.evaluationErrorCount, 301);
      assert.ok(payload.nextEvaluationAt instanceof Date);
      return demotedToken;
    };

    try {
      const result = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, null);

      assert.equal(result, demotedToken);
    } finally {
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      catalogWorker.__private.setDefaultGmgnClientForTest(null);
    }
  });

  it('admin-blocks persistent GMGN dex-unavailable zombies when fresh GMGN liquidity is under 1k', async () => {
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const originalAdminBlockAdd = adminBlockedToken.add;
    const blockWrites = [];
    const tokenBefore = {
      address: TOKEN_A,
      chain: 'solana',
      source: 'gmgn',
      symbol: 'BRUCE',
      name: 'Bruce',
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      last_mcap: 122550,
      last_vol_5m: 0,
      suppressed_reason: 'dex_unavailable',
      last_evaluation_error: 'dex_unavailable',
      evaluation_error_count: 300,
    };
    const blockedToken = { ...tokenBefore, monitor_priority: 'dormant', eligible_for_monitoring: false };

    catalogWorker.__private.setDefaultGmgnClientForTest({
      fetchTokenInfo: async (request) => {
        assert.equal(request.address, tokenBefore.address);
        return {
          address: tokenBefore.address,
          symbol: 'BRUCE',
          name: 'Bruce',
          liquidityUsd: 721.2,
          marketCap: 84551,
          price: 0.00001,
        };
      },
    });
    adminBlockedToken.add = async (payload) => {
      blockWrites.push(payload);
      return payload;
    };
    tokenCatalog.applyEvaluationResult = async (address, payload) => {
      assert.equal(address, tokenBefore.address);
      assert.equal(payload.eligibilityState, 'admin-blocked');
      assert.equal(payload.eligibleForMonitoring, false);
      assert.equal(payload.suppressedReason, 'admin_blocked');
      assert.equal(payload.monitorPriority, 'dormant');
      assert.equal(payload.lastEvaluationError, null);
      assert.equal(payload.evaluationErrorCount, 0);
      assert.ok(payload.nextEvaluationAt instanceof Date);
      return blockedToken;
    };

    try {
      const result = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, null);

      assert.equal(result, blockedToken);
      assert.equal(blockWrites.length, 1);
      assert.equal(blockWrites[0].address, tokenBefore.address);
      assert.equal(blockWrites[0].label, 'gmgn-liquidity:under-1k-spam:721:84551');
      assert.equal(blockWrites[0].evidence.pipeline, 'catalog-worker:gmgn-dex-unavailable-low-liquidity');
      assert.equal(blockWrites[0].evidence.marketSnapshot.liquidityUsd, 721.2);
      assert.equal(blockWrites[0].evidence.gmgnSnapshot.info.liquidityUsd, 721.2);
    } finally {
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      adminBlockedToken.add = originalAdminBlockAdd;
      catalogWorker.__private.setDefaultGmgnClientForTest(null);
    }
  });

  it('does not admin-block GMGN dex-unavailable zombies when mcap is missing', async () => {
    const originalApplyEvaluationResult = tokenCatalog.applyEvaluationResult;
    const originalAdminBlockAdd = adminBlockedToken.add;
    const blockWrites = [];
    const tokenBefore = {
      address: TOKEN_A,
      chain: 'solana',
      source: 'gmgn',
      symbol: 'BRUCE',
      name: 'Bruce',
      eligible_for_monitoring: true,
      monitor_priority: 'high',
      last_mcap: null,
      last_vol_5m: 0,
      suppressed_reason: 'dex_unavailable',
      last_evaluation_error: 'dex_unavailable',
      evaluation_error_count: 300,
    };
    const demotedToken = { ...tokenBefore, eligibility_state: 'dex-unavailable' };

    catalogWorker.__private.setDefaultGmgnClientForTest({
      fetchTokenInfo: async (request) => {
        assert.equal(request.address, tokenBefore.address);
        return {
          address: tokenBefore.address,
          symbol: 'BRUCE',
          name: 'Bruce',
          liquidityUsd: 721.2,
          marketCap: null,
          price: 0.00001,
        };
      },
    });
    adminBlockedToken.add = async (payload) => {
      blockWrites.push(payload);
      return payload;
    };
    tokenCatalog.applyEvaluationResult = async (address, payload) => {
      assert.equal(address, tokenBefore.address);
      assert.notEqual(payload.eligibilityState, 'admin-blocked');
      return demotedToken;
    };

    try {
      const result = await catalogWorker.__private.evaluateTokenWithData(tokenBefore, null);

      assert.equal(result, demotedToken);
      assert.equal(blockWrites.length, 0);
    } finally {
      tokenCatalog.applyEvaluationResult = originalApplyEvaluationResult;
      adminBlockedToken.add = originalAdminBlockAdd;
      catalogWorker.__private.setDefaultGmgnClientForTest(null);
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
    const blockWrites = [];
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
      blockWrites.push(payload);
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
      assert.equal(blockWrites.length, 1);
      assert.match(blockWrites[0].label, /^catalog-volume:young-extreme-churn:33000:33000:120000:3\.6x$/);
      assert.equal(blockWrites[0].evidence.pipeline, 'catalog-worker:young-extreme-churn');
      assert.equal(blockWrites[0].evidence.marketSnapshot.currentMcap, 33000);
      assert.equal(blockWrites[0].evidence.marketSnapshot.vol5m, 120000);
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
