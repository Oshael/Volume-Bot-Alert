const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const worker = require('../src/services/robinhood-retention-worker');
const VALID_WALLET_GATE = Object.freeze({
  valid: true,
  reason: null,
  completeThroughBlock: '900',
  sourceFrontierBlock: '905',
  updatedAt: new Date().toISOString(),
});

function dependencies(database, gate = VALID_WALLET_GATE) {
  return {
    database,
    watermarkRepository: { loadRetentionGate: async () => gate },
  };
}

function createFakeDatabase(rawBatches = []) {
  const calls = [];
  return {
    calls,
    async queryWithStatementTimeout(sql, params, timeoutMs) {
      calls.push({ sql, params, timeoutMs });
      if (/DELETE FROM robinhood_processed_logs/.test(sql)) {
        const row = rawBatches.shift() || {
          examined: 0,
          processedLogs: 0,
          observations: 0,
        };
        return {
          rows: [{
            examined_logs: row.examined ?? row.processedLogs,
            processed_logs: row.processedLogs,
            observations: row.observations,
            wallet_protected: row.protectedByWallet,
            bucket_protected: row.protectedByBucketCoverage,
            aggregation_protected: row.protectedByAggregation,
            candidate_block_min: row.candidateBlockMin,
            candidate_block_max: row.candidateBlockMax,
          }],
        };
      }
      throw new Error('Unexpected retention query');
    },
  };
}

