const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenAlertEvent = require('../src/models/token-alert-event');

describe('token alert event model', () => {
  it('creates an alert event with normalized fields', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          id: 7,
          rule_key: 'high-cap-dump-5m',
          token_address: 'So11111111111111111111111111111111111111112',
          baseline_ts: '2026-04-05T12:00:00.000Z',
          baseline_mcap: '8000000',
          window_low_mcap: '3200000',
          current_ts: '2026-04-05T12:05:00.000Z',
          current_close_mcap: '4200000',
          dump_pct: '-60',
          threshold_pct: '50',
          triggered_at: '2026-04-05T12:05:10.000Z',
          metadata: { bucketCount: 5 },
          created_at: '2026-04-05T12:05:10.000Z',
        }],
      };
    };

    try {
      const event = await tokenAlertEvent.createEvent({
        ruleKey: 'HIGH-CAP-DUMP-5M',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        baselineTs: '2026-04-05T12:00:00.000Z',
        baselineMcap: 8000000,
        windowLowMcap: 3200000,
        currentTs: '2026-04-05T12:05:00.000Z',
        currentCloseMcap: 4200000,
        dumpPct: -60,
        thresholdPct: 50,
        metadata: { bucketCount: 5 },
      });

      assert.equal(capturedParams[0], 'high-cap-dump-5m');
      assert.equal(event.id, 7);
      assert.equal(event.ruleKey, 'high-cap-dump-5m');
      assert.equal(event.dumpPct, -60);
      assert.deepEqual(event.metadata, { bucketCount: 5 });
    } finally {
      db.query = originalQuery;
    }
  });

  it('lists recent events with optional filters', async () => {
    const originalQuery = db.query;
    let capturedParams = null;
    let capturedSql = null;

    db.query = async (sql, params) => {
      capturedSql = String(sql);
      capturedParams = params;
      return {
        rows: [{
          id: 9,
          rule_key: 'high-cap-dump-5m',
          token_address: 'So11111111111111111111111111111111111111112',
          baseline_ts: '2026-04-05T12:00:00.000Z',
          baseline_mcap: '7000000',
          window_low_mcap: '3000000',
          current_ts: '2026-04-05T12:05:00.000Z',
          current_close_mcap: '4100000',
          dump_pct: '-57.14',
          threshold_pct: '50',
          triggered_at: '2026-04-05T12:05:10.000Z',
          metadata: {},
          created_at: '2026-04-05T12:05:10.000Z',
        }],
      };
    };

    try {
      const events = await tokenAlertEvent.listRecentEvents({
        ruleKey: 'high-cap-dump-5m',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        afterId: 5,
        limit: 10,
        sort: 'asc',
      });

      assert.match(capturedSql, /ORDER BY id ASC/);
      assert.deepEqual(capturedParams, [ 'high-cap-dump-5m', 'So11111111111111111111111111111111111111112', 5, 10 ]);
      assert.equal(events.length, 1);
      assert.equal(events[0].id, 9);
    } finally {
      db.query = originalQuery;
    }
  });
});
