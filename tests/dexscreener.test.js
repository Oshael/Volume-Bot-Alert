const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const dexscreener = require('../src/services/dexscreener');

describe('dexscreener rate-limit helpers', () => {
  beforeEach(() => {
    dexscreener.__private.resetRateLimitState();
    dexscreener.clearCache();
  });

  it('parses Retry-After seconds responses', () => {
    assert.equal(dexscreener.__private.parseRetryAfterMs('12'), 12000);
  });

  it('parses Retry-After HTTP dates', () => {
    const now = Date.UTC(2026, 2, 25, 12, 0, 0);
    const retryAt = new Date(now + 30000).toUTCString();
    assert.equal(dexscreener.__private.parseRetryAfterMs(retryAt, now), 30000);
  });

  it('uses Retry-After directly when the upstream provides it', () => {
    assert.equal(dexscreener.__private.computeRateLimitBackoffMs(45000, 3, 0.4), 45000);
  });

  it('falls back to exponential backoff with jitter when Retry-After is absent', () => {
    assert.equal(dexscreener.__private.computeRateLimitBackoffMs(null, 1, 0), 5000);
    assert.equal(dexscreener.__private.computeRateLimitBackoffMs(null, 3, 0), 20000);
  });

  it('preserves batch delay when options are passed as an object', () => {
    const resolved = dexscreener.__private.resolveBatchOptions({
      chain: 'solana',
      delayMs: 175,
      priorityByAddress: new Map(),
    });

    assert.equal(resolved.delayMs, 175);
    assert.equal(resolved.options.chain, 'solana');
    assert.equal(resolved.options.priorityByAddress instanceof Map, true);
    assert.equal(Object.prototype.hasOwnProperty.call(resolved.options, 'delayMs'), false);
  });

  it('does not use FDV as operational market cap', () => {
    assert.equal(dexscreener.resolveOperationalMarketCap({ fdv: 99800000 }), null);
    assert.equal(dexscreener.resolveOperationalMarketCap({ marketCap: 41200000, fdv: 99800000 }), 41200000);
  });

  it('activates global cooldown only after the 10th consecutive 429', () => {
    const response = { headers: { get: () => null } };

    for (let index = 0; index < 9; index += 1) {
      const result = dexscreener.__private.noteRateLimit(response, `batch-${index}`);
      assert.equal(result.activatedCooldown, false);
    }

    assert.equal(dexscreener.getThrottleState().mode, 'normal');

    const activation = dexscreener.__private.noteRateLimit(response, 'batch-10');
    assert.equal(activation.activatedCooldown, true);
    assert.equal(dexscreener.getThrottleState().mode, 'cooldown');
  });

  it('walks recovery phases after cooldown ends', () => {
    const response = { headers: { get: () => null } };

    for (let index = 0; index < 10; index += 1) {
      dexscreener.__private.noteRateLimit(response, `batch-${index}`);
    }

    dexscreener.__private.getThrottleState(Date.now() + (11 * 60 * 1000));
    assert.equal(dexscreener.getThrottleState().mode, 'recovery');
    assert.equal(dexscreener.getThrottleState().recoveryPhase, 'high-manual');

    for (let index = 0; index < 5; index += 1) {
      dexscreener.__private.completeRecoveryCycle();
    }
    assert.equal(dexscreener.getThrottleState().recoveryPhase, 'normal');

    for (let index = 0; index < 5; index += 1) {
      dexscreener.__private.completeRecoveryCycle();
    }
    assert.equal(dexscreener.getThrottleState().recoveryPhase, 'low-near');
  });

  it('prefers the single-token endpoint when the batch endpoint only returns a stale low-liquidity pumpfun pair', async () => {
    const address = '7c5gm5fqvQuyteJ9G4pFaubqRVHuegsFXtfHJXBBpump';
    const stalePumpPair = {
      chainId: 'solana',
      dexId: 'pumpfun',
      pairAddress: '9qgnQRssM2DZVk1uCpHarAWXiY3yx7DrRQSFANv3JZeN',
      baseToken: { address },
      quoteToken: { address: 'So11111111111111111111111111111111111111112' },
      marketCap: 34353.69,
      volume: { h24: 7107.29, h6: 0, h1: 0, m5: 0 },
    };
    const bestLivePair = {
      chainId: 'solana',
      dexId: 'pumpswap',
      pairAddress: '4Yu8BiAw6MFmSNzeLJgVDgNjsbBYKj9gNjM31fwZRuyA',
      baseToken: { address },
      quoteToken: { address: 'So11111111111111111111111111111111111111112' },
      marketCap: 10333620,
      liquidity: { usd: 311340.32 },
      volume: { h24: 12572287.08, h6: 11409321.03, h1: 1606428.11, m5: 89101.78 },
    };

    const originalFetch = global.fetch;
    const seenUrls = [];
    global.fetch = async (url) => {
      seenUrls.push(String(url));
      if (String(url).includes(`/tokens/v1/solana/${address}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => [stalePumpPair],
        };
      }

      if (String(url).includes(`/latest/dex/tokens/${address}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ pairs: [stalePumpPair, bestLivePair] }),
        };
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    try {
      const results = await dexscreener.__private.fetchTokenPairsBatchUncached([address], { chain: 'solana' });
      const payload = results.get(address);
      const bestPair = dexscreener.getBestPair(payload, 'solana');

      assert.ok(seenUrls.some((url) => url.includes(`/tokens/v1/solana/${address}`)));
      assert.ok(seenUrls.some((url) => url.includes(`/latest/dex/tokens/${address}`)));
      assert.equal(bestPair?.pairAddress, bestLivePair.pairAddress);
      assert.equal(payload?.pairs?.length, 2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('prefers the single-token endpoint when the batch endpoint only returns a stale launchlab pair', async () => {
    const address = 'CKTCDmUcgFXhLq6u2CZZxSNkkbut8e1F2MvgWHiYbonk';
    const staleLaunchlabPair = {
      chainId: 'solana',
      dexId: 'launchlab',
      pairAddress: 'CFqKvuRnQGW519UCpdG2rB3c4XqWU3MRPtyzdKiUE2jH',
      baseToken: { address },
      quoteToken: { address: 'So11111111111111111111111111111111111111112' },
      marketCap: 34649.11,
      fdv: 34649.11,
      priceUsd: '0.00003464',
      volume: { h24: 33644.64, h6: 0, h1: 0, m5: 0 },
      txns: {
        m5: { buys: 0, sells: 0 },
        h1: { buys: 0, sells: 0 },
        h24: { buys: 0, sells: 0 },
      },
    };
    const bestLivePair = {
      chainId: 'solana',
      dexId: 'raydium',
      pairAddress: 'DL8CtmmV3emMPREvVrphgxQNAw9gs3QuZ7yQXkuK1MRz',
      baseToken: { address },
      quoteToken: { address: 'So11111111111111111111111111111111111111112' },
      marketCap: 1988,
      fdv: 1988,
      priceUsd: '0.000001988',
      liquidity: { usd: 3579.88 },
      volume: { h24: 73981.04, h6: 0.28, h1: 0.03, m5: 0 },
      txns: {
        m5: { buys: 0, sells: 0 },
        h1: { buys: 1, sells: 0 },
        h24: { buys: 801, sells: 868 },
      },
    };

    const originalFetch = global.fetch;
    const seenUrls = [];
    global.fetch = async (url) => {
      seenUrls.push(String(url));
      if (String(url).includes(`/tokens/v1/solana/${address}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => [staleLaunchlabPair],
        };
      }

      if (String(url).includes(`/latest/dex/tokens/${address}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ pairs: [bestLivePair, staleLaunchlabPair] }),
        };
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    try {
      const results = await dexscreener.__private.fetchTokenPairsBatchUncached([address], { chain: 'solana' });
      const payload = results.get(address);
      const bestPair = dexscreener.getBestPair(payload, 'solana');

      assert.ok(seenUrls.some((url) => url.includes(`/tokens/v1/solana/${address}`)));
      assert.ok(seenUrls.some((url) => url.includes(`/latest/dex/tokens/${address}`)));
      assert.equal(bestPair?.pairAddress, bestLivePair.pairAddress);
      assert.equal(payload?.pairs?.length, 2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('prefers the single-token endpoint when the batch endpoint returns only a migrated launch-floor pair', async () => {
    const address = 'vD4gAaQdJb3T3E4233vS4ix41ppSxQa7pGbfLtJpump';
    const migratedPumpfunPair = {
      chainId: 'solana',
      dexId: 'pumpfun',
      pairAddress: 'FzaGkGLgABu3UHYUy5FzX7dVmHqHUmsRjVKtvyRVdPCb',
      baseToken: { address },
      quoteToken: { address: 'So11111111111111111111111111111111111111112' },
      marketCap: 30474.98,
      fdv: 30474.98,
      priceUsd: '0.00003047',
      volume: { h24: 6304.84, h6: 6304.84, h1: 6304.84, m5: 0 },
      txns: {
        m5: { buys: 0, sells: 0 },
        h1: { buys: 2, sells: 0 },
        h6: { buys: 2, sells: 0 },
        h24: { buys: 2, sells: 0 },
      },
    };
    const bestLivePair = {
      chainId: 'solana',
      dexId: 'pumpswap',
      pairAddress: 'E7VswuHUKUp9TZJb5tgQspV45YidnBJCo6v9UhyQ4sVm',
      baseToken: { address },
      quoteToken: { address: 'So11111111111111111111111111111111111111112' },
      marketCap: 225872,
      fdv: 225872,
      priceUsd: '0.0002258',
      liquidity: { usd: 35325.49 },
      volume: { h24: 481125.71, h6: 481125.71, h1: 481125.71, m5: 50696.31 },
      txns: {
        m5: { buys: 291, sells: 188 },
        h1: { buys: 3171, sells: 2609 },
        h6: { buys: 3171, sells: 2609 },
        h24: { buys: 3171, sells: 2609 },
      },
    };

    const originalFetch = global.fetch;
    const seenUrls = [];
    global.fetch = async (url) => {
      seenUrls.push(String(url));
      if (String(url).includes(`/tokens/v1/solana/${address}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => [migratedPumpfunPair],
        };
      }

      if (String(url).includes(`/latest/dex/tokens/${address}`)) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ pairs: [bestLivePair, migratedPumpfunPair] }),
        };
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    };

    try {
      const results = await dexscreener.__private.fetchTokenPairsBatchUncached([address], { chain: 'solana' });
      const payload = results.get(address);
      const bestPair = dexscreener.getBestPair(payload, 'solana');

      assert.ok(seenUrls.some((url) => url.includes(`/tokens/v1/solana/${address}`)));
      assert.ok(seenUrls.some((url) => url.includes(`/latest/dex/tokens/${address}`)));
      assert.equal(bestPair?.pairAddress, bestLivePair.pairAddress);
      assert.equal(payload?.pairs?.length, 2);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('prefers a pair with meaningful recent activity over a more liquid but stale pair', () => {
    const activePair = {
      chainId: 'solana',
      dexId: 'raydium',
      pairAddress: 'active-pair',
      liquidity: { usd: 62000 },
      marketCap: 320000,
      volume: { m5: 3103, h1: 18400, h6: 88200, h24: 120000 },
      txns: {
        m5: { buys: 4, sells: 3 },
        h1: { buys: 28, sells: 17 },
        h24: { buys: 210, sells: 180 },
      },
    };
    const staleLiquidityPair = {
      chainId: 'solana',
      dexId: 'raydium',
      pairAddress: 'stale-liquidity-pair',
      liquidity: { usd: 110000 },
      marketCap: 30000,
      volume: { m5: 0, h1: 0, h6: 43522, h24: 43522 },
      txns: {
        m5: { buys: 0, sells: 0 },
        h1: { buys: 0, sells: 0 },
        h24: { buys: 22, sells: 19 },
      },
    };

    const bestPair = dexscreener.getBestPair({
      pairs: [staleLiquidityPair, activePair],
    }, 'solana');

    assert.equal(bestPair?.pairAddress, activePair.pairAddress);
  });

  it('still prefers the more liquid pair when recent activity is comparable', () => {
    const lowerLiquidityPair = {
      chainId: 'solana',
      dexId: 'raydium',
      pairAddress: 'lower-liquidity-pair',
      liquidity: { usd: 42000 },
      marketCap: 280000,
      volume: { m5: 1800, h1: 12000, h6: 64000, h24: 110000 },
      txns: {
        m5: { buys: 3, sells: 2 },
        h1: { buys: 16, sells: 13 },
        h24: { buys: 170, sells: 120 },
      },
    };
    const higherLiquidityPair = {
      chainId: 'solana',
      dexId: 'raydium',
      pairAddress: 'higher-liquidity-pair',
      liquidity: { usd: 98000 },
      marketCap: 300000,
      volume: { m5: 1600, h1: 11800, h6: 60000, h24: 108000 },
      txns: {
        m5: { buys: 3, sells: 2 },
        h1: { buys: 15, sells: 12 },
        h24: { buys: 168, sells: 118 },
      },
    };

    const bestPair = dexscreener.getBestPair({
      pairs: [lowerLiquidityPair, higherLiquidityPair],
    }, 'solana');

    assert.equal(bestPair?.pairAddress, higherLiquidityPair.pairAddress);
  });
});
