const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createSolanaWorkspaceRadarReader,
  __private,
} = require('../src/services/solana-workspace-radar-reader');

const TOKEN = 'So11111111111111111111111111111111111111112';
const DISMISSED = '11111111111111111111111111111111';
const AS_OF = '2026-07-15T18:00:00.000Z';

function catalogRow(overrides = {}) {
  return {
    address: TOKEN, symbol: 'SOL', name: 'Persistent Solana', source: 'gmgn',
    first_seen_at: '2026-07-14T12:00:00.000Z',
    last_seen_at: '2026-07-14T13:00:00.000Z',
    last_evaluated_at: '2026-07-15T17:59:00.000Z',
    last_token_created_at_ms: String(Date.parse('2026-07-14T12:00:00.000Z')),
    last_mcap: '40000', last_price: '2.5', last_liquidity_usd: '9000',
    last_pair_address: 'pair', last_pair_url: 'https://dex.example/pair',
    last_dex_id: 'raydium', last_image_url: null, last_twitter_url: null,
    last_community_url: null, monitor_priority: 'low', total_count: '1',
    ...overrides,
  };
}

function metrics(overrides = {}) {
  return {
    chain: 'solana', address: TOKEN, key: `solana:${TOKEN}`, windowEnd: AS_OF,
    lastActivityAt: '2026-07-14T13:00:00.000Z',
    volume5mUsd: 0, volume1hUsd: 0, volume6hUsd: 0, volume24hUsd: 100,
    priceChange1hPct: null, priceChange6hPct: null, priceChange24hPct: 2,
    coverage: { '5m': 'complete', '1h': 'complete', '6h': 'complete', '24h': 'complete' },
    priceChangeCoverage: { '1h': 'unavailable', '6h': 'unavailable', '24h': 'complete' },
    ...overrides,
  };
}

describe('Solana workspace radar reader', () => {
  it('reads an inactive persistent row with normalized age, valuation and coverage', async () => {
    const calls = [];
    const reader = createSolanaWorkspaceRadarReader({
      database: {
        async queryWithStatementTimeout(sql, params, timeout) {
          calls.push({ sql, params, timeout });
          return { rows: [catalogRow()] };
        },
      },
      windowRead: {
        async getMetricsByAddresses(input) {
          calls.push({ input });
          return [metrics()];
        },
      },
    });
    const result = await reader.listRadarPrefix({
      asOf: AS_OF, bucket: 'recent', minMcap: 30_000, maxMcap: 80_000,
      searchQuery: 'persistent', dismissedIdentities: [`solana:${DISMISSED}`],
      starredIdentities: [],
      sorts: [{ mode: 'vol', window: '1h' }],
    });

    assert.equal(result.total, 1);
    assert.equal(result.rows[0].identity.key, `solana:${TOKEN}`);
    assert.equal(result.rows[0].tokenAge.provenance, 'chain-native');
    assert.equal(result.rows[0].valuation.type, 'mcap');
    assert.equal(result.rows[0].valuation.usd, 40_000);
    assert.equal(result.rows[0].volume1hUsd, 0);
    assert.equal(result.rows[0].coverage['1h'], 'complete');
    assert.equal(calls[0].timeout, 15_000);
    assert.deepEqual(calls[0].params.slice(1), [
      30_000, 80_000, 0, 10_080, '%persistent%', [DISMISSED], false, [], 30,
    ]);
    assert.deepEqual(calls[1].input.addresses, [TOKEN]);
  });

  it('keeps persistent visibility separate from monitoring eligibility in SQL', () => {
    const sql = __private.buildCatalogSql([
      { mode: 'vol', window: '1h' },
      { mode: 'pchange', window: '24h' },
      { mode: 'mcap', window: 'lowest' },
      { mode: 'age', window: 'newest' },
    ]);

    assert.match(sql, /FROM token_catalog tc/);
    assert.match(sql, /token_market_volume_buckets_1m/);
    assert.match(sql, /token_market_buckets_1m/);
    assert.match(sql, /admin_blocked_tokens/);
    assert.match(sql, /junk_permanent/);
    assert.match(sql, /tc\.last_mcap ASC NULLS LAST/);
    assert.match(sql, /price_24h/);
    assert.match(sql, /IS DISTINCT FROM 'complete'/);
    assert.doesNotMatch(sql, /eligible_for_monitoring/);
    assert.doesNotMatch(sql, /is_active_monitor_candidate/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('applies canonical static filters and returns an explicit empty starred result', async () => {
    let queried = false;
    const reader = createSolanaWorkspaceRadarReader({
      database: { async query() { queried = true; return { rows: [] }; } },
      windowRead: { async getMetricsByAddresses() { return []; } },
    });
    const empty = await reader.listRadarPrefix({
      asOf: AS_OF, starredOnly: true, starredIdentities: [],
    });

    assert.equal(empty.total, 0);
    assert.deepEqual(empty.rows, []);
    assert.equal(queried, false);
  });

  it('looks up an order-lock pin outside age and valuation filters', async () => {
    const reader = createSolanaWorkspaceRadarReader({
      database: { async query(sql) {
        assert.match(sql, /address = ANY\(\$1::varchar\[\]\)/);
        return { rows: [catalogRow({ first_seen_at: null,
          last_token_created_at_ms: null, last_mcap: null, total_count: undefined })] };
      } },
      windowRead: { async getMetricsByAddresses() { return [metrics()]; } },
    });
    const rows = await reader.getRadarTokensByAddresses({ addresses: [TOKEN], asOf: AS_OF });
    assert.equal(rows[0].tokenAge.state, 'unknown');
    assert.equal(rows[0].valuation.usd, null);
  });

  it('fails closed when SQL and normalized metric ordering disagree', async () => {
    const second = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const reader = createSolanaWorkspaceRadarReader({
      database: { async query() { return { rows: [
        catalogRow({ total_count: '2' }),
        catalogRow({ address: second, total_count: '2' }),
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
