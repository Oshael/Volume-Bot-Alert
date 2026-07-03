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
});
