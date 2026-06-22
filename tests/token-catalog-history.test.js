process.env.NODE_ENV = 'test';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenCatalog = require('../src/models/token-catalog');

describe('token-catalog history bucket queries', () => {
  it('prioritizes manual due tokens before automatic due backlog', async () => {
    const originalQuery = db.query;
    const captured = {
      sql: '',
      params: null,
    };

    db.query = async (sql, params) => {
      captured.sql = String(sql);
      captured.params = params;
      return { rows: [] };
    };

    try {
      const result = await tokenCatalog.listDueForEvaluation(25);

      assert.deepEqual(result, []);
      assert.match(captured.sql, /ORDER BY CASE\s+WHEN source = 'user-manual'\s+OR EXISTS \(\s+SELECT 1\s+FROM user_tokens ut\s+WHERE ut\.address = token_catalog\.address\s+\) THEN 0\s+ELSE 1\s+END ASC,/);
      assert.ok(
        captured.sql.indexOf("source = 'user-manual'") < captured.sql.indexOf("COALESCE(monitor_priority, 'dormant') = 'high'")
      );
      assert.deepEqual(captured.params, [25]);
    } finally {
      db.query = originalQuery;
    }
  });

  it('builds a valid SQL statement for dashboard history buckets', async () => {
    const originalQuery = db.query;
    const captured = {
      sql: '',
      params: null,
    };

    db.query = async (sql, params) => {
      captured.sql = String(sql);
      captured.params = params;
      return { rows: [] };
    };

    try {
      const result = await tokenCatalog.listDashboardHistoryBucket('recent', {
        page: 0,
        perPage: 30,
        searchQuery: '',
        starredOnly: false,
        sorts: [{ mode: 'vol', window: '1h' }],
        dismissedAddresses: [],
        starredAddresses: [],
        mcapMin: 120000,
        mcapMax: 0,
        ageMinMinutes: 30,
        ageMaxMinutes: 120,
      });

      assert.equal(result.total, 0);
      assert.equal(result.page, 0);
      assert.equal(result.perPage, 30);
      assert.match(captured.sql, /^SELECT\s+tc\.address,/);
      assert.doesNotMatch(captured.sql, /\bSELECT\s+SELECT\b/i);
      assert.match(captured.sql, /\(CUME_DIST\(\) OVER \(ORDER BY COALESCE\(tc\.last_vol_1h, 0\) ASC\)\) \/ 1 AS history_sort_score/);
      assert.match(captured.sql, /ORDER BY history_sort_score DESC,\s+COALESCE\(tc\.last_vol_1h, 0\) DESC,/);
      assert.match(captured.sql, /tc\.last_token_created_at_ms >= \$1 AND tc\.last_token_created_at_ms <= \$2/);
      assert.ok(Array.isArray(captured.params));
      assert.equal(captured.params.length, 10);
    } finally {
      db.query = originalQuery;
    }
  });

  it('builds a valid SQL statement for dashboard history debug probes', async () => {
    const originalQuery = db.query;
    const captured = {
      sql: '',
      params: null,
    };

    db.query = async (sql, params) => {
      captured.sql = String(sql);
      captured.params = params;
      return { rows: [] };
    };

    try {
      const result = await tokenCatalog.listDashboardHistoryBucketDebugProbe('recent', {
        page: 0,
        perPage: 30,
        searchQuery: '',
        starredOnly: false,
        sorts: [{ mode: 'vol', window: '24h' }, { mode: 'vol', window: '6h' }, { mode: 'vol', window: '1h' }],
        dismissedAddresses: [],
        starredAddresses: [],
        mcapMin: 30000,
        mcapMax: 100000000,
        ageMinMinutes: 30,
        ageMaxMinutes: 10080,
      }, ['So11111111111111111111111111111111111111112']);

      assert.deepEqual(result, []);
      assert.match(captured.sql, /^WITH requested AS \(/);
      assert.match(captured.sql, /FROM unnest\(\$1::varchar\[\]\) WITH ORDINALITY/);
      assert.match(captured.sql, /tc\.last_token_created_at_ms >= \$2 AND tc\.last_token_created_at_ms <= \$3/);
      assert.match(captured.sql, /COALESCE\(tc\.last_mcap, 0\) >= \$4/);
      assert.match(captured.sql, /ROW_NUMBER\(\) OVER \(ORDER BY history_sort_score DESC,\s+COALESCE\(scored\.last_vol_24h, 0\) DESC,/);
      assert.ok(Array.isArray(captured.params));
      assert.equal(captured.params.length, 9);
      assert.deepEqual(captured.params[0], ['So11111111111111111111111111111111111111112']);
    } finally {
      db.query = originalQuery;
    }
  });

  it('uses a single upper age bound for old-week buckets', async () => {
    const originalQuery = db.query;
    const captured = {
      sql: '',
      params: null,
    };

    db.query = async (sql, params) => {
      captured.sql = String(sql);
      captured.params = params;
      return { rows: [] };
    };

    try {
      const result = await tokenCatalog.listDashboardHistoryBucket('oldWeek', {
        page: 0,
        perPage: 30,
        searchQuery: '',
        starredOnly: false,
        sorts: [{ mode: 'vol', window: '1h' }],
        dismissedAddresses: [],
        starredAddresses: [],
        mcapMin: 120000,
        mcapMax: 0,
      });

      assert.equal(result.total, 0);
      assert.match(captured.sql, /tc\.last_token_created_at_ms <= \$1/);
      assert.ok(Array.isArray(captured.params));
      assert.equal(captured.params.length, 9);
    } finally {
      db.query = originalQuery;
    }
  });

  it('scores multiple history bucket sort criteria as an average rank', async () => {
    const originalQuery = db.query;
    const captured = {
      sql: '',
      params: null,
    };

    db.query = async (sql, params) => {
      captured.sql = String(sql);
      captured.params = params;
      return { rows: [] };
    };

    try {
      const result = await tokenCatalog.listDashboardHistoryBucket('oldWeek', {
        page: 0,
        perPage: 30,
        searchQuery: '',
        starredOnly: false,
        sorts: [
          { mode: 'vol', window: '24h' },
          { mode: 'vol', window: '6h' },
          { mode: 'pchange', window: '1h' },
        ],
        dismissedAddresses: [],
        starredAddresses: [],
        mcapMin: 120000,
        mcapMax: 0,
      });

      assert.equal(result.total, 0);
      assert.match(
        captured.sql,
        /\(CUME_DIST\(\) OVER \(ORDER BY COALESCE\(tc\.last_vol_24h, 0\) ASC\) \+ CUME_DIST\(\) OVER \(ORDER BY COALESCE\(tc\.last_vol_6h, 0\) ASC\) \+ CUME_DIST\(\) OVER \(ORDER BY COALESCE\(tc\.last_price_change_1h, 0\) ASC\)\) \/ 3 AS history_sort_score/
      );
      assert.match(
        captured.sql,
        /ORDER BY history_sort_score DESC,\s+COALESCE\(tc\.last_vol_24h, 0\) DESC,\s+COALESCE\(tc\.last_vol_6h, 0\) DESC,\s+COALESCE\(tc\.last_price_change_1h, 0\) DESC,/
      );
      assert.ok(Array.isArray(captured.params));
      assert.equal(captured.params.length, 9);
    } finally {
      db.query = originalQuery;
    }
  });

  it('uses a bounded age range for old-week buckets when an age max is provided', async () => {
    const originalQuery = db.query;
    const captured = {
      sql: '',
      params: null,
    };

    db.query = async (sql, params) => {
      captured.sql = String(sql);
      captured.params = params;
      return { rows: [] };
    };

    try {
      const result = await tokenCatalog.listDashboardHistoryBucket('oldWeek', {
        page: 0,
        perPage: 30,
        searchQuery: '',
        starredOnly: false,
        sorts: [{ mode: 'vol', window: '1h' }],
        dismissedAddresses: [],
        starredAddresses: [],
        mcapMin: 120000,
        mcapMax: 0,
        ageMinMinutes: 20160,
        ageMaxMinutes: 43200,
      });

      assert.equal(result.total, 0);
      assert.match(captured.sql, /tc\.last_token_created_at_ms >= \$1 AND tc\.last_token_created_at_ms <= \$2/);
      assert.ok(Array.isArray(captured.params));
      assert.equal(captured.params.length, 10);
    } finally {
      db.query = originalQuery;
    }
  });
});
