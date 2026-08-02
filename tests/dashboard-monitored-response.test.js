const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  buildDashboardMonitoredPayload,
  buildDashboardMonitoredToken,
} = require('../src/services/dashboard-monitored-response');

const SOLANA_ADDRESS = 'So11111111111111111111111111111111111111112';
const ROBINHOOD_ADDRESS = `0x${'1'.repeat(40)}`;

function normalizedRow(chain, overrides = {}) {
  const address = chain === 'solana' ? SOLANA_ADDRESS : ROBINHOOD_ADDRESS;
  return {
    identity: { chain, address, key: `${chain}:${address}` },
    symbol: 'TOKEN',
    name: 'Token',
    source: 'catalog',
    firstSeenAt: '2026-07-14T12:00:00.000Z',
    lastSeenAt: '2026-07-15T17:55:00.000Z',
    lastEvaluatedAt: null,
    tokenCreatedAt: 1_000,
    tokenAgeProvenance: 'chain-native',
    priceUsd: 2.5,
    liquidityUsd: chain === 'solana' ? 9_000 : null,
    liquidityCoverage: chain === 'robinhood' ? 'unavailable' : null,
    liquidityMarketCount: chain === 'robinhood' ? 0 : null,
    valuedLiquidityMarketCount: chain === 'robinhood' ? 0 : null,
    pairAddress: 'pair',
    pairUrl: 'https://dex.example/pair',
    pairDexId: 'dex',
    imageUrl: 'https://cdn.example/token.png',
    launchpadId: chain === 'robinhood' ? 'pons' : null,
    twitterUrl: 'https://x.com/token',
    communityUrl: null,
    monitorPriority: 'normal',
    valuation: {
      type: chain === 'solana' ? 'mcap' : 'fdv',
      usd: 50_000,
      observedAt: '2026-07-15T17:55:00.000Z',
      freshness: 'fresh',
    },
    windowEnd: '2026-07-15T18:00:00.000Z',
    lastActivityAt: '2026-07-15T17:55:00.000Z',
    volume5mUsd: 0,
    prevVolume5mCanonical: 80,
    volume5mBaselineAt: '2026-07-15T17:55:00.000Z',
    volume5mWindowEnd: '2026-07-15T18:00:00.000Z',
    volume5mDeltaCoverage: 'complete',
    volume1hUsd: null,
    volume6hUsd: 2_000,
    volume24hUsd: 9_000,
    swaps5m: 0,
    swaps1h: null,
    swaps6h: 4,
    swaps24h: 12,
    coverage: { '5m': 'complete', '1h': 'unavailable', '6h': 'partial', '24h': 'complete' },
    swapCoverage: { '5m': 'complete', '1h': 'unavailable', '6h': 'partial', '24h': 'complete' },
    priceChangeCoverage: { '1h': 'unavailable', '6h': 'partial', '24h': 'complete' },
    priceChange1hPct: null,
    priceChange6hPct: null,
    priceChange24hPct: 5,
    activityState: 'fresh',
    riskState: 'unknown',
    dataQuality: [],
    ...overrides,
  };
}

describe('dashboard monitored response', () => {
  it('keeps chain-native valuation fields and honest coverage values', () => {
    const solana = buildDashboardMonitoredToken(normalizedRow('solana'));
    const robinhood = buildDashboardMonitoredToken(normalizedRow('robinhood'));

    assert.deepEqual(
      { mcap: solana.mcap, fdv: solana.fdv, type: solana.valuationType },
      { mcap: 50_000, fdv: null, type: 'market-cap' },
    );
    assert.deepEqual(
      { mcap: robinhood.mcap, fdv: robinhood.fdv, type: robinhood.valuationType },
      { mcap: null, fdv: 50_000, type: 'fdv' },
    );
    assert.equal(solana.volume5m, 0);
    assert.equal(robinhood.prevVolume5mCanonical, 80);
    assert.equal(robinhood.volume5mBaselineAt, '2026-07-15T17:55:00.000Z');
    assert.equal(robinhood.volume5mDeltaCoverage, 'complete');
    assert.equal(robinhood.launchpadId, 'pons');
    assert.equal(solana.volume1h, null);
    assert.equal(solana.coverage['1h'], 'unavailable');
    assert.equal(solana.catalogFirstSeenAt, Date.parse('2026-07-14T12:00:00.000Z'));
    assert.equal(Object.hasOwn(solana, 'eligibleForMonitoring'), false);

    const partial = buildDashboardMonitoredToken(normalizedRow('robinhood', {
      liquidityUsd: 12_000,
      liquidityCoverage: 'partial',
      liquidityMarketCount: 3,
      valuedLiquidityMarketCount: 2,
    }));
    assert.equal(partial.liquidityUsd, 12_000);
    assert.equal(partial.liquidityIsLowerBound, true);
    assert.equal(partial.liquidityMarketCount, 3);
    assert.equal(partial.valuedLiquidityMarketCount, 2);

    const unknown = buildDashboardMonitoredToken(normalizedRow('robinhood', {
      valuation: { type: 'fdv', usd: null, observedAt: null, freshness: 'unknown' },
    }));
    assert.equal(unknown.fdv, null);
    assert.equal(unknown.valuationType, null);
  });

  it('builds a stable page payload and applies canonical pin order', () => {
    const solanaRow = normalizedRow('solana');
    const robinhoodRow = normalizedRow('robinhood');
    const payload = buildDashboardMonitoredPayload({
      asOf: '2026-07-15T18:00:00.000Z',
      total: 2,
      page: 0,
      perPage: 1,
      hasMore: true,
      rows: [solanaRow],
    }, {
      pinnedRows: [{ row: robinhoodRow, sortOrder: 3,
        filterMismatch: ['valuation_below_min'] }],
      coverage: { solana: 'ready', robinhood: 'syncing' },
    });

    assert.equal(payload.generatedAt, payload.asOf);
    assert.equal(payload.tokens[0].chain, 'solana');
    assert.equal(payload.pinnedTokens[0].chain, 'robinhood');
    assert.equal(payload.pinnedTokens[0].pinnedSortOrder, 3);
    assert.deepEqual(payload.pinnedTokens[0].filterMismatch, ['valuation_below_min']);
    assert.deepEqual(payload.coverage, { solana: 'ready', robinhood: 'syncing' });
  });
});
