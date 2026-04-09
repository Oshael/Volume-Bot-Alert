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
