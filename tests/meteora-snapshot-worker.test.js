const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenCatalog = require('../src/models/token-catalog');
const tokenMeteoraState = require('../src/models/token-meteora-state');
const tokenMeteoraSnapshot = require('../src/models/token-meteora-snapshot');
const meteora = require('../src/services/meteora');
const meteoraSnapshotWorker = require('../src/services/meteora-snapshot-worker');

describe('Meteora snapshot worker scheduling', () => {
  it('uses the 20s loop interval for Meteora refreshes', () => {
    assert.equal(meteoraSnapshotWorker.__private.LOOP_INTERVAL_MS, 20 * 1000);
  });

  it('computes dynamic batch limits capped at 800 tokens per minute', () => {
    assert.equal(meteoraSnapshotWorker.__private.computeDynamicBatchLimit(0), 0);
    assert.equal(meteoraSnapshotWorker.__private.computeDynamicBatchLimit(45), 15);
    assert.equal(meteoraSnapshotWorker.__private.computeDynamicBatchLimit(390), 130);
    assert.equal(meteoraSnapshotWorker.__private.computeDynamicBatchLimit(800), 267);
    assert.equal(meteoraSnapshotWorker.__private.computeDynamicBatchLimit(1200), 267);
  });

  it('computes tier budgets with SLA demand and automatic degradation under the global cap', () => {
    const underCapPlan = meteoraSnapshotWorker.__private.computeTierBudgetPlan({
      high: 74,
      normal: 68,
      low: 248,
    });
    assert.deepEqual(underCapPlan.universeByTier, { high: 74, normal: 68, low: 248 });
    assert.deepEqual(underCapPlan.targetChecksPerMinuteByTier, {
      high: 148,
      normal: 68,
      low: 49.6,
    });
    assert.deepEqual(underCapPlan.effectiveChecksPerMinuteByTier, {
      high: 148,
      normal: 68,
      low: 49.6,
    });
    assert.deepEqual(underCapPlan.targetChecksPerCycleByTier, {
      high: 50,
      normal: 23,
      low: 17,
    });
    assert.equal(underCapPlan.degraded, false);
    assert.deepEqual(underCapPlan.degradedTiers, []);

    const degradedPlan = meteoraSnapshotWorker.__private.computeTierBudgetPlan({
      high: 250,
      normal: 400,
      low: 600,
    });
    assert.deepEqual(degradedPlan.targetChecksPerMinuteByTier, {
      high: 500,
      normal: 400,
      low: 120,
    });
    assert.deepEqual(degradedPlan.effectiveChecksPerMinuteByTier, {
      high: 500,
      normal: 300,
      low: 0,
    });
    assert.deepEqual(degradedPlan.targetChecksPerCycleByTier, {
      high: 167,
      normal: 100,
      low: 0,
    });
    assert.equal(degradedPlan.degraded, true);
    assert.deepEqual(degradedPlan.degradedTiers, ['normal', 'low']);
  });

  it('selects cycle tokens by tier with due cutoffs and carryover to lower tiers', async () => {
    const originalListDueForMeteoraSnapshots = tokenCatalog.listDueForMeteoraSnapshots;
    const calls = [];
    const checkedAt = new Date('2026-04-05T23:30:00.000Z');

    tokenCatalog.listDueForMeteoraSnapshots = async (limit, tier, checkedBefore) => {
      calls.push({ limit, tier, checkedBefore });
      if (tier === 'high') {
        return [
          { address: 'high-1', meteora_priority_tier: 'high' },
        ];
      }
      if (tier === 'normal') {
        return [
          { address: 'normal-1', meteora_priority_tier: 'normal' },
          { address: 'normal-2', meteora_priority_tier: 'normal' },
        ];
      }
      return [
        { address: 'low-1', meteora_priority_tier: 'low' },
          { address: 'low-2', meteora_priority_tier: 'low' },
          { address: 'low-3', meteora_priority_tier: 'low' },
          { address: 'low-4', meteora_priority_tier: 'low' },
        ];
    };

    try {
      const selection = await meteoraSnapshotWorker.__private.selectCycleTokens(
        10,
        { high: 3, normal: 2, low: 1 },
        checkedAt
      );

      assert.deepEqual(calls.map((call) => [call.tier, call.limit]), [
        ['high', 3],
        ['normal', 4],
        ['low', 3],
      ]);
      assert.deepEqual(calls.map((call) => call.checkedBefore.toISOString()), [
        '2026-04-05T23:29:30.000Z',
        '2026-04-05T23:29:00.000Z',
        '2026-04-05T23:25:00.000Z',
      ]);
      assert.deepEqual(selection.selectedCountByTier, {
        high: 1,
        normal: 2,
        low: 4,
      });
      assert.deepEqual(selection.tokens.map((token) => token.address), [
        'high-1',
        'normal-1',
        'normal-2',
        'low-1',
        'low-2',
        'low-3',
        'low-4',
      ]);
      assert.equal(selection.remainingCapacity, 3);
      assert.equal(selection.carryoverSlots, 0);
    } finally {
      tokenCatalog.listDueForMeteoraSnapshots = originalListDueForMeteoraSnapshots;
    }
  });

  it('persists current Meteora state for checked tokens and sizes each run from the current Meteora universe', async () => {
    const originalGetClient = db.getClient;
    const originalCountDueForMeteoraSnapshots = tokenCatalog.countDueForMeteoraSnapshots;
    const originalCountDueForMeteoraSnapshotsByTier = tokenCatalog.countDueForMeteoraSnapshotsByTier;
    const originalListDueForMeteoraSnapshots = tokenCatalog.listDueForMeteoraSnapshots;
    const originalMarkMeteoraChecked = tokenCatalog.markMeteoraChecked;
    const originalFetchMeteoraBulk = meteora.fetchMeteoraBulk;
    const originalUpsertState = tokenMeteoraState.upsertState;
    const originalRecordError = tokenMeteoraState.recordError;
    const originalInsertSnapshot = tokenMeteoraSnapshot.insertSnapshot;
    const originalListBaselineTvlsByAddresses = tokenMeteoraSnapshot.listBaselineTvlsByAddresses;

    const listCalls = [];
    let markedArgs = null;
    const inserted = [];
    const baselineCalls = [];
    const upserts = [];
    const recordedErrors = [];
    const transactionLog = [];

    tokenCatalog.countDueForMeteoraSnapshots = async () => 390;
    tokenCatalog.countDueForMeteoraSnapshotsByTier = async () => ({
      total: 390,
      byTier: {
        high: 74,
        normal: 68,
        low: 248,
      },
    });
    tokenCatalog.listDueForMeteoraSnapshots = async (limit, tier, checkedBefore) => {
      listCalls.push({ limit, tier, checkedBefore });
      if (tier === 'high') {
        return [
          { address: 'So11111111111111111111111111111111111111112', meteora_priority_tier: 'high' },
        ];
      }
      if (tier === 'normal') {
        return [
          { address: '11111111111111111111111111111111', meteora_priority_tier: 'normal' },
          { address: '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb', meteora_priority_tier: 'normal' },
        ];
      }
      return [];
    };
    db.getClient = async () => ({
      query: async (sql) => {
        transactionLog.push(sql);
      },
      release: () => {},
    });
    tokenCatalog.markMeteoraChecked = async (addresses, checkedAt) => {
      markedArgs = [addresses, checkedAt];
      return addresses.length;
    };
    meteora.fetchMeteoraBulk = async () => ({
      results: {
        So11111111111111111111111111111111111111112: {
          tvl: 32000,
          poolAddress: 'pool_test_123',
          poolCount: 2,
          volume1h: 9000,
          volume4h: 19000,
          volume24h: 45000,
        },
      },
      checkedAddresses: [
        'So11111111111111111111111111111111111111112',
        '11111111111111111111111111111111',
      ],
      errorsByAddress: {
        '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb': 'HTTP 503',
      },
    });
    tokenMeteoraState.upsertState = async (payload) => {
      upserts.push(payload);
      return payload;
    };
    tokenMeteoraState.recordError = async (address, error) => {
      recordedErrors.push([address, error]);
      return { tokenAddress: address, lastError: error };
    };
    tokenMeteoraSnapshot.insertSnapshot = async (payload) => {
      inserted.push(payload);
      return payload;
    };
    tokenMeteoraSnapshot.listBaselineTvlsByAddresses = async (addresses, anchorTs) => {
      baselineCalls.push({ addresses, anchorTs });
      return [{
        token_address: 'So11111111111111111111111111111111111111112',
        baseline_tvl_1h: '22000',
        baseline_tvl_4h: '20000',
        baseline_tvl_6h: '18000',
        baseline_tvl_24h: '14000',
      }];
    };

    meteoraSnapshotWorker.start();
    try {
      await meteoraSnapshotWorker.runOnce();
      assert.deepEqual(listCalls.map((call) => [call.tier, call.limit]), [
        ['high', 50],
        ['normal', 72],
        ['low', 87],
      ]);
      assert.deepEqual(meteoraSnapshotWorker.getStatus().lastUniverseCountByTier, {
        high: 74,
        normal: 68,
        low: 248,
      });
      assert.deepEqual(meteoraSnapshotWorker.getStatus().lastTargetChecksPerCycleByTier, {
        high: 50,
        normal: 23,
        low: 17,
      });
      assert.deepEqual(meteoraSnapshotWorker.getStatus().lastSelectedCountByTier, {
        high: 1,
        normal: 2,
        low: 0,
      });
      assert.equal(meteoraSnapshotWorker.getStatus().lastBudgetDegraded, false);
      assert.equal(inserted.length, 1);
      assert.equal(inserted[0].tokenAddress, 'So11111111111111111111111111111111111111112');
      assert.ok(inserted[0].ts instanceof Date);
      assert.equal(baselineCalls.length, 1);
      assert.deepEqual(baselineCalls[0].addresses, ['So11111111111111111111111111111111111111112']);
      assert.ok(baselineCalls[0].anchorTs instanceof Date);
      assert.equal(upserts.length, 2);
      assert.equal(upserts[0].tokenAddress, 'So11111111111111111111111111111111111111112');
      assert.equal(upserts[0].hasPool, true);
      assert.equal(upserts[0].lastSnapshotAt, inserted[0].ts);
      assert.equal(upserts[0].baselineTvl1h, '22000');
      assert.equal(upserts[0].baselineTvl4h, '20000');
      assert.equal(upserts[0].baselineTvl6h, '18000');
      assert.equal(upserts[0].baselineTvl24h, '14000');
      assert.equal(upserts[0].volume1h, 9000);
      assert.equal(upserts[0].volume4h, 19000);
      assert.equal(upserts[0].volume24h, 45000);
      assert.equal(upserts[1].tokenAddress, '11111111111111111111111111111111');
      assert.equal(upserts[1].hasPool, false);
      assert.equal(upserts[1].currentTvl, null);
      assert.equal(upserts[1].lastSnapshotAt, null);
      assert.equal(upserts[1].baselineTvl1h, null);
      assert.equal(upserts[1].baselineTvl4h, null);
      assert.equal(upserts[1].volume1h, null);
      assert.equal(recordedErrors.length, 1);
      assert.deepEqual(recordedErrors[0], ['34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb', 'HTTP 503']);
      assert.deepEqual(markedArgs[0], [
        'So11111111111111111111111111111111111111112',
        '11111111111111111111111111111111',
      ]);
      assert.ok(markedArgs[1] instanceof Date);
      assert.deepEqual(transactionLog, ['BEGIN', 'COMMIT']);
    } finally {
      meteoraSnapshotWorker.stop();
      db.getClient = originalGetClient;
      tokenCatalog.countDueForMeteoraSnapshots = originalCountDueForMeteoraSnapshots;
      tokenCatalog.countDueForMeteoraSnapshotsByTier = originalCountDueForMeteoraSnapshotsByTier;
      tokenCatalog.listDueForMeteoraSnapshots = originalListDueForMeteoraSnapshots;
      tokenCatalog.markMeteoraChecked = originalMarkMeteoraChecked;
      meteora.fetchMeteoraBulk = originalFetchMeteoraBulk;
      tokenMeteoraState.upsertState = originalUpsertState;
      tokenMeteoraState.recordError = originalRecordError;
      tokenMeteoraSnapshot.insertSnapshot = originalInsertSnapshot;
      tokenMeteoraSnapshot.listBaselineTvlsByAddresses = originalListBaselineTvlsByAddresses;
    }
  });
});
