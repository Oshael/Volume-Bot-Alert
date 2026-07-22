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
      return { rows: [{ chain: params[0], token_address: params[1], close_vol_1m: params[3] }] };
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
      assert.equal(row.chain, 'solana');
      assert.match(calls[0].sql, /INSERT INTO token_market_volume_buckets_1m \(\s+chain,/);
      assert.match(calls[0].sql, /VALUES \(\$1, \$2/);
      assert.match(calls[0].sql, /ON CONFLICT \(chain, token_address, bucket_ts\)/);
      assert.match(calls[0].sql, /close_vol_1m/);
      assert.equal(calls[0].params[0], 'solana');
      assert.equal(calls[0].params[3], 150);
      assert.equal(calls[0].params[4], 900);
      assert.equal(calls[0].params[8], 'gmgn');
      assert.deepEqual(JSON.parse(calls[0].params[9]), {
        '1m': { state: 'partial', source: 'gmgn' },
        '5m': { state: 'partial', source: 'gmgn' },
      });
      assert.match(calls[0].sql,
        /window_coverage = jsonb_strip_nulls\(jsonb_build_object\(/);
    } finally {
      db.query = originalQuery;
    }
  });

  it('does not let a partial conflict overwrite a complete stored window', () => {
    const sql = tokenMarketVolumeBucket1m.__private.UPSERT_SNAPSHOT_SQL;
    const volumeAssignment = sql.match(/close_vol_6h = CASE[\s\S]*?END,/)[0];
    const coverageStart = sql.indexOf("'6h', CASE");
    const coverageEntry = sql.slice(coverageStart, sql.indexOf("'24h', CASE", coverageStart));

    assert.match(volumeAssignment, /WHEN 'complete' THEN 2 WHEN 'partial' THEN 1/);
    assert.match(volumeAssignment, /> \(CASE/);
    assert.match(volumeAssignment,
      /THEN token_market_volume_buckets_1m\.close_vol_6h ELSE EXCLUDED\.close_vol_6h/);
    assert.match(coverageEntry,
      /THEN token_market_volume_buckets_1m\.window_coverage -> '6h'/);
    assert.match(coverageEntry, /ELSE EXCLUDED\.window_coverage -> '6h'/);
  });

  it('keeps missing volume null and stores explicit coverage provenance', async () => {
    const originalQuery = db.query;
    let params;
    db.query = async (_sql, values) => {
      params = values;
      return { rows: [{}] };
    };

    try {
      await tokenMarketVolumeBucket1m.upsertSnapshotBucket({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        vol5m: null,
        vol1h: 500,
        volumeCoverage: { '1h': 'complete' },
      });
      assert.equal(params[4], null);
      assert.equal(params[5], 500);
      assert.deepEqual(JSON.parse(params[9]), {
        '1h': { state: 'complete', source: 'dexscreener' },
      });
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
      assert.equal((calls[0].sql.match(/chain = \$3/g) || []).length, 3);
      assert.deepEqual(calls[0].params[0], ['So11111111111111111111111111111111111111112']);
      assert.equal(calls[0].params[1], 1);
      assert.equal(calls[0].params[2], 'solana');
    } finally {
      db.query = originalQuery;
    }
  });

  it('falls back to 5m for unsupported volume windows', () => {
    assert.equal(tokenMarketVolumeBucket1m.__private.normalizeVolumeWindow('unsafe_window'), '5m');
  });

  it('keeps destructive legacy cleanup scoped to Solana', async () => {
    const originalQuery = db.query;
    const originalTimeoutQuery = db.queryWithStatementTimeout;
    const calls = [];
    db.query = async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rowCount: 0 };
    };
    db.queryWithStatementTimeout = async (sql, params) => {
      calls.push({ sql: String(sql), params });
      return { rowCount: 0 };
    };

    try {
      const address = 'So11111111111111111111111111111111111111112';
      await tokenMarketVolumeBucket1m.deleteByAddresses([address]);
      await tokenMarketVolumeBucket1m.deleteChunkByAddress(address);
      assert.equal(calls.length, 2);
      assert.match(calls[0].sql, /chain = \$1/);
      assert.deepEqual(calls[0].params, ['solana', [address]]);
      assert.match(calls[1].sql, /chain = \$1/);
      assert.match(calls[1].sql, /LIMIT \$3/);
      assert.deepEqual(calls[1].params, ['solana', address, 250]);
    } finally {
      db.query = originalQuery;
      db.queryWithStatementTimeout = originalTimeoutQuery;
    }
  });

  it('normalizes Robinhood identity for future chain-specific writers', async () => {
    const originalQuery = db.query;
    let captured = null;
    db.query = async (sql, params) => {
      captured = { sql: String(sql), params };
      return { rows: [{ chain: params[0], token_address: params[1] }] };
    };

    try {
      const row = await tokenMarketVolumeBucket1m.upsertSnapshotBucket({
        chain: 'robinhood',
        tokenAddress: '0x1234567890ABCDEF1234567890ABCDEF12345678',
        ts: '2026-07-12T12:00:00.000Z',
        vol1m: 10,
      });
      assert.equal(row.chain, 'robinhood');
      assert.equal(captured.params[1], '0x1234567890abcdef1234567890abcdef12345678');
      assert.match(captured.sql, /ON CONFLICT \(chain, token_address, bucket_ts\)/);
    } finally {
      db.query = originalQuery;
    }
  });
});
