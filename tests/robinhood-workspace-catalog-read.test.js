const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWorkspaceCatalogReadRepository,
  __private,
} = require('../src/models/robinhood-workspace-catalog-read');

const TOKEN = '0x1111111111111111111111111111111111111111';
const TOKEN_TWO = '0x2222222222222222222222222222222222222222';
const AS_OF = '2026-07-15T18:00:00.000Z';

function catalogRow(overrides = {}) {
  return {
    address: TOKEN,
    symbol: 'OLD',
    name: 'Older activity',
    source: 'robinhood-onchain',
    first_seen_at: new Date('2026-07-14T12:00:00.000Z'),
    last_image_url: null,
    last_twitter_url: null,
    last_community_url: null,
    admin_blocked: false,
    last_activity_at: new Date('2026-07-15T17:20:00.000Z'),
    last_fdv_usd: '52000',
    valuation_observed_at: new Date('2026-07-15T17:20:00.000Z'),
    ...overrides,
  };
}

describe('Robinhood persistent workspace catalog reader', () => {
  it('keeps a token last active 40 minutes ago queryable and marks its data stale', async () => {
    const calls = [];
    const database = {
      async queryWithStatementTimeout(sql, params, timeoutMs) {
        calls.push({ sql, params, timeoutMs });
        return { rows: [catalogRow()] };
      },
    };
    const repository = createRobinhoodWorkspaceCatalogReadRepository({ database });
    const page = await repository.listCatalogPage({
      asOf: AS_OF,
      limit: 25,
      filters: { minValuationUsd: 30_000 },
    });

    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].identity.key, `robinhood:${TOKEN}`);
    assert.equal(page.rows[0].lastActivityAt, '2026-07-15T17:20:00.000Z');
    assert.equal(page.rows[0].activityState, 'stale');
    assert.equal(page.rows[0].valuation.type, 'fdv');
    assert.equal(page.rows[0].valuation.usd, 52_000);
    assert.equal(page.rows[0].valuation.freshness, 'stale');
    assert.equal(page.rows[0].visible, true);
    assert.deepEqual(page.rows[0].exclusionReasons, []);
    assert.deepEqual(page.rows[0].windowMetrics, {
      coverage: 'unavailable',
      reason: 'window_metric_adapter_required',
    });

    assert.deepEqual(calls[0].params, [new Date(AS_OF), null, 26]);
    assert.equal(calls[0].timeoutMs, 15_000);
    assert.match(calls[0].sql, /FROM token_catalog catalog/);
    assert.match(calls[0].sql, /FROM robinhood_market_buckets_1h bucket/);
    assert.match(calls[0].sql, /bucket\.last_observed_at AS last_activity_at/);
    assert.match(calls[0].sql, /ORDER BY bucket\.bucket_ts DESC/);
    assert.match(calls[0].sql, /'uniswap-v2', 'uniswap-v3', 'uniswap-v4'/);
    assert.doesNotMatch(calls[0].sql, /INTERVAL '15 minutes'/);
    assert.doesNotMatch(calls[0].sql, /catalog\.last_seen_at/);
    assert.doesNotMatch(calls[0].sql, /eligible_for_monitoring/);
    assert.doesNotMatch(calls[0].sql, /\b(?:INSERT|UPDATE|DELETE)\b/);
  });

  it('does not invent activity or valuation for a manual catalog identity', async () => {
    const database = {
      async query() {
        return { rows: [catalogRow({
          source: 'user-manual',
          last_activity_at: null,
          last_fdv_usd: null,
          valuation_observed_at: null,
        })] };
      },
    };
    const repository = createRobinhoodWorkspaceCatalogReadRepository({ database });
    const page = await repository.listCatalogPage({ asOf: AS_OF });
    const row = page.rows[0];

    assert.equal(row.source, 'user-manual');
    assert.equal(row.lastActivityAt, null);
    assert.equal(row.activityState, 'unknown');
    assert.deepEqual(row.valuation, {
      type: 'fdv', usd: null, observedAt: null, freshness: 'unknown',
    });
    assert.equal(row.visible, true);
    assert.deepEqual(row.dataQuality, []);
  });

  it('returns authoritative administrative blocks without using lifecycle as membership', async () => {
    const database = {
      async query() {
        return { rows: [catalogRow({ admin_blocked: true })] };
      },
    };
    const repository = createRobinhoodWorkspaceCatalogReadRepository({ database });
    const page = await repository.listCatalogPage({ asOf: AS_OF });

    assert.equal(page.rows.length, 1);
    assert.equal(page.rows[0].visible, false);
    assert.deepEqual(page.rows[0].exclusionReasons, ['admin_blocked']);
    assert.equal(page.rows[0].riskState, 'blocked');
  });

  it('uses an address keyset and preserves asOf between pages', async () => {
    const calls = [];
    const responses = [
      [catalogRow(), catalogRow({ address: TOKEN_TWO })],
      [],
    ];
    const database = {
      async query(sql, params) {
        calls.push({ sql, params });
        return { rows: responses.shift() };
      },
    };
    const repository = createRobinhoodWorkspaceCatalogReadRepository({ database });
    const first = await repository.listCatalogPage({ asOf: AS_OF, limit: 1 });

    assert.equal(first.hasMore, true);
    assert.ok(first.nextCursor);
    assert.deepEqual(__private.parseCursor(first.nextCursor), {
      asOf: new Date(AS_OF),
      address: TOKEN,
    });

    const second = await repository.listCatalogPage({ cursor: first.nextCursor, limit: 1 });
    assert.equal(second.asOf, AS_OF);
    assert.deepEqual(calls[1].params, [new Date(AS_OF), TOKEN, 2]);
  });

  it('rejects malformed limits, cursors, snapshots and timeouts before querying', () => {
    const cursor = __private.encodeCursor(TOKEN, new Date(AS_OF));

    assert.throws(() => __private.normalizeQuery({ limit: 0 }), /positive safe integer/);
    assert.throws(() => __private.normalizeQuery({ limit: 101 }), /no greater than 100/);
    assert.throws(() => __private.normalizeQuery({ cursor: 'invalid' }), /Invalid/);
    assert.throws(
      () => __private.normalizeQuery({ cursor, asOf: '2026-07-15T18:01:00.000Z' }),
      /does not match/,
    );
    assert.throws(
      () => __private.normalizeQuery({ statementTimeoutMs: 999 }),
      /between 1000 and 60000/,
    );
  });
});
