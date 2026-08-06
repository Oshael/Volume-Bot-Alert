const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWorkspaceTokenReader,
  __private,
} = require('../src/services/robinhood-workspace-token-reader');

const TOKEN = `0x${'1'.repeat(40)}`;
const TOKEN_TWO = `0x${'2'.repeat(40)}`;
const EXCLUDED = `0x${'a'.repeat(40)}`;
const AS_OF = '2026-07-15T18:00:00.000Z';

function catalogRow(address, overrides = {}) {
  return {
    address,
    symbol: 'RHD',
    name: 'Robinhood token',
    source: 'robinhood-onchain',
    first_seen_at: new Date('2026-07-14T12:00:00.000Z'),
    last_fdv_usd: '50000',
    valuation_observed_at: new Date('2026-07-15T17:20:00.000Z'),
    last_price: '0.25',
    last_liquidity_usd: '12000',
    last_pair_address: `0x${'3'.repeat(40)}`,
    last_pair_url: 'https://dex.example/robinhood',
    last_dex_id: 'uniswap-v3',
    last_image_url: 'https://cdn.example/rhd.png',
    launchpad_id: 'pons',
    last_twitter_url: 'https://x.com/robinhood',
    last_community_url: 'https://t.me/robinhood',
    monitor_priority: 'dormant',
    last_seen_at: new Date('2026-07-15T17:20:00.000Z'),
    last_evaluated_at: null,
    ranking_volume_5m_usd: '0',
    ranking_volume_1h_usd: '500',
    ranking_volume_6h_usd: '2000',
    ranking_volume_24h_usd: '9000',
    ranking_coverage_5m: 'complete',
    ranking_coverage_1h: 'complete',
    ranking_coverage_6h: 'complete',
    ranking_coverage_24h: 'complete',
    total_count: '2',
    ...overrides,
  };
}

function metrics(address, overrides = {}) {
  return {
    chain: 'robinhood', address, key: `robinhood:${address}`,
    windowEnd: AS_OF,
    lastActivityAt: '2026-07-15T17:20:00.000Z',
    volume5mUsd: 0, volume1hUsd: 500, volume6hUsd: 2_000, volume24hUsd: 9_000,
    liquidityUsd: 9_000,
    liquidityCoverage: 'partial',
    liquidityMarketCount: 3,
    valuedLiquidityMarketCount: 2,
    liquidityPools: [
      { protocol: 'uniswap-v3', marketKey: 'market',
        poolAddress: `0x${'3'.repeat(40)}`, poolId: null, liquidityUsd: 9_000 },
      { protocol: 'uniswap-v4', marketKey: 'market-v4',
        poolAddress: null, poolId: `0x${'4'.repeat(64)}`, liquidityUsd: 0 },
    ],
    coverage: {
      '5m': 'complete', '1h': 'complete', '6h': 'complete', '24h': 'complete',
    },
    ...overrides,
  };
}

