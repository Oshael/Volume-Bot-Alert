const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenMarketBucket1m = require('../src/models/token-market-bucket-1m');

describe('token market 1m bucket helpers', () => {
  beforeEach(() => {
    tokenMarketBucket1m.__private.clearSparklineCache();
  });

  it('rounds timestamps down to the start of the minute in UTC', () => {
    const bucketDate = tokenMarketBucket1m.__private.getBucketDate('2026-03-24T04:18:59.999Z');
    assert.equal(bucketDate.toISOString(), '2026-03-24T04:18:00.000Z');
  });

  it('preserves exact minute boundaries', () => {
    const bucketDate = tokenMarketBucket1m.__private.getBucketDate('2026-03-24T04:18:00.000Z');
    assert.equal(bucketDate.toISOString(), '2026-03-24T04:18:00.000Z');
  });

  it('rounds timestamps down to supported aggregate bucket starts', () => {
    const fiveMinute = tokenMarketBucket1m.__private.getAggregateBucketDate('2026-03-24T04:18:59.999Z', 5);
    const fifteenMinute = tokenMarketBucket1m.__private.getAggregateBucketDate('2026-03-24T04:18:59.999Z', 15);
    const thirtyMinute = tokenMarketBucket1m.__private.getAggregateBucketDate('2026-03-24T04:18:59.999Z', 30);

    assert.equal(fiveMinute.toISOString(), '2026-03-24T04:15:00.000Z');
    assert.equal(fifteenMinute.toISOString(), '2026-03-24T04:15:00.000Z');
    assert.equal(thirtyMinute.toISOString(), '2026-03-24T04:00:00.000Z');
    assert.throws(
      () => tokenMarketBucket1m.__private.getAggregateBucketDate('2026-03-24T04:18:59.999Z', 10),
      /Invalid aggregate granularity/
    );
  });

  it('builds current and previous source bucket dates for aggregate refresh', () => {
    const dates = tokenMarketBucket1m.__private.getAggregateRefreshBucketDates('2026-03-24T04:20:59.999Z');

    assert.deepEqual(dates.map((date) => date.toISOString()), [
      '2026-03-24T04:20:00.000Z',
      '2026-03-24T04:19:00.000Z',
    ]);
  });

  it('recomputes aggregate buckets only when a new 1m source bucket is inserted', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return {
          rows: [
            {
              token_address: 'So11111111111111111111111111111111111111112',
              bucket_ts: '2026-03-24T04:18:00.000Z',
              sample_count: 1,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      const row = await tokenMarketBucket1m.upsertSnapshotBucket({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        pairAddress: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
        ts: '2026-03-24T04:18:59.999Z',
        mcap: 123456,
        price: 0.1234,
        liquidityUsd: 987.65,
        gmgnLockPercent: 0,
        gmgnBurnRatio: 0,
        gmgnBurnStatus: 'none',
        gmgnCreatorClose: true,
        gmgnCreatorTokenStatus: 'creator_close',
        source: 'gmgn',
      });

      assert.equal(row.token_address, 'So11111111111111111111111111111111111111112');
      assert.equal(calls.length, 2);
      assert.match(calls[0].sql, /INSERT INTO token_market_buckets_1m/);
      assert.match(calls[0].sql, /close_liquidity_usd/);
      assert.match(calls[0].sql, /gmgn_lock_percent/);
      assert.equal(calls[0].params[5], 987.65);
      assert.equal(calls[0].params[6], 0);
      assert.equal(calls[0].params[7], 0);
      assert.equal(calls[0].params[8], 'none');
      assert.equal(calls[0].params[9], true);
      assert.equal(calls[0].params[10], 'creator_close');
      assert.match(calls[1].sql, /INSERT INTO token_market_buckets_agg/);
      assert.match(calls[1].sql, /WITH requested\(granularity_minutes, bucket_start\)/);
      assert.match(calls[1].sql, /INNER JOIN token_market_buckets_1m b/);
      assert.deepEqual(calls[1].params.map((value) => (
        value instanceof Date ? value.toISOString() : value
      )), [
        'So11111111111111111111111111111111111111112',
        5,
        '2026-03-24T04:15:00.000Z',
        15,
        '2026-03-24T04:15:00.000Z',
        30,
        '2026-03-24T04:00:00.000Z',
      ]);
    } finally {
      db.query = originalQuery;
    }
  });

  it('lists recent liquidity samples by address', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [
          {
            token_address: 'So11111111111111111111111111111111111111112',
            bucket_ts: '2026-03-24T04:18:00.000Z',
            close_liquidity_usd: '900.00',
          },
        ],
      };
    };

    try {
      const rows = await tokenMarketBucket1m.listRecentLiquiditySamplesByAddresses([
        'So11111111111111111111111111111111111111112',
      ], 5);

      assert.deepEqual(capturedParams, [['So11111111111111111111111111111111111111112'], 5]);
      assert.match(capturedSql, /close_liquidity_usd IS NOT NULL/);
      assert.match(capturedSql, /ROW_NUMBER\(\) OVER/);
      assert.equal(rows.length, 1);
    } finally {
      db.query = originalQuery;
    }
  });

  it('lists recent GMGN liquidity-protection samples by address', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [
          {
            token_address: 'So11111111111111111111111111111111111111112',
            bucket_ts: '2026-03-24T04:18:00.000Z',
            gmgn_lock_percent: '0',
            gmgn_burn_ratio: '0',
            gmgn_burn_status: 'none',
            gmgn_creator_close: true,
            gmgn_creator_token_status: 'creator_close',
          },
        ],
      };
    };

    try {
      const rows = await tokenMarketBucket1m.listRecentGmgnLiquidityProtectionSamplesByAddresses([
        'So11111111111111111111111111111111111111112',
      ], 4);

      assert.deepEqual(capturedParams, [['So11111111111111111111111111111111111111112'], 4]);
      assert.match(capturedSql, /source = 'gmgn'/);
      assert.match(capturedSql, /gmgn_lock_percent IS NOT NULL/);
      assert.match(capturedSql, /gmgn_creator_token_status IS NOT NULL/);
      assert.equal(rows.length, 1);
    } finally {
      db.query = originalQuery;
    }
  });

  it('does not recompute aggregate buckets for repeated writes inside the same 1m bucket', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [
          {
            token_address: 'So11111111111111111111111111111111111111112',
            bucket_ts: '2026-03-24T04:18:00.000Z',
            sample_count: 2,
          },
        ],
      };
    };

    try {
      const row = await tokenMarketBucket1m.upsertSnapshotBucket({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        pairAddress: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
        ts: '2026-03-24T04:18:20.000Z',
        mcap: 123457,
        price: 0.1235,
        source: 'gmgn',
      });

      assert.equal(row.sample_count, 2);
      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /INSERT INTO token_market_buckets_1m/);
    } finally {
      db.query = originalQuery;
    }
  });

  it('includes the previous aggregate window when a new minute crosses a 5m boundary', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return {
          rows: [
            {
              token_address: 'So11111111111111111111111111111111111111112',
              bucket_ts: '2026-03-24T04:20:00.000Z',
              sample_count: 1,
            },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      await tokenMarketBucket1m.upsertSnapshotBucket({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        pairAddress: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
        ts: '2026-03-24T04:20:00.000Z',
        mcap: 123456,
        price: 0.1234,
        source: 'gmgn',
      });

      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1].params.map((value) => (
        value instanceof Date ? value.toISOString() : value
      )), [
        'So11111111111111111111111111111111111111112',
        5,
        '2026-03-24T04:20:00.000Z',
        15,
        '2026-03-24T04:15:00.000Z',
        30,
        '2026-03-24T04:00:00.000Z',
        5,
        '2026-03-24T04:15:00.000Z',
      ]);
    } finally {
      db.query = originalQuery;
    }
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

  it('uses aggregate buckets for supported sparkline granularities when coverage is sufficient', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
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
            bucket_ts: '2026-04-19T12:00:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111112',
            close_mcap: '160',
          },
        ],
      };
    };

    try {
      const rows = await tokenMarketBucket1m.listSparklineByAddresses([
        'So11111111111111111111111111111111111111112',
      ], {
        hours: 14 * 24,
        points: 336,
        granularityMinutes: 30,
      });

      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /FROM token_market_buckets_agg/);
      assert.doesNotMatch(calls[0].sql, /spark_bucket_ts/);
      assert.deepEqual(calls[0].params, [[
        'So11111111111111111111111111111111111111112',
      ], 14 * 24, 30]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].bucketCount, 2);
      assert.equal(rows[0].granularityMinutes, 30);
      assert.equal(rows[0].effectiveHours, 336);
    } finally {
      db.query = originalQuery;
    }
  });

  it('falls back to 1m sparkline rows when aggregate coverage is too short', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return {
          rows: [
            {
              token_address: 'So11111111111111111111111111111111111111112',
              bucket_ts: '2026-04-19T12:00:00.000Z',
              pair_address: 'So11111111111111111111111111111111111111112',
              close_mcap: '160',
            },
          ],
        };
      }

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
            bucket_ts: '2026-04-19T12:00:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111112',
            close_mcap: '160',
          },
        ],
      };
    };

    try {
      const metrics = [];
      const rows = await tokenMarketBucket1m.listSparklineByAddresses([
        'So11111111111111111111111111111111111111112',
      ], {
        hours: 14 * 24,
        points: 336,
        granularityMinutes: 30,
        onMetrics: (entry) => metrics.push(entry),
      });

      assert.equal(calls.length, 2);
      assert.match(calls[0].sql, /FROM token_market_buckets_agg/);
      assert.match(calls[1].sql, /FROM token_market_buckets_1m/);
      assert.match(calls[1].sql, /spark_bucket_ts/);
      assert.deepEqual(calls[1].params, [[
        'So11111111111111111111111111111111111111112',
      ], 14 * 24, 30]);
      assert.equal(rows[0].effectiveHours, 336);
      assert.equal(rows[0].bucketCount, 2);
      assert.equal(metrics[0].source, '1m-fallback');
      assert.equal(metrics[0].aggregateRows, 1);
      assert.equal(metrics[0].fallbackRows, 2);
      assert.equal(metrics[0].fallbackAddresses, 1);
    } finally {
      db.query = originalQuery;
    }
  });

  it('caches repeated sparkline requests for the same batch options', async () => {
    const originalQuery = db.query;
    let queryCount = 0;

    db.query = async () => {
      queryCount += 1;
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
            bucket_ts: '2026-04-19T12:00:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111112',
            close_mcap: '160',
          },
        ],
      };
    };

    try {
      const metrics = [];
      const first = await tokenMarketBucket1m.listSparklineByAddresses([
        'So11111111111111111111111111111111111111112',
      ], {
        hours: 14 * 24,
        points: 336,
        granularityMinutes: 30,
        onMetrics: (entry) => metrics.push(entry),
      });
      const second = await tokenMarketBucket1m.listSparklineByAddresses([
        'So11111111111111111111111111111111111111112',
      ], {
        hours: 14 * 24,
        points: 336,
        granularityMinutes: 30,
        onMetrics: (entry) => metrics.push(entry),
      });

      assert.equal(queryCount, 1);
      assert.deepEqual(second, first);
      assert.equal(metrics[0].cacheHit, false);
      assert.equal(metrics[1].cacheHit, true);
      assert.equal(metrics[1].queryDurationMs, 0);
    } finally {
      db.query = originalQuery;
    }
  });

  it('invalidates cached sparkline entries for updated addresses', async () => {
    const key = tokenMarketBucket1m.__private.getSparklineCacheKey([
      'So11111111111111111111111111111111111111112',
      'So11111111111111111111111111111111111111113',
    ], {
      hours: 1,
      points: 60,
      granularityMinutes: 30,
    });

    assert.equal(typeof key, 'string');

    const originalQuery = db.query;
    let queryCount = 0;

    db.query = async () => {
      queryCount += 1;
      return {
        rows: [
          {
            token_address: 'So11111111111111111111111111111111111111112',
            bucket_ts: '2026-04-19T12:00:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111112',
            close_mcap: '160',
          },
          {
            token_address: 'So11111111111111111111111111111111111111113',
            bucket_ts: '2026-04-19T12:00:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111113',
            close_mcap: '260',
          },
        ],
      };
    };

    try {
      await tokenMarketBucket1m.listSparklineByAddresses([
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111113',
      ], {
        hours: 1,
        points: 60,
        granularityMinutes: 30,
      });
      await tokenMarketBucket1m.listSparklineByAddresses([
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111113',
      ], {
        hours: 1,
        points: 60,
        granularityMinutes: 30,
      });
      assert.equal(queryCount, 1);

      const deleted = tokenMarketBucket1m.__private.invalidateSparklineCacheForAddresses([
        'So11111111111111111111111111111111111111113',
      ]);
      assert.equal(deleted, 1);

      await tokenMarketBucket1m.listSparklineByAddresses([
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111113',
      ], {
        hours: 1,
        points: 60,
        granularityMinutes: 30,
      });
      assert.equal(queryCount, 2);
    } finally {
      db.query = originalQuery;
    }
  });

  it('deletes aggregate buckets with source 1m buckets during cleanup', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: calls.length === 2 ? 2 : 4 };
    };

    try {
      const deleted = await tokenMarketBucket1m.deleteByAddresses([
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111113',
        'invalid',
      ]);

      assert.equal(deleted, 2);
      assert.equal(calls.length, 2);
      assert.match(calls[0].sql, /DELETE FROM token_market_buckets_agg/);
      assert.match(calls[1].sql, /DELETE FROM token_market_buckets_1m/);
      assert.deepEqual(calls[0].params, [[
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111113',
      ]]);
      assert.deepEqual(calls[1].params, calls[0].params);
    } finally {
      db.query = originalQuery;
    }
  });
});
