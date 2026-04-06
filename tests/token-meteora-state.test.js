const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/models/db');
const tokenMeteoraState = require('../src/models/token-meteora-state');

describe('token meteora state model', () => {
  it('upserts current Meteora state with explicit no-pool checks', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          token_address: 'So11111111111111111111111111111111111111112',
          last_checked_at: '2026-04-05T21:00:00.000Z',
          has_pool: false,
          current_tvl: null,
          best_pool_address: null,
          pool_count: 0,
          last_error: null,
          source: 'meteora',
          updated_at: '2026-04-05T21:00:00.000Z',
        }],
      };
    };

    try {
      const state = await tokenMeteoraState.upsertState({
        tokenAddress: 'So11111111111111111111111111111111111111112',
        lastCheckedAt: '2026-04-05T21:00:00.000Z',
        hasPool: false,
        currentTvl: null,
        bestPoolAddress: null,
        poolCount: 0,
        lastError: null,
      });

      assert.equal(capturedParams[0], 'So11111111111111111111111111111111111111112');
      assert.equal(capturedParams[2], false);
      assert.equal(state.hasPool, false);
      assert.equal(state.currentTvl, null);
      assert.equal(state.poolCount, 0);
    } finally {
      db.query = originalQuery;
    }
  });

  it('records Meteora fetch errors without requiring a successful check timestamp', async () => {
    const originalQuery = db.query;
    let capturedParams = null;

    db.query = async (_sql, params) => {
      capturedParams = params;
      return {
        rows: [{
          token_address: '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
          last_checked_at: null,
          has_pool: null,
          current_tvl: null,
          best_pool_address: null,
          pool_count: 0,
          last_error: 'HTTP 503',
          source: 'meteora',
          updated_at: '2026-04-05T21:01:00.000Z',
        }],
      };
    };

    try {
      const state = await tokenMeteoraState.recordError(
        '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
        'HTTP 503'
      );

      assert.deepEqual(capturedParams, [
        '34q2KmCvapecJgR6ZrtbCTrzZVtkt3a5mHEA3TuEsWYb',
        'HTTP 503',
      ]);
      assert.equal(state.lastCheckedAt, null);
      assert.equal(state.hasPool, null);
      assert.equal(state.lastError, 'HTTP 503');
    } finally {
      db.query = originalQuery;
    }
  });

  it('lists dashboard summaries from current Meteora state instead of historical snapshots alone', async () => {
    const originalQuery = db.query;
    let capturedSql = null;
    let capturedParams = null;

    db.query = async (sql, params) => {
      capturedSql = sql;
      capturedParams = params;
      return {
        rows: [{
          token_address: 'So11111111111111111111111111111111111111112',
          last_checked_at: '2026-04-05T21:05:00.000Z',
          has_pool: true,
          current_tvl: '82000',
          best_pool_address: 'pool_test_123',
          pool_count: 2,
          last_error: null,
          source: 'meteora',
          updated_at: '2026-04-05T21:05:00.000Z',
          last_snapshot_at: '2026-04-05T21:05:00.000Z',
          baseline_tvl_1h: '40000',
          baseline_tvl_6h: '20000',
          baseline_tvl_24h: '10000',
        }],
      };
    };

    try {
      const rows = await tokenMeteoraState.listSummaryByAddresses([
        'So11111111111111111111111111111111111111112',
      ]);

      assert.deepEqual(capturedParams, [['So11111111111111111111111111111111111111112']]);
      assert.match(capturedSql, /FROM token_meteora_state/i);
      assert.match(capturedSql, /latest_snapshot/i);
      assert.equal(rows[0].hasPool, true);
      assert.equal(rows[0].currentTvl, 82000);
      assert.equal(rows[0].baselineTvl24h, 10000);
    } finally {
      db.query = originalQuery;
    }
  });
});
