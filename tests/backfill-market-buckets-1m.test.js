const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const backfillBuckets = require('../src/utils/backfill-market-buckets-1m');
const db = require('../src/models/db');

describe('backfill market buckets cli parsing', () => {
  it('defaults to a 48h lookback', () => {
    const parsed = backfillBuckets.__private.parseCliArgs([]);
    assert.equal(parsed.lookbackHours, 48);
    assert.equal(parsed.all, false);
  });

  it('supports day-based lookback conversion', () => {
    const parsed = backfillBuckets.__private.parseCliArgs(['--days', '3']);
    assert.equal(parsed.lookbackHours, 72);
  });

  it('supports all-history mode', () => {
    const parsed = backfillBuckets.__private.parseCliArgs(['--all']);
    assert.equal(parsed.all, true);
    assert.equal(parsed.lookbackHours, null);
  });

  it('rejects invalid numeric arguments', () => {
    assert.throws(
      () => backfillBuckets.__private.parseCliArgs(['--hours', 'abc']),
      /hours must be an integer/
    );
  });

  it('keeps reset and upsert scoped to the Solana composite bucket identity', async () => {
    const originalQuery = db.query;
    const calls = [];
    db.query = async (sql) => {
      calls.push(String(sql));
      return { rows: [], rowCount: 0 };
    };

    try {
      const options = { all: true, lookbackHours: null, limitAddresses: null };
      await backfillBuckets.__private.resetExistingBuckets(options);
      await backfillBuckets.__private.backfillBuckets(options);

      assert.match(calls[0], /buckets\.chain = 'solana'/);
      assert.match(calls[1], /INSERT INTO token_market_buckets_1m \(\s+chain,/);
      assert.match(calls[1], /SELECT\s+'solana',\s+token_address/);
      assert.match(calls[1], /ON CONFLICT \(chain, token_address, bucket_ts\)/);
    } finally {
      db.query = originalQuery;
    }
  });
});
