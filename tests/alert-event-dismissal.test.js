const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const alertEventDismissal = require('../src/models/alert-event-dismissal');

describe('alert event dismissal model', () => {
  it('persists an idempotent chain-scoped dismissal', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;
    db.query = async (sql, params) => {
      capturedSql = String(sql);
      capturedParams = params;
      return { rows: [{
        user_id: 7,
        rule_key: 'custom-alert',
        chain: 'robinhood',
        event_id: '91',
        dismissed_at: '2026-07-16T12:00:00.000Z',
      }] };
    };

    try {
      const dismissal = await alertEventDismissal.dismissEvent({
        userId: 7, ruleKey: 'CUSTOM-ALERT', chain: 'robinhood', eventId: 91,
      });
      assert.match(capturedSql, /ON CONFLICT \(user_id, rule_key, chain, event_id\) DO UPDATE/);
      assert.deepEqual(capturedParams, [7, 'custom-alert', 'robinhood', 91]);
      assert.equal(dismissal.eventId, 91);
      assert.equal(dismissal.chain, 'robinhood');
    } finally {
      db.query = originalQuery;
    }
  });

  it('rejects invalid identities before querying', async () => {
    await assert.rejects(
      () => alertEventDismissal.dismissEvent({
        userId: 7, ruleKey: 'custom-alert', chain: 'robinhood', eventId: 0,
      }),
      /Alert event id is required/,
    );
  });
});
