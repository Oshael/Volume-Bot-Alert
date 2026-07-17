const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const probe = require('../src/utils/jupiter-api-probe');

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN = '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb';

describe('jupiter api probe', () => {
  it('deduplicates valid Solana addresses and rejects EVM addresses for Jupiter probes', () => {
    assert.deepEqual(probe.uniqueAddresses([
      SOL,
      SOL,
      '0x0000000000000000000000000000000000000000',
      'invalid',
      USDC,
    ]), [SOL, USDC]);
  });

  it('builds API URLs using the documented batch parameters', () => {
    assert.equal(
      probe.buildPriceUrl([SOL, USDC]),
      `https://api.jup.ag/price/v3?ids=${SOL}%2C${USDC}`,
    );
    assert.equal(
      probe.buildTokensUrl([SOL, USDC]),
      `https://api.jup.ag/tokens/v2/search?query=${SOL}%2C${USDC}`,
    );
  });

  it('normalizes missing price API entries as missing rather than null-priced', () => {
    const rows = probe.normalizePriceResults([SOL, TOKEN], {
      [SOL]: {
        usdPrice: 147.25,
        blockId: 348004023,
        decimals: 9,
        priceChange24h: 1.2,
      },
    });

    assert.deepEqual(rows, [
      {
        id: SOL,
        found: true,
        usdPrice: 147.25,
        blockId: 348004023,
        decimals: 9,
        priceChange24h: 1.2,
      },
      {
        id: TOKEN,
        found: false,
        usdPrice: null,
        blockId: null,
        decimals: null,
        priceChange24h: null,
      },
    ]);
  });

  it('normalizes token API volume windows from buy and sell volume', () => {
    const [row] = probe.normalizeTokenResults([{
      id: TOKEN,
      symbol: 'TEST',
      name: 'Test Token',
      isVerified: false,
      organicScore: 42,
      liquidity: 1000,
      mcap: 50000,
      usdPrice: 0.01,
      priceBlockId: 123,
      stats5m: { buyVolume: 10, sellVolume: 15, numTraders: 3 },
      stats1h: { buyVolume: 100, sellVolume: 125, numTraders: 30 },
      stats6h: { buyVolume: 500, sellVolume: 600 },
      stats24h: { buyVolume: 1000, sellVolume: 2000 },
      audit: { isSus: true },
      firstPool: { createdAt: '2026-07-04T00:00:00Z' },
      updatedAt: '2026-07-04T01:00:00Z',
    }]);

    assert.equal(row.id, TOKEN);
    assert.equal(row.volume5m, 25);
    assert.equal(row.volume1h, 225);
    assert.equal(row.volume6h, 1100);
    assert.equal(row.volume24h, 3000);
    assert.equal(row.numTraders5m, 3);
    assert.equal(row.isSus, true);
  });

  it('summarizes price and volume coverage for the requested token set', () => {
    const summary = probe.summarizeProbe(
      [SOL, TOKEN],
      probe.normalizePriceResults([SOL, TOKEN], { [SOL]: { usdPrice: 147, blockId: 1 } }),
      probe.normalizeTokenResults([
        { id: SOL, symbol: 'SOL', stats5m: { buyVolume: 1, sellVolume: 2 }, stats1h: { buyVolume: 3, sellVolume: 4 } },
      ]),
      { priceLatencyMs: 50, tokenLatencyMs: 75 },
      { totalRequests: 2, totalBytes: 1234 },
    );

    assert.equal(summary.requested, 2);
    assert.equal(summary.priced, 1);
    assert.equal(summary.missingPrice, 1);
    assert.equal(summary.tokenInfoFound, 1);
    assert.equal(summary.withVolume5m, 1);
    assert.equal(summary.withVolume1h, 1);
    assert.deepEqual(summary.usage, { totalRequests: 2, totalBytes: 1234 });
    assert.equal(summary.samples.length, 2);
  });

  it('tracks endpoint usage and last rate limit headers', () => {
    const usage = probe.createEndpointUsage();

    probe.updateEndpointUsage(usage, {
      bytes: 100,
      latencyMs: 10,
      headers: {
        'x-ratelimit-current': '1',
        'x-ratelimit-remaining': '59',
        'x-ratelimit-reset': '123',
        'x-credits-consumed': '2',
      },
    });
    probe.updateEndpointUsage(usage, {
      bytes: 50,
      latencyMs: 15,
      headers: {},
    });

    assert.deepEqual(usage, {
      requests: 2,
      bytes: 150,
      latencyMs: 25,
      lastRateLimitCurrent: '1',
      lastRateLimitRemaining: '59',
      lastRateLimitReset: '123',
      lastCreditsConsumed: '2',
    });
  });

  it('chunks requests according to Jupiter documented limits', () => {
    const items = Array.from({ length: 101 }, (_, index) => `item-${index}`);
    assert.deepEqual(probe.chunk(items, probe.PRICE_BATCH_SIZE).map((part) => part.length), [50, 50, 1]);
    assert.deepEqual(probe.chunk(items, probe.TOKEN_BATCH_SIZE).map((part) => part.length), [100, 1]);
  });
});
