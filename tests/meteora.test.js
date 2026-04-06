const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const meteora = require('../src/services/meteora');

describe('meteora service', () => {
  it('defaults to one-token requests to avoid grouped Meteora result bias', async () => {
    const originalFetch = global.fetch;
    const urls = [];

    global.fetch = async (url) => {
      urls.push(String(url));
      return {
        ok: true,
        json: async () => ({ data: [] }),
      };
    };

    try {
      const result = await meteora.fetchMeteoraBulk([
        'So11111111111111111111111111111111111111112',
        '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
      ], {
        delayMs: 0,
      });

      assert.equal(urls.length, 4);
      assert.match(urls[0], /^https:\/\/dlmm\.datapi\.meteora\.ag\/pools\?/);
      assert.match(urls[0], /filter_by=token_x%3D%5BSo11111111111111111111111111111111111111112%5D/);
      assert.match(urls[1], /filter_by=token_y%3D%5BSo11111111111111111111111111111111111111112%5D/);
      assert.match(urls[2], /filter_by=token_x%3D%5B34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb%5D/);
      assert.match(urls[3], /filter_by=token_y%3D%5B34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb%5D/);
      assert.deepEqual(result.checkedAddresses.sort(), [
        '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
        'So11111111111111111111111111111111111111112',
      ]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('returns checked addresses separately from chunk failures', async () => {
    const originalFetch = global.fetch;
    let fetchCount = 0;

    global.fetch = async (url) => {
      fetchCount += 1;
      if (fetchCount <= 2) {
        assert.match(String(url), /So11111111111111111111111111111111111111112/);
        return {
          ok: true,
          json: async () => ({
            data: [{
              token_x: { address: 'So11111111111111111111111111111111111111112' },
              token_y: { address: 'USDC111111111111111111111111111111111111111' },
              tvl: 12500,
              address: 'pool_test_123',
            }],
          }),
        };
      }

      throw new Error('socket hang up');
    };

    try {
      const result = await meteora.fetchMeteoraBulk([
        'So11111111111111111111111111111111111111112',
        '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
      ], {
        chunkSize: 1,
        concurrency: 1,
        delayMs: 0,
      });

      assert.equal(result.results.So11111111111111111111111111111111111111112.tvl, 12500);
      assert.deepEqual(result.checkedAddresses, ['So11111111111111111111111111111111111111112']);
      assert.equal(result.errorsByAddress['34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb'], 'socket hang up');
      assert.equal(fetchCount, 4);
    } finally {
      global.fetch = originalFetch;
    }
  });
});
