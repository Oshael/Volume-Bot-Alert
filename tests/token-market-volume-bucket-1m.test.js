const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokenMarketVolumeBucket1m = require('../src/models/token-market-volume-bucket-1m');
const db = require('../src/models/db');

describe('token market volume 1m bucket helpers', () => {
  it('rounds timestamps down to the start of the minute in UTC', () => {
    const bucketDate = tokenMarketVolumeBucket1m.__private.getBucketDate('2026-03-24T04:18:59.999Z');
    assert.equal(bucketDate.toISOString(), '2026-03-24T04:18:00.000Z');
  });

  it('preserves exact minute boundaries', () => {
    const bucketDate = tokenMarketVolumeBucket1m.__private.getBucketDate('2026-03-24T04:18:00.000Z');
    assert.equal(bucketDate.toISOString(), '2026-03-24T04:18:00.000Z');
  });

  it('writes 1m volume close values when present', async () => {
    const originalQuery = db.query;
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [{ token_address: params[0], close_vol_1m: params[2] }] };
    };

    try {
      const row = await tokenMarketVolumeBucket1m.upsertSnapshotBucket({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        ts: '2026-03-24T04:18:59.999Z',
        vol1m: 150,
        vol5m: 900,
        source: 'gmgn',
      });

      assert.equal(row.close_vol_1m, 150);
      assert.match(calls[0].sql, /close_vol_1m/);
      assert.equal(calls[0].params[2], 150);
      assert.equal(calls[0].params[3], 900);
      assert.equal(calls[0].params[7], 'gmgn');
    } finally {
      db.query = originalQuery;
    }
  });

  it('uses the requested safe volume window for current and baseline lookups', async () => {
    const originalQuery = db.query;
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rows: [] };
    };

    try {
      await tokenMarketVolumeBucket1m.listCurrentAndBaselineByAddresses(
        ['So11111111111111111111111111111111111111112'],
        1,
        { volumeWindow: '1m' }
      );

      assert.match(calls[0].sql, /close_vol_1m AS current_volume/);
      assert.match(calls[0].sql, /baseline_vol_1m/);
      assert.deepEqual(calls[0].params[0], ['So11111111111111111111111111111111111111112']);
      assert.equal(calls[0].params[1], 1);
    } finally {
      db.query = originalQuery;
    }
  });

  it('falls back to 5m for unsupported volume windows', () => {
    assert.equal(tokenMarketVolumeBucket1m.__private.normalizeVolumeWindow('unsafe_window'), '5m');
  });
});
