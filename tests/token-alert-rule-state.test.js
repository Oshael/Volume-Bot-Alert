const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenAlertRuleState = require('../src/models/token-alert-rule-state');

describe('token alert rule state model', () => {
  it('upserts rule state with normalized payload', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          rule_key: 'high-cap-dump-5m',
          token_address: 'So11111111111111111111111111111111111111112',
          status: 'triggered',
          last_baseline_ts: '2026-04-05T12:00:00.000Z',
          last_baseline_mcap: '8000000',
          last_window_low_mcap: '3200000',
          last_current_ts: '2026-04-05T12:05:00.000Z',
          last_current_close_mcap: '4200000',
          last_alerted_at: '2026-04-05T12:05:10.000Z',
          last_alerted_pct: '-60',
          rearm_required: true,
          metadata: { source: 'manual-test' },
          updated_at: '2026-04-05T12:05:10.000Z',
        }],
      };
    };

    try {
      const state = await tokenAlertRuleState.upsertState({
        ruleKey: 'HIGH-CAP-DUMP-5M',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        status: 'triggered',
        lastBaselineTs: '2026-04-05T12:00:00.000Z',
        lastBaselineMcap: 8000000,
        lastWindowLowMcap: 3200000,
        lastCurrentTs: '2026-04-05T12:05:00.000Z',
        lastCurrentCloseMcap: 4200000,
        lastAlertedAt: '2026-04-05T12:05:10.000Z',
        lastAlertedPct: -60,
        rearmRequired: true,
        metadata: { source: 'manual-test' },
      });

      assert.equal(capturedParams[0], 'high-cap-dump-5m');
      assert.equal(state.status, 'triggered');
      assert.equal(state.rearmRequired, true);
      assert.equal(state.lastAlertedPct, -60);
    } finally {
      db.query = originalQuery;
    }
  });

  it('loads persisted state for a rule and token', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          rule_key: 'high-cap-dump-5m',
          token_address: 'So11111111111111111111111111111111111111112',
          status: 'rearmed',
          last_baseline_ts: '2026-04-05T12:00:00.000Z',
          last_baseline_mcap: '7000000',
          last_window_low_mcap: '3000000',
          last_current_ts: '2026-04-05T12:05:00.000Z',
          last_current_close_mcap: '6900000',
          last_alerted_at: '2026-04-05T12:05:10.000Z',
          last_alerted_pct: '-57.14',
          rearm_required: false,
          metadata: { recovered: true },
          updated_at: '2026-04-05T12:10:00.000Z',
        }],
      };
    };

    try {
      const state = await tokenAlertRuleState.getState(
        'high-cap-dump-5m',
        'So11111111111111111111111111111111111111112'
      );

      assert.deepEqual(capturedParams, ['high-cap-dump-5m', 'So11111111111111111111111111111111111111112']);
      assert.equal(state.status, 'rearmed');
      assert.equal(state.rearmRequired, false);
      assert.deepEqual(state.metadata, { recovered: true });
    } finally {
      db.query = originalQuery;
    }
  });
});
