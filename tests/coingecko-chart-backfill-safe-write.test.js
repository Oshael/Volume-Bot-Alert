const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/services/coingecko-chart-backfill-plan');
const safeWrite = require('../src/services/coingecko-chart-backfill-safe-write');

const TOKEN_ADDRESS = '8wxkvAfEns76yBzu4MnbV7VnXWjg3iDPA9uwAQ6cpump';
const POOL_ADDRESS = 'Ak7hDCxDSocD2ZgJBCa1ZwLcuDQz5F6n747a7rQtpXE3';

const candles = [
  { bucketTs: '2026-07-02T18:00:00.000Z', open: 0.1, high: 0.12, low: 0.09, close: 0.11, volume: 100 },
  { bucketTs: '2026-07-02T18:05:00.000Z', open: 0.11, high: 0.14, low: 0.1, close: 0.13, volume: 200 },
];

function buildContext() {
  const plan = planner.buildDryRunPlan({
    tokenAddress: TOKEN_ADDRESS,
    poolAddress: POOL_ADDRESS,
    catalogRow: { address: TOKEN_ADDRESS, last_mcap: 130000 },
    result: {
      poolAddress: POOL_ADDRESS,
      network: 'solana',
      timeframe: 'minute',
      aggregate: 5,
      requestedDays: 31,
      calls: 1,
      candles,
    },
  });
  const buckets = planner.buildBackfillBuckets(candles, {
    tokenAddress: TOKEN_ADDRESS,
    poolAddress: POOL_ADDRESS,
    granularityMinutes: 5,
    mcapMultiplier: plan.mcapMultiplier.value,
  });
  return { plan, buckets };
}

function buildFakeDb(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (/SELECT bucket_ts/.test(sql)) {
        const timestamps = /open_mcap IS NULL/.test(sql)
          ? (options.badTimestamps || [])
          : (options.existingTimestamps || []);
        return {
          rows: timestamps.map((bucketTs) => ({ bucket_ts: bucketTs })),
          rowCount: timestamps.length,
        };
      }
      if (/coingecko_backfill_rollup/.test(sql)) return { rows: [], rowCount: 1 };
      if (/FROM token_market_buckets_agg/.test(sql) && /SELECT/.test(sql)) {
        return {
          rows: [{
            token_address: TOKEN_ADDRESS,
            granularity_minutes: 5,
            bucket_ts: candles[0].bucketTs,
            close_mcap: '110000',
            source: 'aggregate',
          }],
          rowCount: 1,
        };
      }
      if (/INSERT INTO token_market_buckets_agg/.test(sql)) {
        return { rows: [], rowCount: options.insertedRows ?? (params.length / 14) };
      }
      if (/DELETE FROM token_market_buckets_agg/.test(sql)) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return { calls, db: { getClient: async () => client } };
}

function buildFakeFs(options = {}) {
  const writes = [];
  return {
    writes,
    fsImpl: {
      mkdir: async () => {},
      writeFile: async (file, body) => {
        writes.push({ file, body });
        if (options.failWrite) throw new Error('safe backup failed');
      },
    },
  };
}

describe('CoinGecko selective chart writes', () => {
  it('previews the exact number of missing buckets without writing', async () => {
    const context = buildContext();
    const fake = buildFakeDb({ existingTimestamps: [candles[0].bucketTs] });

    const impact = await safeWrite.inspectSelectiveWrite({
      db: fake.db,
      mode: 'fill-missing',
      ...context,
    });

    assert.equal(impact.candidateCandles, 2);
    assert.equal(impact.matchingExistingRows, 1);
    assert.equal(impact.wouldWrite, 1);
    assert.equal(fake.calls.some((call) => /INSERT|DELETE/.test(call.sql)), false);
  });

  it('fills only missing 5m rows and rebuilds aggregates without touching 1m', async () => {
    const context = buildContext();
    const fake = buildFakeDb({ insertedRows: 1, existingTimestamps: [candles[0].bucketTs] });
    const fakeFs = buildFakeFs();

    const result = await safeWrite.executeFillMissing({
      db: fake.db,
      fsImpl: fakeFs.fsImpl,
      backupDir: '/tmp/backups',
      ...context,
    });

    assert.equal(result.inserted, 1);
    assert.equal(fakeFs.writes.length, 1);
    const sourceInsert = fake.calls.find((call) => /INSERT INTO token_market_buckets_agg/.test(call.sql)
      && !/coingecko_backfill_rollup/.test(call.sql));
    assert.match(sourceInsert.sql,
      /ON CONFLICT \(chain, token_address, granularity_minutes, bucket_ts\) DO NOTHING/);
    assert.ok(fake.calls
      .filter((call) => /FROM token_market_buckets_agg/.test(call.sql))
      .every((call) => /chain = 'solana'/.test(call.sql)));
    assert.equal(fake.calls.some((call) => /token_market_buckets_1m/.test(call.sql)), false);
    assert.deepEqual(Object.keys(result.rebuiltAggregates), ['15', '30', '60', '240', '1440']);
  });

  it('does not rebuild aggregates when fill-missing inserts no rows', async () => {
    const context = buildContext();
    const fake = buildFakeDb({
      insertedRows: 0,
      existingTimestamps: candles.map((candle) => candle.bucketTs),
    });

    const result = await safeWrite.executeFillMissing({ db: fake.db, ...context });

    assert.equal(result.inserted, 0);
    assert.deepEqual(result.rebuiltAggregates, {});
    assert.equal(fake.calls.some((call) => /coingecko_backfill_rollup/.test(call.sql)), false);
  });

  it('backs up and replaces only bad buckets with matching CoinGecko timestamps', async () => {
    const context = buildContext();
    const fake = buildFakeDb({ badTimestamps: [candles[1].bucketTs], insertedRows: 1 });
    const fakeFs = buildFakeFs();

    const result = await safeWrite.executeReplaceBadBuckets({
      db: fake.db,
      fsImpl: fakeFs.fsImpl,
      backupDir: '/tmp/backups',
      ...context,
    });

    assert.equal(result.matchedBadBuckets, 1);
    assert.equal(result.replaced, 1);
    assert.equal(fakeFs.writes.length, 1);
    const sourceInsert = fake.calls.find((call) => /INSERT INTO token_market_buckets_agg/.test(call.sql)
      && !/coingecko_backfill_rollup/.test(call.sql));
    assert.equal(sourceInsert.params.length, 14);
    assert.equal(sourceInsert.params[2], candles[1].bucketTs);
    assert.ok(fake.calls
      .filter((call) => /FROM token_market_buckets_agg/.test(call.sql))
      .every((call) => /chain = 'solana'/.test(call.sql)));
    assert.ok(fake.calls.some((call) => call.sql === 'COMMIT'));
  });

  it('rolls back replace-bad-buckets when its backup cannot be written', async () => {
    const context = buildContext();
    const fake = buildFakeDb({ badTimestamps: [candles[0].bucketTs] });
    const fakeFs = buildFakeFs({ failWrite: true });

    await assert.rejects(
      () => safeWrite.executeReplaceBadBuckets({
        db: fake.db,
        fsImpl: fakeFs.fsImpl,
        backupDir: '/tmp/backups',
        ...context,
      }),
      /safe backup failed/
    );

    assert.ok(fake.calls.some((call) => call.sql === 'ROLLBACK'));
    assert.equal(fake.calls.some((call) => call.sql === 'COMMIT'), false);
  });
});
