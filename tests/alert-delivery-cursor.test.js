const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const alertDeliveryCursor = require('../src/models/alert-delivery-cursor');

describe('alert delivery cursor model', () => {
  it('loads a persisted cursor for a user and rule', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          user_id: 7,
          rule_key: 'monitored-vol',
          chain: 'robinhood',
          last_seen_event_id: 19,
          last_acked_event_id: 17,
          updated_at: '2026-04-05T18:10:00.000Z',
        }],
      };
    };

    try {
      const cursor = await alertDeliveryCursor.getCursor(7, 'monitored-vol', 'robinhood');
      assert.deepEqual(capturedParams, [7, 'monitored-vol', 'robinhood']);
      assert.equal(cursor.userId, 7);
      assert.equal(cursor.chain, 'robinhood');
      assert.equal(cursor.lastSeenEventId, 19);
      assert.equal(cursor.lastAckedEventId, 17);
    } finally {
      db.query = originalQuery;
    }
  });

  it('upserts a cursor monotonically and treats ack as seen', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          user_id: 7,
          rule_key: 'monitored-vol',
          chain: 'robinhood',
          last_seen_event_id: 25,
          last_acked_event_id: 25,
          updated_at: '2026-04-05T18:12:00.000Z',
        }],
      };
    };

    try {
      const cursor = await alertDeliveryCursor.upsertCursor({
        userId: 7,
        ruleKey: 'monitored-vol',
        chain: 'robinhood',
        lastAckedEventId: 25,
      });

      assert.deepEqual(capturedParams, [7, 'monitored-vol', 'robinhood', 25, 25]);
      assert.equal(cursor.chain, 'robinhood');
      assert.equal(cursor.lastSeenEventId, 25);
      assert.equal(cursor.lastAckedEventId, 25);
    } finally {
      db.query = originalQuery;
    }
  });
});
