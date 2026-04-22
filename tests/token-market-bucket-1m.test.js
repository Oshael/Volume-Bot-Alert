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
      baseline_pair_address: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
      baseline_mcap: 8_000_000,
      current_ts: '2026-04-05T12:05:00.000Z',
      current_pair_address: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
      current_close_mcap: 3_600_000,
      window_low_bucket_ts: '2026-04-05T12:03:00.000Z',
      window_low_pair_address: '4Yx3iT9W3YfAqQKpH5uVh6hNnZx4oLrR8j9t4Qw2fN3m',
      window_low_mcap: 3_200_000,
      bucket_count: 5,
      window_pair_count: 2,
    }, {
      referenceTs: '2026-04-05T12:05:30.000Z',
    });

    assert.equal(detection.passesHighCapGate, true);
    assert.equal(detection.passesCoverageGate, true);
    assert.equal(detection.passesFreshnessGate, true);
    assert.equal(detection.passesThreshold, true);
    assert.equal(detection.passesPairConsistencyGate, false);
    assert.equal(detection.dumpPct, -60);
    assert.equal(detection.pairChangedInWindow, true);
    assert.equal(detection.windowLowPairAddress, '4Yx3iT9W3YfAqQKpH5uVh6hNnZx4oLrR8j9t4Qw2fN3m');
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
            pinned_pair_address: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
            baseline_ts: '2026-04-05T12:00:00.000Z',
            baseline_pair_address: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
            baseline_mcap: '7000000',
            current_ts: '2026-04-05T12:05:00.000Z',
            current_pair_address: '4Yx3iT9W3YfAqQKpH5uVh6hNnZx4oLrR8j9t4Qw2fN3m',
            live_current_ts: '2026-04-05T12:05:00.000Z',
            live_current_pair_address: '4Yx3iT9W3YfAqQKpH5uVh6hNnZx4oLrR8j9t4Qw2fN3m',
            current_close_mcap: '5000000',
            window_low_bucket_ts: '2026-04-05T12:03:00.000Z',
            window_low_pair_address: '4Yx3iT9W3YfAqQKpH5uVh6hNnZx4oLrR8j9t4Qw2fN3m',
            window_low_mcap: '3200000',
            bucket_count: 5,
            window_pair_count: 2,
          },
        ],
      };
    };

    try {
      const rows = await tokenMarketBucket1m.listHighCapDumpDetectionsByAddresses(
        ['So11111111111111111111111111111111111111112'],
        { referenceTs: '2026-04-05T12:05:20.000Z' }
      );

      assert.match(capturedSql, /bucket_ts <= current_row\.current_ts - \(\$3::int \* INTERVAL '1 minute'\)/);
      assert.match(capturedSql, /bucket_ts >= current_row\.current_ts - \(\(\$3::int \+ 1\) \* INTERVAL '1 minute'\)/);
      assert.match(capturedSql, /bucket_ts > current_row\.current_ts - \(\$3::int \* INTERVAL '1 minute'\)/);
      assert.doesNotMatch(capturedSql, /bucket_ts > baseline_row\.baseline_ts/);
      assert.doesNotMatch(capturedSql, /fallback/i);
      assert.deepEqual(capturedParams, [['So11111111111111111111111111111111111111112'], [null], 5]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].tokenAddress, 'So11111111111111111111111111111111111111112');
      assert.equal(rows[0].passesHighCapGate, true);
      assert.equal(rows[0].passesThreshold, true);
      assert.equal(rows[0].passesPairConsistencyGate, false);
      assert.equal(rows[0].latestBucketAgeMs, 20_000);
      assert.equal(rows[0].pairChangedInWindow, true);
      assert.equal(rows[0].baselinePairAddress, '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1');
      assert.equal(rows[0].currentPairAddress, '4Yx3iT9W3YfAqQKpH5uVh6hNnZx4oLrR8j9t4Qw2fN3m');
      assert.equal(rows[0].pinnedPairAddress, '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1');
      assert.equal(rows[0].liveCurrentPairAddress, '4Yx3iT9W3YfAqQKpH5uVh6hNnZx4oLrR8j9t4Qw2fN3m');
    } finally {
      db.query = originalQuery;
    }
  });

  it('includes pairAddress in history rows for bucket-level diagnostics', async () => {
    const originalQuery = db.query;

    db.query = async () => ({
      rows: [
        {
          token_address: 'So11111111111111111111111111111111111111112',
          bucket_ts: '2026-04-05T12:05:00.000Z',
          pair_address: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
          open_mcap: '7000000',
          high_mcap: '7100000',
          low_mcap: '6800000',
          close_mcap: '6900000',
          open_price: '1.1',
          high_price: '1.2',
          low_price: '1.0',
          close_price: '1.15',
          sample_count: 3,
          source: 'dexscreener',
        },
      ],
    });

    try {
      const rows = await tokenMarketBucket1m.listHistoryByAddress('So11111111111111111111111111111111111111112');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].pairAddress, '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1');
      assert.equal(rows[0].sampleCount, 3);
    } finally {
      db.query = originalQuery;
    }
  });

  it('builds a fixed-width sparkline series from bucket history', () => {
    const sparkline = tokenMarketBucket1m.__private.buildSparklineSeriesFromBuckets([
      {
        ts: '2026-04-05T12:00:00.000Z',
        closeMcap: 100,
        pairAddress: 'So11111111111111111111111111111111111111112',
      },
      {
        ts: '2026-04-05T12:01:00.000Z',
        closeMcap: 120,
        pairAddress: 'So11111111111111111111111111111111111111112',
      },
      {
        ts: '2026-04-05T12:03:00.000Z',
        closeMcap: 90,
        pairAddress: 'So11111111111111111111111111111111111111112',
      },
    ], {
      hours: 1,
      points: 60,
      granularityMinutes: 1,
    });

    assert.equal(sparkline.series.length, 60);
    assert.equal(sparkline.series[0], 100);
    assert.equal(sparkline.series[sparkline.series.length - 1], 90);
    assert(Math.max(...sparkline.series) > 119);
    assert(Math.max(...sparkline.series) <= 120);
    assert.equal(Math.min(...sparkline.series), 90);
    assert.equal(sparkline.bucketCount, 3);
    assert.equal(sparkline.effectiveHours, 0.05);
    assert.equal(sparkline.granularityMinutes, 1);
    assert.equal(sparkline.coverageRatio, 1);
  });

  it('compresses the sparkline window to the token lifespan when younger than 14d', () => {
    const sparkline = tokenMarketBucket1m.__private.buildSparklineSeriesFromBuckets([
      {
        ts: '2026-04-05T00:00:00.000Z',
        closeMcap: 100,
        pairAddress: 'So11111111111111111111111111111111111111112',
      },
      {
        ts: '2026-04-08T00:00:00.000Z',
        closeMcap: 160,
        pairAddress: 'So11111111111111111111111111111111111111112',
      },
    ], {
      hours: 14 * 24,
      points: 20,
      granularityMinutes: 15,
    });

    assert.equal(sparkline.series.length, 20);
    assert.equal(sparkline.series[0], 100);
    assert.equal(sparkline.series[sparkline.series.length - 1], 160);
    assert.equal(sparkline.effectiveHours, 72);
    assert.equal(sparkline.granularityMinutes, 15);
  });

  it('interpolates sparse sparkline gaps before downsampling', () => {
    const denseSeries = tokenMarketBucket1m.__private.buildDenseSparklineMinuteSeries([
      {
        tsMs: Date.parse('2026-04-05T12:00:00.000Z'),
        closeMcap: 100,
      },
      {
        tsMs: Date.parse('2026-04-05T12:03:00.000Z'),
        closeMcap: 160,
      },
    ], Date.parse('2026-04-05T12:00:00.000Z'), 3 * 60000, 1);

    assert.deepEqual(denseSeries, [100, 120, 140, 160]);
  });

  it('preserves spikes when downsampling sparkline series', () => {
    const sampled = tokenMarketBucket1m.__private.downsampleSparklineSeries([
      100, 102, 101, 103, 104, 180, 106, 108, 110, 112, 114,
    ], 5);

    assert.equal(sampled.length, 5);
    assert.equal(sampled[0], 100);
    assert.equal(sampled[sampled.length - 1], 114);
    assert(sampled.includes(180));
  });

  it('maps sparkline batch rows by address and preserves empty results', async () => {
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
            bucket_ts: '2026-04-05T12:00:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111112',
            close_mcap: '100',
          },
          {
            token_address: 'So11111111111111111111111111111111111111112',
            bucket_ts: '2026-04-05T12:01:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111112',
            close_mcap: '120',
          },
        ],
      };
    };

    try {
      const rows = await tokenMarketBucket1m.listSparklineByAddresses([
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111113',
      ], {
        hours: 14 * 24,
        points: 336,
      });

      assert.match(capturedSql, /FROM token_market_buckets_1m/);
      assert.match(capturedSql, /token_address = ANY\(\$1::varchar\[\]\)/);
      assert.match(capturedSql, /bucket_ts >= NOW\(\) - \(\$2::int \* INTERVAL '1 hour'\)/);
      assert.match(capturedSql, /spark_bucket_ts/);
      assert.deepEqual(capturedParams, [[
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111113',
      ], 14 * 24, 30]);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].address, 'So11111111111111111111111111111111111111112');
      assert.equal(rows[0].series.length, 336);
      assert(rows[0].effectiveHours > 0);
      assert.equal(rows[0].granularityMinutes, 30);
      assert.equal(rows[1].address, 'So11111111111111111111111111111111111111113');
      assert.deepEqual(rows[1].series, []);
      assert.equal(rows[1].coverageRatio, 0);
      assert.equal(rows[1].granularityMinutes, 30);
    } finally {
      db.query = originalQuery;
    }
  });
});
