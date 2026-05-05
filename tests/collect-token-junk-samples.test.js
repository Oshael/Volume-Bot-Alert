const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildApiUrl,
  normalizeDexPair,
  parseArgs,
  summarizeMarketHistory,
  summarizeMeteoraPayload,
} = require('../src/utils/collect-token-junk-samples');

describe('collect token junk samples helpers', () => {
  it('parses CLI args with equals and value syntax', () => {
    const parsed = parseArgs([
      '--input=data/in.json',
      '--output',
      'data/out.json',
      '--days',
      '14',
      '--flag',
    ]);

    assert.deepEqual(parsed, {
      input: 'data/in.json',
      output: 'data/out.json',
      days: '14',
      flag: 'true',
    });
  });

  it('builds API urls with query params', () => {
    assert.equal(
      buildApiUrl('https://api.trendscope.pro', '/api/catalog/history/token123', {
        days: 7,
        limit: 500,
      }),
      'https://api.trendscope.pro/api/catalog/history/token123?days=7&limit=500'
    );
  });

  it('summarizes market history snapshots', () => {
    const summary = summarizeMarketHistory({
      snapshots: [
        { ts: '2026-04-08T00:00:00.000Z', mcap: 100, price: 1, sampleCount: 2 },
        { ts: '2026-04-08T00:01:00.000Z', mcap: 120, price: 1.2, sampleCount: 3 },
        { ts: '2026-04-08T00:02:00.000Z', mcap: 140, price: 1.4, sampleCount: 5 },
      ],
    });

    assert.equal(summary.snapshotCount, 3);
    assert.equal(summary.totalSampleCount, 10);
    assert.equal(summary.firstMcap, 100);
    assert.equal(summary.lastMcap, 140);
    assert.equal(summary.minMcap, 100);
    assert.equal(summary.maxMcap, 140);
    assert.equal(summary.avgMcap, 120);
    assert.equal(summary.rangePct, 33.33);
    assert.equal(summary.driftPct, 40);
  });

  it('summarizes meteora payload', () => {
    const summary = summarizeMeteoraPayload({
      snapshots: [
        { ts: '2026-04-08T00:00:00.000Z', totalTvl: 5000 },
        { ts: '2026-04-08T01:00:00.000Z', totalTvl: 6500 },
      ],
      summary: {
        tvl: 6500,
        poolAddress: 'pool123',
        poolCount: 2,
        noPool: false,
        change1h: 30,
      },
    });

    assert.equal(summary.snapshotCount, 2);
    assert.equal(summary.latestTvl, 6500);
    assert.equal(summary.minTvl, 5000);
    assert.equal(summary.maxTvl, 6500);
    assert.equal(summary.poolAddress, 'pool123');
    assert.equal(summary.poolCount, 2);
    assert.equal(summary.noPool, false);
    assert.equal(summary.change1h, 30);
  });

  it('normalizes dexscreener best pair fields', () => {
    const summary = normalizeDexPair({
      pairAddress: 'pair123',
      dexId: 'raydium',
      url: 'https://dex.example/pair123',
      marketCap: 120000,
      fdv: 130000,
      liquidity: { usd: 45000 },
      priceUsd: '0.123',
      pairCreatedAt: 1700000000000,
      volume: { m5: 100, h1: 1000, h6: 4000, h24: 12000 },
      txns: {
        m5: { buys: 4, sells: 1 },
        h1: { buys: 20, sells: 5 },
        h24: { buys: 180, sells: 90 },
      },
      priceChange: { m5: 10, h1: 20, h6: 30, h24: 40 },
      baseToken: { symbol: 'TEST', name: 'Test Token' },
      info: { imageUrl: 'https://example.com/token.png' },
    }, {
      pairs: [{}, {}],
    });

    assert.equal(summary.pairCount, 2);
    assert.equal(summary.marketCap, 120000);
    assert.equal(summary.liquidityUsd, 45000);
    assert.equal(summary.txns24hBuys, 180);
    assert.equal(summary.symbol, 'TEST');
  });
});
