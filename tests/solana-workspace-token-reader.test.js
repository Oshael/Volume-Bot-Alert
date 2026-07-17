const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createSolanaWorkspaceTokenReader,
  __private,
} = require('../src/services/solana-workspace-token-reader');

const TOKEN = 'So11111111111111111111111111111111111111112';
const TOKEN_TWO = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const EXCLUDED = '11111111111111111111111111111111';
const AS_OF = '2026-07-15T18:00:00.000Z';

function catalogRow(address, overrides = {}) {
  return {
    address,
    symbol: 'SOL',
    name: 'Solana token',
    source: 'gmgn',
    first_seen_at: new Date('2026-07-14T12:00:00.000Z'),
    last_evaluated_at: new Date('2026-07-15T17:59:00.000Z'),
    last_mcap: '40000',
    last_token_created_at_ms: '1000',
    last_price: '2.50',
    last_liquidity_usd: '9000',
    last_pair_address: 'pair-solana',
    last_pair_url: 'https://dex.example/solana',
    last_dex_id: 'raydium',
    last_image_url: 'https://cdn.example/sol.png',
    last_twitter_url: 'https://x.com/solana',
    last_community_url: 'https://t.me/solana',
    monitor_priority: 'normal',
    last_seen_at: new Date('2026-07-15T17:58:00.000Z'),
    total_count: '5',
    ...overrides,
  };
}

function metrics(address, overrides = {}) {
  return {
    chain: 'solana',
    address,
    key: `solana:${address}`,
    windowEnd: AS_OF,
    lastActivityAt: null,
    volume5mUsd: 100,
    volume1hUsd: 500,
    volume6hUsd: 2_000,
    volume24hUsd: 9_000,
    coverage: {
      '5m': 'complete', '1h': 'complete', '6h': 'complete', '24h': 'complete',
    },
    ...overrides,
  };
}

