const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  compareRadarRows,
  isRadarAgeInQuery,
  normalizeRadarQuery,
  resolveRadarTokenAge,
} = require('../src/services/dashboard-radar-query');

const AS_OF = '2026-07-15T12:34:56.000Z';

function row(chain, address, overrides = {}) {
  return {
    identity: { chain, address },
    tokenAge: { state: 'known', timestampMs: Date.parse('2026-07-14T00:00:00.000Z') },
    valuation: { type: chain === 'robinhood' ? 'fdv' : 'mcap', usd: 50_000 },
    volume1hUsd: 0,
    volume6hUsd: 0,
    volume24hUsd: 0,
    priceChange1hPct: null,
    priceChange6hPct: null,
    priceChange24hPct: null,
    coverage: { '1h': 'complete', '6h': 'complete', '24h': 'complete' },
    priceChangeCoverage: { '1h': 'unavailable', '6h': 'unavailable', '24h': 'unavailable' },
    ...overrides,
  };
}

describe('dashboard radar query contract', () => {
  it('normalizes independent chain valuation filters and a stable bounded prefix', () => {
    const query = normalizeRadarQuery({
      asOf: AS_OF,
      bucket: 'oldWeek',
      chains: ['solana', 'robinhood', 'solana'],
      page: 1,
      perPage: 40,
      minMcap: 12_000,
      maxMcap: 90_000,
      minFdv: 30_000,
      maxFdv: 120_000,
      ageMinMinutes: 10_080,
      ageMaxMinutes: 50_000,
      searchQuery: '  BONK  ',
      dismissedIdentities: [
        'solana:So11111111111111111111111111111111111111112',
        'robinhood:0x1111111111111111111111111111111111111111',
      ],
      starredIdentities: ['robinhood:0x2222222222222222222222222222222222222222'],
      starredOnly: true,
      sorts: [{ mode: 'pchange', window: '24h' }, { mode: 'age', window: 'oldest' }],
    });

    assert.equal(query.asOf, '2026-07-15T12:34:00.000Z');
    assert.deepEqual(query.chains, ['solana', 'robinhood']);
    assert.equal(query.requiredPrefix, 80);
    assert.deepEqual([query.minMcap, query.maxMcap], [12_000, 90_000]);
    assert.deepEqual([query.minFdv, query.maxFdv], [30_000, 120_000]);
    assert.equal(query.searchQuery, 'bonk');
    assert.equal(query.dismissedIdentities.length, 2);
    assert.equal(query.starredIdentities[0].chain, 'robinhood');
    assert.equal(query.empty, false);
  });

  it('keeps legacy defaults Solana-only and makes an empty starred query explicit', () => {
    const query = normalizeRadarQuery({ starredOnly: true });

    assert.deepEqual(query.chains, ['solana']);
    assert.equal(query.bucket, 'recent');
    assert.equal(query.ageMinMinutes, 0);
    assert.equal(query.ageMaxMinutes, 10_080);
    assert.equal(query.minMcap, 30_000);
    assert.equal(query.minFdv, 30_000);
    assert.equal(query.empty, true);
  });

  it('rejects unbounded pages, invalid age partitions and duplicate sorts', () => {
    assert.throws(() => normalizeRadarQuery({ page: 5, perPage: 100 }), /prefix/);
    assert.throws(() => normalizeRadarQuery({
      bucket: 'recent', ageMaxMinutes: 10_081,
    }), /seven days/);
    assert.throws(() => normalizeRadarQuery({
      bucket: 'oldWeek', ageMinMinutes: 1,
    }), /below seven days/);
    assert.throws(() => normalizeRadarQuery({ sorts: [
      { mode: 'vol', window: '1h' }, { mode: 'vol', window: '1h' },
    ] }), /duplicates/);
  });

  it('uses chain-native age, falls back to first seen and preserves unknown', () => {
    const native = resolveRadarTokenAge({
      tokenCreatedAt: String(Date.parse('2026-07-10T00:00:00.000Z')),
      firstSeenAt: '2026-07-11T00:00:00.000Z',
    });
    const fallback = resolveRadarTokenAge({ firstSeenAt: '2026-07-11T00:00:00.000Z' });
    const unknown = resolveRadarTokenAge({});

    assert.deepEqual(native, {
      state: 'known',
      timestampMs: Date.parse('2026-07-10T00:00:00.000Z'),
      provenance: 'chain-native',
    });
    assert.equal(fallback.provenance, 'first-seen');
    assert.deepEqual(unknown, { state: 'unknown', timestampMs: null, provenance: 'unknown' });
    assert.equal(normalizeRadarQuery({ bucket: 'oldWeek', ageMaxMinutes: 0 }).ageMaxMinutes, null);
  });

  it('never assigns unknown or future age to Recent or Old Week', () => {
    const query = normalizeRadarQuery({ asOf: AS_OF, bucket: 'recent' });
    const known = resolveRadarTokenAge({ firstSeenAt: '2026-07-14T12:00:00.000Z' });
    const future = resolveRadarTokenAge({ firstSeenAt: '2026-07-16T12:00:00.000Z' });

    assert.equal(isRadarAgeInQuery(known, query), true);
    assert.equal(isRadarAgeInQuery(resolveRadarTokenAge({}), query), false);
    assert.equal(isRadarAgeInQuery(future, query), false);
  });

  it('sorts numeric volume before coverage and keeps unavailable values last', () => {
    const completeZero = row('solana', 'So11111111111111111111111111111111111111112');
    const partialPositive = row('robinhood', '0x1111111111111111111111111111111111111111', {
      volume1hUsd: 100,
      coverage: { '1h': 'partial', '6h': 'complete', '24h': 'complete' },
    });
    const unavailable = row('robinhood', '0x2222222222222222222222222222222222222222', {
      volume1hUsd: null,
      coverage: { '1h': 'unavailable', '6h': 'complete', '24h': 'complete' },
    });
    const sorted = [unavailable, partialPositive, completeZero].sort((left, right) => (
      compareRadarRows(left, right, [{ mode: 'vol', window: '1h' }])
    ));

    assert.deepEqual(sorted, [partialPositive, completeZero, unavailable]);
  });

  it('sorts valuation and age without treating missing values as zero', () => {
    const newer = row('solana', 'So11111111111111111111111111111111111111112', {
      valuation: { type: 'mcap', usd: null },
      tokenAge: { state: 'known', timestampMs: Date.parse('2026-07-15T00:00:00.000Z') },
    });
    const older = row('robinhood', '0x1111111111111111111111111111111111111111', {
      valuation: { type: 'fdv', usd: 40_000 },
      tokenAge: { state: 'known', timestampMs: Date.parse('2026-07-01T00:00:00.000Z') },
    });

    assert.equal(compareRadarRows(newer, older, [{ mode: 'mcap', window: 'highest' }]) > 0, true);
    assert.equal(compareRadarRows(newer, older, [{ mode: 'age', window: 'newest' }]) < 0, true);
  });
});