describe('Robinhood workspace token reader', () => {
  it('keeps a stale persistent token in a bounded normalized FDV prefix', async () => {
    const calls = [];
    const database = {
      async queryWithStatementTimeout(sql, params, timeoutMs) {
        calls.push({ sql, params, timeoutMs });
        return { rows: [catalogRow(TOKEN), catalogRow(TOKEN_TWO, {
          last_fdv_usd: '40000',
          ranking_volume_1h_usd: '0',
        })] };
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
    const reader = createRobinhoodWorkspaceTokenReader({ database, windowRead });
    const prefix = await reader.listMonitoredPrefix({
      asOf: '2026-07-15T18:00:45.000Z', page: 1, perPage: 1,
      minFdv: 30_000, maxFdv: 100_000,
      excludedAddresses: [EXCLUDED.toUpperCase(), EXCLUDED],
      sorts: [{ mode: 'vol', window: '1h' }],
    });

    assert.equal(prefix.chain, 'robinhood');
    assert.equal(prefix.asOf, AS_OF);
    assert.equal(prefix.total, 2);
    assert.equal(prefix.rows.length, 2);
    assert.equal(prefix.rows[0].identity.key, `robinhood:${TOKEN}`);
    assert.deepEqual(prefix.rows[0].valuation, {
      type: 'fdv', usd: 50_000, observedAt: '2026-07-15T17:20:00.000Z',
      freshness: 'stale',
    });
    assert.equal(prefix.rows[0].activityState, 'stale');
    assert.match(calls[0].sql, /valuation\.last_fdv_usd < 30000000000/);
    assert.deepEqual({
      priceUsd: prefix.rows[0].priceUsd,
      liquidityUsd: prefix.rows[0].liquidityUsd,
      pairDexId: prefix.rows[0].pairDexId,
      launchpadId: prefix.rows[0].launchpadId,
      monitorPriority: prefix.rows[0].monitorPriority,
      lastSeenAt: prefix.rows[0].lastSeenAt,
    }, {
      priceUsd: 0.25,
      liquidityUsd: 9000,
      pairDexId: 'uniswap-v3',
      launchpadId: 'pons',
      monitorPriority: 'dormant',
      lastSeenAt: '2026-07-15T17:20:00.000Z',
    });
    assert.equal(prefix.rows[0].liquidityCoverage, 'partial');
    assert.equal(prefix.rows[0].liquidityMarketCount, 3);
    assert.equal(prefix.rows[0].valuedLiquidityMarketCount, 2);
    assert.equal(prefix.rows[0].liquidityPools[0].liquidityUsd, 9000);
    assert.equal(prefix.rows[1].volume1hUsd, 0);
    assert.deepEqual(calls[0].params, [
      new Date(AS_OF), 30_000, 100_000, [EXCLUDED], 500,
    ]);
    assert.equal(calls[0].timeoutMs, 15_000);
    assert.deepEqual(calls[1].windowInput, {
      addresses: [TOKEN, TOKEN_TWO], asOf: AS_OF, statementTimeoutMs: 15_000,
    });
  });

  it('prefilters persisted FDV before exact snapshot valuation and activity ranking', () => {
    const sql = __private.buildPrefixSql([
      { mode: 'vol', window: '5m' },
      { mode: 'mcap', window: 'lowest' },
      { mode: 'age', window: 'newest' },
    ]);

    assert.match(sql, /WITH catalog_candidates AS MATERIALIZED/);
    assert.match(sql, /FROM token_catalog tc/);
    assert.match(sql, /tc\.last_seen_at > \$1::timestamptz/);
    assert.match(sql, /tc\.last_fdv IS NULL/);
    assert.match(sql, /tc\.last_fdv >= \$2::numeric/);
    assert.match(sql, /FROM catalog_candidates tc/);
    assert.match(sql, /robinhood_market_buckets_1m/);
    assert.match(sql, /robinhood_market_buckets_1h/);
    assert.match(sql, /activity AS MATERIALIZED/);
    assert.match(sql, /INNER JOIN catalog_candidates candidate/);
    assert.match(sql, /LEFT JOIN activity ON activity\.token_address = tc\.address/);
    assert.match(sql, /activity\.volume_5m_usd AS ranking_volume_5m_usd/);
    assert.match(sql, /AS ranking_coverage_5m/);
    assert.match(sql, /tc\.last_price/);
    assert.match(sql, /tc\.last_pair_url/);
    assert.match(sql, /robinhood_ingestion_cursors/);
    assert.match(sql, /robinhood_head_capture_cursors/);
    assert.match(sql, /market_processing_frontier AS/);
    assert.match(sql, /LEFT JOIN market_cursor cursor ON TRUE/);
    assert.match(sql, /SUM\(bucket\.volume_usd\)/);
    assert.match(sql, /'uniswap-v2', 'uniswap-v3', 'uniswap-v4'/);
    assert.match(sql, /coverage_start_timestamp/);
    assert.match(sql, /last_fdv_usd ASC NULLS LAST/);
    assert.match(sql, /admin_blocked_tokens/);
    assert.match(sql, /tc\.address <> ALL\(\$4::varchar\[\]\)/);
    assert.match(sql, /LIMIT \$5::int/);
    assert.match(sql, /ORDER BY bucket\.bucket_ts DESC, bucket\.last_observed_at DESC/);
    assert.doesNotMatch(sql, /INTERVAL '15 minutes'/);
    assert.doesNotMatch(__private.buildActivityCteSql([
      { mode: 'vol', window: '5m' },
    ]), /LATERAL/);
    assert.doesNotMatch(sql, /eligible_for_monitoring/);
    assert.doesNotMatch(sql, /is_active_monitor_candidate/);
    assert.doesNotMatch(sql, /robinhood_pool_registry/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('bounds ranking activity to the largest requested volume window', () => {
    const fiveMinutes = __private.buildPrefixSql([{ mode: 'vol', window: '5m' }]);
    const sixHours = __private.buildPrefixSql([
      { mode: 'vol', window: '5m' },
      { mode: 'vol', window: '6h' },
    ]);
    const valuationOnly = __private.buildPrefixSql([{ mode: 'mcap', window: 'highest' }]);

    assert.match(fiveMinutes, /bucket_ts >= \$1::timestamptz - INTERVAL '5 minutes'/);
    assert.doesNotMatch(fiveMinutes, /bucket_ts >= \$1::timestamptz - INTERVAL '24 hours'/);
    assert.match(fiveMinutes, /SUM\(bucket\.volume_usd\) FILTER/);
    assert.match(sixHours, /bucket_ts >= \$1::timestamptz - INTERVAL '6 hours'/);
    assert.match(sixHours, /AS volume_5m_usd/);
    assert.match(sixHours, /AS volume_6h_usd/);
    assert.doesNotMatch(sixHours, /AS volume_1h_usd/);
    assert.doesNotMatch(valuationOnly, /robinhood_market_buckets_1m/);
    assert.doesNotMatch(valuationOnly, /\bactivity\./);
    assert.doesNotMatch(valuationOnly, /robinhood_ingestion_cursors/);
  });

  it('uses persisted FDV only for an explicitly prioritized first page', () => {
    const exact = __private.buildPrefixSql([{ mode: 'vol', window: '5m' }]);
    const priority = __private.buildPrefixSql(
      [{ mode: 'vol', window: '5m' }],
      { preferCatalogValuation: true },
    );

    assert.match(exact, /FROM robinhood_market_buckets_1h bucket/);
    assert.match(priority, /SELECT tc\.last_fdv AS last_fdv_usd/);
    assert.match(priority, /tc\.last_seen_at AS valuation_observed_at/);
    assert.doesNotMatch(priority, /FROM robinhood_market_buckets_1h bucket/);
  });

  it('hydrates pinned identities exactly without applying the FDV floor', async () => {
    const calls = [];
    const database = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: [catalogRow(TOKEN, { last_fdv_usd: '10', total_count: undefined })] };
      },
    };
    const windowRead = {
      async getMetricsByAddresses(input) {
        calls.push({ windowInput: input });
        return [metrics(TOKEN)];
      },
    };
    const reader = createRobinhoodWorkspaceTokenReader({ database, windowRead });
    const rows = await reader.getTokensByAddresses({ addresses: [TOKEN], asOf: AS_OF });

    assert.equal(rows[0].valuation.usd, 10);
    assert.deepEqual(calls[0].params, [new Date(AS_OF), [TOKEN]]);
    assert.match(calls[0].sql, /tc\.address = ANY\(\$2::varchar\[\]\)/);
    assert.match(calls[0].sql, /admin_blocked_tokens/);
    assert.doesNotMatch(calls[0].sql, /last_fdv_usd >=/);
    assert.equal(calls[1].windowInput.asOf, AS_OF);
  });

  it('reuses one ranked snapshot and hydrates only newly requested prefix rows', async () => {
    const addresses = Array.from({ length: 101 }, (_, index) => (
      `0x${(index + 1).toString(16).padStart(40, '0')}`
    )).sort();
    let queryCount = 0;
    const database = {
      async query(_sql, params) {
        queryCount += 1;
        return { rows: addresses.slice(0, params[4]).map((address) => catalogRow(address, {
          total_count: '101',
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
    const reader = createRobinhoodWorkspaceTokenReader({ database, windowRead });
    const firstPage = await reader.listMonitoredPrefix({
      asOf: AS_OF, page: 0, perPage: 100, minFdv: 0,
    });
    const secondPagePrefix = await reader.listMonitoredPrefix({
      asOf: AS_OF, page: 1, perPage: 100, minFdv: 0,
    });

    assert.equal(firstPage.rows.length, 100);
    assert.equal(secondPagePrefix.rows.length, 101);
    assert.equal(queryCount, 1);
    assert.deepEqual(batches.map((batch) => batch.length), [100, 1]);
    const incompleteReader = createRobinhoodWorkspaceTokenReader({
      database,
      windowRead: { async getMetricsByAddresses() { return []; } },
    });
    await assert.rejects(
      incompleteReader.listMonitoredPrefix({ asOf: AS_OF, perPage: 1, minFdv: 0 }),
      /metric hydration returned 0 rows; 1 required/,
    );
  });

  it('rejects invalid FDV filters and timeouts before querying', async () => {
    const reader = createRobinhoodWorkspaceTokenReader({
      database: { async query() { throw new Error('must not query'); } },
      windowRead: { async getMetricsByAddresses() { return []; } },
    });

    await assert.rejects(reader.listMonitoredPrefix({ minFdv: -1 }), /minFdv/);
    await assert.rejects(
      reader.listMonitoredPrefix({ excludedAddresses: ['invalid'] }), /Invalid robinhood/,
    );
    await assert.rejects(
      reader.listMonitoredPrefix({ minFdv: 50, maxFdv: 40 }), /maxFdv/,
    );
    await assert.rejects(
      reader.listMonitoredPrefix({ statementTimeoutMs: 999 }), /between 1000 and 60000/,
    );
  });
});
