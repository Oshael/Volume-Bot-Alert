const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodDashboardReadRepository,
  __private,
} = require('../src/models/robinhood-dashboard-read');

const TOKEN = '0x1111111111111111111111111111111111111111';
const QUOTE = '0x2222222222222222222222222222222222222222';
const MARKET = `robinhood:uniswap-v3:0x${'3'.repeat(40)}`;

function dashboardRow(overrides = {}) {
  return {
    protocol: 'uniswap-v3',
    market_key: MARKET,
    token_address: TOKEN,
    quote_address: QUOTE,
    token_discovered_at: new Date('2026-07-14T12:00:00.000Z'),
    token_first_observed_at: new Date('2026-07-14T12:05:00.000Z'),
    token_last_observed_at: new Date('2026-07-14T17:58:30.000Z'),
    token_volume_24h_usd: '4900.25',
    token_liquidity_usd: '9000',
    token_market_count: '3',
    incomplete_liquidity_markets: '2',
    last_price_usd: '2',
    last_fdv_usd: '2000000',
    last_liquidity_usd: null,
    last_liquidity_status: 'requires_tick_liquidity_distribution',
    last_liquidity_confidence: 'none',
    last_liquidity_warning: null,
    volume_5m_usd: '450.5',
    volume_1h_usd: '1200.75',
    volume_6h_usd: '3000',
    exact_volume_24h_usd: '5000.25',
    exact_swaps_24h: '90',
    exact_transactions_24h: '81',
    price_1h_usd: '1.6',
    price_6h_usd: '1',
    price_24h_usd: null,
    protocol_breakdown: {
      'uniswap-v2': { volumeUsd: '1000', swaps: '20', transactions: '18', markets: '1' },
      'uniswap-v3': { volumeUsd: '3000', swaps: '50', transactions: '45', markets: '1' },
      'uniswap-v4': { volumeUsd: '900.25', swaps: '20', transactions: '18', markets: '1' },
    },
    market_breakdown: [
      { protocol: 'uniswap-v3', marketKey: MARKET, volumeUsd: '3000' },
    ],
    ...overrides,
  };
}

