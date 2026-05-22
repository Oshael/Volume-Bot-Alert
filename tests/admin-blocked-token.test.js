const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const adminBlockedToken = require('../src/models/admin-blocked-token');

describe('admin blocked token model', () => {
  it('lists currently blocked tokens that still have cleanup artifacts', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/SELECT ab\.address/.test(sql)) {
        return {
          rows: [
            { address: 'So11111111111111111111111111111111111111112' },
            { address: 'So11111111111111111111111111111111111111113' },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      const addresses = await adminBlockedToken.listAddressesWithCleanupArtifacts(1000);
      const selectCall = calls.find((call) => /SELECT ab\.address/.test(call.sql));

      assert.deepEqual(addresses, [
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111113',
      ]);
      assert.ok(selectCall);
      assert.deepEqual(selectCall.params, [500]);
      assert.match(selectCall.sql, /FROM admin_blocked_tokens ab/);
      assert.match(selectCall.sql, /token_market_buckets_1m/);
      assert.match(selectCall.sql, /token_market_buckets_agg/);
      assert.match(selectCall.sql, /token_market_volume_buckets_1m/);
      assert.match(selectCall.sql, /token_meteora_snapshots/);
    } finally {
      db.query = originalQuery;
    }
  });
});
