const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodBackfillWatchdog,
} = require('../src/services/robinhood-backfill-watchdog');

describe('Robinhood backfill watchdog', () => {
  it('cancels only stale client backends matching the finalizer query signature', async () => {
    const calls = [];
    const warnings = [];
    const watchdog = createRobinhoodBackfillWatchdog({
      database: {
        async query(sql, params) {
          calls.push({ sql: String(sql), params });
          return {
            rows: [
              { pid: 321, age_ms: '45123', cancelled: true },
              { pid: 654, age_ms: '43999', cancelled: false },
            ],
          };
        },
      },
      logger: { warn: (message) => warnings.push(message) },
      now: () => Date.parse('2026-07-29T18:00:00Z'),
    });

    const result = await watchdog.runOnce({ staleQueryThresholdMs: 20_000 });

    assert.deepEqual(calls[0].params, [20_000]);
    assert.match(calls[0].sql, /datname = current_database\(\)/);
    assert.match(calls[0].sql, /usename = current_user/);
    assert.match(calls[0].sql, /backend_type = 'client backend'/);
    assert.match(
      calls[0].sql,
      /query ~ '\^\[\[:space:\]\]\*WITH candidate_ranges AS MATERIALIZED'/
    );
    assert.match(calls[0].sql, /COUNT\(staging\.transaction_hash\)/);
    assert.match(calls[0].sql, /pg_cancel_backend\(pid\)/);
    assert.deepEqual(result, {
      status: 'cancelled',
      checkedAt: '2026-07-29T18:00:00.000Z',
      staleQueryThresholdMs: 20_000,
      staleQueries: [
        { pid: 321, ageMs: 45_123, cancelled: true },
        { pid: 654, ageMs: 43_999, cancelled: false },
      ],
      cancelledPids: [321],
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /queries=2 cancelled=1 pids=321/);
  });

  it('reports healthy when no matching finalizer is stale', async () => {
    const watchdog = createRobinhoodBackfillWatchdog({
      database: {
        query: async () => ({ rows: [] }),
      },
      logger: {
        warn() {
          throw new Error('healthy checks must not warn');
        },
      },
      now: () => 0,
    });

    const result = await watchdog.runOnce();

    assert.equal(result.status, 'healthy');
    assert.equal(result.staleQueryThresholdMs, 20_000);
    assert.deepEqual(result.staleQueries, []);
    assert.deepEqual(result.cancelledPids, []);
  });
});
