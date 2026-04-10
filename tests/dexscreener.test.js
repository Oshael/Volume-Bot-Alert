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
});