describe('Solana workspace token reader', () => {
  it('returns a bounded persistent prefix with normalized valuation and metrics', async () => {
    const calls = [];
    const database = {
      async queryWithStatementTimeout(sql, params, timeoutMs) {
        calls.push({ sql, params, timeoutMs });
        return { rows: [
          catalogRow(TOKEN, { last_mcap: '50000' }),
          catalogRow(TOKEN_TWO, { last_mcap: '40000' }),
        ] };
      },
    };
    const windowRead = {
      async getMetricsByAddresses(input) {
        calls.push({ windowInput: input });
        return input.addresses.map((address, index) => metrics(address, {
          volume1hUsd: index === 0 ? 500 : 0,
        }));
      },
    };
    const reader = createSolanaWorkspaceTokenReader({ database, windowRead });
    const prefix = await reader.listMonitoredPrefix({
      asOf: '2026-07-15T18:00:45.000Z', page: 1, perPage: 1,
      minMcap: 30_000, maxMcap: 100_000,
      excludedAddresses: [EXCLUDED, EXCLUDED],
      sorts: [{ mode: 'vol', window: '1h' }],
    });

    assert.equal(prefix.chain, 'solana');
    assert.equal(prefix.asOf, AS_OF);
    assert.equal(prefix.total, 5);
    assert.equal(prefix.rows.length, 2);
    assert.equal(prefix.rows[0].identity.key, `solana:${TOKEN}`);
    assert.deepEqual(prefix.rows[0].valuation, {
      type: 'mcap', usd: 50_000, observedAt: '2026-07-15T17:59:00.000Z',
      freshness: 'fresh',
    });
    assert.deepEqual({
      priceUsd: prefix.rows[0].priceUsd,
      liquidityUsd: prefix.rows[0].liquidityUsd,
      pairAddress: prefix.rows[0].pairAddress,
      pairDexId: prefix.rows[0].pairDexId,
      monitorPriority: prefix.rows[0].monitorPriority,
      lastSeenAt: prefix.rows[0].lastSeenAt,
    }, {
      priceUsd: 2.5,
      liquidityUsd: 9000,
      pairAddress: 'pair-solana',
      pairDexId: 'raydium',
      monitorPriority: 'normal',
      lastSeenAt: '2026-07-15T17:58:00.000Z',
    });
    assert.equal(prefix.rows[1].volume1hUsd, 0);
    assert.deepEqual(calls[0].params, [
      new Date(AS_OF), 30_000, 100_000, [EXCLUDED], 2,
    ]);
    assert.equal(calls[0].timeoutMs, 15_000);
    assert.deepEqual(calls[1].windowInput, {
      addresses: [TOKEN, TOKEN_TWO], asOf: AS_OF, statementTimeoutMs: 15_000,
    });
  });

  it('uses equivalent persistent visibility and coverage ordering in SQL', () => {
    const sql = __private.buildPrefixSql([
      { mode: 'vol', window: '5m' },
      { mode: 'mcap', window: 'lowest' },
      { mode: 'age', window: 'newest' },
    ]);

    assert.match(sql, /FROM token_catalog tc/);
    assert.match(sql, /token_market_volume_buckets_1m/);
    assert.match(sql, /tc\.last_price/);
    assert.match(sql, /tc\.last_pair_url/);
    assert.match(sql, /window_coverage/);
    assert.match(sql, /admin_blocked_tokens/);
    assert.match(sql, /junk_permanent/);
    assert.match(sql, /CASE[\s\S]+close_vol_5m[\s\S]+INTERVAL '1 minute'/);
    assert.match(sql, /close_vol_5m DESC NULLS LAST/);
    assert.match(sql, /tc\.last_mcap ASC NULLS LAST/);
    assert.match(sql, /token_created_at_ms[\s\S]+DESC NULLS LAST/);
    assert.match(sql, /tc\.address <> ALL\(\$4::varchar\[\]\)/);
    assert.match(sql, /LIMIT \$5::int/);
    assert.doesNotMatch(sql, /eligible_for_monitoring/);
    assert.doesNotMatch(sql, /is_active_monitor_candidate/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('hydrates pinned identities exactly without applying the valuation floor', async () => {
    const calls = [];
    const database = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [catalogRow(TOKEN, { last_mcap: '10', total_count: undefined })] };
      },
    };
    const windowRead = {
      async getMetricsByAddresses(input) {
        calls.push({ windowInput: input });
        return [metrics(TOKEN)];
      },
    };
    const reader = createSolanaWorkspaceTokenReader({ database, windowRead });
    const rows = await reader.getTokensByAddresses({ addresses: [TOKEN], asOf: AS_OF });

    assert.equal(rows[0].valuation.usd, 10);
    assert.deepEqual(calls[0].params, [[TOKEN]]);
    assert.match(calls[0].sql, /tc\.address = ANY\(\$1::varchar\[\]\)/);
    assert.match(calls[0].sql, /junk_permanent/);
    assert.doesNotMatch(calls[0].sql, /last_mcap >=/);
    assert.equal(calls[1].windowInput.asOf, AS_OF);
  });

  it('batches bounded metric hydration and fails closed on an incomplete result', async () => {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const addresses = Array.from({ length: 101 }, (_, index) => (
      `${'1'.repeat(30)}${alphabet[Math.floor(index / alphabet.length)]}`
        + alphabet[index % alphabet.length]
    )).sort();
    const database = {
      async query(_sql, params) {
        return { rows: addresses.slice(0, params[4]).map((address) => catalogRow(address, {
          total_count: '101', last_token_created_at_ms: null,
        })) };
      },
    };
    const batches = [];
    const windowRead = {
      async getMetricsByAddresses(input) {
        batches.push(input.addresses);
        return input.addresses.map((address) => metrics(address));
      },
    };
    const reader = createSolanaWorkspaceTokenReader({ database, windowRead });
    const prefix = await reader.listMonitoredPrefix({
      asOf: AS_OF, page: 1, perPage: 100, minMcap: 0,
    });

    assert.equal(prefix.rows.length, 101);
    assert.deepEqual(batches.map((batch) => batch.length), [100, 1]);

    windowRead.getMetricsByAddresses = async () => [];
    await assert.rejects(
      reader.listMonitoredPrefix({ asOf: AS_OF, perPage: 1, minMcap: 0 }),
      /metric hydration returned 0 rows; 1 required/,
    );
  });

  it('rejects invalid filters and timeouts before querying', async () => {
    const reader = createSolanaWorkspaceTokenReader({
      database: { async query() { throw new Error('must not query'); } },
      windowRead: { async getMetricsByAddresses() { return []; } },
    });

    await assert.rejects(reader.listMonitoredPrefix({ minMcap: -1 }), /minMcap/);
    await assert.rejects(
      reader.listMonitoredPrefix({ excludedAddresses: ['invalid'] }), /Invalid solana/,
    );
    await assert.rejects(
      reader.listMonitoredPrefix({ minMcap: 50, maxMcap: 40 }), /maxMcap/,
    );
    await assert.rejects(
      reader.listMonitoredPrefix({ statementTimeoutMs: 999 }), /between 1000 and 60000/,
    );
  });
});
