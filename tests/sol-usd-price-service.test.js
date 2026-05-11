const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const solUsdPrice = require('../src/services/sol-usd-price-service');

const {
  buildCoinMarketCapUrl,
  computeBackoffMs,
  parseCoinMarketCapSolQuote,
  parseRetryAfterMs,
  resolveOptions,
} = solUsdPrice.__private;

function noopLogger() {
  return {
    warn: () => {},
  };
}

function timerHarness() {
  const scheduled = [];
  return {
    scheduled,
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms };
      scheduled.push(timer);
      return timer;
    },
    clearTimeoutImpl: (timer) => {
      const index = scheduled.indexOf(timer);
      if (index >= 0) {
        scheduled.splice(index, 1);
      }
    },
  };
}

describe('SOL/USD price service', () => {
  it('resolves CoinMarketCap env options with bounded polling values', () => {
    const options = resolveOptions({
      env: {
        COINMARKETCAP_API_KEY: ' cmc-key ',
        SOL_PRICE_PROVIDER: 'COINMARKETCAP',
        SOL_CMC_ASSET_ID: '5426',
        SOL_PRICE_CONVERT: 'usd',
        SOL_PRICE_POLL_INTERVAL_MS: '1000',
        SOL_PRICE_STALE_AFTER_MS: '999999999',
      },
    });

    assert.equal(options.provider, 'coinmarketcap');
    assert.equal(options.apiKey, 'cmc-key');
    assert.equal(options.assetId, '5426');
    assert.equal(options.convert, 'USD');
    assert.equal(options.pollIntervalMs, 30000);
    assert.equal(options.staleAfterMs, 60 * 60 * 1000);
  });

  it('builds the latest quotes URL with Solana CMC id and USD conversion', () => {
    const url = new URL(buildCoinMarketCapUrl(resolveOptions({
      env: {},
      apiKey: 'key',
      assetId: '5426',
      convert: 'USD',
    })));

    assert.equal(url.origin, 'https://pro-api.coinmarketcap.com');
    assert.equal(url.pathname, '/v3/cryptocurrency/quotes/latest');
    assert.equal(url.searchParams.get('id'), '5426');
    assert.equal(url.searchParams.get('convert'), 'USD');
  });

  it('parses latest quote payloads from CoinMarketCap v3 shape', () => {
    const quote = parseCoinMarketCapSolQuote({
      data: [
        {
          id: 5426,
          symbol: 'SOL',
          quote: {
            USD: {
              price: 176.42,
              last_updated: '2026-05-11T12:00:00.000Z',
            },
          },
        },
      ],
      status: { error_code: 0, timestamp: '2026-05-11T12:00:01.000Z' },
    });

    assert.equal(quote.provider, 'coinmarketcap');
    assert.equal(quote.assetId, '5426');
    assert.equal(quote.convert, 'USD');
    assert.equal(quote.priceUsd, 176.42);
    assert.equal(quote.lastUpdatedAt, '2026-05-11T12:00:00.000Z');
  });

  it('parses simple-price style payloads for defensive compatibility', () => {
    const quote = parseCoinMarketCapSolQuote({
      data: [
        {
          id: 5426,
          price: 175.1,
          last_updated: '2026-05-11T12:01:00.000Z',
        },
      ],
      status: { error_code: 0 },
    });

    assert.equal(quote.priceUsd, 175.1);
    assert.equal(quote.lastUpdatedAt, '2026-05-11T12:01:00.000Z');
  });

  it('rejects invalid CoinMarketCap price payloads', () => {
    assert.throws(
      () => parseCoinMarketCapSolQuote({ data: [], status: { error_code: 0 } }),
      /valid SOL\/USD price/
    );

    assert.throws(
      () => parseCoinMarketCapSolQuote({
        data: [],
        status: { error_code: 1002, error_message: 'API key missing' },
      }),
      /API key missing/
    );
  });

  it('parses Retry-After and computes bounded backoff', () => {
    const now = Date.UTC(2026, 4, 11, 12, 0, 0);
    const retryAt = new Date(now + 45000).toUTCString();

    assert.equal(parseRetryAfterMs('12'), 12000);
    assert.equal(parseRetryAfterMs(retryAt, now), 45000);
    assert.equal(computeBackoffMs(null, 1, { minBackoffMs: 5000, maxBackoffMs: 60000 }), 5000);
    assert.equal(computeBackoffMs(null, 4, { minBackoffMs: 5000, maxBackoffMs: 60000 }), 40000);
    assert.equal(computeBackoffMs(120000, 4, { minBackoffMs: 5000, maxBackoffMs: 60000 }), 60000);
  });

  it('fetches and caches a fresh CoinMarketCap quote', async () => {
    let fetchUrl = null;
    let fetchOptions = null;
    const service = solUsdPrice.createSolUsdPriceService({
      env: {},
      apiKey: 'cmc-test-key',
      now: () => Date.parse('2026-05-11T12:00:05.000Z'),
      logger: noopLogger(),
      fetchImpl: async (url, options) => {
        fetchUrl = url;
        fetchOptions = options;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: [{
              id: 5426,
              quote: { USD: { price: 180.25, last_updated: '2026-05-11T12:00:00.000Z' } },
            }],
            status: { error_code: 0 },
          }),
        };
      },
    });

    const status = await service.fetchOnce();
    const freshQuote = service.getFreshQuote();

    assert.equal(new URL(fetchUrl).searchParams.get('id'), '5426');
    assert.equal(fetchOptions.headers['X-CMC_PRO_API_KEY'], 'cmc-test-key');
    assert.equal(status.priceUsd, 180.25);
    assert.equal(status.fetchInFlight, false);
    assert.equal(status.stale, false);
    assert.equal(status.lastError, null);
    assert.deepEqual(freshQuote, {
      provider: 'coinmarketcap',
      priceUsd: 180.25,
      lastUpdatedAt: '2026-05-11T12:00:00.000Z',
      ageSeconds: 5,
    });
  });

  it('marks cached quotes stale after the configured window', async () => {
    let now = Date.parse('2026-05-11T12:00:05.000Z');
    const service = solUsdPrice.createSolUsdPriceService({
      env: {},
      apiKey: 'cmc-test-key',
      staleAfterMs: 30000,
      now: () => now,
      logger: noopLogger(),
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: 5426, quote: { USD: { price: 180, last_updated: '2026-05-11T12:00:00.000Z' } } }],
          status: { error_code: 0 },
        }),
      }),
    });

    await service.fetchOnce();
    assert.equal(service.getStatus().stale, false);

    now = Date.parse('2026-05-11T12:00:31.000Z');
    assert.equal(service.getStatus().stale, true);
    assert.throws(() => service.getFreshQuote(), /Fresh SOL\/USD price is unavailable/);
  });

  it('schedules Retry-After backoff after CoinMarketCap rate limits', async () => {
    const timers = timerHarness();
    const service = solUsdPrice.createSolUsdPriceService({
      env: {},
      apiKey: 'cmc-test-key',
      now: () => Date.parse('2026-05-11T12:00:00.000Z'),
      minBackoffMs: 5000,
      maxBackoffMs: 60000,
      logger: noopLogger(),
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl,
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        headers: { get: () => '12' },
        json: async () => ({}),
      }),
    });

    const status = await service.start();

    assert.equal(status.lastError, 'rate_limited');
    assert.equal(status.consecutiveErrors, 1);
    assert.equal(timers.scheduled.length, 1);
    assert.equal(timers.scheduled[0].ms, 12000);
    assert.equal(status.nextFetchInSeconds, 12);

    service.stop();
    assert.equal(timers.scheduled.length, 0);
  });
});
