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

describe('Robinhood market aggregate repository', () => {
  it('folds V2, V3 and V4 market rows once with deterministic chain-wide ordering', () => {
    const rows = [
      marketRow('uniswap-v3', 'market-b', 2),
      marketRow('uniswap-v4', 'market-c', 3),
      marketRow('uniswap-v2', 'market-a', 1),
    ];
    const aggregate = foldMarketRows(rows, INPUT);

    assert.deepEqual(foldMarketRows([...rows].reverse(), INPUT), aggregate);
    assert.equal(aggregate.open_price_usd, 1);
    assert.equal(aggregate.close_price_usd, 4);
    assert.equal(aggregate.volume_usd, '60');
    assert.equal(aggregate.swaps, '6');
    assert.equal(aggregate.market_count, 3);
    assert.equal(aggregate.source_bucket_count, 3);
    assert.deepEqual(aggregate.protocols, ['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
  });

  it('replaces an active aggregate after a late source update instead of adding twice', async () => {
    const sourceVersions = [
      [marketRow('uniswap-v2', 'market-a', 1, { volume: '0.1' })],
      [marketRow('uniswap-v2', 'market-a', 1, { volume: '0.2' })],
    ];
    const written = [];
    const database = {
      async query(sql, params) {
        if (/^\s*SELECT protocol/.test(sql)) return { rows: sourceVersions.shift() };
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
  });
});
