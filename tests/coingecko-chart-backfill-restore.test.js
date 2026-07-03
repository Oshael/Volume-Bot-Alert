const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const restore = require('../src/services/coingecko-chart-backfill-restore');

const TOKEN_ADDRESS = '8wxkvAfEns76yBzu4MnbV7VnXWjg3iDPA9uwAQ6cpump';

function buildPayload() {
  return {
    generatedAt: '2026-07-02T19:00:00.000Z',
    operation: 'coingecko_replace_chart_backup',
    token: { address: TOKEN_ADDRESS, symbol: 'SOLANGELES' },
    poolAddress: 'Ak7hDCxDSocD2ZgJBCa1ZwLcuDQz5F6n747a7rQtpXE3',
    granularityMinutes: 5,
    range: {
      firstBucketAt: '2026-07-02T18:00:00.000Z',
      latestBucketAt: '2026-07-02T18:05:00.000Z',
    },
    counts: { tokenMarketBuckets1m: 0, tokenMarketBucketsAgg: 2 },
    tokenMarketBuckets1m: [],
    tokenMarketBucketsAgg: [
      {
        token_address: TOKEN_ADDRESS,
        granularity_minutes: 5,
        bucket_ts: '2026-07-02T18:00:00.000Z',
        pair_address: 'pool',
        open_mcap: '100', high_mcap: '120', low_mcap: '90', close_mcap: '110',
        open_price: '0.1', high_price: '0.12', low_price: '0.09', close_price: '0.11',
        sample_count: 1,
        source: 'aggregate',
      },
      {
        token_address: TOKEN_ADDRESS,
        granularity_minutes: 15,
        bucket_ts: '2026-07-02T18:00:00.000Z',
        pair_address: 'pool',
        open_mcap: '100', high_mcap: '130', low_mcap: '90', close_mcap: '125',
        open_price: '0.1', high_price: '0.13', low_price: '0.09', close_price: '0.125',
        sample_count: 3,
        source: 'aggregate',
      },
    ],
  };
}

function buildFakeDb(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }
      if (/DELETE FROM token_market_buckets_agg/.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      if (/INSERT INTO token_market_buckets_agg/.test(sql)) {
        if (options.failInsert) throw new Error('restore insert failed');
        return { rows: [], rowCount: params.length / 14 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {
      calls.push({ sql: 'RELEASE', params: [] });
    },
  };
  return { calls, db: { getClient: async () => client } };
}

describe('CoinGecko chart backup restore', () => {
  it('rejects a backup whose token or declared counts do not match', () => {
    assert.throws(
      () => restore.validateBackupPayload(buildPayload(), 'OtherTokenAddress111111111111111111111111111'),
      /does not match --token/
    );

    const invalidCounts = buildPayload();
    invalidCounts.counts.tokenMarketBucketsAgg = 3;
    assert.throws(
      () => restore.validateBackupPayload(invalidCounts, TOKEN_ADDRESS),
      /row counts do not match/
    );

    const ambiguous = buildPayload();
    delete ambiguous.granularityMinutes;
    assert.throws(
      () => restore.validateBackupPayload(ambiguous, TOKEN_ADDRESS),
      /granularityMinutes must be explicitly 1 or 5/
    );
  });

  it('deletes the changed scopes and restores backed-up aggregate rows atomically', async () => {
    const backup = restore.validateBackupPayload(buildPayload(), TOKEN_ADDRESS);
    const fake = buildFakeDb();

    const result = await restore.executeRestore({ db: fake.db, backup });

    assert.equal(result.writes, true);
    assert.equal(result.restored.tokenMarketBucketsAgg, 2);
    const deleteCalls = fake.calls.filter((call) => /DELETE FROM token_market_buckets_agg/.test(call.sql));
    assert.deepEqual(deleteCalls.map((call) => call.params[1]), [5, 15, 30, 60, 240, 1440]);
    assert.ok(fake.calls.some((call) => /INSERT INTO token_market_buckets_agg/.test(call.sql)));
    assert.ok(fake.calls.some((call) => call.sql === 'COMMIT'));
  });

  it('rolls back when backed-up rows cannot be restored', async () => {
    const backup = restore.validateBackupPayload(buildPayload(), TOKEN_ADDRESS);
    const fake = buildFakeDb({ failInsert: true });

    await assert.rejects(
      () => restore.executeRestore({ db: fake.db, backup }),
      /restore insert failed/
    );

    assert.ok(fake.calls.some((call) => call.sql === 'ROLLBACK'));
    assert.equal(fake.calls.some((call) => call.sql === 'COMMIT'), false);
  });
});
