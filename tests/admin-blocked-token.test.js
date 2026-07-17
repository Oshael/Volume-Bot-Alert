const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const adminBlockedToken = require('../src/models/admin-blocked-token');

describe('admin blocked token model', () => {
  it('prevents automatic admin blocks for valid risk reviews', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM token_risk_reviews/.test(sql)) {
        return { rows: [{ label: 'valid', source: 'auto' }] };
      }
      if (/INSERT INTO admin_blocked_tokens/.test(sql)) {
        throw new Error('protected auto block must not insert');
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      await assert.rejects(
        () => adminBlockedToken.add({
          address: 'So11111111111111111111111111111111111111112',
          label: 'auto-junk-probable:test',
        }),
        (err) => err.code === 'PROTECTED_RISK_REVIEW_AUTO_BLOCK'
          && err.riskReviewLabel === 'valid'
          && err.riskReviewSource === 'auto'
      );

      assert.ok(calls.some((call) => /FROM token_risk_reviews/.test(call.sql)));
      assert.equal(calls.some((call) => /INSERT INTO admin_blocked_tokens/.test(call.sql)), false);
    } finally {
      db.query = originalQuery;
    }
  });

  it('allows explicit low-liquidity overrides for auto valid risk reviews', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM token_risk_reviews/.test(sql)) {
        return { rows: [{ label: 'valid', source: 'auto' }] };
      }
      if (/INSERT INTO admin_blocked_tokens/.test(sql)) {
        return {
          rows: [{
            chain: params[0],
            address: params[1],
            label: params[2],
            created_by: params[3],
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      const row = await adminBlockedToken.add({
        address: 'So11111111111111111111111111111111111111112',
        label: 'catalog-liquidity:under-1k-48h:500:30000',
        allowAutoValidOverride: true,
      });

      assert.ok(calls.some((call) => /FROM token_risk_reviews/.test(call.sql)));
      assert.deepEqual(row, {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        label: 'catalog-liquidity:under-1k-48h:500:30000',
        created_by: null,
      });
    } finally {
      db.query = originalQuery;
    }
  });

  it('prevents automatic admin blocks for manual risk reviews', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/FROM token_risk_reviews/.test(sql)) {
        return { rows: [{ label: 'valid_but_weak', source: 'manual' }] };
      }
      if (/INSERT INTO admin_blocked_tokens/.test(sql)) {
        throw new Error('protected auto block must not insert');
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      await assert.rejects(
        () => adminBlockedToken.add({
          address: 'So11111111111111111111111111111111111111112',
          label: 'auto-junk-probable:test',
        }),
        (err) => err.code === 'PROTECTED_RISK_REVIEW_AUTO_BLOCK'
          && err.riskReviewLabel === 'valid_but_weak'
          && err.riskReviewSource === 'manual'
      );

      assert.ok(calls.some((call) => /FROM token_risk_reviews/.test(call.sql)));
      assert.equal(calls.some((call) => /INSERT INTO admin_blocked_tokens/.test(call.sql)), false);
    } finally {
      db.query = originalQuery;
    }
  });

  it('allows explicit manual admin blocks for protected risk reviews', async () => {
    const originalQuery = db.query;
    const calls = [];

    db.query = async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO admin_blocked_tokens/.test(sql)) {
        return {
          rows: [{
            chain: params[0],
            address: params[1],
            label: params[2],
            created_by: params[3],
          }],
        };
      }
      return { rows: [], rowCount: 0 };
    };

    try {
      const row = await adminBlockedToken.add({
        address: 'So11111111111111111111111111111111111111112',
        label: 'manual-admin-block',
        createdBy: 7,
      });

      assert.deepEqual(row, {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        label: 'manual-admin-block',
        created_by: 7,
      });
      assert.equal(calls.some((call) => /FROM token_risk_reviews/.test(call.sql)), false);
      assert.ok(calls.some((call) => /INSERT INTO admin_blocked_tokens/.test(call.sql)));
    } finally {
      db.query = originalQuery;
    }
  });

  it('lists currently blocked tokens old enough for artifact cleanup', async () => {
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
      const addresses = await adminBlockedToken.listAddressesWithCleanupArtifacts(1000, {
        minBlockedAgeMs: 24 * 60 * 60 * 1000,
      });
      const selectCall = calls.find((call) => /SELECT ab\.address/.test(call.sql));

      assert.deepEqual(addresses, [
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111113',
      ]);
      assert.ok(selectCall);
      assert.deepEqual(selectCall.params, [500, 24 * 60 * 60 * 1000]);
      assert.match(selectCall.sql, /FROM admin_blocked_tokens ab/);
      assert.match(selectCall.sql, /LEFT JOIN token_risk_reviews trr/i);
      assert.match(selectCall.sql, /trr\.chain = ab\.chain/);
      assert.match(selectCall.sql, /trr\.token_address = ab\.address/);
      assert.match(selectCall.sql, /WHERE ab\.chain = 'solana'/);
      assert.match(selectCall.sql, /ab\.created_at <= NOW\(\) - \(\$2 \* INTERVAL '1 millisecond'\)/);
      assert.match(selectCall.sql, /COALESCE\(LOWER\(trr\.label\), ''\) <> 'valid'/);
      assert.match(selectCall.sql, /COALESCE\(LOWER\(trr\.source\), ''\) <> 'manual'/);
      assert.match(selectCall.sql, /token_market_buckets_1m/);
      assert.match(selectCall.sql, /token_market_buckets_agg/);
      assert.match(selectCall.sql, /token_market_volume_buckets_1m/);
      assert.match(selectCall.sql, /token_meteora_snapshots/);
      assert.equal((selectCall.sql.match(/buckets\.chain = ab\.chain/g) || []).length, 3);
    } finally {
      db.query = originalQuery;
    }
  });
});
