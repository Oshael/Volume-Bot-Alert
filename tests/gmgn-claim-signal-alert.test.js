const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const claimAlert = require('../src/services/gmgn-claim-signal-alert');

const TOKEN_A = 'So11111111111111111111111111111111111111112';

function createRunner() {
  const state = new Map();
  const events = new Map();
  return {
    async query(sql, params = []) {
      const text = String(sql);
      if (text.includes('INSERT INTO gmgn_claim_alert_state')) {
        const key = `${params[0]}:${params[1]}`;
        if (!state.has(key)) {
          state.set(key, {
            rule_key: params[0],
            token_address: params[1],
            alert_count: 0,
            last_claim_id: null,
            last_claimed_at: null,
            metadata: params[2] ? { baselineCompleted: true } : {},
            updated_at: '2026-06-01T00:00:00.000Z',
          });
        }
        return { rows: [] };
      }

      if (text.includes('FROM gmgn_claim_alert_state') && text.includes('FOR UPDATE')) {
        return { rows: [state.get(`${params[0]}:${params[1]}`)] };
      }

      if (text.includes('INSERT INTO gmgn_claim_alert_events')) {
        const eventKey = `${params[0]}:${params[5]}`;
        if (events.has(eventKey)) {
          return { rows: [] };
        }
        const row = {
          id: events.size + 1,
          rule_key: params[0],
          token_address: params[1],
          signal_type: params[2],
          source: params[3],
          claim_sequence: params[4],
          claim_id: params[5],
          total_fee_usd: params[6],
          claimed_at: params[7],
          payload: JSON.parse(params[8]),
          is_baseline: params[9],
          triggered_at: '2026-06-01T00:00:00.000Z',
          created_at: '2026-06-01T00:00:00.000Z',
        };
        events.set(eventKey, row);
        return { rows: [row] };
      }

      if (text.includes('UPDATE gmgn_claim_alert_state')) {
        const key = `${params[0]}:${params[1]}`;
        const current = state.get(key);
        const next = {
          ...current,
          alert_count: params[2],
          last_claim_id: params[3],
          last_claimed_at: params[4],
          metadata: { lastTotalFeeUsd: params[5] },
        };
        state.set(key, next);
        return { rows: [next] };
      }

      if (text.includes('SELECT EXISTS') && text.includes('FROM gmgn_claim_alert_state')) {
        return { rows: [{ exists: state.has(`${params[0]}:${params[1]}`) }] };
      }

      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

describe('gmgn claim signal alert', () => {
  it('records only the first two claim alerts for a token', async () => {
    const runner = createRunner();
    const published = [];
    const publisher = {
      publishEventSafe: async (event) => {
        published.push(event);
        return { delivered: true };
      },
    };

    const first = await claimAlert.recordClaimSignal({
      tokenAddress: TOKEN_A,
      signalType: 18,
      claimId: 'claim-1',
      totalFeeUsd: 1,
    }, { maxAlertsPerToken: 2 }, { client: runner, publisher });
    const second = await claimAlert.recordClaimSignal({
      tokenAddress: TOKEN_A,
      signalType: 18,
      claimId: 'claim-2',
      totalFeeUsd: 2,
    }, { maxAlertsPerToken: 2 }, { client: runner, publisher });
    const third = await claimAlert.recordClaimSignal({
      tokenAddress: TOKEN_A,
      signalType: 18,
      claimId: 'claim-3',
      totalFeeUsd: 3,
    }, { maxAlertsPerToken: 2 }, { client: runner, publisher });

    assert.equal(first.action, 'triggered');
    assert.equal(second.action, 'triggered');
    assert.equal(third.action, 'suppressed');
    assert.equal(third.reason, 'max-alerts-per-token');
    assert.equal(published.length, 2);
    assert.equal(second.event.claimSequence, 2);
  });

  it('baselines existing claims without publishing alerts', async () => {
    const runner = createRunner();
    const published = [];
    const publisher = {
      publishEventSafe: async (event) => {
        published.push(event);
        return { delivered: true };
      },
    };

    assert.equal(await claimAlert.hasBaselineCompleted({}, runner), false);

    const result = await claimAlert.recordClaimSignalBaseline({
      tokenAddress: TOKEN_A,
      signalType: 18,
      claimId: 'backlog-1',
      totalFeeUsd: 1,
    }, { maxAlertsPerToken: 2 }, { client: runner, publisher });

    assert.equal(result.action, 'baselined');
    assert.equal(result.event.isBaseline, true);
    assert.equal(result.event.claimSequence, 1);
    assert.equal(published.length, 0);
    assert.equal(await claimAlert.hasBaselineCompleted({}, runner), false);

    await claimAlert.markBaselineCompleted({}, runner);

    assert.equal(await claimAlert.hasBaselineCompleted({}, runner), true);
  });
});
