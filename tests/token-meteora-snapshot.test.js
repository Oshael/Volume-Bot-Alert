const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenMeteoraSnapshot = require('../src/models/token-meteora-snapshot');

describe('token meteora snapshot model', () => {
  it('limits worker baseline lookups to fresh snapshots near each window target', async () => {
    const calls = [];
    const anchorTs = new Date('2026-07-10T19:52:09.000Z');
    const runner = {
      query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [] };
      },
    };

    await tokenMeteoraSnapshot.listBaselineTvlsByAddresses([
      'So11111111111111111111111111111111111111112',
    ], anchorTs, runner);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, [[
      'So11111111111111111111111111111111111111112',
    ], anchorTs]);
    assert.match(calls[0].sql, /ts <= \$2::timestamptz - INTERVAL '1 hour'\s+AND ts >= \$2::timestamptz - INTERVAL '1 hour' - INTERVAL '20 minutes'/);
    assert.match(calls[0].sql, /ts <= \$2::timestamptz - INTERVAL '4 hour'\s+AND ts >= \$2::timestamptz - INTERVAL '4 hour' - INTERVAL '1 hour'/);
    assert.match(calls[0].sql, /ts <= \$2::timestamptz - INTERVAL '6 hour'\s+AND ts >= \$2::timestamptz - INTERVAL '6 hour' - INTERVAL '1 hour'/);
    assert.match(calls[0].sql, /ts <= \$2::timestamptz - INTERVAL '24 hour'\s+AND ts >= \$2::timestamptz - INTERVAL '24 hour' - INTERVAL '3 hour'/);
  });

  it('limits latest summary fallback baselines to snapshots near each window target', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [] };
    };

    try {
      await tokenMeteoraSnapshot.listLatestSummaryByAddresses([
        'So11111111111111111111111111111111111111112',
      ]);

      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].params, [[
        'So11111111111111111111111111111111111111112',
      ]]);
      assert.match(calls[0].sql, /ts <= latest\.current_ts - INTERVAL '1 hour'\s+AND ts >= latest\.current_ts - INTERVAL '1 hour' - INTERVAL '20 minutes'/);
      assert.match(calls[0].sql, /ts > latest\.current_ts - INTERVAL '1 hour'\s+AND ts <= latest\.current_ts - INTERVAL '1 hour' \+ INTERVAL '20 minutes'/);
      assert.match(calls[0].sql, /ts <= latest\.current_ts - INTERVAL '4 hour'\s+AND ts >= latest\.current_ts - INTERVAL '4 hour' - INTERVAL '1 hour'/);
      assert.match(calls[0].sql, /ts > latest\.current_ts - INTERVAL '4 hour'\s+AND ts <= latest\.current_ts - INTERVAL '4 hour' \+ INTERVAL '1 hour'/);
      assert.match(calls[0].sql, /ts <= latest\.current_ts - INTERVAL '6 hour'\s+AND ts >= latest\.current_ts - INTERVAL '6 hour' - INTERVAL '1 hour'/);
      assert.match(calls[0].sql, /ts > latest\.current_ts - INTERVAL '6 hour'\s+AND ts <= latest\.current_ts - INTERVAL '6 hour' \+ INTERVAL '1 hour'/);
      assert.match(calls[0].sql, /ts <= latest\.current_ts - INTERVAL '24 hour'\s+AND ts >= latest\.current_ts - INTERVAL '24 hour' - INTERVAL '3 hour'/);
      assert.match(calls[0].sql, /ts > latest\.current_ts - INTERVAL '24 hour'\s+AND ts <= latest\.current_ts - INTERVAL '24 hour' \+ INTERVAL '3 hour'/);
    } finally {
      db.query = originalQuery;
    }
  });
});
