const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const planner = require('../src/services/coingecko-chart-backfill-plan');
const writer = require('../src/services/coingecko-chart-backfill-write');

const TOKEN_ADDRESS = '8wxkvAfEns76yBzu4MnbV7VnXWjg3iDPA9uwAQ6cpump';
const POOL_ADDRESS = 'Ak7hDCxDSocD2ZgJBCa1ZwLcuDQz5F6n747a7rQtpXE3';

function buildPlan(granularityMinutes = 5) {
  return planner.buildDryRunPlan({
    tokenAddress: TOKEN_ADDRESS,
    poolAddress: POOL_ADDRESS,
    catalogRow: { address: TOKEN_ADDRESS, symbol: 'SOLANGELES', last_mcap: 130000 },
    result: {
      poolAddress: POOL_ADDRESS,
      network: 'solana',
      timeframe: 'minute',
      aggregate: granularityMinutes,
      requestedDays: 31,
      calls: 1,
      candles: [
        { bucketTs: '2026-07-02T18:00:00.000Z', open: 0.1, high: 0.12, low: 0.09, close: 0.11, volume: 100 },
        { bucketTs: '2026-07-02T18:05:00.000Z', open: 0.11, high: 0.14, low: 0.1, close: 0.13, volume: 200 },
      ],
    },
  });
}

