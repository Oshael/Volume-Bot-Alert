const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodTokenReadRepository,
  __private,
} = require('../src/models/robinhood-token-read');

const TOKEN = '0x1111111111111111111111111111111111111111';
const TOKEN_TWO = '0x3333333333333333333333333333333333333333';
const QUOTE = '0x2222222222222222222222222222222222222222';
const MARKET = `robinhood:uniswap-v3:0x${'3'.repeat(40)}`;

function aggregateRow(overrides = {}) {
  return {
    protocol: 'uniswap-v3',
    market_key: MARKET,
    token_address: TOKEN,
    quote_address: QUOTE,
    token_discovered_at: new Date('2026-07-14T17:00:00.000Z'),
    token_first_observed_at: new Date('2026-07-14T17:55:05.000Z'),
    token_last_observed_at: new Date('2026-07-14T17:59:55.000Z'),
    window_start: new Date('2026-07-14T17:55:00.000Z'),
    window_end: new Date('2026-07-14T18:00:00.000Z'),
    token_volume_usd: '2400.50',
    token_swaps: '30',
    token_buys: '18',
    token_sells: '12',
    token_transactions: '27',
    last_price_usd: '1.25',
    last_fdv_usd: '1250000',
    last_liquidity_usd: null,
    token_liquidity_usd: null,
    last_liquidity_status: 'requires_tick_liquidity_distribution',
    last_liquidity_confidence: 'none',
    last_liquidity_warning: null,
    incomplete_liquidity_markets: '2',
    token_market_count: '2',
    protocol_breakdown: {
      'uniswap-v2': {
        volumeUsd: '400.50', swaps: '10', buys: '6', sells: '4',
        transactions: '9', markets: '1',
      },
      'uniswap-v3': {
        volumeUsd: '2000', swaps: '20', buys: '12', sells: '8',
        transactions: '18', markets: '1',
      },
    },
    market_breakdown: [
      { protocol: 'uniswap-v3', marketKey: MARKET, volumeUsd: '2000' },
      { protocol: 'uniswap-v2', marketKey: `robinhood:uniswap-v2:0x${'4'.repeat(40)}`, volumeUsd: '400.50' },
    ],
    admin_blocked: false,
    ...overrides,
  };
}

