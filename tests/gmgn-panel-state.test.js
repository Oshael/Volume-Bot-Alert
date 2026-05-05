const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const gmgnPanelState = require('../src/models/token-gmgn-panel-state');
const gmgnPanelStateManager = require('../src/services/gmgn-panel-state-manager');

const TOKEN_A = 'So11111111111111111111111111111111111111112';
const TOKEN_B = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';

function createRunner() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [] };
    },
  };
}

describe('gmgn panel state model', () => {
  it('marks a token as active and clears previous Dex handoff state', async () => {
    const runner = createRunner();
    runner.query = async (sql, params) => {
      runner.calls.push({ sql: String(sql), params });
      return {
        rows: [{
          token_address: params[0],
          first_seen_at: params[1],
          last_seen_at: params[1],
          last_interval: params[2],
          last_rank: params[3],
          last_mcap: params[4],
          last_vol_1m: params[5],
          last_vol_5m: params[6],
          last_payload: JSON.parse(params[7]),
          status: 'active',
          dex_handoff_at: null,
          updated_at: '2026-05-03T07:00:00.000Z',
        }],
      };
    };

    const row = await gmgnPanelState.markTokenSeen({
      address: TOKEN_A,
      gmgnInterval: '5m',
      gmgnRank: 2,
      mcap: '12345.67',
      vol5m: '8900',
      raw: { address: TOKEN_A, volume: '8900' },
    }, { seenAt: '2026-05-03T07:00:00.000Z' }, runner);

    assert.equal(row.tokenAddress, TOKEN_A);
    assert.equal(row.status, 'active');
    assert.equal(row.dexHandoffAt, null);
    assert.equal(row.lastInterval, '5m');
    assert.equal(row.lastRank, 2);
    assert.equal(row.lastMcap, 12345.67);
    assert.equal(row.lastVol5m, 8900);
    assert.match(runner.calls[0].sql, /status = 'active'/);
    assert.match(runner.calls[0].sql, /dex_handoff_at = NULL/);
  });

  it('marks active tokens missing from the current panel as stale', async () => {
    const runner = createRunner();
    runner.query = async (sql, params) => {
      runner.calls.push({ sql: String(sql), params });
      return {
        rows: [{
          token_address: TOKEN_B,
          first_seen_at: '2026-05-03T06:59:00.000Z',
          last_seen_at: '2026-05-03T06:59:30.000Z',
          status: 'stale',
          dex_handoff_at: '2026-05-03T07:00:00.000Z',
          last_payload: {},
        }],
      };
    };

    const rows = await gmgnPanelState.markMissingActiveTokensStale(
      [TOKEN_A],
      { staleBefore: '2026-05-03T06:59:45.000Z' },
      runner
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].tokenAddress, TOKEN_B);
    assert.equal(rows[0].status, 'stale');
    assert.equal(runner.calls[0].params[0].toISOString(), '2026-05-03T06:59:45.000Z');
    assert.deepEqual(runner.calls[0].params[1], [TOKEN_A]);
    assert.match(runner.calls[0].sql, /token_address <> ALL/);
  });
});

describe('gmgn panel state manager', () => {
  it('marks seen tokens and schedules Dex evaluation for stale transitions', async () => {
    const scheduled = [];
    const panelStateModel = {
      async markTokensSeen(tokens, options) {
        assert.equal(tokens.length, 1);
        assert.equal(options.seenAt.toISOString(), '2026-05-03T07:00:00.000Z');
        return [{ tokenAddress: TOKEN_A, status: 'active' }];
      },
      async markMissingActiveTokensStale(seenAddresses, options) {
        assert.deepEqual(seenAddresses, [TOKEN_A]);
        assert.equal(options.staleBefore.toISOString(), '2026-05-03T06:59:45.000Z');
        return [{ tokenAddress: TOKEN_B, status: 'stale' }];
      },
    };
    const tokenCatalogModel = {
      async scheduleImmediateEvaluation(address) {
        scheduled.push(address);
        return { address };
      },
    };

    const result = await gmgnPanelStateManager.applyPanelCycle(
      [{ address: TOKEN_A }],
      {
        staleAfterMs: 15000,
        now: () => new Date('2026-05-03T07:00:00.000Z'),
        panelStateModel,
        tokenCatalogModel,
      }
    );

    assert.equal(result.seenCount, 1);
    assert.equal(result.staleCount, 1);
    assert.equal(result.handoffCount, 1);
    assert.deepEqual(scheduled, [TOKEN_B]);
  });

  it('reports handoff scheduling errors without failing the whole cycle', async () => {
    const result = await gmgnPanelStateManager.applyPanelCycle(
      [],
      {
        now: () => new Date('2026-05-03T07:00:00.000Z'),
        panelStateModel: {
          async markTokensSeen() { return []; },
          async markMissingActiveTokensStale() {
            return [{ tokenAddress: TOKEN_B, status: 'stale' }];
          },
        },
        tokenCatalogModel: {
          async scheduleImmediateEvaluation() {
            throw new Error('catalog unavailable');
          },
        },
      }
    );

    assert.equal(result.handoffCount, 0);
    assert.equal(result.handoffs.length, 1);
    assert.equal(result.handoffs[0].scheduled, false);
    assert.equal(result.handoffs[0].error, 'catalog unavailable');
  });
});
