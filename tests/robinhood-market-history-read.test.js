const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodMarketHistoryReadRepository,
  __private,
} = require('../src/models/robinhood-market-history-read');

const ADDRESS = '0xabcdef0123456789abcdef0123456789abcdef01';
const SECOND_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';

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
    assert.match(__private.HISTORY_SQL, /FROM robinhood_market_buckets_1h/);
    assert.match(__private.HISTORY_SQL, /FROM robinhood_market_buckets_1m/);
    assert.match(__private.HISTORY_SQL, /bucket\.bucket_ts < \$5::timestamptz/);
    assert.match(__private.HISTORY_SQL, /bucket\.bucket_ts >= \$5::timestamptz/);
    assert.match(__private.HISTORY_SQL, /GREATEST\(\$4::int, source_granularity_minutes\)/);
    assert.match(__private.HISTORY_SQL,
      /ROW_NUMBER\(\) OVER \(PARTITION BY token_address ORDER BY bucket_ts DESC\)/);
    assert.doesNotMatch(__private.HISTORY_SQL, /bucket\.\*/);
  });

  it('aggregates token-wide activity and deterministic OHLC ordering', () => {
    assert.match(__private.HISTORY_SQL, /SUM\(volume_usd\)/);
    assert.match(__private.HISTORY_SQL, /COUNT\(DISTINCT \(protocol, market_key\)\)/);
    assert.match(__private.HISTORY_SQL,
      /open_fdv_usd ORDER BY bucket_ts, first_block_number,[\s\S]*protocol, market_key/);
    assert.match(__private.HISTORY_SQL,
      /close_fdv_usd ORDER BY bucket_ts DESC, last_block_number DESC,[\s\S]*protocol, market_key/);
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
