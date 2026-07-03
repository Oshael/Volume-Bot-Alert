const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const coingeckoOnchain = require('../src/services/coingecko-onchain');

const {
  buildOhlcvUrl,
  getNextBeforeTimestamp,
  normalizeOhlcvList,
  parseRetryAfterMs,
  resolveOptions,
} = coingeckoOnchain.__private;

describe('CoinGecko onchain OHLCV service', () => {
  it('resolves demo API options without exposing a pro base URL', () => {
    const options = resolveOptions({
      env: {
        COINGECKO_DEMO_API_KEY: ' demo-key ',
      },
      network: 'solana',
      days: 31,
    });

    assert.equal(options.plan, 'demo');
    assert.equal(options.apiBaseUrl, 'https://api.coingecko.com/api/v3');
    assert.equal(options.apiKeyHeader, 'x-cg-demo-api-key');
    assert.equal(options.apiKey, 'demo-key');
    assert.equal(options.network, 'solana');
    assert.equal(options.days, 31);
  });

  it('builds pool OHLCV URLs with 5 minute aggregation and backwards cursor', () => {
    const options = resolveOptions({
      env: { COINGECKO_DEMO_API_KEY: 'key' },
      network: 'solana',
      aggregate: 5,
      limit: 1000,
    });
    const url = new URL(buildOhlcvUrl(options, 'pool123', 1779926400));

    assert.equal(url.origin, 'https://api.coingecko.com');
    assert.equal(url.pathname, '/api/v3/onchain/networks/solana/pools/pool123/ohlcv/minute');
    assert.equal(url.searchParams.get('aggregate'), '5');
    assert.equal(url.searchParams.get('limit'), '1000');
    assert.equal(url.searchParams.get('before_timestamp'), '1779926400');
    assert.equal(url.searchParams.get('include_empty_intervals'), 'true');
  });

  it('normalizes OHLCV rows ascending and deduplicates repeated timestamps', () => {
    const candles = normalizeOhlcvList([
      [300, 3, 4, 2, 3.5, 30],
      [100, 1, 2, 0.5, 1.5, 10],
      [300, 5, 6, 4, 5.5, 50],
      ['bad'],
      [200, 2, 3, 1, 2.5, 20],
    ]);

    assert.deepEqual(candles.map((item) => item.timestamp), [100, 200, 300]);
    assert.equal(candles[2].open, 5);
    assert.equal(candles[2].volume, 50);
  });

  it('computes next before_timestamp from the oldest page candle', () => {
    assert.equal(getNextBeforeTimestamp([
      { timestamp: 200 },
      { timestamp: 100 },
      { timestamp: 300 },
    ]), 99);
  });

  it('parses Retry-After seconds and HTTP date values', () => {
    assert.equal(parseRetryAfterMs('2'), 2000);
    assert.equal(parseRetryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);
    assert.equal(parseRetryAfterMs(''), null);
  });

  it('fetches only candles inside an exact from/to window', async () => {
    const requestedUrls = [];
    const fetchImpl = async (url) => {
      requestedUrls.push(new URL(url));
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          data: {
            attributes: {
              ohlcv_list: [
                [Date.parse('2026-05-31T23:55:00.000Z') / 1000, 1, 1, 1, 1, 10],
                [Date.parse('2026-06-01T00:00:00.000Z') / 1000, 2, 2, 2, 2, 20],
                [Date.parse('2026-06-02T12:00:00.000Z') / 1000, 3, 3, 3, 3, 30],
                [Date.parse('2026-06-03T00:00:00.000Z') / 1000, 4, 4, 4, 4, 40],
              ],
            },
          },
        }),
      };
    };

    const result = await coingeckoOnchain.fetchPoolOhlcv({
      poolAddress: 'pool123',
      apiKey: 'key',
      from: '2026-06-01',
      to: '2026-06-02',
      aggregate: 5,
      limit: 1000,
      delayMs: 0,
      fetchImpl,
      now: () => Date.parse('2026-07-03T00:00:00.000Z'),
    });

    const expectedBeforeTimestamp = Math.floor(Date.parse('2026-06-02T23:59:59.999Z') / 1000) + 1;
    assert.equal(requestedUrls[0].searchParams.get('before_timestamp'), String(expectedBeforeTimestamp));
    assert.equal(result.requestedFrom, '2026-06-01T00:00:00.000Z');
    assert.equal(result.requestedTo, '2026-06-02T23:59:59.999Z');
    assert.deepEqual(
      result.candles.map((candle) => candle.bucketTs),
      ['2026-06-01T00:00:00.000Z', '2026-06-02T12:00:00.000Z']
    );
  });

  it('rejects from/to windows with an inverted range', async () => {
    await assert.rejects(
      () => coingeckoOnchain.fetchPoolOhlcv({
        poolAddress: 'pool123',
        apiKey: 'key',
        from: '2026-06-03',
        to: '2026-06-02',
        fetchImpl: async () => {
          throw new Error('fetch should not be called');
        },
      }),
      /--from must be earlier than or equal to --to/
    );
  });
});