describe('Robinhood dashboard read repository', () => {
  it('lists exact active identities with an independent FDV floor', async () => {
    const calls = [];
    const database = {
      async queryWithStatementTimeout(sql, params, timeoutMs) {
        calls.push({ sql, params, timeoutMs });
        return { rows: [{ chain: 'robinhood', address: TOKEN, last_fdv: '30000' }] };
      },
    };
    const repository = createRobinhoodDashboardReadRepository({ database });
    const rows = await repository.listActiveCatalogRows({
      asOf: '2026-07-14T18:00:00.000Z', minFdv: 30_000,
    });

    assert.equal(rows[0].last_fdv, '30000');
    assert.deepEqual(calls[0].params, [new Date('2026-07-14T18:00:00.000Z'), 30_000]);
    assert.equal(calls[0].timeoutMs, 15_000);
    assert.match(calls[0].sql, /eligible_for_monitoring/);
    assert.match(calls[0].sql, /last_fdv_usd, catalog\.last_fdv/);
    assert.match(calls[0].sql, /protocol IN \('uniswap-v2', 'uniswap-v3', 'uniswap-v4'\)/);
    assert.match(calls[0].sql, /MAX\(bucket\.last_observed_at\) > bounds\.freshness_start/);
    assert.doesNotMatch(calls[0].sql, /catalog\.eligible_for_monitoring\s*=\s*TRUE/);
    assert.doesNotMatch(calls[0].sql, /last_mcap[^,\n]*>=/);
  });

  it('returns bounded token rows with aggregate windows and partial liquidity', async () => {
    const calls = [];
    const database = {
      async queryWithStatementTimeout(sql, params, timeoutMs) {
        calls.push({ sql, params, timeoutMs });
        return { rows: [dashboardRow()] };
      },
    };
    const repository = createRobinhoodDashboardReadRepository({ database });
    const page = await repository.listTokenPage({
      limit: 25,
      asOf: '2026-07-14T18:00:59.000Z',
      statementTimeoutMs: 5000,
    });

    assert.equal(page.asOf, '2026-07-14T18:00:59.000Z');
    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].volume5mUsd, '450.5');
    assert.equal(page.rows[0].volume24hUsd, '5000.25');
    assert.equal(page.rows[0].swaps24h, 90);
    assert.equal(page.rows[0].transactions24h, 81);
    assert.equal(page.rows[0].priceChange1hPct, '25');
    assert.equal(page.rows[0].priceChange6hPct, '100');
    assert.equal(page.rows[0].priceChange24hPct, null);
    assert.equal(page.rows[0].freshness, 'fresh');
    assert.equal(page.rows[0].liquidityCoverage, 'partial');
    assert.equal(page.rows[0].liquidityUsd, null);
    assert.equal(page.rows[0].protocolBreakdown['uniswap-v4'].volumeUsd, '900.25');
    assert.equal(page.hasMore, false);
    assert.equal(page.nextCursor, null);

    assert.deepEqual(calls[0].params, [
      new Date('2026-07-14T18:00:59.000Z'), 26, null, null, null,
    ]);
    assert.equal(calls[0].timeoutMs, 5000);
    assert.match(calls[0].sql, /protocol IN \('uniswap-v2', 'uniswap-v3', 'uniswap-v4'\)/);
    assert.match(calls[0].sql, /SUM\(volume_24h_usd\) OVER token/);
    assert.match(calls[0].sql, /INTERVAL '5 minutes'/);
    assert.match(calls[0].sql, /AS protocol_breakdown/);
    assert.match(calls[0].sql, /date_trunc\('minute', bounds\.freshness_start\)/);
    assert.doesNotMatch(calls[0].sql, /token_market_(?:buckets|snapshots)/);
    assert.doesNotMatch(calls[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('uses the stable 24h sort key in the next-page cursor', async () => {
    const rows = [
      dashboardRow(),
      dashboardRow({
        token_address: `0x${'4'.repeat(40)}`,
        token_volume_24h_usd: '4100',
        exact_volume_24h_usd: '4200',
      }),
    ];
    const database = { async query() { return { rows }; } };
    const repository = createRobinhoodDashboardReadRepository({ database });
    const page = await repository.listTokenPage({
      limit: 1, asOf: '2026-07-14T18:00:00.000Z',
    });

    assert.equal(page.hasMore, true);
    const cursor = __private.parseCursor(page.nextCursor);
    assert.equal(cursor.volumeUsd, '4900.25');
    assert.equal(cursor.tokenAddress, TOKEN);
    assert.equal(cursor.asOf.toISOString(), page.asOf);
  });

  it('passes decoded keyset values and cursor asOf to the query', async () => {
    const cursor = __private.encodeCursor(dashboardRow(), new Date('2026-07-14T18:00:00Z'));
    const calls = [];
    const database = {
      async query(sql, params) { calls.push({ sql, params }); return { rows: [] }; },
    };
    const repository = createRobinhoodDashboardReadRepository({ database });
    await repository.listTokenPage({ cursor, limit: 10 });

    assert.deepEqual(calls[0].params, [
      new Date('2026-07-14T18:00:00.000Z'), 11, '4900.25',
      new Date('2026-07-14T17:58:30.000Z'), TOKEN,
    ]);
  });

  it('rejects malformed cursors, limits, mismatched snapshots and timeouts', () => {
    const cursor = __private.encodeCursor(dashboardRow(), new Date('2026-07-14T18:00:00Z'));
    assert.throws(() => __private.normalizeQuery({ cursor: 'bad' }), /Invalid/);
    assert.throws(() => __private.normalizeQuery({ limit: 0 }), /positive safe integer/);
    assert.throws(
      () => __private.normalizeQuery({ cursor, asOf: '2026-07-14T18:02:00Z' }),
      /does not match/,
    );
    assert.throws(
      () => __private.normalizeQuery({ statementTimeoutMs: 999 }),
      /between 1000 and 60000/,
    );
  });
});
