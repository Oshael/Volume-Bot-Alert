const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodMarketAggregateRepository,
  __private: { foldMarketRows },
} = require('../src/models/robinhood-market-aggregate');

const ADDRESS = `0x${'a'.repeat(40)}`;
const INPUT = {
  tokenAddress: ADDRESS,
  granularityMinutes: 5,
  bucketTs: '2026-07-18T12:00:00.000Z',
  source: { minutes: 1 },
};

function marketRow(protocol, marketKey, order, values = {}) {
  return {
    protocol,
    market_key: marketKey,
    open_price_usd: values.open ?? order,
    high_price_usd: values.high ?? order + 2,
    low_price_usd: values.low ?? order - 0.5,
    close_price_usd: values.close ?? order + 1,
    open_fdv_usd: (values.open ?? order) * 100,
    high_fdv_usd: (values.high ?? order + 2) * 100,
    low_fdv_usd: (values.low ?? order - 0.5) * 100,
    close_fdv_usd: (values.close ?? order + 1) * 100,
    volume_usd: values.volume ?? order * 10,
    swaps: String(values.swaps ?? order),
    buys: String(values.buys ?? order - 1),
    sells: '1',
    transactions: String(values.transactions ?? order),
    first_observed_at: `2026-07-18T12:0${order}:00.000Z`,
    first_block_number: String(100 + order),
    first_log_index: String(order),
    last_observed_at: `2026-07-18T12:0${order}:30.000Z`,
    last_block_number: String(100 + order),
    last_log_index: String(order + 10),
  };
}

function withValuation(rows, protocol, marketKey, volume24h = '1000') {
  return rows.map((row) => ({
    ...row,
    valuation_protocol: protocol,
    valuation_market_key: marketKey,
    valuation_volume_24h_usd: volume24h,
  }));
}

