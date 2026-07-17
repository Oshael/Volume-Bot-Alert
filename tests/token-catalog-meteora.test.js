const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenCatalog = require('../src/models/token-catalog');

describe('token catalog Meteora scheduling', () => {
  it('counts the Meteora universe with the same eligibility rule used by the worker', async () => {
    const originalQuery = db.query;
    let capturedSql = null;

    db.query = async (sql) => {
      capturedSql = sql;
      return { rows: [{ count: '390' }] };
    };

    try {
      const count = await tokenCatalog.countDueForMeteoraSnapshots();
      assert.equal(count, 390);
      assert.match(capturedSql, /SELECT COUNT\(\*\)::int AS count/i);
      assert.match(capturedSql, /LEFT JOIN token_meteora_state ms/i);
      assert.match(capturedSql, /COALESCE\(tc\.last_mcap, 0\) >= 100000/i);
      assert.match(capturedSql, /ms\.has_pool = TRUE/i);
      assert.match(capturedSql, /COALESCE\(tc\.source, ''\) <> 'gmgn'/i);
      assert.match(capturedSql, /tc\.eligibility_state IN \('dex-low', 'dex-normal', 'dex-high'\)/i);
    } finally {
      db.query = originalQuery;
    }
  });

  it('counts the Meteora universe by priority tier from 24h volume', async () => {
    const originalQuery = db.query;
    let capturedSql = null;

    db.query = async (sql) => {
      capturedSql = sql;
      return {
        rows: [
          { meteora_priority_tier: 'high', count: '12' },
          { meteora_priority_tier: 'normal', count: '25' },
          { meteora_priority_tier: 'low', count: '353' },
        ],
      };
    };

    try {
      const summary = await tokenCatalog.countDueForMeteoraSnapshotsByTier();
      assert.deepEqual(summary, {
        total: 390,
        byTier: {
          high: 12,
          normal: 25,
          low: 353,
        },
      });
      assert.match(capturedSql, /CASE\s+WHEN COALESCE\(tc\.last_vol_24h, 0\) >= 100000 THEN 'high'/i);
      assert.match(capturedSql, /WHEN COALESCE\(tc\.last_vol_24h, 0\) >= 15000 THEN 'normal'/i);
      assert.match(capturedSql, /GROUP BY CASE/i);
    } finally {
      db.query = originalQuery;
    }
  });

  it('lists due Meteora snapshot candidates by Meteora freshness instead of catalog freshness', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    };

    try {
      await tokenCatalog.listDueForMeteoraSnapshots(45);
      assert.deepEqual(capturedParams, [45]);
      assert.match(capturedSql, /LEFT JOIN token_meteora_state ms/i);
      assert.match(capturedSql, /WHERE tc\.chain = 'solana'\s+AND tc\.is_active_monitor_candidate = TRUE/i);
      assert.match(capturedSql, /COALESCE\(tc\.last_mcap, 0\) >= 100000/i);
      assert.match(capturedSql, /ms\.has_pool = TRUE/i);
      assert.match(capturedSql, /COALESCE\(tc\.source, ''\) <> 'gmgn'/i);
      assert.match(capturedSql, /tc\.eligibility_state IN \('dex-low', 'dex-normal', 'dex-high'\)/i);
      assert.match(capturedSql, /AS meteora_priority_tier/i);
      assert.match(capturedSql, /ORDER BY tc\.last_meteora_checked_at ASC NULLS FIRST/i);
      assert.doesNotMatch(capturedSql, /last_evaluated_at DESC/i);
    } finally {
      db.query = originalQuery;
    }
  });

  it('can list due Meteora snapshot candidates scoped to a priority tier', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    };

    try {
      await tokenCatalog.listDueForMeteoraSnapshots(80, 'high');
      assert.deepEqual(capturedParams, [80, 'high']);
      assert.match(capturedSql, /AND CASE/i);
      assert.match(capturedSql, /= \$2/i);
      assert.match(capturedSql, /COALESCE\(tc\.last_vol_24h, 0\) >= 100000/i);
    } finally {
      db.query = originalQuery;
    }
  });

  it('can filter due Meteora snapshot candidates by checked-before freshness cutoff', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rows: [] };
    };

    try {
      const checkedBefore = new Date('2026-04-05T23:30:00.000Z');
      await tokenCatalog.listDueForMeteoraSnapshots(50, 'normal', checkedBefore);
      assert.deepEqual(capturedParams, [50, 'normal', checkedBefore]);
      assert.match(capturedSql, /last_meteora_checked_at IS NULL OR tc\.last_meteora_checked_at <= \$3/i);
    } finally {
      db.query = originalQuery;
    }
  });

  it('marks unique valid addresses as Meteora-checked', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return { rowCount: 2 };
    };

    try {
      const checkedAt = new Date('2026-04-05T20:00:00.000Z');
      const count = await tokenCatalog.markMeteoraChecked([
        'So11111111111111111111111111111111111111112',
        'So11111111111111111111111111111111111111112',
        '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
        'bad-address',
      ], checkedAt);

      assert.equal(count, 2);
      assert.match(capturedSql, /SET last_meteora_checked_at = \$2/i);
      assert.deepEqual(capturedParams, [
        [
          'So11111111111111111111111111111111111111112',
          '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
        ],
        checkedAt,
      ]);
    } finally {
      db.query = originalQuery;
    }
  });
});
