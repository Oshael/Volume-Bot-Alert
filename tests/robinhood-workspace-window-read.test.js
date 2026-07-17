const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWorkspaceWindowReadRepository,
  __private,
} = require('../src/models/robinhood-workspace-window-read');

const TOKEN = '0x1111111111111111111111111111111111111111';
const WINDOW_END = '2026-07-15T18:00:00.000Z';

function metricRow(overrides = {}) {
  return {
    token_address: TOKEN,
    coverage_start_at: new Date('2026-07-13T18:00:00.000Z'),
    coverage_end_at: new Date(WINDOW_END),
    caught_up: true,
    volume_5m_usd: null,
    volume_1h_usd: '125000',
    volume_6h_usd: '410000',
    volume_24h_usd: '980000',
    swaps_5m: null,
    swaps_1h: '18',
    swaps_6h: '70',
    swaps_24h: '140',
    last_activity_at: new Date('2026-07-15T17:20:00.000Z'),
    primary_protocol: 'uniswap-v3',
    primary_market_key: `robinhood:uniswap-v3:0x${'2'.repeat(40)}`,
    current_price_usd: '2',
    current_observed_at: new Date('2026-07-15T17:59:00.000Z'),
    price_1h_usd: '1.6',
    price_1h_observed_at: new Date('2026-07-15T16:58:00.000Z'),
    price_6h_usd: '1',
    price_6h_observed_at: new Date('2026-07-15T11:59:00.000Z'),
    price_24h_usd: null,
    price_24h_observed_at: null,
    ...overrides,
  };
}

describe('Robinhood workspace window metric reader', () => {
  it('returns zero 5m and positive 1h after the latest swap becomes stale', async () => {
    const calls = [];
    const database = {
      async queryWithStatementTimeout(sql, params, timeoutMs) {
        calls.push({ sql, params, timeoutMs });
        return { rows: [metricRow()] };
      },
    };
    const repository = createRobinhoodWorkspaceWindowReadRepository({ database });
    const rows = await repository.getMetricsByAddresses({
      addresses: [TOKEN], asOf: '2026-07-15T18:00:59.000Z',
    });
    const row = rows[0];

    assert.equal(row.key, `robinhood:${TOKEN}`);
    assert.equal(row.windowEnd, WINDOW_END);
    assert.equal(row.lastActivityAt, '2026-07-15T17:20:00.000Z');
    assert.equal(row.volume5mUsd, 0);
    assert.equal(row.volume1hUsd, 125000);
    assert.equal(row.swaps5m, 0);
    assert.equal(row.swaps1h, 18);
    assert.deepEqual(row.coverage, {
      '5m': 'complete', '1h': 'complete', '6h': 'complete', '24h': 'complete',
    });
    assert.equal(row.priceChange1hPct, 25);
    assert.equal(row.priceChange6hPct, 100);
    assert.equal(row.priceChange24hPct, null);
    assert.equal(row.priceChangeCoverage['24h'], 'unavailable');
    assert.deepEqual(row.primaryMarket, {
      protocol: 'uniswap-v3', marketKey: metricRow().primary_market_key,
    });
    assert.deepEqual(row.coverageProvenance, {
      source: 'robinhood-market-cursor',
      startAt: '2026-07-13T18:00:00.000Z',
      endAt: WINDOW_END,
      caughtUp: true,
    });

    assert.deepEqual(calls[0].params, [[TOKEN], new Date(WINDOW_END)]);
    assert.equal(calls[0].timeoutMs, 15_000);
  });

  it('keeps cursor gaps and recent bootstrap windows partial', async () => {
    const database = {
      async query() {
        return { rows: [metricRow({
          coverage_start_at: new Date('2026-07-15T17:30:00.000Z'),
          coverage_end_at: new Date('2026-07-15T17:58:00.000Z'),
          caught_up: false,
        })] };
      },
    };
    const repository = createRobinhoodWorkspaceWindowReadRepository({ database });
    const [row] = await repository.getMetricsByAddresses({
      addresses: [TOKEN], asOf: WINDOW_END,
    });

    assert.deepEqual(row.coverage, {
      '5m': 'partial', '1h': 'partial', '6h': 'partial', '24h': 'partial',
    });
    assert.equal(row.volume5mUsd, null);
    assert.equal(row.volume1hUsd, 125000);
    assert.equal(row.coverageProvenance.caughtUp, false);
  });

  it('does not expose numeric activity without persistent cursor evidence', async () => {
    const database = {
      async query() {
        return { rows: [metricRow({
          coverage_start_at: null,
          coverage_end_at: null,
          caught_up: null,
        })] };
      },
    };
    const repository = createRobinhoodWorkspaceWindowReadRepository({ database });
    const [row] = await repository.getMetricsByAddresses({
      addresses: [TOKEN], asOf: WINDOW_END,
    });

    assert.deepEqual(row.coverage, {
      '5m': 'unavailable', '1h': 'unavailable',
      '6h': 'unavailable', '24h': 'unavailable',
    });
    assert.equal(row.volume1hUsd, null);
    assert.equal(row.swaps1h, null);
  });

  it('aggregates supported protocols by token and keeps price on one primary market', () => {
    const sql = __private.WINDOW_METRICS_SQL;
    assert.match(sql, /SUM\(bucket\.volume_usd\)/);
    assert.match(sql, /SUM\(bucket\.swaps\)/);
    assert.match(sql, /'uniswap-v2', 'uniswap-v3', 'uniswap-v4'/);
    assert.match(sql, /DISTINCT ON \(token_address\)/);
    assert.match(sql, /volume_24h_usd DESC, market_last_observed_at DESC/);
    assert.match(sql, /bucket\.protocol = primary_market\.protocol/);
    assert.match(sql, /robinhood_ingestion_cursors/);
    assert.match(sql, /coverage_start_timestamp AS coverage_start_at/);
    assert.doesNotMatch(sql, /created_at AS coverage_start_at/);
    assert.equal((sql.match(/INNER JOIN robinhood_market_buckets_1m bucket/g) || []).length, 1);
    assert.match(sql, /FROM market_activity\s+GROUP BY token_address/);
    assert.match(sql, /MAX\(market_last_observed_at\) AS last_activity_at/);
    assert.match(sql, /COALESCE\(token_activity\.last_activity_at, latest_hour\.last_activity_at\)/);
    assert.doesNotMatch(sql, /\) latest_minute ON TRUE/);
    assert.match(sql, /\) latest_hour ON TRUE/);
    assert.match(sql, /robinhood_market_buckets_1h/);
    assert.doesNotMatch(sql, /robinhood_pool_registry/);
    assert.doesNotMatch(sql, /eligible_for_monitoring/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('bounds identity input and avoids a query for an empty page', async () => {
    let calls = 0;
    const database = { async query() { calls += 1; return { rows: [] }; } };
    const repository = createRobinhoodWorkspaceWindowReadRepository({ database });

    assert.deepEqual(await repository.getMetricsByAddresses({ addresses: [] }), []);
    assert.equal(calls, 0);
    await assert.rejects(
      repository.getMetricsByAddresses({ addresses: ['invalid'] }), /Invalid robinhood/,
    );
    await assert.rejects(repository.getMetricsByAddresses({
      addresses: Array.from({ length: 101 }, (_, index) => (
        `0x${index.toString(16).padStart(40, '0')}`
      )),
    }), /at most 100/);
    await assert.rejects(repository.getMetricsByAddresses({
      addresses: [TOKEN], statementTimeoutMs: 999,
    }), /between 1000 and 60000/);
  });
});
