const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodMarketHistoryReadRepository,
  __private,
} = require('../src/models/robinhood-market-history-read');

const ADDRESS = '0xabcdef0123456789abcdef0123456789abcdef01';
const SECOND_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const VERIFIED_COVERAGE = Object.freeze({
  from: '2026-07-14T00:00:00.000Z',
  through: '2026-07-16T00:00:00.000Z',
});

function row(overrides = {}) {
  return {
    token_address: ADDRESS,
    bucket_ts: '2026-07-15T11:00:00.000Z',
    granularity_minutes: 60,
    source_granularity_minutes: 60,
    open_fdv_usd: '100', high_fdv_usd: '140', low_fdv_usd: '90', close_fdv_usd: '130',
    open_price_usd: '1', high_price_usd: '1.4', low_price_usd: '0.9', close_price_usd: '1.3',
    volume_usd: '450.25', swaps: '4', buys: '3', sells: '1', transaction_contributions: '3',
    market_count: 2, protocols: ['uniswap-v2', 'uniswap-v3'],
    ...overrides,
  };
}

describe('Robinhood native market history reader', () => {
  it('selects permanent hours and retained minutes without overlap', () => {
    assert.match(__private.LEGACY_HISTORY_SQL, /FROM robinhood_market_buckets_1h/);
    assert.match(__private.LEGACY_HISTORY_SQL, /FROM robinhood_market_buckets_1m/);
    assert.match(__private.LEGACY_HISTORY_SQL, /bucket\.bucket_ts < \$5::timestamptz/);
    assert.match(__private.LEGACY_HISTORY_SQL, /bucket\.bucket_ts >= \$5::timestamptz/);
    assert.match(__private.LEGACY_HISTORY_SQL, /GREATEST\(\$4::int, source_granularity_minutes\)/);
    assert.match(__private.LEGACY_HISTORY_SQL,
      /ROW_NUMBER\(\) OVER \(PARTITION BY token_address ORDER BY bucket_ts DESC\)/);
    assert.doesNotMatch(__private.LEGACY_HISTORY_SQL, /bucket\.\*/);
  });

  it('aggregates token-wide activity and deterministic OHLC ordering', () => {
    assert.match(__private.LEGACY_HISTORY_SQL, /SUM\(volume_usd\)/);
    assert.match(__private.LEGACY_HISTORY_SQL, /COUNT\(DISTINCT \(protocol, market_key\)\)/);
    assert.match(__private.LEGACY_HISTORY_SQL,
      /open_fdv_usd ORDER BY bucket_ts, first_block_number,[\s\S]*protocol, market_key/);
    assert.match(__private.LEGACY_HISTORY_SQL,
      /close_fdv_usd ORDER BY bucket_ts DESC, last_block_number DESC,[\s\S]*protocol, market_key/);
  });

  it('reads exact stored aggregate resolutions without regrouping raw buckets', () => {
    assert.match(__private.AGGREGATE_HISTORY_SQL, /FROM robinhood_market_buckets_agg/);
    assert.match(__private.AGGREGATE_HISTORY_SQL, /bucket\.granularity_minutes = \$4::int/);
    assert.match(__private.AGGREGATE_HISTORY_SQL,
      /date_bin\([\s\S]*\$4::int \* INTERVAL '1 minute', \$2::timestamptz/);
    assert.match(__private.AGGREGATE_HISTORY_SQL, /bucket\.transactions AS transaction_contributions/);
    assert.doesNotMatch(__private.AGGREGATE_HISTORY_SQL, /robinhood_market_buckets_1m/);
    assert.doesNotMatch(__private.AGGREGATE_HISTORY_SQL, /GROUP BY/);
  });

  it('returns FDV candles as sparse observations without fabricated zeros', async () => {
    const calls = [];
    const repository = createRobinhoodMarketHistoryReadRepository({
      now: () => new Date('2026-07-15T12:30:00.000Z'),
      database: {
        async queryWithStatementTimeout(sql, params, timeout) {
          calls.push({ sql, params, timeout });
          return { rows: [row({
            bucket_ts: '2026-07-15T09:00:00.000Z',
            source_granularity_minutes: 1,
            granularity_minutes: 5,
          }), row()] };
        },
      },
    });

    const result = await repository.getHistory({
      address: ADDRESS.toUpperCase(),
      startAt: '2026-06-01T00:00:00.000Z',
      endAt: '2026-07-15T12:00:00.000Z',
      granularityMinutes: 5,
      limit: 10,
    });

    assert.equal(result.address, ADDRESS);
    assert.equal(result.resolution, 'mixed');
    assert.equal(result.candles.length, 2);
    assert.equal(result.candles[0].closeFdvUsd, 130);
    assert.equal(result.candles[0].valuationType, 'fdv');
    assert.equal(result.candles[0].activity.volumeUsd, 450.25);
    assert.equal(result.candles[0].activity.transactionContributions, 3);
    assert.equal('transactions' in result.candles[0].activity, false);
    assert.equal(result.candles[1].bucketTs, '2026-07-15T11:00:00.000Z');
    assert.equal(result.candles.some((candle) => candle.bucketTs === '2026-07-15T10:00:00.000Z'), false);
    assert.equal(calls[0].timeout, 15000);
    assert.deepEqual(calls[0].params[0], [ADDRESS]);
    assert.equal(calls[0].params[4].toISOString(), '2026-07-01T13:00:00.000Z');
    assert.equal(calls[0].params[5], 11);
  });

  it('loads multiple tokens in one query and limits each token independently', async () => {
    const calls = [];
    const repository = createRobinhoodMarketHistoryReadRepository({
      database: { async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [
          row({ bucket_ts: '2026-07-15T09:00:00.000Z' }),
          row({ bucket_ts: '2026-07-15T10:00:00.000Z' }),
          row({ bucket_ts: '2026-07-15T11:00:00.000Z' }),
          row({ token_address: SECOND_ADDRESS, bucket_ts: '2026-07-15T08:00:00.000Z' }),
        ] };
      } },
    });

    const histories = await repository.getHistories({
      addresses: [ADDRESS.toUpperCase(), SECOND_ADDRESS, ADDRESS],
      startAt: '2026-07-14T00:00:00.000Z', endAt: '2026-07-16T00:00:00.000Z',
      granularityMinutes: 60, limit: 2,
    });

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params[0], [ADDRESS, SECOND_ADDRESS]);
    assert.equal(calls[0].params[5], 3);
    assert.deepEqual(histories.map((history) => history.address), [ADDRESS, SECOND_ADDRESS]);
    assert.equal(histories[0].truncated, true);
    assert.deepEqual(histories[0].candles.map((candle) => candle.bucketTs), [
      '2026-07-15T10:00:00.000Z', '2026-07-15T11:00:00.000Z',
    ]);
    assert.equal(histories[1].truncated, false);
    assert.equal(histories[1].candles.length, 1);
  });

  it('samples the complete permanent hourly history in all-available mode', async () => {
    const calls = [];
    const repository = createRobinhoodMarketHistoryReadRepository({
      now: () => new Date('2026-07-15T12:30:00.000Z'),
      database: { async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [
          row({ bucket_ts: '2025-01-01T00:00:00.000Z' }),
          row({ bucket_ts: '2026-07-15T11:00:00.000Z' }),
        ] };
      } },
    });

    const [history] = await repository.getHistories({
      addresses: [ADDRESS], endAt: '2026-07-15T12:00:00.000Z',
      allAvailable: true, limit: 500,
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].sql, __private.ALL_AVAILABLE_HISTORY_SQL);
    assert.match(calls[0].sql, /generate_series/);
    assert.deepEqual(calls[0].params, [
      [ADDRESS], new Date('2026-07-15T12:00:00.000Z'), 500,
    ]);
    assert.equal(history.requestedGranularityMinutes, 60);
    assert.equal(history.candles.length, 2);
    assert.equal(history.candles[0].bucketTs, '2025-01-01T00:00:00.000Z');
    assert.equal(history.candles[1].bucketTs, '2026-07-15T11:00:00.000Z');
  });

  it('uses aggregate rows first and reports their rollout metrics', async () => {
    const calls = [];
    let metrics;
    const repository = createRobinhoodMarketHistoryReadRepository({
      aggregateReadsEnabled: true,
      verifiedCoverage: VERIFIED_COVERAGE,
      database: { async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [row({ granularity_minutes: 5, source_granularity_minutes: 1 })] };
      } },
    });

    const [history] = await repository.getHistories({
      addresses: [ADDRESS], startAt: '2026-07-14T00:00:00.000Z',
      endAt: '2026-07-16T00:00:00.000Z', granularityMinutes: 5, limit: 10,
      onMetrics(value) { metrics = value; },
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /robinhood_market_buckets_agg/);
    assert.deepEqual(calls[0].params, [
      [ADDRESS], new Date('2026-07-14T00:00:00.000Z'),
      new Date('2026-07-16T00:00:00.000Z'), 5, 11,
    ]);
    assert.equal(history.candles.length, 1);
    assert.equal(metrics.source, 'aggregate');
    assert.equal(metrics.aggregateRows, 1);
    assert.equal(metrics.fallbackAddresses, 0);
  });

  it('uses legacy rows outside the globally verified aggregate interval', async () => {
    const calls = [];
    let metrics;
    const repository = createRobinhoodMarketHistoryReadRepository({
      aggregateReadsEnabled: true,
      verifiedCoverage: {
        from: '2026-07-15T00:00:00.000Z',
        through: '2026-07-16T00:00:00.000Z',
      },
      database: { async query(sql, params) {
        calls.push({ sql, params });
        return calls.length === 1
          ? { rows: [row({
            bucket_ts: '2026-07-15T11:00:00.000Z',
            granularity_minutes: 30,
            source_granularity_minutes: 1,
          })] }
          : { rows: [row({
            token_address: SECOND_ADDRESS,
            bucket_ts: '2026-07-14T11:00:00.000Z',
          })] };
      } },
    });

    const histories = await repository.getHistories({
      addresses: [ADDRESS, SECOND_ADDRESS], startAt: '2026-07-14T00:00:00.000Z',
      endAt: '2026-07-16T00:00:00.000Z', granularityMinutes: 30, limit: 10,
      onMetrics(value) { metrics = value; },
    });

    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /robinhood_market_buckets_agg/);
    assert.match(calls[1].sql, /robinhood_market_buckets_1m/);
    assert.match(calls[1].sql,
      /\$7::timestamptz IS NULL OR bucket\.bucket_ts < \$7 OR bucket\.bucket_ts >= \$8/);
    assert.deepEqual(calls[1].params.slice(6), [
      new Date('2026-07-15T00:00:00.000Z'),
      new Date('2026-07-16T00:00:00.000Z'),
    ]);
    assert.deepEqual(histories.map((history) => history.candles.length), [1, 1]);
    assert.equal(metrics.source, 'mixed');
    assert.equal(metrics.fallbackAddresses, 2);
    assert.equal(metrics.aggregateCoverageFrom, '2026-07-15T00:00:00.000Z');
  });

  it('caches successful empty aggregate reads but never caches failures', async () => {
    let calls = 0;
    const repository = createRobinhoodMarketHistoryReadRepository({
      aggregateReadsEnabled: true,
      fallbackEnabled: false,
      verifiedCoverage: VERIFIED_COVERAGE,
      now: () => new Date('2026-07-15T12:00:00.000Z'),
      database: { async query() {
        calls += 1;
        if (calls === 1) throw new Error('temporary database failure');
        return { rows: [] };
      } },
    });
    const input = {
      address: ADDRESS, startAt: '2026-07-14T00:00:00.000Z',
      endAt: '2026-07-16T00:00:00.000Z', granularityMinutes: 30, limit: 10,
    };

    await assert.rejects(repository.getHistory(input), /temporary database failure/);
    assert.equal((await repository.getHistory(input)).candles.length, 0);
    assert.equal((await repository.getHistory(input)).candles.length, 0);
    assert.equal(calls, 2);
  });

  it('keeps aggregate reads on legacy when no verified interval is configured', async () => {
    let metrics;
    const calls = [];
    const repository = createRobinhoodMarketHistoryReadRepository({
      aggregateReadsEnabled: true,
      database: { async query(sql) {
        calls.push(sql);
        return { rows: [row()] };
      } },
    });

    await repository.getHistory({
      address: ADDRESS, startAt: '2026-07-14T00:00:00.000Z',
      endAt: '2026-07-16T00:00:00.000Z', granularityMinutes: 30, limit: 10,
      onMetrics(value) { metrics = value; },
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0], /robinhood_market_buckets_1m/);
    assert.equal(metrics.source, 'legacy');
    assert.equal(metrics.aggregateCoverageFrom, null);
  });

  it('uses only legacy data when fallback is disabled for a partially covered window', async () => {
    const calls = [];
    const repository = createRobinhoodMarketHistoryReadRepository({
      aggregateReadsEnabled: true,
      fallbackEnabled: false,
      verifiedCoverage: {
        from: '2026-07-15T00:00:00.000Z',
        through: '2026-07-16T00:00:00.000Z',
      },
      database: { async query(sql) {
        calls.push(sql);
        return { rows: [row()] };
      } },
    });

    await repository.getHistory({
      address: ADDRESS, startAt: '2026-07-14T00:00:00.000Z',
      endAt: '2026-07-16T00:00:00.000Z', granularityMinutes: 30, limit: 10,
    });

    assert.equal(calls.length, 1);
    assert.match(calls[0], /robinhood_market_buckets_1m/);
    assert.doesNotMatch(calls[0], /robinhood_market_buckets_agg/);
  });

  it('compares verified aggregate and legacy rows in opt-in shadow mode', async () => {
    let metrics;
    const calls = [];
    const repository = createRobinhoodMarketHistoryReadRepository({
      aggregateReadsEnabled: true,
      shadowCompareEnabled: true,
      verifiedCoverage: VERIFIED_COVERAGE,
      now: () => new Date('2026-07-15T12:00:00.000Z'),
      database: { async query(sql) {
        calls.push(sql);
        return { rows: [row({
          granularity_minutes: 60,
          source_granularity_minutes: 60,
        })] };
      } },
    });

    await repository.getHistory({
      address: ADDRESS, startAt: VERIFIED_COVERAGE.from,
      endAt: VERIFIED_COVERAGE.through, granularityMinutes: 60, limit: 10,
      onMetrics(value) { metrics = value; },
    });

    assert.equal(calls.length, 2);
    assert.match(calls[0], /robinhood_market_buckets_agg/);
    assert.match(calls[1], /robinhood_market_buckets_1h/);
    assert.deepEqual(metrics.shadow, {
      comparedRows: 1, missingAggregateRows: 0, missingLegacyRows: 0, divergentRows: 0,
    });
  });

  it('validates identity, range, granularity and bounded result size', async () => {
    const repository = createRobinhoodMarketHistoryReadRepository({
      database: { async query() { return { rows: [] }; } },
    });
    const base = {
      address: ADDRESS,
      startAt: '2026-07-01T00:00:00.000Z',
      endAt: '2026-07-02T00:00:00.000Z',
    };
    await assert.rejects(repository.getHistory({ ...base, address: 'bad' }), /address/i);
    await assert.rejects(repository.getHistory({ ...base, granularityMinutes: 2 }), /granularity/);
    await assert.rejects(repository.getHistory({ ...base, limit: 5001 }), /limit/);
    await assert.rejects(repository.getHistory({ ...base, startAt: base.endAt }), /window/);
  });
});
