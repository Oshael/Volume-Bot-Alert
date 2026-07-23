const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const worker = require('../src/services/robinhood-retention-worker');
const VERIFIED_COVERAGE = Object.freeze({
  from: '2026-07-01T00:00:00.000Z',
  through: '2026-07-20T00:00:00.000Z',
});

function createFakeDatabase(rawBatches = [], minuteBatches = []) {
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
          }],
        };
      }
      if (/DELETE FROM robinhood_market_buckets_1m/.test(sql)) {
        const next = minuteBatches.shift() || 0;
        const row = typeof next === 'number' ? { examined: next, deleted: next } : next;
        return {
          rows: [{
            examined_buckets: row.examined,
            minute_buckets: row.deleted,
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
      verifiedCoverage: null,
    });
    assert.throws(
      () => worker.__private.normalizeVerifiedCoverage({
        from: '2026-07-01T01:00:00.000Z',
        through: '2026-07-20T00:00:00.000Z',
      }),
      /align to UTC days/
    );
  });

  it('deletes expired raw rows through the cascading ledger in bounded batches', async () => {
    const database = createFakeDatabase(
      [
        { processedLogs: 100, observations: 80 },
        { processedLogs: 25, observations: 20 },
      ],
      [100, 4]
    );

    const summary = await worker.runOnce({
      batchLimit: 100,
      maxBatches: 5,
      statementTimeoutMs: 2500,
      verifiedCoverage: VERIFIED_COVERAGE,
    }, {}, { database });

    assert.deepEqual(summary, {
      batches: 2,
      examinedProcessedLogs: 125,
      processedLogs: 125,
      protectedProcessedLogs: 0,
      observations: 100,
      minuteBuckets: 104,
      protectedMinuteBuckets: 0,
      minuteDeletionBlockedByCoverage: false,
      hourlyBuckets: 0,
      protectedHourlyBuckets: 0,
    });
    assert.equal(database.calls.length, 4);
    assert.ok(database.calls.every((call) => call.params[0] === 100));
    assert.ok(database.calls.every((call) => call.timeoutMs === 2500));
    assert.match(database.calls[0].sql, /FOR UPDATE OF processed SKIP LOCKED/);
    assert.match(database.calls[0].sql, /robinhood_market_observations/);
    assert.match(database.calls[0].sql, /observation\.status = 'accepted'/);
    assert.match(database.calls[0].sql, /robinhood_market_buckets_1m minute/);
    assert.match(database.calls[0].sql, /observation\.status = 'rejected'/);
    assert.doesNotMatch(database.calls[0].sql, /observation\.status = 'pending'/);
  });

  it('only removes expired minute buckets after current permanent parents exist', async () => {
    const database = createFakeDatabase([], []);

    await worker.runOnce({
      batchLimit: 100, maxBatches: 1, verifiedCoverage: VERIFIED_COVERAGE,
    }, {}, { database });

    const minuteCall = database.calls.find((call) => (
      /DELETE FROM robinhood_market_buckets_1m/.test(call.sql)
    ));
    assert.match(minuteCall.sql, /EXISTS \([\s\S]*robinhood_market_buckets_1h/);
    assert.match(minuteCall.sql, /hourly\.updated_at >= expired\.updated_at/);
    assert.match(minuteCall.sql, /hourly\.first_block_number <= expired\.first_block_number/);
    assert.match(minuteCall.sql, /VALUES \(5\), \(15\), \(30\)/);
    assert.match(minuteCall.sql, /aggregate\.updated_at >= expired\.updated_at/);
    assert.match(minuteCall.sql, /minute\.bucket_ts >= \$2::timestamptz/);
    assert.match(minuteCall.sql, /minute\.bucket_ts < \$3::timestamptz/);
    assert.match(minuteCall.sql, /date_trunc\('hour', NOW\(\) AT TIME ZONE 'UTC'\)/);
    assert.match(minuteCall.sql, /FOR UPDATE OF minute SKIP LOCKED/);
    assert.deepEqual(minuteCall.params, [
      100, VERIFIED_COVERAGE.from, VERIFIED_COVERAGE.through,
    ]);
    assert.doesNotMatch(minuteCall.sql, /DELETE FROM robinhood_market_buckets_agg/);
    assert.doesNotMatch(minuteCall.sql, /DELETE FROM robinhood_market_buckets_1h/);
  });

  it('never removes permanent hourly buckets used by fallback and all-available reads', async () => {
    const database = createFakeDatabase();

    const summary = await worker.runOnce({
      batchLimit: 100, maxBatches: 1, verifiedCoverage: VERIFIED_COVERAGE,
    }, {}, { database });

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
      observations: 0,
      minuteBuckets: 0,
      protectedMinuteBuckets: 0,
      minuteDeletionBlockedByCoverage: false,
      hourlyBuckets: 0,
      protectedHourlyBuckets: 0,
    });
    assert.equal(database.calls.length, 0);
  });

  it('reports and preserves expired minute buckets without a confirmed hourly rollup', async () => {
    const database = createFakeDatabase(
      [{ processedLogs: 100, observations: 100 }, { processedLogs: 100, observations: 100 }],
      [{ examined: 10, deleted: 7 }]
    );

    const summary = await worker.runOnce({
      batchLimit: 100,
      maxBatches: 5,
      verifiedCoverage: VERIFIED_COVERAGE,
    }, {}, { database });

    assert.deepEqual(summary, {
      batches: 1,
      examinedProcessedLogs: 100,
      processedLogs: 100,
      protectedProcessedLogs: 0,
      observations: 100,
      minuteBuckets: 7,
      protectedMinuteBuckets: 3,
      minuteDeletionBlockedByCoverage: false,
      hourlyBuckets: 0,
      protectedHourlyBuckets: 0,
    });
    assert.equal(database.calls.length, 2);
  });

  it('stops before compacting buckets when an expired raw observation lacks coverage', async () => {
    const database = createFakeDatabase([
      { examined: 10, processedLogs: 7, observations: 7 },
    ]);

    const summary = await worker.runOnce({ batchLimit: 100 }, {}, { database });

    assert.equal(summary.protectedProcessedLogs, 3);
    assert.equal(summary.processedLogs, 7);
    assert.equal(summary.minuteBuckets, 0);
    assert.equal(summary.hourlyBuckets, 0);
    assert.equal(database.calls.length, 1);
  });

  it('blocks minute deletion when no globally verified coverage is configured', async () => {
    const database = createFakeDatabase(
      [{ examined: 100, processedLogs: 100, observations: 0 }],
      [100]
    );

    const summary = await worker.runOnce({ batchLimit: 100 }, {}, { database });

    assert.equal(summary.minuteBuckets, 0);
    assert.equal(summary.minuteDeletionBlockedByCoverage, true);
    assert.equal(summary.hourlyBuckets, 0);
    assert.equal(database.calls.length, 1);
  });
});
