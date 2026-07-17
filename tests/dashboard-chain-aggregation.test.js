const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildExactMonitoredPage,
  buildMonitoredSlice,
  compareNormalizedMonitoredRows,
  normalizeMonitoredQuery,
  rankTopPerformerRows,
} = require('../src/services/dashboard-chain-aggregation');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function row(chain, address, overrides = {}) {
  return {
    chain,
    address,
    last_mcap: chain === 'solana' ? '40000' : null,
    last_fdv: chain === 'robinhood' ? '40000' : null,
    last_vol_5m: '100',
    last_vol_24h: '250000',
    last_price_change_24h: '10',
    last_token_created_at_ms: '1000',
    last_seen_at: '2026-07-14T18:00:00.000Z',
    ...overrides,
  };
}

function normalizedRow(chain, address, overrides = {}) {
  return {
    identity: { chain, address },
    valuation: { type: chain === 'robinhood' ? 'fdv' : 'mcap', usd: 40_000 },
    tokenCreatedAt: 1_000,
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

describe('dashboard chain aggregation', () => {
  it('preserves chain identities and paginates them globally', () => {
    const robinhoodAddress = `0x${'1'.repeat(40)}`;
    const slice = buildMonitoredSlice([
      [row('solana', SOL, { last_vol_5m: '50' })],
      [row('robinhood', robinhoodAddress, { last_vol_5m: '500' })],
    ], { page: 0, perPage: 1, sorts: [{ mode: 'vol', window: '5m' }] });

    assert.equal(slice.total, 2);
    assert.equal(slice.rows[0].chain, 'robinhood');
    assert.equal(slice.rows[0].address, robinhoodAddress);
  });

  it('ranks the combined candidate pool instead of merging per-chain ranks', () => {
    const ranked = rankTopPerformerRows([[
      row('solana', SOL, { last_vol_24h: '900000', last_price_change_24h: '4' }),
      row('solana', USDC, { last_vol_24h: '210000', last_price_change_24h: '90' }),
    ], [
      row('robinhood', `0x${'2'.repeat(40)}`, {
        last_vol_24h: '600000', last_price_change_24h: '40',
      }),
    ]], { limit: 3 });

    assert.equal(ranked.length, 3);
    assert.deepEqual(new Set(ranked.map((item) => item.chain)), new Set(['solana', 'robinhood']));
    assert.ok(ranked.every((item) => item.performance_score > 0));
    assert.equal(ranked[0].address, SOL);
    const robinhood = ranked.find((item) => item.chain === 'robinhood');
    assert.equal(robinhood.volume_rank_score, 2 / 3);
    assert.equal(robinhood.pchange_rank_score, 2 / 3);
  });
});

describe('exact monitored prefix aggregation', () => {
  it('sorts complete positive, complete zero, partial, then unavailable volume', () => {
    const rows = [
      normalizedRow('solana', SOL, { volume5mUsd: 0 }),
      normalizedRow('solana', USDC, { volume5mUsd: 10 }),
      normalizedRow('robinhood', `0x${'1'.repeat(40)}`, {
        volume5mUsd: 1_000,
        coverage: { '5m': 'partial' },
      }),
      normalizedRow('robinhood', `0x${'2'.repeat(40)}`, {
        volume5mUsd: null,
        coverage: { '5m': 'unavailable' },
      }),
    ];

    rows.sort((left, right) => compareNormalizedMonitoredRows(left, right, [
      { mode: 'vol', window: '5m' },
    ]));

    assert.deepEqual(rows.map((item) => item.identity.address), [
      USDC, SOL, `0x${'1'.repeat(40)}`, `0x${'2'.repeat(40)}`,
    ]);
  });

  it('keeps missing valuation last for both directions and applies ordered tie breakers', () => {
    const lowOlder = normalizedRow('solana', SOL, {
      valuation: { type: 'mcap', usd: 10_000 }, tokenCreatedAt: 500,
    });
    const lowNewer = normalizedRow('robinhood', `0x${'3'.repeat(40)}`, {
      valuation: { type: 'fdv', usd: 10_000 }, tokenCreatedAt: 1_500,
    });
    const high = normalizedRow('solana', USDC, {
      valuation: { type: 'mcap', usd: 20_000 }, tokenCreatedAt: 2_000,
    });
    const missing = normalizedRow('robinhood', `0x${'4'.repeat(40)}`, {
      valuation: { type: 'fdv', usd: null }, tokenCreatedAt: 3_000,
    });

    const lowest = [missing, high, lowNewer, lowOlder].sort((left, right) => (
      compareNormalizedMonitoredRows(left, right, [{ mode: 'mcap', window: 'lowest' }])
    ));
    assert.deepEqual(lowest.map((item) => item.identity.address), [
      lowNewer.identity.address, lowOlder.identity.address, high.identity.address,
      missing.identity.address,
    ]);

    const highest = [missing, lowOlder, high].sort((left, right) => (
      compareNormalizedMonitoredRows(left, right, [{ mode: 'mcap', window: 'highest' }])
    ));
    assert.equal(highest[0], high);
    assert.equal(highest.at(-1), missing);
  });

  it('builds an exact combined page from bounded sorted per-chain prefixes', () => {
    const asOf = '2026-07-15T18:00:00.000Z';
    const query = normalizeMonitoredQuery({
      asOf: '2026-07-15T18:00:45.000Z',
      page: 1,
      perPage: 2,
      sorts: [{ mode: 'vol', window: '5m' }],
    });
    const solana = [100, 80, 60, 40].map((volume, index) => (
      normalizedRow('solana', index === 0 ? SOL : `${'1'.repeat(31)}${index + 1}`, {
        volume5mUsd: volume,
      })
    ));
    const robinhood = [90, 70, 50].map((volume, index) => (
      normalizedRow('robinhood', `0x${String(index + 5).repeat(40)}`, {
        volume5mUsd: volume,
      })
    ));

    const page = buildExactMonitoredPage([
      { chain: 'solana', asOf, total: 5, rows: solana },
      { chain: 'robinhood', asOf, total: 3, rows: robinhood },
    ], query);

    assert.equal(page.asOf, asOf);
    assert.equal(page.total, 8);
    assert.equal(page.page, 1);
    assert.equal(page.perPage, 2);
    assert.equal(page.hasMore, true);
    assert.equal(page.requiredPrefix, 4);
    assert.deepEqual(page.rows.map((item) => item.volume5mUsd), [80, 70]);
  });

  it('deduplicates canonical identities without merging equal addresses across chains', () => {
    const evm = `0x${'7'.repeat(40)}`;
    const solanaRow = normalizedRow('solana', SOL);
    const robinhoodRow = normalizedRow('robinhood', evm);
    const page = buildExactMonitoredPage([
      { chain: 'solana', asOf: '2026-07-15T18:00:00.000Z', total: 1,
        rows: [solanaRow, solanaRow] },
      { chain: 'robinhood', asOf: '2026-07-15T18:00:00.000Z', total: 1,
        rows: [robinhoodRow] },
    ], normalizeMonitoredQuery({ asOf: '2026-07-15T18:00:00.000Z', perPage: 2 }));

    assert.equal(page.total, 2);
    assert.deepEqual(new Set(page.rows.map((item) => item.identity.chain)),
      new Set(['solana', 'robinhood']));
  });

  it('fails closed for invalid, stale, unbounded, insufficient, or unsorted prefixes', () => {
    assert.throws(
      () => normalizeMonitoredQuery({ page: 5, perPage: 100 }),
      /prefix cannot exceed 500/,
    );
    assert.throws(
      () => normalizeMonitoredQuery({ sorts: [{ mode: 'vol', window: '2h' }] }),
      /invalid monitored sort criterion/,
    );

    const query = normalizeMonitoredQuery({
      asOf: '2026-07-15T18:00:00.000Z', perPage: 2,
    });
    const high = normalizedRow('solana', SOL, { volume5mUsd: 100 });
    const low = normalizedRow('solana', USDC, { volume5mUsd: 10 });
    const prefix = (overrides) => ({
      chain: 'solana', asOf: query.asOf, total: 2, rows: [high, low], ...overrides,
    });

    assert.throws(
      () => buildExactMonitoredPage([prefix({ asOf: '2026-07-15T17:59:00.000Z' })], query),
      /snapshot does not match/,
    );
    assert.throws(
      () => buildExactMonitoredPage([prefix({ rows: [high] })], query),
      /returned 1 rows; 2 required/,
    );
    assert.throws(
      () => buildExactMonitoredPage([prefix({ rows: [low, high] })], query),
      /prefix is not sorted/,
    );
    assert.throws(
      () => buildExactMonitoredPage([prefix({ rows: [high, low, low] })], query),
      /exceeds required prefix 2/,
    );
    assert.throws(
      () => buildExactMonitoredPage([prefix({ total: 1 })], query),
      /more identities than its total/,
    );
  });
});
