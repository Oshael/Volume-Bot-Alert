const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodWorkspaceRadarReader,
  __private,
} = require('../src/services/robinhood-workspace-radar-reader');

const TOKEN = `0x${'1'.repeat(40)}`;
const DISMISSED = `0x${'a'.repeat(40)}`;
const AS_OF = '2026-07-15T18:00:00.000Z';

function catalogRow(overrides = {}) {
  return {
    address: TOKEN, symbol: 'RHD', name: 'Persistent Robinhood', source: 'robinhood-onchain',
    first_seen_at: '2026-07-14T12:00:00.000Z',
    last_seen_at: '2026-07-14T13:00:00.000Z', last_evaluated_at: null,
    last_token_created_at_ms: null, last_fdv_usd: '50000',
    valuation_observed_at: '2026-07-14T13:00:00.000Z', last_price: '0.25',
    last_pair_address: `0x${'2'.repeat(40)}`, last_pair_url: 'https://dex.example/rh',
    last_dex_id: 'uniswap-v3', last_image_url: null, last_twitter_url: null,
    last_community_url: null, monitor_priority: 'dormant', total_count: '1',
    ...overrides,
  };
}

function metrics(overrides = {}) {
  return {
    chain: 'robinhood', address: TOKEN, key: `robinhood:${TOKEN}`, windowEnd: AS_OF,
    lastActivityAt: '2026-07-14T13:00:00.000Z', volume5mUsd: 0,
    volume1hUsd: 0, volume6hUsd: 0, volume24hUsd: 100,
    priceChange1hPct: null, priceChange6hPct: null, priceChange24hPct: 2,
    coverage: { '5m': 'complete', '1h': 'complete', '6h': 'complete', '24h': 'complete' },
    priceChangeCoverage: { '1h': 'unavailable', '6h': 'unavailable', '24h': 'complete' },
    ...overrides,
  };
}

