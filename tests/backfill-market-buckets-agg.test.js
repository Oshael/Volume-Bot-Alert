const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const backfillBucketsAgg = require('../src/utils/backfill-market-buckets-agg');

describe('backfill aggregate market buckets', () => {
  it('defaults to a 14d lookback with supported granularities', () => {
    const parsed = backfillBucketsAgg.__private.parseCliArgs([]);

    assert.equal(parsed.lookbackHours, 14 * 24);
    assert.equal(parsed.all, false);
    assert.equal(parsed.batchSize, 250);
    assert.deepEqual(parsed.granularities, [5, 15, 30]);
  });

  it('supports day-based lookback, cursor resume, and selected granularities', () => {
    const parsed = backfillBucketsAgg.__private.parseCliArgs([
      '--days',
      '3',
      '--batchSize',
      '25',
      '--afterAddress',
      'So11111111111111111111111111111111111111112',
      '--granularity',
      '5,30',
    ]);

    assert.equal(parsed.lookbackHours, 72);
    assert.equal(parsed.batchSize, 25);
    assert.equal(parsed.afterAddress, 'So11111111111111111111111111111111111111112');
    assert.deepEqual(parsed.granularities, [5, 30]);
  });

  it('supports all-history mode', () => {
    const parsed = backfillBucketsAgg.__private.parseCliArgs(['--all']);

    assert.equal(parsed.all, true);
    assert.equal(parsed.lookbackHours, null);
  });

  it('rejects unsupported granularities', () => {
    assert.throws(
      () => backfillBucketsAgg.__private.parseCliArgs(['--granularity', '10']),
      /granularity must be one of/
    );
  });

  it('builds aggregate backfill SQL from 1m buckets', async () => {
    const originalQuery = db.query;
    let capturedSql = '';
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [], rowCount: 7 };
    };

    try {
      const rowCount = await backfillBucketsAgg.__private.backfillAggregateBuckets([
        'So11111111111111111111111111111111111111112',
      ], 15, {
        all: false,
        lookbackHours: 72,
      });

      assert.equal(rowCount, 7);
      assert.match(capturedSql, /INSERT INTO token_market_buckets_agg/);
      assert.match(capturedSql, /FROM token_market_buckets_1m b/);
      assert.match(capturedSql, /date_trunc\('hour', b\.bucket_ts\)/);
      assert.match(capturedSql, /FLOOR\(EXTRACT\(MINUTE FROM b\.bucket_ts\) \/ \$2::numeric\)::int/);
      assert.match(capturedSql, /ON CONFLICT \(token_address, granularity_minutes, bucket_ts\) DO UPDATE SET/);
      assert.deepEqual(capturedParams, [[
        'So11111111111111111111111111111111111111112',
      ], 15, 72]);
    } finally {
      db.query = originalQuery;
    }
  });

  it('paginates candidate addresses after the resume cursor', async () => {
    const originalQuery = db.query;
    let capturedSql = '';
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [
          { token_address: 'So11111111111111111111111111111111111111113' },
        ],
      };
    };

    try {
      const rows = await backfillBucketsAgg.__private.listCandidateAddresses({
        all: false,
        lookbackHours: 48,
        batchSize: 10,
      }, 'So11111111111111111111111111111111111111112');

      assert.deepEqual(rows, ['So11111111111111111111111111111111111111113']);
      assert.match(capturedSql, /b\.token_address > \$2/);
      assert.match(capturedSql, /LIMIT \$3::int/);
      assert.deepEqual(capturedParams, [48, 'So11111111111111111111111111111111111111112', 10]);
    } finally {
      db.query = originalQuery;
    }
  });

  it('does not write rows when dryRun is combined with resetRange', async () => {
    const originalQuery = db.query;
    const statements = [];

    db.query = async (sql) => {
      statements.push(sql);
      return statements.length === 1
        ? { rows: [{ token_address: 'So11111111111111111111111111111111111111112' }] }
        : { rows: [] };
    };

    try {
      const result = await backfillBucketsAgg.__private.runBackfill({
        all: false,
        lookbackHours: 48,
        batchSize: 1,
        dryRun: true,
        resetRange: true,
        granularities: [5],
      });

      assert.equal(result.processedAddressCount, 1);
      assert.equal(result.totalAggregateRows, 0);
      assert.equal(statements.length, 2);
      assert(statements.every((statement) => /^SELECT DISTINCT b\.token_address/.test(statement.trim())));
    } finally {
      db.query = originalQuery;
    }
  });
});