describe('Robinhood aggregate token read repository', () => {
  it('returns one token candidate with totals and protocol contribution breakdown', async () => {
    const calls = [];
    const database = {
      async queryWithStatementTimeout(sql, params, timeoutMs) {
        calls.push({ sql, params, timeoutMs });
        return { rows: [aggregateRow()] };
      },
    };
    const repository = createRobinhoodTokenReadRepository({ database });
    const rows = await repository.listSignalDryRunCandidates({
      windowMs: 300000,
      limit: 25,
      asOf: '2026-07-14T18:00:10.000Z',
      statementTimeoutMs: 5000,
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokenAddress, TOKEN);
    assert.equal(rows[0].protocol, 'uniswap-v3');
    assert.equal(rows[0].volumeUsd, '2400.50');
    assert.equal(rows[0].swaps, 30);
    assert.equal(rows[0].transactions, 27);
    assert.equal(rows[0].marketCount, 2);
    assert.equal(rows[0].protocolBreakdown['uniswap-v2'].volumeUsd, '400.50');
    assert.equal(rows[0].protocolBreakdown['uniswap-v3'].volumeUsd, '2000');
    assert.equal(rows[0].liquidityCoverage, 'partial');
    assert.equal(rows[0].liquidityUsd, null);

    assert.deepEqual(calls[0].params, [
      300000, 25, new Date('2026-07-14T18:00:10.000Z'), true,
    ]);
    assert.equal(calls[0].timeoutMs, 5000);
    assert.match(calls[0].sql, /protocol IN \('uniswap-v2', 'uniswap-v3', 'uniswap-v4'\)/);
    assert.match(calls[0].sql, /SUM\(activity\.volume_usd\) OVER token/);
    assert.match(calls[0].sql, /PARTITION BY activity\.token_address/);
    assert.match(calls[0].sql, /ORDER BY activity\.volume_usd DESC/);
    assert.match(calls[0].sql, /AS protocol_breakdown/);
    assert.match(calls[0].sql, /AS market_breakdown/);
    assert.doesNotMatch(calls[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('keeps signal windows minute-aligned but allows exact active-token reads', async () => {
    const calls = [];
    const repository = createRobinhoodTokenReadRepository({
      database: {
        async query(_sql, params) { calls.push(params); return { rows: [] }; },
      },
    });

    await repository.listSignalDryRunCandidates({ windowMs: 900000 });
    await repository.listActiveTokenCandidates({
      windowMs: 900000, asOf: '2026-07-14T18:00:10.000Z',
    });

    assert.equal(calls[0][3], true);
    assert.equal(calls[1][3], false);
    assert.equal(calls[1][2].toISOString(), '2026-07-14T18:00:10.000Z');
  });

  it('uses an indexed token filter for immediate reads of touched identities', async () => {
    const calls = [];
    const repository = createRobinhoodTokenReadRepository({
      database: {
        async queryWithStatementTimeout(sql, params, timeoutMs) {
          calls.push({ sql, params, timeoutMs });
          return { rows: [aggregateRow()] };
        },
      },
    });

    const rows = await repository.listActiveTokenCandidatesByAddresses({
      addresses: [TOKEN.toUpperCase(), TOKEN, TOKEN_TWO],
      windowMs: 300000,
      asOf: '2026-07-14T18:00:10.000Z',
      statementTimeoutMs: 1500,
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokenAddress, TOKEN);
    assert.deepEqual(calls[0].params, [
      300000, 2, new Date('2026-07-14T18:00:10.000Z'), false, [TOKEN, TOKEN_TWO],
    ]);
    assert.equal(calls[0].timeoutMs, 1500);
    assert.match(calls[0].sql, /bucket\.token_address = ANY\(\$5::varchar\[\]\)/);
    assert.doesNotMatch(__private.AGGREGATE_SIGNAL_SQL, /\$5::varchar\[\]/);
  });

  it('turns cold repair into a bounded targeted read', async () => {
    const calls = [];
    const repository = createRobinhoodTokenReadRepository({
      database: {
        async query(sql, params) {
          calls.push({ sql, params });
          return /FROM token_catalog/.test(sql)
            ? { rows: [{ address: TOKEN, repair_seen_at: new Date('2026-07-14T17:59:00Z') }] }
            : { rows: [aggregateRow()] };
        },
      },
    });

    const rows = await repository.listColdRepairCandidates({
      windowMs: 900000, limit: 5000, alignToMinute: false,
    });

    assert.equal(rows.length, 1);
    assert.equal(calls[0].params[0], 25);
    assert.doesNotMatch(calls[0].sql, /robinhood_market_buckets_1m/);
    assert.match(calls[1].sql, /bucket\.token_address = ANY\(\$5::varchar\[\]\)/);
    assert.deepEqual(calls[1].params.slice(3), [false, [TOKEN]]);
  });

  it('skips empty targeted reads and rejects invalid or excessive identities', async () => {
    let calls = 0;
    const repository = createRobinhoodTokenReadRepository({
      database: { async query() { calls += 1; return { rows: [] }; } },
    });

    assert.deepEqual(await repository.listActiveTokenCandidatesByAddresses({
      addresses: [], windowMs: 300000,
    }), []);
    assert.equal(calls, 0);
    await assert.rejects(
      repository.listActiveTokenCandidatesByAddresses({
        addresses: ['invalid'], windowMs: 300000,
      }),
      /Invalid robinhood token address/,
    );
    await assert.rejects(
      repository.listActiveTokenCandidatesByAddresses({
        addresses: Array.from({ length: 101 }, (_, index) => (
          `0x${index.toString(16).padStart(40, '0')}`
        )),
        windowMs: 300000,
      }),
      /at most 100 addresses/,
    );
  });

  it('exposes USD liquidity only when every contributing market is covered', () => {
    const complete = __private.normalizeCandidate(aggregateRow({
      protocol: 'uniswap-v2',
      market_key: `robinhood:uniswap-v2:0x${'5'.repeat(40)}`,
      incomplete_liquidity_markets: '0',
      last_liquidity_usd: '9000',
      token_liquidity_usd: '12000',
      last_liquidity_status: 'spot_estimate_from_double_quote_reserve',
      last_liquidity_confidence: 'medium',
    }), 300000);

    assert.equal(complete.liquidityCoverage, 'complete');
    assert.equal(complete.liquidityUsd, '12000');
    assert.equal(complete.primaryMarketLiquidityUsd, '9000');
    assert.equal(complete.liquidityStatus, 'spot_estimate_from_double_quote_reserve');
  });

  it('rejects unbounded windows, limits, and statement timeouts', () => {
    assert.throws(
      () => __private.normalizeQuery({ windowMs: 90000 }),
      /whole minute/,
    );
    assert.throws(
      () => __private.normalizeQuery({ windowMs: 60000, limit: 0 }),
      /positive safe integer/,
    );
    assert.throws(
      () => __private.normalizeQuery({ windowMs: 60000, statementTimeoutMs: 999 }),
      /between 1000 and 60000/,
    );
  });
});
