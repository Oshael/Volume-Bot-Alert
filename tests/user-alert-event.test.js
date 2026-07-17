const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const userAlertEvent = require('../src/models/user-alert-event');

describe('user alert event model', () => {
  it('creates a per-user alert event with normalized fields', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          id: 7,
          user_id: 15,
          rule_key: 'monitored-vol',
          kind: 'monitored-vol',
          chain: 'solana',
          token_address: 'So11111111111111111111111111111111111111112',
          dedupe_key: '15:monitored-vol:So11111111111111111111111111111111111111112:80',
          payload: {
            address: 'So11111111111111111111111111111111111111112',
            symbol: 'WSOL',
            label: 'VOL',
            pct: 80,
            prevVolume5m: 10000,
            volume5m: 18000,
            mcap: 300000,
          },
          triggered_at: '2026-04-16T12:05:10.000Z',
          created_at: '2026-04-16T12:05:10.000Z',
        }],
      };
    };

    try {
      const event = await userAlertEvent.createEvent({
        userId: '15',
        ruleKey: 'MONITORED-VOL',
        kind: 'MONITORED-VOL',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        dedupeKey: '15:monitored-vol:So11111111111111111111111111111111111111112:80',
        payload: {
          address: 'So11111111111111111111111111111111111111112',
          symbol: 'WSOL',
          label: 'VOL',
          pct: 80,
          prevVolume5m: 10000,
          volume5m: 18000,
          mcap: 300000,
        },
      });

      assert.deepEqual(capturedParams.slice(0, 6), [
        15,
        'monitored-vol',
        'monitored-vol',
        'solana',
        'So11111111111111111111111111111111111111112',
        '15:monitored-vol:So11111111111111111111111111111111111111112:80',
      ]);
      assert.equal(event.userId, 15);
      assert.equal(event.ruleKey, 'monitored-vol');
      assert.equal(event.kind, 'monitored-vol');
      assert.equal(event.chain, 'solana');
      assert.equal(event.payload.symbol, 'WSOL');
    } finally {
      db.query = originalQuery;
    }
  });

  it('lists recent per-user events with optional filters', async () => {
    const originalQuery = db.query;
    let capturedParams = null;
    let capturedSql = null;

    db.query = async (sql, params) => {
      capturedSql = String(sql);
      capturedParams = params;
      return {
        rows: [{
          id: 9,
          user_id: 5,
          rule_key: 'meteora-surge',
          kind: 'meteora-surge',
          chain: 'solana',
          token_address: 'So11111111111111111111111111111111111111112',
          dedupe_key: '5:meteora-surge:So11111111111111111111111111111111111111112:60',
          payload: {
            address: 'So11111111111111111111111111111111111111112',
            symbol: 'WSOL',
            label: 'METEORA 1H',
            pct: 60,
          },
          triggered_at: '2026-04-16T12:05:10.000Z',
          created_at: '2026-04-16T12:05:10.000Z',
        }],
      };
    };

    try {
      const events = await userAlertEvent.listRecentEvents({
        userId: 5,
        ruleKey: 'meteora-surge',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        afterId: 4,
        dismissedByUserId: 5,
        limit: 10,
        sort: 'asc',
      });

      assert.match(capturedSql, /ORDER BY id ASC/);
      assert.match(capturedSql, /FROM alert_event_dismissals dismissal/);
      assert.deepEqual(capturedParams, [5, 'solana', 'meteora-surge', 'So11111111111111111111111111111111111111112', 4, 5, 10]);
      assert.equal(events.length, 1);
      assert.equal(events[0].id, 9);
      assert.equal(events[0].kind, 'meteora-surge');
    } finally {
      db.query = originalQuery;
    }
  });

  it('gets the latest event id for a specific user and rule', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{ latest_id: '31' }],
      };
    };

    try {
      const latestId = await userAlertEvent.getLatestEventId({
        userId: 12,
        ruleKey: 'monitored-mcap',
      });

      assert.deepEqual(capturedParams, [12, 'solana', 'monitored-mcap']);
      assert.equal(latestId, 31);
    } finally {
      db.query = originalQuery;
    }
  });

  it('loads an event only when the id belongs to the expected user', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = String(sql);
      capturedParams = params;
      return {
        rows: [{
          id: 33,
          user_id: 12,
          rule_key: 'monitored-vol',
          kind: 'monitored-vol',
          chain: 'solana',
          token_address: 'So11111111111111111111111111111111111111112',
          dedupe_key: 'dedupe-33',
          payload: {},
          triggered_at: '2026-07-09T12:00:00.000Z',
          created_at: '2026-07-09T12:00:00.000Z',
        }],
      };
    };

    try {
      const event = await userAlertEvent.getEventForUser(33, 12);

      assert.match(capturedSql, /WHERE id = \$1/);
      assert.match(capturedSql, /AND user_id = \$2/);
      assert.deepEqual(capturedParams, [33, 12]);
      assert.equal(event.id, 33);
      assert.equal(event.userId, 12);
    } finally {
      db.query = originalQuery;
    }
  });

  it('lists chart events by user, token, cutoff and explicit rules', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = String(sql);
      capturedParams = params;
      return { rows: [] };
    };

    try {
      const cutoff = new Date('2026-07-02T06:00:00.000Z');
      const events = await userAlertEvent.listChartEvents({
        userId: 9,
        tokenAddress: 'So11111111111111111111111111111111111111112',
        triggeredAfter: cutoff,
        ruleKeys: ['monitored-vol', 'hvnc', 'monitored-vol'],
        limit: 501,
      });

      assert.deepEqual(events, []);
      assert.match(capturedSql, /triggered_at >= \$4/);
      assert.match(capturedSql, /rule_key = ANY\(\$5::text\[\]\)/);
      assert.match(capturedSql, /ORDER BY triggered_at ASC, id ASC/);
      assert.deepEqual(capturedParams, [
        9,
        'solana',
        'So11111111111111111111111111111111111111112',
        cutoff,
        ['monitored-vol', 'hvnc'],
        501,
      ]);
    } finally {
      db.query = originalQuery;
    }
  });

  it('rejects chart event queries without a valid cutoff', async () => {
    await assert.rejects(
      () => userAlertEvent.listChartEvents({
        userId: 9,
        tokenAddress: 'So11111111111111111111111111111111111111112',
        ruleKeys: ['monitored-vol'],
      }),
      /Valid chart alert cutoff is required/
    );
  });

  it('keeps Robinhood automatic event creation disabled', async () => {
    await assert.rejects(
      () => userAlertEvent.createEvent({
        userId: 15,
        ruleKey: 'monitored-vol',
        kind: 'monitored-vol',
        chain: 'robinhood',
        tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
        dedupeKey: 'same-dedupe-key',
      }),
      (error) => error.code === 'NON_SOLANA_ALERT_TRIGGER_DISABLED'
    );
  });
});
