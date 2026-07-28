const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const marketTicker = require('../src/services/market-ticker-service');

const universe = ['ETH', 'PUMP', 'BTC', 'HYPE', 'SOL'];
const prices = {
  BTC: [64000, 62500],
  ETH: [3200, 3300],
  SOL: [180, 150],
  HYPE: [40, 32],
  PUMP: [0.006, 0.005],
};

function payload() {
  return [
    { universe: universe.map((name) => ({ name })) },
    universe.map((name) => ({ markPx: String(prices[name][0]), prevDayPx: String(prices[name][1]) })),
  ];
}

describe('market ticker service', () => {
  beforeEach(() => marketTicker.__private.resetCache());

  it('maps the five configured markets by symbol and calculates their 24h delta', () => {
    const result = marketTicker.__private.parseMarketTickerPayload(payload(), '2026-07-28T12:00:00.000Z');

    assert.deepEqual(result.items.map((item) => item.symbol), ['BTC', 'ETH', 'SOL', 'HYPE', 'PUMP']);
    assert.equal(result.items.find((item) => item.symbol === 'SOL').change24hPct, 20);
    assert.equal(result.items.find((item) => item.symbol === 'PUMP').priceUsd, 0.006);
  });

  it('reuses the shared cache and returns it as stale when a later refresh fails', async () => {
    let requests = 0;
    const okFetch = async () => {
      requests += 1;
      return { ok: true, json: async () => payload() };
    };

    const fresh = await marketTicker.getMarketTicker({ fetchImpl: okFetch, now: 1_000 });
    const cached = await marketTicker.getMarketTicker({ fetchImpl: okFetch, now: 5_999 });
    assert.equal(requests, 1);
    assert.equal(cached, fresh);

    const refreshed = await marketTicker.getMarketTicker({ fetchImpl: okFetch, now: 6_000 });
    assert.equal(requests, 2);
    assert.notEqual(refreshed, fresh);

    const stale = await marketTicker.getMarketTicker({
      fetchImpl: async () => { throw new Error('offline'); },
      now: 11_000,
    });
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.items, refreshed.items);
  });
});
