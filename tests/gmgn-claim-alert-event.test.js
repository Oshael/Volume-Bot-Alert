const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const gmgnClaimAlertEvent = require('../src/models/gmgn-claim-alert-event');

describe('gmgn claim alert event model', () => {
  it('loads visible events by id without returning baseline rows', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = String(sql);
      capturedParams = params;
      return {
        rows: [{
          id: 17,
          rule_key: 'gmgn-claim-signal',
          token_address: 'So11111111111111111111111111111111111111112',
          signal_type: 18,
          source: 'gmgn',
          claim_sequence: 1,
          claim_id: 'claim-17',
          total_fee_usd: '42.5',
          claimed_at: '2026-07-09T12:00:00.000Z',
          payload: {},
          is_baseline: false,
          triggered_at: '2026-07-09T12:00:01.000Z',
          created_at: '2026-07-09T12:00:01.000Z',
        }],
      };
    };

    try {
      const event = await gmgnClaimAlertEvent.getEventById(17);

      assert.match(capturedSql, /WHERE id = \$1/);
      assert.match(capturedSql, /AND is_baseline = false/);
      assert.deepEqual(capturedParams, [17]);
      assert.equal(event.id, 17);
      assert.equal(event.ruleKey, 'gmgn-claim-signal');
      assert.equal(event.isBaseline, false);
    } finally {
      db.query = originalQuery;
    }
  });
});