function buildFakeDb(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (/coingecko_backfill_rollup/.test(sql)) {
        if (Number(options.failRollupGranularity) === Number(params[3])) {
          throw new Error(`rollup ${params[3]}m failed`);
        }
        return { rows: [], rowCount: 1 };
      }
      if (/FROM token_market_buckets_1m/.test(sql) && /SELECT/.test(sql)) {
        return {
          rows: [{
            token_address: TOKEN_ADDRESS,
            bucket_ts: '2026-07-02T18:00:00.000Z',
            close_mcap: '120000',
            source: 'dexscreener',
          }],
          rowCount: 1,
        };
      }
      if (/FROM token_market_buckets_agg/.test(sql) && /SELECT/.test(sql)) {
        return {
          rows: [{
            token_address: TOKEN_ADDRESS,
            granularity_minutes: 5,
            bucket_ts: '2026-07-02T18:00:00.000Z',
            close_mcap: '120000',
            source: 'aggregate',
          }],
          rowCount: 1,
        };
      }
      if (/DELETE FROM token_market_buckets_agg/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/DELETE FROM token_market_buckets_1m/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO token_market_buckets_1m/.test(sql)) {
        if (options.failInsert) throw new Error('insert failed');
        return { rows: [], rowCount: params.length / 13 };
      }
      if (/INSERT INTO token_market_buckets_agg/.test(sql)) {
        if (options.failInsert) throw new Error('insert failed');
        return { rows: [], rowCount: params.length / 14 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return {
    calls,
    db: {
      getClient: async () => client,
    },
  };
}

function buildFakeFs(options = {}) {
  const writes = [];
  return {
    writes,
    fsImpl: {
      mkdir: async (dir) => {
        writes.push({ type: 'mkdir', dir });
      },
      writeFile: async (file, body) => {
        writes.push({ type: 'writeFile', file, body });
        if (options.failWrite) throw new Error('backup failed');
      },
    },
  };
}

describe('CoinGecko chart backfill writer', () => {
  it('uses source-aware wick bounds when rolling up replaced 1m buckets', () => {
    const sql = writer.buildAggregateRollupSql(1);

    assert.match(sql, /FROM token_market_buckets_1m/);
    assert.match(sql, /normalized_source_rows AS/);
    assert.match(sql, /source_stats AS/);
    assert.match(sql, /COALESCE\(source, ''\) = 'gmgn'/);
    assert.match(sql, /primary_high_mcap/);
  });

  it('replaces recent 5m aggregate rows without touching native 1m rows', async () => {
    const plan = buildPlan();
    const buckets = planner.buildBackfillBuckets([
      { bucketTs: '2026-07-02T18:00:00.000Z', open: 0.1, high: 0.12, low: 0.09, close: 0.11, volume: 100 },
      { bucketTs: '2026-07-02T18:05:00.000Z', open: 0.11, high: 0.14, low: 0.1, close: 0.13, volume: 200 },
    ], {
      tokenAddress: TOKEN_ADDRESS,
      poolAddress: POOL_ADDRESS,
      granularityMinutes: 5,
      mcapMultiplier: plan.mcapMultiplier.value,
    });
    const fakeDb = buildFakeDb();
    const fakeFs = buildFakeFs();

    const result = await writer.executeReplaceChart({
      db: fakeDb.db,
      fsImpl: fakeFs.fsImpl,
      backupDir: '/tmp/backups',
      plan,
      buckets,
    });

    assert.equal(result.writes, true);
    assert.equal(result.granularityMinutes, 5);
    assert.equal(result.backedUp.tokenMarketBuckets1m, 0);
    assert.equal(result.backedUp.tokenMarketBucketsAgg, 1);
    assert.equal(result.deleted.tokenMarketBucketsAggDeleted, 1);
    assert.equal(result.deleted.tokenMarketBuckets1mDeleted, 0);
    assert.equal(result.insertedOrUpdated, 2);
    assert.deepEqual(result.rebuiltAggregates, {
      15: 1,
      30: 1,
      60: 1,
      240: 1,
      1440: 1,
    });
    assert.ok(fakeFs.writes.some((call) => call.type === 'writeFile' && call.body.includes('coingecko_replace_chart_backup')));

    const sqlOrder = fakeDb.calls.map((call) => call.sql);
    assert.equal(sqlOrder[0], 'BEGIN');
    assert.equal(sqlOrder.some((sql) => /token_market_buckets_1m/.test(sql)), false);
    assert.ok(sqlOrder.some((sql) => /DELETE FROM token_market_buckets_agg/.test(sql)));
    assert.ok(sqlOrder.some((sql) => /INSERT INTO token_market_buckets_agg/.test(sql)));
    const rollupCalls = fakeDb.calls.filter((call) => /coingecko_backfill_rollup/.test(call.sql));
    assert.deepEqual(rollupCalls.map((call) => call.params[3]), [15, 30, 60, 240, 1440]);
    assert.ok(rollupCalls.every((call) => /FROM token_market_buckets_agg/.test(call.sql)));
    assert.ok(rollupCalls.every((call) => /granularity_minutes = \$5::int/.test(call.sql)));
    assert.ok(rollupCalls.every((call) => !/source_stats AS/.test(call.sql)));
    assert.deepEqual(rollupCalls[0].params.slice(1, 4), [
      '2026-07-02T18:00:00.000Z',
      '2026-07-02T18:15:00.000Z',
      15,
    ]);
    assert.ok(sqlOrder.includes('COMMIT'));
  });

  it('refuses to overwrite recent 1m candles before opening a transaction', async () => {
    const plan = buildPlan(1);
    plan.readiness = { canReplace: true, blockers: [] };
    const buckets = planner.buildBackfillBuckets([
      { bucketTs: '2026-07-02T18:00:00.000Z', open: 0.1, high: 0.12, low: 0.09, close: 0.11, volume: 100 },
    ], {
      tokenAddress: TOKEN_ADDRESS,
      poolAddress: POOL_ADDRESS,
      granularityMinutes: 1,
      mcapMultiplier: plan.mcapMultiplier.value,
    });
    const fakeDb = buildFakeDb();

    await assert.rejects(
      () => writer.executeReplaceChart({
        db: fakeDb.db,
        plan,
        buckets,
        now: new Date('2026-07-02T19:00:00.000Z'),
      }),
      /protected 1m candles from the last 14 days/
    );

    assert.equal(fakeDb.calls.length, 0);
  });

  it('keeps an allowed 1m replace and its rollups scoped to Solana', async () => {
    const plan = buildPlan(1);
    plan.readiness = { canReplace: true, blockers: [] };
    const buckets = planner.buildBackfillBuckets([
      { bucketTs: '2026-07-02T18:00:00.000Z', open: 0.1, high: 0.12, low: 0.09, close: 0.11, volume: 100 },
    ], {
      tokenAddress: TOKEN_ADDRESS,
      poolAddress: POOL_ADDRESS,
      granularityMinutes: 1,
      mcapMultiplier: plan.mcapMultiplier.value,
    });
    const fakeDb = buildFakeDb();
    const fakeFs = buildFakeFs();

    const result = await writer.executeReplaceChart({
      db: fakeDb.db,
      fsImpl: fakeFs.fsImpl,
      backupDir: '/tmp/backups',
      plan,
      buckets,
      now: new Date('2026-07-30T00:00:00.000Z'),
    });

    assert.equal(result.insertedOrUpdated, 1);
    const relevant = fakeDb.calls.filter((call) => /token_market_buckets_(?:1m|agg)/.test(call.sql));
    assert.ok(relevant.every((call) => /chain = 'solana'|'solana'/.test(call.sql)));
    const insert = relevant.find((call) => /INSERT INTO token_market_buckets_1m/.test(call.sql));
    assert.match(insert.sql, /chain,\s+token_address/);
    assert.match(insert.sql, /ON CONFLICT \(chain, token_address, bucket_ts\)/);
  });

  it('rolls back when backup writing fails before deletes run', async () => {
    const plan = buildPlan();
    const buckets = planner.buildBackfillBuckets([
      { bucketTs: '2026-07-02T18:00:00.000Z', open: 0.1, high: 0.12, low: 0.09, close: 0.11, volume: 100 },
    ], {
      tokenAddress: TOKEN_ADDRESS,
      poolAddress: POOL_ADDRESS,
      granularityMinutes: 5,
      mcapMultiplier: plan.mcapMultiplier.value,
    });
    const fakeDb = buildFakeDb();
    const fakeFs = buildFakeFs({ failWrite: true });

    await assert.rejects(
      () => writer.executeReplaceChart({
        db: fakeDb.db,
        fsImpl: fakeFs.fsImpl,
        backupDir: '/tmp/backups',
        plan,
        buckets,
      }),
      /backup failed/
    );

    const sqlOrder = fakeDb.calls.map((call) => call.sql);
    assert.ok(sqlOrder.includes('ROLLBACK'));
    assert.equal(sqlOrder.some((sql) => /DELETE FROM token_market_buckets_1m/.test(sql)), false);
    assert.equal(sqlOrder.some((sql) => /INSERT INTO token_market_buckets_1m/.test(sql)), false);
  });

  it('rolls back the entire replace when a dependent aggregate rebuild fails', async () => {
    const plan = buildPlan();
    const buckets = planner.buildBackfillBuckets([
      { bucketTs: '2026-07-02T18:00:00.000Z', open: 0.1, high: 0.12, low: 0.09, close: 0.11, volume: 100 },
    ], {
      tokenAddress: TOKEN_ADDRESS,
      poolAddress: POOL_ADDRESS,
      granularityMinutes: 5,
      mcapMultiplier: plan.mcapMultiplier.value,
    });
    const fakeDb = buildFakeDb({ failRollupGranularity: 60 });
    const fakeFs = buildFakeFs();

    await assert.rejects(
      () => writer.executeReplaceChart({
        db: fakeDb.db,
        fsImpl: fakeFs.fsImpl,
        backupDir: '/tmp/backups',
        plan,
        buckets,
      }),
      /rollup 60m failed/
    );

    const sqlOrder = fakeDb.calls.map((call) => call.sql);
    const aggregateInserts = fakeDb.calls.filter((call) => /INSERT INTO token_market_buckets_agg/.test(call.sql));
    assert.ok(aggregateInserts.length > 0);
    assert.ok(aggregateInserts.every((call) => /chain,\s+token_address/.test(call.sql)));
    assert.match(aggregateInserts[0].sql,
      /ON CONFLICT \(chain, token_address, granularity_minutes, bucket_ts\)/);
    assert.ok(sqlOrder.includes('ROLLBACK'));
    assert.equal(sqlOrder.includes('COMMIT'), false);
  });
});
