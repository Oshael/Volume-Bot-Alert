const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const userAlertRuleState = require('../src/models/user-alert-rule-state');

describe('user alert rule state model', () => {
  it('upserts persisted per-user rule state with normalized payload', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          user_id: 17,
          rule_key: 'monitored-vol',
          token_address: 'So11111111111111111111111111111111111111112',
          status: 'triggered',
          last_alerted_at: '2026-04-16T12:05:10.000Z',
          last_alerted_value: '18000',
          last_alerted_pct: '80',
          cooldown_until: '2026-04-16T12:06:10.000Z',
          rearm_required: true,
          last_fingerprint: '80|10000|18000',
          metadata: { source: 'matcher-test' },
          updated_at: '2026-04-16T12:05:10.000Z',
        }],
      };
    };

    try {
      const state = await userAlertRuleState.upsertState({
        userId: '17',
        ruleKey: 'MONITORED-VOL',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        status: 'triggered',
        lastAlertedAt: '2026-04-16T12:05:10.000Z',
        lastAlertedValue: 18000,
        lastAlertedPct: 80,
        cooldownUntil: '2026-04-16T12:06:10.000Z',
        rearmRequired: true,
        lastFingerprint: '80|10000|18000',
        metadata: { source: 'matcher-test' },
      });

      assert.deepEqual(capturedParams.slice(0, 4), [
        17,
        'monitored-vol',
        'So11111111111111111111111111111111111111112',
        'triggered',
      ]);
      assert.equal(state.userId, 17);
      assert.equal(state.status, 'triggered');
      assert.equal(state.lastAlertedValue, 18000);
      assert.equal(state.lastAlertedPct, 80);
      assert.equal(state.rearmRequired, true);
    } finally {
      db.query = originalQuery;
    }
  });

  it('loads persisted state for a user rule and token', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          user_id: 7,
          rule_key: 'meteora-surge',
          token_address: 'So11111111111111111111111111111111111111112',
          status: 'rearmed',
          last_alerted_at: '2026-04-16T11:05:10.000Z',
          last_alerted_value: '25000',
          last_alerted_pct: '60',
          cooldown_until: null,
          rearm_required: false,
          last_fingerprint: '60|300000|60000',
          metadata: { recovered: true },
          updated_at: '2026-04-16T11:10:00.000Z',
        }],
      };
    };

    try {
      const state = await userAlertRuleState.getState(
        7,
        'meteora-surge',
        'So11111111111111111111111111111111111111112'
      );

      assert.deepEqual(capturedParams, [7, 'meteora-surge', 'So11111111111111111111111111111111111111112']);
      assert.equal(state.status, 'rearmed');
      assert.equal(state.rearmRequired, false);
      assert.equal(state.lastFingerprint, '60|300000|60000');
      assert.deepEqual(state.metadata, { recovered: true });
    } finally {
      db.query = originalQuery;
    }
  });

  it('marks a rule as triggered with default rearm_required=true', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          user_id: 21,
          rule_key: 'hvnc',
          token_address: 'So11111111111111111111111111111111111111112',
          status: 'triggered',
          last_alerted_at: '2026-04-16T12:05:10.000Z',
          last_alerted_value: '350000',
          last_alerted_pct: '0',
          cooldown_until: '2026-04-16T12:10:10.000Z',
          rearm_required: true,
          last_fingerprint: 'hvnc:350000',
          metadata: {},
          updated_at: '2026-04-16T12:05:10.000Z',
        }],
      };
    };

    try {
      const state = await userAlertRuleState.markTriggered({
        userId: 21,
        ruleKey: 'hvnc',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        lastAlertedAt: '2026-04-16T12:05:10.000Z',
        lastAlertedValue: 350000,
        lastAlertedPct: 0,
        cooldownUntil: '2026-04-16T12:10:10.000Z',
        lastFingerprint: 'hvnc:350000',
      });

      assert.equal(capturedParams[3], 'triggered');
      assert.equal(capturedParams[8], true);
      assert.equal(state.status, 'triggered');
      assert.equal(state.rearmRequired, true);
    } finally {
      db.query = originalQuery;
    }
  });

  it('marks a rule as rearmed by preserving the previous alert fields and clearing cooldown', async () => {
    const originalQuery = db.query;
    const queries = [];

    db.query = async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (queries.length === 1) {
        return {
          rows: [{
            user_id: 8,
            rule_key: 'monitored-mcap',
            token_address: 'So11111111111111111111111111111111111111112',
            status: 'triggered',
            last_alerted_at: '2026-04-16T12:05:10.000Z',
            last_alerted_value: '300000',
            last_alerted_pct: '120',
            cooldown_until: '2026-04-16T12:10:10.000Z',
            rearm_required: true,
            last_fingerprint: '120|120000|300000',
            metadata: { previous: true },
            updated_at: '2026-04-16T12:05:10.000Z',
          }],
        };
      }

      return {
        rows: [{
          user_id: 8,
          rule_key: 'monitored-mcap',
          token_address: 'So11111111111111111111111111111111111111112',
          status: 'rearmed',
          last_alerted_at: '2026-04-16T12:05:10.000Z',
          last_alerted_value: '300000',
          last_alerted_pct: '120',
          cooldown_until: null,
          rearm_required: false,
          last_fingerprint: '120|120000|300000',
          metadata: { reason: 'recovered' },
          updated_at: '2026-04-16T12:11:10.000Z',
        }],
      };
    };

    try {
      const state = await userAlertRuleState.markRearmed({
        userId: 8,
        ruleKey: 'monitored-mcap',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        metadata: { reason: 'recovered' },
      });

      assert.equal(queries.length, 2);
      assert.deepEqual(queries[0].params, [8, 'monitored-mcap', 'So11111111111111111111111111111111111111112']);
      assert.equal(queries[1].params[3], 'rearmed');
      assert.equal(queries[1].params[7], null);
      assert.equal(queries[1].params[8], false);
      assert.equal(state.status, 'rearmed');
      assert.equal(state.rearmRequired, false);
      assert.equal(state.cooldownUntil, null);
    } finally {
      db.query = originalQuery;
    }
  });

  it('preserves cooldown on rearm when an explicit cooldownUntil is provided', async () => {
    const originalQuery = db.query;
    const queries = [];

    db.query = async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (queries.length === 1) {
        return {
          rows: [{
            user_id: 9,
            rule_key: 'monitored-vol',
            token_address: 'So11111111111111111111111111111111111111112',
            status: 'triggered',
            last_alerted_at: '2026-04-16T12:05:10.000Z',
            last_alerted_value: '18000',
            last_alerted_pct: '80',
            cooldown_until: '2026-04-16T12:06:10.000Z',
            rearm_required: true,
            last_fingerprint: '80|10000|18000',
            metadata: { previous: true },
            updated_at: '2026-04-16T12:05:10.000Z',
          }],
        };
      }

      return {
        rows: [{
          user_id: 9,
          rule_key: 'monitored-vol',
          token_address: 'So11111111111111111111111111111111111111112',
          status: 'rearmed',
          last_alerted_at: '2026-04-16T12:05:10.000Z',
          last_alerted_value: '18000',
          last_alerted_pct: '80',
          cooldown_until: '2026-04-16T12:06:10.000Z',
          rearm_required: false,
          last_fingerprint: '80|10000|18000',
          metadata: { reason: 'preserve-cooldown' },
          updated_at: '2026-04-16T12:05:30.000Z',
        }],
      };
    };

    try {
      const state = await userAlertRuleState.markRearmed({
        userId: 9,
        ruleKey: 'monitored-vol',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        cooldownUntil: '2026-04-16T12:06:10.000Z',
        metadata: { reason: 'preserve-cooldown' },
      });

      assert.equal(queries.length, 2);
      assert.equal(queries[1].params[7]?.toISOString(), '2026-04-16T12:06:10.000Z');
      assert.equal(state.status, 'rearmed');
      assert.equal(state.cooldownUntil, '2026-04-16T12:06:10.000Z');
    } finally {
      db.query = originalQuery;
    }
  });
});
