const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenCatalog = require('../src/models/token-catalog');

describe('token catalog risk enrichment candidates', () => {
  it('lists active catalog tokens joined with structural enrichment cache', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [{
          address: 'So11111111111111111111111111111111111111112',
          monitor_priority: 'high',
          last_mcap: '120000',
          last_vol_24h: '45000',
          last_enriched_at: '2026-04-08T20:00:00.000Z',
          last_error: null,
        }],
      };
    };

    try {
      const rows = await tokenCatalog.listRiskEnrichmentCandidates(40);

      assert.deepEqual(capturedParams, [40]);
      assert.match(capturedSql, /LEFT JOIN token_risk_reviews/i);
      assert.match(capturedSql, /LEFT JOIN token_risk_enrichment/i);
      assert.match(capturedSql, /admin_blocked_tokens/i);
      assert.match(capturedSql, /is_active_monitor_candidate = TRUE/i);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].address, 'So11111111111111111111111111111111111111112');
    } finally {
      db.query = originalQuery;
    }
  });
});

describe('token catalog auto risk review candidates', () => {
  it('joins blocked token metadata so the auto review worker query stays valid', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [{
          address: 'So11111111111111111111111111111111111111112',
          blocked_label: null,
          risk_review_label: null,
          risk_holder_count: null,
        }],
      };
    };

    try {
      const rows = await tokenCatalog.listAutoRiskReviewCandidates(25, 10, 30000);

      assert.deepEqual(capturedParams, [25, 10, 30000]);
      assert.match(capturedSql, /LEFT JOIN token_risk_reviews/i);
      assert.match(capturedSql, /LEFT JOIN admin_blocked_tokens ab/i);
      assert.match(capturedSql, /LEFT JOIN token_risk_enrichment/i);
      assert.match(capturedSql, /COALESCE\(tc\.last_mcap, 0\) >= \$3/i);
      assert.match(capturedSql, /COALESCE\(trr\.label, ''\) <> 'valid'/i);
      assert.match(capturedSql, /trr\.source = 'auto'/i);
      assert.match(capturedSql, /trr\.updated_at < tc\.last_evaluated_at/i);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].address, 'So11111111111111111111111111111111111111112');
    } finally {
      db.query = originalQuery;
    }
  });
});

describe('token catalog dashboard top performers', () => {
  it('ranks eligible active tokens with mixed 24h price change and volume score while excluding blocked junk', async () => {
    const originalQueryWithStatementTimeout = db.queryWithStatementTimeout;
    let capturedSql = null;
    let capturedParams = null;
    let capturedTimeout = null;

    db.queryWithStatementTimeout = async (sql, params, timeoutMs) => {
      capturedSql = sql;
      capturedParams = params;
      capturedTimeout = timeoutMs;
      return {
        rows: [{
          address: 'So11111111111111111111111111111111111111112',
          performance_score: '557.12',
        }],
      };
    };

    try {
      const rows = await tokenCatalog.listDashboardTopPerformers({
        limit: 10,
        minMcap: 30000,
        minVol24h: 200000,
      });

      assert.deepEqual(capturedParams, [10, 30000, 200000, 300]);
      assert.equal(capturedTimeout, 5000);
      assert.match(capturedSql, /LEAST\(GREATEST\(COALESCE\(tc\.last_price_change_24h, 0\), 0\), \$4::numeric\)/i);
      assert.match(capturedSql, /LN\(1 \+ GREATEST\(COALESCE\(tc\.last_vol_24h, 0\), 0\)\)/i);
      assert.match(capturedSql, /tc\.eligible_for_monitoring = TRUE/i);
      assert.match(capturedSql, /tc\.is_active_monitor_candidate = TRUE/i);
      assert.match(capturedSql, /COALESCE\(tc\.last_mcap, 0\) >= \$2/i);
      assert.match(capturedSql, /COALESCE\(tc\.last_vol_24h, 0\) >= \$3/i);
      assert.match(capturedSql, /COALESCE\(trr\.label, ''\) NOT IN \('junk_probable', 'junk_permanent'\)/i);
      assert.match(capturedSql, /FROM admin_blocked_tokens ab/i);
      assert.match(capturedSql, /ORDER BY\s+performance_score DESC/i);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].performance_score, '557.12');
    } finally {
      db.queryWithStatementTimeout = originalQueryWithStatementTimeout;
    }
  });
});