describe('Robinhood retention worker', () => {
  it('bounds cleanup load controls', () => {
    assert.deepEqual(worker.__private.normalizeOptions({
      intervalMs: 1,
      batchLimit: 1,
      maxBatches: 999,
      statementTimeoutMs: 1,
    }), {
      enabled: true,
      intervalMs: 10_000,
      batchLimit: 100,
      maxBatches: 50,
      statementTimeoutMs: 1000,
    });
  });

  it('deletes expired raw rows through the cascading ledger in bounded batches', async () => {
    const database = createFakeDatabase(
      [
        { processedLogs: 100, observations: 80 },
        { processedLogs: 25, observations: 20 },
      ]
    );

    const summary = await worker.runOnce({
      batchLimit: 100,
      maxBatches: 5,
      statementTimeoutMs: 2500,
    }, {}, dependencies(database));

    assert.deepEqual(summary, {
      batches: 2,
      examinedProcessedLogs: 125,
      processedLogs: 125,
      protectedProcessedLogs: 0,
      candidatesProtectedByWallet: 0,
      candidatesProtectedByBucketCoverage: 0,
      candidatesProtectedByAggregation: 0,
      retentionCandidateBlockMin: null,
      retentionCandidateBlockMax: null,
      walletGateValid: true,
      walletGateReason: null,
      walletCompleteThroughBlock: '900',
      walletWatermarkUpdatedAt: VALID_WALLET_GATE.updatedAt,
      walletWatermarkAgeMs: summary.walletWatermarkAgeMs,
      walletLagBlocks: '5',
      observations: 100,
      hourlyBuckets: 0,
      protectedHourlyBuckets: 0,
    });
    assert.equal(database.calls.length, 2);
    assert.ok(database.calls.every((call) => call.params[0] === 50));
    assert.ok(database.calls.every((call) => call.timeoutMs === 2500));
    assert.match(database.calls[0].sql, /FOR UPDATE OF processed SKIP LOCKED/);
    assert.match(database.calls[0].sql, /independent_expired AS MATERIALIZED/);
    assert.match(database.calls[0].sql, /guarded_expired AS MATERIALIZED/);
    assert.match(database.calls[0].sql, /robinhood_market_observations/);
    assert.match(database.calls[0].sql, /observation\.status = 'accepted'/);
    assert.match(database.calls[0].sql, /observation\.status <> 'rejected'/);
    assert.match(database.calls[0].sql, /robinhood_market_buckets_1m minute/);
    assert.match(database.calls[0].sql, /robinhood_backfill_aggregation_outbox aggregation/);
    assert.match(database.calls[0].sql, /aggregation\.status <> 'completed'/);
    assert.match(database.calls[0].sql, /status = 'rejected'/);
    assert.match(database.calls[0].sql, /observation\.block_number <= \$2::bigint/);
    assert.deepEqual(database.calls[0].params, [50, '900']);
    assert.doesNotMatch(database.calls[0].sql, /status = 'pending'/);
  });

  it('never removes durable minute buckets', async () => {
    const database = createFakeDatabase([{ examined: 100, processedLogs: 100 }]);

    await worker.runOnce({ batchLimit: 100, maxBatches: 1 }, {}, dependencies(database));

    assert.equal(database.calls.some((call) => (
      /DELETE FROM robinhood_market_buckets_1m/.test(call.sql)
    )), false);
  });

  it('never removes permanent hourly buckets used by fallback and all-available reads', async () => {
    const database = createFakeDatabase();

    const summary = await worker.runOnce({
      batchLimit: 100, maxBatches: 1,
    }, {}, dependencies(database));

    assert.equal(summary.hourlyBuckets, 0);
    assert.equal(database.calls.some((call) => (
      /DELETE FROM robinhood_market_buckets_1h/.test(call.sql)
    )), false);
  });

  it('does not touch the database when retention is disabled', async () => {
    const database = createFakeDatabase();

    const summary = await worker.runOnce({ enabled: false }, {}, { database });

    assert.deepEqual(summary, {
      batches: 0,
      examinedProcessedLogs: 0,
      processedLogs: 0,
      protectedProcessedLogs: 0,
      candidatesProtectedByWallet: 0,
      candidatesProtectedByBucketCoverage: 0,
      candidatesProtectedByAggregation: 0,
      retentionCandidateBlockMin: null,
      retentionCandidateBlockMax: null,
      walletGateValid: false,
      walletGateReason: 'not_evaluated',
      walletCompleteThroughBlock: null,
      walletWatermarkUpdatedAt: null,
      walletWatermarkAgeMs: null,
      walletLagBlocks: null,
      observations: 0,
      hourlyBuckets: 0,
      protectedHourlyBuckets: 0,
    });
    assert.equal(database.calls.length, 0);
  });

  it('stops raw deletion when an expired observation lacks coverage', async () => {
    const database = createFakeDatabase([
      {
        examined: 10,
        processedLogs: 6,
        observations: 6,
        protectedByWallet: 2,
        protectedByBucketCoverage: 1,
        protectedByAggregation: 1,
        candidateBlockMin: '899',
        candidateBlockMax: '901',
      },
    ]);

    const summary = await worker.runOnce({ batchLimit: 100 }, {}, dependencies(database));

    assert.equal(summary.protectedProcessedLogs, 4);
    assert.equal(summary.processedLogs, 6);
    assert.equal(summary.candidatesProtectedByWallet, 2);
    assert.equal(summary.candidatesProtectedByBucketCoverage, 1);
    assert.equal(summary.candidatesProtectedByAggregation, 1);
    assert.equal(summary.retentionCandidateBlockMin, '899');
    assert.equal(summary.retentionCandidateBlockMax, '901');
    assert.equal(summary.hourlyBuckets, 0);
    assert.equal(database.calls.length, 1);
  });

  it('fails closed for accepted rows when loading the wallet watermark fails', async () => {
    const database = createFakeDatabase([{
      examined: 8,
      processedLogs: 5,
      observations: 5,
      protectedByWallet: 3,
      candidateBlockMin: '901',
      candidateBlockMax: '903',
    }]);

    const summary = await worker.runOnce(
      { batchLimit: 100 },
      {},
      {
        database,
        watermarkRepository: {
          loadRetentionGate: async () => { throw new Error('cursor read failed'); },
        },
      }
    );

    assert.equal(summary.walletGateValid, false);
    assert.equal(summary.walletGateReason, 'watermark_load_error');
    assert.equal(summary.candidatesProtectedByWallet, 3);
    assert.equal(summary.processedLogs, 5);
    assert.deepEqual(database.calls[0].params, [50, null]);
    assert.match(database.calls[0].sql, /status = 'rejected'/);
    assert.match(database.calls[0].sql, /status = 'accepted' AND wallet_complete/);
    assert.equal(worker.getStatus().lastWalletGateValid, false);
    assert.equal(worker.getStatus().lastWalletGateReason, 'watermark_load_error');
    assert.equal(worker.getStatus().lastCandidatesProtectedByWallet, 3);
  });
});
