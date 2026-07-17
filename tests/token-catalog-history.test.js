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
      assert.match(captured.sql, /ORDER BY CASE\s+WHEN source = 'user-manual'\s+OR EXISTS \(\s+SELECT 1\s+FROM user_tokens ut\s+WHERE ut\.chain = token_catalog\.chain\s+AND ut\.address = token_catalog\.address\s+\) THEN 0\s+ELSE 1\s+END ASC,/);
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
        chains: ['solana', 'robinhood'],
        page: 0,
        perPage: 30,
        searchQuery: '',
        starredOnly: false,
        sorts: [{ mode: 'vol', window: '1h' }],
        dismissedTokenIdentities: ['robinhood:0x1111111111111111111111111111111111111111'],
        starredTokenIdentities: [],
        mcapMin: 120000,
        mcapMax: 0,
        ageMinMinutes: 30,
        ageMaxMinutes: 120,
      });

      assert.equal(result.total, 0);
      assert.equal(result.page, 0);
      assert.equal(result.perPage, 30);
      assert.match(captured.sql, /^SELECT\s+tc\.chain,\s+tc\.address,/);
      assert.match(captured.sql, /tc\.chain = ANY\(\$9::varchar\[\]\)/);
      assert.match(captured.sql, /\(tc\.chain \|\| ':' \|\| tc\.address\) <> ALL\(\$6::varchar\[\]\)/);
      assert.match(captured.sql, /trr\.chain = tc\.chain/);
      assert.match(captured.sql, /ab\.chain = tc\.chain/);
      assert.match(captured.sql, /tre\.chain = tc\.chain/);
      assert.doesNotMatch(captured.sql, /\bSELECT\s+SELECT\b/i);
      assert.match(captured.sql, /\(CUME_DIST\(\) OVER \(ORDER BY COALESCE\(tc\.last_vol_1h, 0\) ASC\)\) \/ 1 AS history_sort_score/);
      assert.match(captured.sql, /ORDER BY history_sort_score DESC,\s+COALESCE\(tc\.last_vol_1h, 0\) DESC,/);
      assert.match(captured.sql, /COALESCE\(tc\.last_mcap, 0\) DESC, tc\.chain ASC, tc\.address ASC/);
      assert.match(captured.sql, /tc\.last_token_created_at_ms >= \$1 AND tc\.last_token_created_at_ms <= \$2/);
      assert.ok(Array.isArray(captured.params));
      assert.equal(captured.params.length, 11);
      assert.deepEqual(captured.params[5], ['robinhood:0x1111111111111111111111111111111111111111']);
      assert.deepEqual(captured.params[8], ['solana', 'robinhood']);
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
        chains: ['solana', 'robinhood'],
        page: 0,
        perPage: 30,
        searchQuery: '',
        starredOnly: false,
        sorts: [{ mode: 'vol', window: '24h' }, { mode: 'vol', window: '6h' }, { mode: 'vol', window: '1h' }],
        dismissedTokenIdentities: [],
        starredTokenIdentities: [],
        mcapMin: 30000,
        mcapMax: 100000000,
        ageMinMinutes: 30,
        ageMaxMinutes: 10080,
      }, ['solana:So11111111111111111111111111111111111111112']);

      assert.deepEqual(result, []);
      assert.match(captured.sql, /^WITH requested AS \(/);
      assert.match(captured.sql, /ON \(tc\.chain \|\| ':' \|\| tc\.address\) = requested\.identity_key/);
      assert.match(captured.sql, /trr\.chain = tc\.chain/);
      assert.match(captured.sql, /FROM unnest\(\$1::varchar\[\]\) WITH ORDINALITY/);
      assert.match(captured.sql, /tc\.last_token_created_at_ms >= \$2 AND tc\.last_token_created_at_ms <= \$3/);
      assert.match(captured.sql, /COALESCE\(tc\.last_mcap, 0\) >= \$4/);
      assert.match(
        captured.sql,
        /ROW_NUMBER\(\) OVER \(ORDER BY history_sort_score DESC,\s+COALESCE\(GREATEST\(COALESCE\(scored\.last_vol_24h, 0\), COALESCE\(scored\.last_vol_6h, 0\), COALESCE\(scored\.last_vol_1h, 0\)\), 0\) DESC,/
      );
      assert.ok(Array.isArray(captured.params));
      assert.equal(captured.params.length, 10);
      assert.deepEqual(captured.params[0], ['solana:So11111111111111111111111111111111111111112']);
      assert.deepEqual(captured.params[9], ['solana', 'robinhood']);
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
      assert.equal(captured.params.length, 10);
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
        /\(CUME_DIST\(\) OVER \(ORDER BY COALESCE\(GREATEST\(COALESCE\(tc\.last_vol_24h, 0\), COALESCE\(tc\.last_vol_6h, 0\), COALESCE\(tc\.last_vol_1h, 0\)\), 0\) ASC\) \+ CUME_DIST\(\) OVER \(ORDER BY COALESCE\(GREATEST\(COALESCE\(tc\.last_vol_6h, 0\), COALESCE\(tc\.last_vol_1h, 0\)\), 0\) ASC\) \+ CUME_DIST\(\) OVER \(ORDER BY COALESCE\(tc\.last_price_change_1h, 0\) ASC\)\) \/ 3 AS history_sort_score/
      );
      assert.match(
        captured.sql,
        /ORDER BY history_sort_score DESC,\s+COALESCE\(GREATEST\(COALESCE\(tc\.last_vol_24h, 0\), COALESCE\(tc\.last_vol_6h, 0\), COALESCE\(tc\.last_vol_1h, 0\)\), 0\) DESC,\s+COALESCE\(GREATEST\(COALESCE\(tc\.last_vol_6h, 0\), COALESCE\(tc\.last_vol_1h, 0\)\), 0\) DESC,\s+COALESCE\(tc\.last_price_change_1h, 0\) DESC,/
      );
      assert.ok(Array.isArray(captured.params));
      assert.equal(captured.params.length, 10);
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
      assert.equal(captured.params.length, 11);
    } finally {
      db.query = originalQuery;
    }
  });
});
