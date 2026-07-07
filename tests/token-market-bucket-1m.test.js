const { beforeEach, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
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
    const hourly = tokenMarketBucket1m.__private.getAggregateBucketDate('2026-03-24T04:18:59.999Z', 60);
    const fourHourly = tokenMarketBucket1m.__private.getAggregateBucketDate('2026-03-24T05:18:59.999Z', 240);
    const daily = tokenMarketBucket1m.__private.getAggregateBucketDate('2026-03-24T23:59:59.999Z', 1440);

    assert.equal(fiveMinute.toISOString(), '2026-03-24T04:15:00.000Z');
    assert.equal(fifteenMinute.toISOString(), '2026-03-24T04:15:00.000Z');
    assert.equal(thirtyMinute.toISOString(), '2026-03-24T04:00:00.000Z');
    assert.equal(hourly.toISOString(), '2026-03-24T04:00:00.000Z');
    assert.equal(fourHourly.toISOString(), '2026-03-24T04:00:00.000Z');
    assert.equal(daily.toISOString(), '2026-03-24T00:00:00.000Z');
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
        source: 'gmgn',
      });

      assert.equal(row.token_address, 'So11111111111111111111111111111111111111112');
      assert.equal(calls.length, 3);
      assert.match(calls[0].sql, /INSERT INTO token_market_buckets_1m/);
      assert.match(calls[1].sql, /INSERT INTO token_market_buckets_agg/);
      assert.match(calls[1].sql, /WITH requested\(granularity_minutes, bucket_start\)/);
      assert.match(calls[1].sql, /raw_source_rows AS/);
      assert.match(calls[1].sql, /COALESCE\(candidate\.source, ''\) <> 'gmgn'/);
      assert.match(calls[1].sql, /sibling\.bucket_start = candidate\.bucket_start/);
      assert.match(calls[1].sql, /INNER JOIN token_market_buckets_1m b/);
      assert.match(calls[2].sql, /WITH requested\(target_granularity_minutes, bucket_start\)/);
      assert.match(calls[2].sql, /INNER JOIN token_market_buckets_agg b/);
      assert.match(calls[2].sql, /b\.granularity_minutes = \$2::int/);
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
      assert.deepEqual(calls[2].params.map((value) => (
        value instanceof Date ? value.toISOString() : value
      )), [
        'So11111111111111111111111111111111111111112',
        5,
        60,
        '2026-03-24T04:00:00.000Z',
        240,
        '2026-03-24T04:00:00.000Z',
        1440,
        '2026-03-24T00:00:00.000Z',
      ]);
    } finally {
      db.query = originalQuery;
    }
  });

  it('prefers non-GMGN 1m rows when building expanded fallback candles', async () => {
    const originalQuery = db.query;
    let capturedSql = '';

    db.query = async (sql) => {
      capturedSql = sql;
      return { rows: [] };
    };

    try {
      await tokenMarketBucket1m.__private.queryAllAvailableOneMinuteSparklineRows(
        'So11111111111111111111111111111111111111112',
        5
      );

      assert.match(capturedSql, /source,/);
      assert.match(capturedSql, /source_rows AS/);
      assert.match(capturedSql, /COALESCE\(candidate\.source, ''\) <> 'gmgn'/);
      assert.match(capturedSql, /sibling\.spark_bucket_ts = candidate\.spark_bucket_ts/);
      assert.match(capturedSql, /FROM source_rows/);
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

  it('can skip inline aggregate recompute when disabled by runtime config', async () => {
    const originalQuery = db.query;
    const originalAggregateOnWriteEnabled = config.marketBuckets.aggregateOnWriteEnabled;
    const calls = [];

    config.marketBuckets.aggregateOnWriteEnabled = false;
    db.query = async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [
          {
            token_address: 'So11111111111111111111111111111111111111112',
            bucket_ts: '2026-03-24T04:18:00.000Z',
            sample_count: 1,
          },
        ],
      };
    };

    try {
      await tokenMarketBucket1m.upsertSnapshotBucket({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        pairAddress: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
        ts: '2026-03-24T04:18:59.999Z',
        mcap: 123456,
        price: 0.1234,
        source: 'dexscreener',
      });

      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /INSERT INTO token_market_buckets_1m/);
    } finally {
      config.marketBuckets.aggregateOnWriteEnabled = originalAggregateOnWriteEnabled;
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

      assert.equal(calls.length, 3);
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
      assert.deepEqual(calls[2].params.map((value) => (
        value instanceof Date ? value.toISOString() : value
      )), [
        'So11111111111111111111111111111111111111112',
        5,
        60,
        '2026-03-24T04:00:00.000Z',
        240,
        '2026-03-24T04:00:00.000Z',
        1440,
        '2026-03-24T00:00:00.000Z',
      ]);
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

  it('normalizes extreme market cap wick outliers in expanded candles', () => {
    const candles = tokenMarketBucket1m.__private.buildExpandedCandlesFromRows([
      {
        bucket_ts: '2026-06-23T21:09:00.000Z',
        open_mcap: '642339',
        high_mcap: '2000000',
        low_mcap: '135352',
        close_mcap: '635437',
        sample_count: 35,
      },
      {
        bucket_ts: '2026-06-23T21:10:00.000Z',
        open_mcap: '644370',
        high_mcap: '700119',
        low_mcap: '634238',
        close_mcap: '695333',
        sample_count: 31,
      },
      {
        bucket_ts: '2026-06-23T21:11:00.000Z',
        open_mcap: '690463',
        high_mcap: '0',
        low_mcap: '0',
        close_mcap: '696203',
        sample_count: 34,
      },
    ], 15);

    assert.equal(candles[0].highMcap, 642339);
    assert.equal(candles[0].lowMcap, 635437);
    assert.equal(candles[1].highMcap, 700119);
    assert.equal(candles[1].lowMcap, 634238);
    assert.equal(candles[2].highMcap, 696203);
    assert.equal(candles[2].lowMcap, 690463);
  });

  it('builds live market bucket update payloads for chart sockets', () => {
    const payload = tokenMarketBucket1m.__private.buildLiveMarketBucketPayload({
      token_address: 'So11111111111111111111111111111111111111112',
      bucket_ts: '2026-06-23T21:09:00.000Z',
      pair_address: '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1',
      open_mcap: '642339',
      high_mcap: '2000000',
      low_mcap: '135352',
      close_mcap: '635437',
      open_price: '0.000642',
      high_price: '0.002',
      low_price: '0.000135',
      close_price: '0.000635',
      sample_count: 35,
    });

    assert.equal(payload.address, 'So11111111111111111111111111111111111111112');
    assert.equal(payload.pairAddress, '2AvJj5CpkvT4Qn6tQ3LRek2L4mM4A6h8K5mJ7u8h9iX1');
    assert.equal(payload.granularityMinutes, 1);
    assert.equal(payload.candle.bucketTs, '2026-06-23T21:09:00.000Z');
    assert.equal(payload.candle.granularityMinutes, 1);
    assert.equal(payload.candle.highMcap, 642339);
    assert.equal(payload.candle.lowMcap, 635437);
    assert.equal(payload.candle.closeMcap, 635437);
    assert.equal(payload.candle.sampleCount, 35);
    assert.match(payload.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
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
        granularityMinutes: 1,
      });

      assert.match(capturedSql, /FROM token_market_buckets_1m/);
      assert.match(capturedSql, /token_address = ANY\(\$1::varchar\[\]\)/);
      assert.match(capturedSql, /bucket_ts >= NOW\(\) - \(\$2::int \* INTERVAL '1 hour'\)/);
      assert.match(capturedSql, /spark_bucket_ts/);
      assert.deepEqual(capturedParams, [[
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111113',
      ], 14 * 24, 1]);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].address, 'So11111111111111111111111111111111111111112');
      assert.equal(rows[0].series.length, 336);
      assert(rows[0].effectiveHours > 0);
      assert.equal(rows[0].granularityMinutes, 1);
      assert.equal(rows[1].address, 'So11111111111111111111111111111111111111113');
      assert.deepEqual(rows[1].series, []);
      assert.equal(rows[1].coverageRatio, 0);
      assert.equal(rows[1].granularityMinutes, 1);
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
        granularityMinutes: 240,
      });

      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /FROM token_market_buckets_agg/);
      assert.doesNotMatch(calls[0].sql, /spark_bucket_ts/);
      assert.deepEqual(calls[0].params, [[
        'So11111111111111111111111111111111111111112',
      ], 14 * 24, 240]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].bucketCount, 2);
      assert.equal(rows[0].granularityMinutes, 240);
      assert.equal(rows[0].effectiveHours, 336);
    } finally {
      db.query = originalQuery;
    }
  });

  it('builds expanded sparkline from aggregate buckets when full-history granularity is supported', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return {
          rows: [
            {
              first_bucket_at: '2026-04-01T00:00:00.000Z',
              latest_bucket_at: '2026-04-20T00:00:00.000Z',
              one_minute_first_bucket_at: '2026-04-01T00:00:00.000Z',
              one_minute_latest_bucket_at: '2026-04-20T00:00:00.000Z',
            },
          ],
        };
      }

      return {
        rows: [
          {
            token_address: 'So11111111111111111111111111111111111111112',
            bucket_ts: '2026-04-01T00:00:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111112',
            open_mcap: '90',
            high_mcap: '110',
            low_mcap: '80',
            close_mcap: '100',
            open_price: '0.000000001',
            high_price: '0.000000003',
            low_price: '0.000000001',
            close_price: '0.000000002',
            sample_count: 7,
          },
          {
            token_address: 'So11111111111111111111111111111111111111112',
            bucket_ts: '2026-04-20T00:00:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111112',
            close_mcap: '220',
          },
        ],
      };
    };

    try {
      const row = await tokenMarketBucket1m.listExpandedSparklineByAddress(
        'So11111111111111111111111111111111111111112',
        { points: 720, granularityMinutes: 240 }
      );

      assert.equal(calls.length, 2);
      assert.match(calls[0].sql, /MIN\(bucket_ts\) AS first_bucket_at/);
      assert.match(calls[0].sql, /FROM token_market_buckets_agg/);
      assert.deepEqual(calls[0].params, [
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111112',
      ]);
      assert.match(calls[1].sql, /FROM token_market_buckets_agg/);
      assert.doesNotMatch(calls[1].sql, /NOW\(\) -/);
      assert.deepEqual(calls[1].params, ['So11111111111111111111111111111111111111112', 240]);
      assert.equal(row.address, 'So11111111111111111111111111111111111111112');
      assert.equal(row.granularityMinutes, 240);
      assert.equal(row.firstBucketAt, '2026-04-01T00:00:00.000Z');
      assert.equal(row.latestBucketAt, '2026-04-20T00:00:00.000Z');
      assert.equal(row.oneMinuteAvailable, true);
      assert.equal(row.series.length, 720);
      assert.equal(row.candles.length, 2);
      assert.deepEqual(row.candles[0], {
        bucketTs: '2026-04-01T00:00:00.000Z',
        pairAddress: 'So11111111111111111111111111111111111111112',
        granularityMinutes: 240,
        openMcap: 90,
        highMcap: 110,
        lowMcap: 80,
        closeMcap: 100,
        openPrice: 0.000000001,
        highPrice: 0.000000003,
        lowPrice: 0.000000001,
        closePrice: 0.000000002,
        sampleCount: 7,
      });
    } finally {
      db.query = originalQuery;
    }
  });

  it('falls back to all available 1m buckets for expanded sparkline when explicitly enabled', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return {
          rows: [
            {
              first_bucket_at: '2026-04-01T00:00:00.000Z',
              latest_bucket_at: '2026-04-20T00:00:00.000Z',
            },
          ],
        };
      }
      if (calls.length === 2) {
        return { rows: [] };
      }

      return {
        rows: [
          {
            token_address: 'So11111111111111111111111111111111111111112',
            bucket_ts: '2026-04-01T00:00:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111112',
            close_mcap: '100',
          },
          {
            token_address: 'So11111111111111111111111111111111111111112',
            bucket_ts: '2026-04-20T00:00:00.000Z',
            pair_address: 'So11111111111111111111111111111111111111112',
            close_mcap: '220',
          },
        ],
      };
    };

    try {
      const row = await tokenMarketBucket1m.listExpandedSparklineByAddress(
        'So11111111111111111111111111111111111111112',
        { points: 720, allowOneMinuteFallback: true }
      );

      assert.equal(calls.length, 3);
      assert.match(calls[1].sql, /FROM token_market_buckets_agg/);
      assert.match(calls[2].sql, /FROM token_market_buckets_1m/);
      assert.match(calls[2].sql, /spark_bucket_ts/);
      assert.doesNotMatch(calls[2].sql, /NOW\(\) -/);
      assert.equal(row.address, 'So11111111111111111111111111111111111111112');
      assert.equal(row.granularityMinutes, 30);
      assert.equal(row.firstBucketAt, '2026-04-01T00:00:00.000Z');
      assert.equal(row.latestBucketAt, '2026-04-20T00:00:00.000Z');
      assert.equal(row.series.length, 720);
    } finally {
      db.query = originalQuery;
    }
  });

  it('does not fall back to all available 1m buckets for expanded sparkline by default', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (calls.length === 1) {
        return {
          rows: [
            {
              first_bucket_at: '2026-04-01T00:00:00.000Z',
              latest_bucket_at: '2026-04-20T00:00:00.000Z',
            },
          ],
        };
      }
      return { rows: [] };
    };

    try {
      const row = await tokenMarketBucket1m.listExpandedSparklineByAddress(
        'So11111111111111111111111111111111111111112',
        { points: 720 }
      );

      assert.equal(calls.length, 2);
      assert.match(calls[1].sql, /FROM token_market_buckets_agg/);
      assert.doesNotMatch(calls[1].sql, /FROM token_market_buckets_1m/);
      assert.equal(row.address, 'So11111111111111111111111111111111111111112');
      assert.equal(row.bucketCount, 0);
      assert.deepEqual(row.candles, []);
      assert.deepEqual(row.series, []);
    } finally {
      db.query = originalQuery;
    }
  });

  it('does not fall back to 1m sparkline rows by default when aggregate coverage is too short', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
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

      assert.equal(calls.length, 1);
      assert.match(calls[0].sql, /FROM token_market_buckets_agg/);
      assert.doesNotMatch(calls[0].sql, /FROM token_market_buckets_1m/);
      assert.equal(rows[0].bucketCount, 1);
      assert.equal(metrics[0].source, 'aggregate-missing-coverage');
      assert.equal(metrics[0].aggregateRows, 1);
      assert.equal(metrics[0].fallbackRows, 0);
      assert.equal(metrics[0].fallbackAddresses, 1);
    } finally {
      db.query = originalQuery;
    }
  });

  it('falls back to 1m sparkline rows when aggregate coverage is too short and fallback is explicitly enabled', async () => {
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
        allowOneMinuteFallback: true,
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

  it('caches repeated expanded sparkline requests and invalidates by address', async () => {
    const address = 'So11111111111111111111111111111111111111112';
    const originalQuery = db.query;
    let queryCount = 0;

    db.query = async (sql) => {
      queryCount += 1;
      if (/WITH one_minute_bounds/.test(sql)) {
        return {
          rows: [{
            first_bucket_at: '2026-04-19T12:00:00.000Z',
            latest_bucket_at: '2026-04-19T12:20:00.000Z',
          }],
        };
      }

      return {
        rows: [
          {
            token_address: address,
            bucket_ts: '2026-04-19T12:00:00.000Z',
            pair_address: address,
            close_mcap: '100',
          },
          {
            token_address: address,
            bucket_ts: '2026-04-19T12:20:00.000Z',
            pair_address: address,
            close_mcap: '160',
          },
        ],
      };
    };

    try {
      const first = await tokenMarketBucket1m.listExpandedSparklineByAddress(address, {
        points: 720,
      });
      const second = await tokenMarketBucket1m.listExpandedSparklineByAddress(address, {
        points: 720,
      });

      assert.equal(queryCount, 2);
      assert.deepEqual(second, first);

      const deleted = tokenMarketBucket1m.__private.invalidateSparklineCacheForAddresses([address]);
      assert.equal(deleted, 1);

      await tokenMarketBucket1m.listExpandedSparklineByAddress(address, {
        points: 720,
      });
      assert.equal(queryCount, 4);
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

  it('normalizes allowed surge baseline windows without accepting arbitrary windows', () => {
    assert.deepEqual(
      tokenMarketBucket1m.__private.normalizeSurgeBaselineWindows([360, 60, 60, 5, 'bad']),
      [360, 60]
    );
    assert.deepEqual(
      tokenMarketBucket1m.__private.normalizeSurgeBaselineWindows([5, null]),
      tokenMarketBucket1m.__private.SURGE_BASELINE_WINDOW_MINUTES
    );
  });

  it('queries current market bucket and exact surge baselines without fallback rows', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      return {
        rows: [
          {
            token_address: 'So11111111111111111111111111111111111111112',
            current_ts: '2026-07-07T08:00:00.000Z',
            current_mcap: '1900000',
            baseline_60m_ts: '2026-07-07T07:00:00.000Z',
            baseline_60m_mcap: '800000',
            baseline_360m_ts: '2026-07-07T02:00:00.000Z',
            baseline_360m_mcap: '700000',
          },
        ],
      };
    };

    try {
      const rows = await tokenMarketBucket1m.listCurrentAndWindowBaselinesByAddresses(
        [
          'So11111111111111111111111111111111111111112',
          'invalid',
          'So11111111111111111111111111111111111111112',
        ],
        [60, 360, 5]
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].baseline_60m_mcap, '800000');
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].params, [['So11111111111111111111111111111111111111112']]);
      assert.match(calls[0].sql, /baseline_60m\.close_mcap AS baseline_60m_mcap/);
      assert.match(calls[0].sql, /baseline_360m\.close_mcap AS baseline_360m_mcap/);
      assert.doesNotMatch(calls[0].sql, /baseline_5m/);
      assert.doesNotMatch(calls[0].sql, /fallback/);
      assert.match(calls[0].sql, /AND close_mcap IS NOT NULL\s+ORDER BY bucket_ts DESC\s+LIMIT 1\s+\) AS current_row/);
      assert.match(calls[0].sql, /bucket_ts <= current_row\.current_ts - \(60::int \* INTERVAL '1 minute'\)/);
      assert.match(calls[0].sql, /bucket_ts <= current_row\.current_ts - \(360::int \* INTERVAL '1 minute'\)/);
    } finally {
      db.query = originalQuery;
    }
  });
});