describe('Robinhood market aggregate repository', () => {
  it('loads only a bounded recent source range for restart recovery', async () => {
    const calls = [];
    const repository = createRobinhoodMarketAggregateRepository({
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [{ token_address: ADDRESS, bucket_ts: INPUT.bucketTs }] };
      },
    });

    const rows = await repository.listRecentSourceBuckets({
      since: '2026-07-18T11:30:00.000Z',
      limit: 25,
    });

    assert.equal(rows.length, 1);
    assert.match(calls[0].sql, /bucket_ts >= \$1[\s\S]*LIMIT \$2/);
    assert.deepEqual(calls[0].params, ['2026-07-18T11:30:00.000Z', 25]);
  });

  it('uses primary-market OHLC while preserving activity from every market', () => {
    const rows = withValuation([
      marketRow('uniswap-v3', 'market-b', 2, { volume: '20' }),
      marketRow('uniswap-v4', 'market-c', 3, { high: 1_000_000, volume: '30' }),
      marketRow('uniswap-v2', 'market-a', 1, { volume: '10' }),
    ], 'uniswap-v3', 'market-b', '5000');
    const aggregate = foldMarketRows(rows, INPUT);

    assert.deepEqual(foldMarketRows([...rows].reverse(), INPUT), aggregate);
    assert.equal(aggregate.open_price_usd, 2);
    assert.equal(aggregate.high_price_usd, 4);
    assert.equal(aggregate.close_price_usd, 3);
    assert.equal(aggregate.volume_usd, '60');
    assert.equal(aggregate.swaps, '6');
    assert.equal(aggregate.valuation_protocol, 'uniswap-v3');
    assert.equal(aggregate.valuation_market_key, 'market-b');
    assert.equal(aggregate.valuation_volume_24h_usd, '5000');
    assert.equal(aggregate.market_count, 3);
    assert.equal(aggregate.source_bucket_count, 3);
    assert.deepEqual(aggregate.protocols, ['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
  });

  it('replaces an active aggregate after a late source update instead of adding twice', async () => {
    const sourceVersions = [
      withValuation([marketRow('uniswap-v2', 'market-a', 1, { volume: '0.1' })],
        'uniswap-v2', 'market-a'),
      withValuation([marketRow('uniswap-v2', 'market-a', 1, { volume: '0.2' })],
        'uniswap-v2', 'market-a'),
    ];
    const written = [];
    const sourceQueries = [];
    const database = {
      async query(sql, params) {
        if (/source_rows AS MATERIALIZED/.test(sql)) {
          sourceQueries.push(sql);
          return { rows: sourceVersions.shift() };
        }
        assert.match(sql, /ON CONFLICT[\s\S]*volume_usd = EXCLUDED\.volume_usd[\s\S]*IS DISTINCT FROM/);
        const payload = JSON.parse(params[0]);
        written.push(payload);
        return { rows: [payload] };
      },
    };
    const repository = createRobinhoodMarketAggregateRepository(database);

    await repository.refreshBucket(INPUT);
    await repository.refreshBucket(INPUT);

    assert.deepEqual(written.map((row) => row.volume_usd), ['0.1', '0.2']);
    assert.deepEqual(written.map((row) => row.source_bucket_count), [1, 1]);
    assert.equal(sourceQueries.length, 2);
    assert.match(sourceQueries[0], /INTERVAL '24 hours'/);
    assert.match(sourceQueries[0], /ORDER BY volume_24h_usd DESC/);
    assert.doesNotMatch(sourceQueries[0], /\bprimary\b/);
  });

  it('rebuilds complete hourly ranges in one set-based statement', async () => {
    const calls = [];
    const repository = createRobinhoodMarketAggregateRepository({
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [{
            source_buckets: 7,
            identity_conflicts: 0,
            written_buckets: 5,
            token_count: 2,
            last_token: ADDRESS,
            has_more_tokens: true,
          }],
        };
      },
    });

    const result = await repository.refreshHourlyRange({
      from: '2026-07-18T12:00:00.000Z',
      to: '2026-07-18T14:00:00.000Z',
      afterToken: null,
      tokenLimit: 2,
    });

    assert.deepEqual(result, {
      sourceBuckets: 7,
      writtenBuckets: 5,
      tokenCount: 2,
      lastToken: ADDRESS,
      hasMoreTokens: true,
    });
    assert.deepEqual(calls[0].params, [
      '2026-07-18T12:00:00.000Z',
      '2026-07-18T14:00:00.000Z',
      null,
      2,
    ]);
    assert.match(calls[0].sql, /candidate_tokens[\s\S]*token_address > \$3/);
    assert.match(calls[0].sql, /LIMIT \(\$4::int \+ 1\)/);
    assert.match(calls[0].sql, /INSERT INTO robinhood_market_buckets_1h/);
    assert.match(calls[0].sql, /FROM robinhood_market_buckets_1m minute/);
    assert.match(calls[0].sql, /ON CONFLICT[\s\S]*IS DISTINCT FROM EXCLUDED\.volume_usd/);
    assert.doesNotMatch(calls[0].sql, /jsonb_to_recordset/);
  });

  it('rejects partial-hour range boundaries before querying PostgreSQL', async () => {
    let queried = false;
    const repository = createRobinhoodMarketAggregateRepository({
      async query() {
        queried = true;
        return { rows: [] };
      },
    });

    await assert.rejects(
      repository.refreshHourlyRange({
        from: '2026-07-18T12:01:00.000Z',
        to: '2026-07-18T13:00:00.000Z',
        afterToken: null,
        tokenLimit: 25,
      }),
      /aligned to UTC hours/
    );
    assert.equal(queried, false);
  });

  it('rejects an hourly range with conflicting stored token dimensions', async () => {
    const repository = createRobinhoodMarketAggregateRepository({
      async query() {
        return {
          rows: [{ source_buckets: 1, identity_conflicts: 1, written_buckets: 0 }],
        };
      },
    });

    await assert.rejects(
      repository.refreshHourlyRange({
        from: '2026-07-18T12:00:00.000Z',
        to: '2026-07-18T13:00:00.000Z',
        afterToken: null,
        tokenLimit: 25,
      }),
      /conflicting token dimensions/
    );
  });

  it('rebuilds all token aggregates in one set-based statement per source range', async () => {
    const calls = [];
    const repository = createRobinhoodMarketAggregateRepository({
      async query(sql, params) {
        calls.push({ sql, params });
        return {
          rows: [{
            source_buckets: 40,
            target_buckets: 12,
            written_buckets: 9,
            token_count: 3,
            last_token: ADDRESS,
            has_more_tokens: false,
          }],
        };
      },
    });

    const result = await repository.refreshAggregateRange({
      from: '2026-07-18T12:03:00.000Z',
      to: '2026-07-18T13:03:00.000Z',
      granularities: [30, 5, 15, 5],
      afterToken: ADDRESS,
      tokenLimit: 3,
    });

    assert.deepEqual(result, {
      sourceBuckets: 40,
      targetBuckets: 12,
      writtenBuckets: 9,
      tokenCount: 3,
      lastToken: ADDRESS,
      hasMoreTokens: false,
    });
    assert.deepEqual(calls[0].params, [
      '2026-07-18T12:03:00.000Z',
      '2026-07-18T13:03:00.000Z',
      [5, 15, 30],
      ADDRESS,
      3,
    ]);
    assert.match(calls[0].sql, /source_window AS MATERIALIZED/);
    assert.match(calls[0].sql, /primary_markets AS MATERIALIZED/);
    assert.match(calls[0].sql, /INTERVAL '24 hours'/);
    assert.match(calls[0].sql, /activity\.volume_24h_usd DESC/);
    assert.match(calls[0].sql, /date_bin\(/);
    assert.match(calls[0].sql, /INNER JOIN robinhood_market_buckets_1m bucket/);
    assert.match(calls[0].sql,
      /last_log_index DESC,\s+bucket\.protocol DESC, bucket\.market_key DESC/);
    assert.match(calls[0].sql, /SUM\(bucket\.volume_usd\)/);
    assert.match(calls[0].sql, /FILTER \(WHERE[\s\S]*valuation_market\.valuation_market_key/);
    assert.doesNotMatch(calls[0].sql, /\bprimary\b/);
    assert.match(calls[0].sql, /ON CONFLICT[\s\S]*IS DISTINCT FROM EXCLUDED\.volume_usd/);

    await repository.refreshAggregateRange({
      from: '2026-07-18T00:00:00.000Z',
      to: '2026-07-19T00:00:00.000Z',
      granularities: [60, 240, 1440],
      afterToken: null,
      tokenLimit: 25,
    });
    assert.match(calls[1].sql, /FROM robinhood_market_buckets_1h/);
    assert.match(calls[1].sql, /60::smallint AS source_granularity_minutes/);
  });

  it('does not mix granularities backed by different source tables', async () => {
    const repository = createRobinhoodMarketAggregateRepository({
      async query() { throw new Error('query must not run'); },
    });

    await assert.rejects(
      repository.refreshAggregateRange({
        from: '2026-07-18T12:00:00.000Z',
        to: '2026-07-18T13:00:00.000Z',
        granularities: [30, 60],
        afterToken: null,
        tokenLimit: 25,
      }),
      /same source table/
    );
  });
});