describe('Robinhood workspace radar reader', () => {
  it('keeps a stale persistent row with first-seen age and FDV semantics', async () => {
    const calls = [];
    const reader = createRobinhoodWorkspaceRadarReader({
      database: { async queryWithStatementTimeout(sql, params, timeout) {
        calls.push({ sql, params, timeout });
        return { rows: [catalogRow()] };
      } },
      windowRead: { async getMetricsByAddresses(input) {
        calls.push({ input });
        return [metrics()];
      } },
    });
    const result = await reader.listRadarPrefix({
      asOf: AS_OF, minFdv: 30_000, maxFdv: 80_000, searchQuery: 'persistent',
      dismissedIdentities: [`robinhood:${DISMISSED}`],
      sorts: [{ mode: 'vol', window: '1h' }],
    });

    assert.equal(result.total, 1);
    assert.equal(result.rows[0].identity.key, `robinhood:${TOKEN}`);
    assert.equal(result.rows[0].tokenAge.provenance, 'first-seen');
    assert.equal(result.rows[0].valuation.type, 'fdv');
    assert.equal(result.rows[0].valuation.usd, 50_000);
    assert.equal(result.rows[0].valuation.freshness, 'stale');
    assert.equal(result.rows[0].liquidityUsd, null);
    assert.equal(result.rows[0].volume1hUsd, 0);
    assert.deepEqual(calls[0].params.slice(1), [
      30_000, 80_000, 0, 10_080, '%persistent%', [DISMISSED], false, [], 30,
    ]);
    assert.equal(calls[0].timeout, 30_000);
  });

  it('uses only Robinhood FDV and multiprotocol market sources', () => {
    const sql = __private.buildCatalogSql([
      { mode: 'vol', window: '1h' }, { mode: 'pchange', window: '24h' },
      { mode: 'mcap', window: 'lowest' }, { mode: 'age', window: 'newest' },
    ]);

    assert.match(sql, /robinhood_market_buckets_1m/);
    assert.match(sql, /robinhood_market_buckets_1h/);
    assert.match(sql, /WITH catalog_candidates AS MATERIALIZED/);
    assert.match(sql, /tc\.last_seen_at > \$1::timestamptz/);
    assert.match(sql, /tc\.last_fdv IS NULL/);
    assert.match(sql, /tc\.last_fdv >= \$2::numeric/);
    assert.match(sql, /LIMIT 1\) primary_market ON TRUE/);
    assert.match(sql, /\) prices ON TRUE/);
    assert.match(sql, /ORDER BY bucket\.bucket_ts DESC, bucket\.last_observed_at DESC/);
    assert.match(sql, /'uniswap-v2', 'uniswap-v3', 'uniswap-v4'/);
    assert.match(sql, /valuation\.last_fdv_usd ASC NULLS LAST/);
    assert.match(sql, /valuation\.last_fdv_usd < 30000000000/);
    assert.match(sql, /admin_blocked_tokens/);
    assert.match(sql, /last_observed_at < \$1::timestamptz/);
    assert.doesNotMatch(sql, /eligible_for_monitoring|is_active_monitor_candidate/);
    assert.doesNotMatch(sql, /last_mcap|meteora|bid.?zone|token_market_buckets_1m/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('only reads the market data required by the active sort windows', () => {
    const volume = __private.buildCatalogSql([{ mode: 'vol', window: '1h' }]);
    const valuation = __private.buildCatalogSql([{ mode: 'mcap', window: 'highest' }]);

    assert.match(volume, /bucket\.token_address = tc\.address/);
    assert.match(volume, /INTERVAL '1 hour'/);
    assert.match(volume, /FROM robinhood_market_buckets_1h bucket/);
    assert.match(volume, /activity_start_1h AS MATERIALIZED/);
    assert.match(volume, /activity_end AS MATERIALIZED/);
    assert.match(volume, /LEFT JOIN activity ON activity\.token_address = tc\.address/);
    assert.match(volume, /date_trunc\('hour', \$1::timestamptz\)/);
    assert.doesNotMatch(volume, /primary_market ON TRUE/);
    assert.doesNotMatch(volume, /prices ON TRUE/);
    assert.doesNotMatch(volume, /24 hours 15 minutes/);
    assert.match(volume, /activity AS MATERIALIZED/);
    assert.doesNotMatch(valuation, /robinhood_market_buckets_1m/);
    assert.doesNotMatch(valuation, /\bactivity\.|\bprices\./);
  });

  it('orders volume values before their coverage state', () => {
    const order = __private.buildOrderSql([{ mode: 'vol', window: '24h' }]);

    assert.match(order, /^\(CASE/);
    assert.match(order, /DESC NULLS LAST,\n {2}CASE/);
  });

  it('returns an explicit empty starred result without querying', async () => {
    let queried = false;
    const reader = createRobinhoodWorkspaceRadarReader({
      database: { async query() { queried = true; return { rows: [] }; } },
      windowRead: { async getMetricsByAddresses() { return []; } },
    });
    const result = await reader.listRadarPrefix({ starredOnly: true, starredIdentities: [] });
    assert.equal(result.total, 0);
    assert.equal(queried, false);
  });

  it('looks up an order-lock pin without applying FDV or age filters', async () => {
    const reader = createRobinhoodWorkspaceRadarReader({
      database: { async query(sql, params) {
        assert.match(sql, /address = ANY\(\$2::varchar\[\]\)/);
        assert.deepEqual(params, [new Date(AS_OF), [TOKEN]]);
        return { rows: [catalogRow({ first_seen_at: null, last_fdv_usd: null,
          valuation_observed_at: null, total_count: undefined })] };
      } },
      windowRead: { async getMetricsByAddresses() { return [metrics()]; } },
    });
    const rows = await reader.getRadarTokensByAddresses({ addresses: [TOKEN], asOf: AS_OF });
    assert.equal(rows[0].tokenAge.state, 'unknown');
    assert.equal(rows[0].valuation.type, 'fdv');
    assert.equal(rows[0].valuation.usd, null);
  });

  it('fails closed when SQL and normalized metrics disagree', async () => {
    const second = `0x${'2'.repeat(40)}`;
    const reader = createRobinhoodWorkspaceRadarReader({
      database: { async query() { return { rows: [
        catalogRow({ total_count: '2' }), catalogRow({ address: second, total_count: '2' }),
      ] }; } },
      windowRead: { async getMetricsByAddresses({ addresses }) {
        return addresses.map((address, index) => ({
          ...metrics({ volume1hUsd: index === 0 ? 0 : 10 }), address,
        }));
      } },
    });
    await assert.rejects(reader.listRadarPrefix({
      asOf: AS_OF, perPage: 2, sorts: [{ mode: 'vol', window: '1h' }],
    }), /not normalized-sort compatible/);
  });
});
