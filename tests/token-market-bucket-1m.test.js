const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');

describe('token market 1m bucket helpers', () => {
  it('rounds timestamps down to the start of the minute in UTC', () => {
    const bucketDate = tokenMarketBucket1m.__private.getBucketDate('2026-03-24T04:18:59.999Z');
    assert.equal(bucketDate.toISOString(), '2026-03-24T04:18:00.000Z');
  });

  it('preserves exact minute boundaries', () => {
    const bucketDate = tokenMarketBucket1m.__private.getBucketDate('2026-03-24T04:18:00.000Z');
    assert.equal(bucketDate.toISOString(), '2026-03-24T04:18:00.000Z');
  });

  it('marks a wick-based high-cap dump using the baseline market cap gate', () => {
    const detection = tokenMarketBucket1m.__private.buildHighCapDumpDetection({
      token_address: 'So11111111111111111111111111111111111111112',
      baseline_ts: '2026-04-05T12:00:00.000Z',
      baseline_mcap: 8_000_000,
      current_ts: '2026-04-05T12:05:00.000Z',
      current_close_mcap: 3_600_000,
      window_low_mcap: 3_200_000,
      bucket_count: 5,
    }, {
      referenceTs: '2026-04-05T12:05:30.000Z',
    });

    assert.equal(detection.passesHighCapGate, true);
    assert.equal(detection.passesCoverageGate, true);
    assert.equal(detection.passesFreshnessGate, true);
    assert.equal(detection.passesThreshold, true);
    assert.equal(detection.dumpPct, -60);
  });

  it('does not use current market cap for the high-cap gate', () => {
    const detection = tokenMarketBucket1m.__private.buildHighCapDumpDetection({
      token_address: 'So11111111111111111111111111111111111111112',
      baseline_ts: '2026-04-05T12:00:00.000Z',
      baseline_mcap: 4_500_000,
      current_ts: '2026-04-05T12:05:00.000Z',
      current_close_mcap: 2_900_000,
      window_low_mcap: 2_100_000,
      bucket_count: 5,
    }, {
      referenceTs: '2026-04-05T12:05:10.000Z',
    });

    assert.equal(detection.passesHighCapGate, true);
    assert.equal(detection.passesThreshold, true);
  });

  it('fails freshness and coverage gates when the window is stale and sparse', () => {
    const detection = tokenMarketBucket1m.__private.buildHighCapDumpDetection({
      token_address: 'So11111111111111111111111111111111111111112',
      baseline_ts: '2026-04-05T12:00:00.000Z',
      baseline_mcap: 6_000_000,
      current_ts: '2026-04-05T12:05:00.000Z',
      current_close_mcap: 5_000_000,
      window_low_mcap: 2_900_000,
      bucket_count: 2,
    }, {
      referenceTs: '2026-04-05T12:07:00.000Z',
    });

    assert.equal(detection.passesCoverageGate, false);
    assert.equal(detection.passesFreshnessGate, false);
    assert.equal(detection.passesThreshold, true);
  });

  it('maps strict high-cap dump detections by address from the database row shape', async () => {
    const originalQuery = db.query;
    let capturedSql = '';
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [
          {
            token_address: 'So11111111111111111111111111111111111111112',
            baseline_ts: '2026-04-05T12:00:00.000Z',
            baseline_mcap: '7000000',
            current_ts: '2026-04-05T12:05:00.000Z',
            current_close_mcap: '5000000',
            window_low_mcap: '3200000',
            bucket_count: 5,
          },
        ],
      };
    };

    try {
      const rows = await tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses(
        ['So11111111111111111111111111111111111111112'],
        { referenceTs: '2026-04-05T12:05:20.000Z' }
      );

      assert.match(capturedSql, /bucket_ts <= current_row\.current_ts - \(\$2::int \* INTERVAL '1 minute'\)/);
      assert.match(capturedSql, /bucket_ts >= current_row\.current_ts - \(\(\$2::int \+ 1\) \* INTERVAL '1 minute'\)/);
      assert.match(capturedSql, /bucket_ts > current_row\.current_ts - \(\$2::int \* INTERVAL '1 minute'\)/);
      assert.doesNotMatch(capturedSql, /bucket_ts > baseline_row\.baseline_ts/);
      assert.doesNotMatch(capturedSql, /fallback/i);
      assert.deepEqual(capturedParams, [['So11111111111111111111111111111111111111112'], 5]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tokenAddress, 'So11111111111111111111111111111111111111112');
      assert.equal(rows[0].passesHighCapGate, true);
      assert.equal(rows[0].passesThreshold, true);
      assert.equal(rows[0].latestBucketAgeMs, 20_000);
    } finally {
      db.query = originalQuery;
    }
  });
});
