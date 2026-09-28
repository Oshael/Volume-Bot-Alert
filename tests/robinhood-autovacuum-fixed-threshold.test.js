'use strict';

const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage255 = require('../src/utils/db-init-stage255');

it('sets a fixed 350k dead-tuple threshold on only the three derived tables', () => {
  assert.deepEqual(stage255.TABLES, [
    'robinhood_market_buckets_agg',
    'robinhood_holder_realtime_outbox',
    'robinhood_liquidity_realtime_outbox',
  ]);
  assert.equal(stage255.STATEMENTS.length, stage255.TABLES.length);
  for (const [index, table] of stage255.TABLES.entries()) {
    const sql = stage255.STATEMENTS[index];
    assert.match(sql, new RegExp(`^ALTER TABLE public\\.${table} SET`));
    assert.match(sql, /autovacuum_vacuum_threshold = 350000/);
    assert.match(sql, /autovacuum_vacuum_scale_factor = 0/);
    assert.doesNotMatch(sql, /autovacuum_enabled/);
  }
});

it('applies the table settings in one bounded transaction', async () => {
  const calls = [];
  let released = false;
  await stage255.init({
    database: { getClient: async () => ({
      query: async (sql) => { calls.push(sql); },
      release: () => { released = true; },
    }) },
    closePool: false,
  });
  assert.deepEqual(calls, [
    'BEGIN', "SET LOCAL lock_timeout = '5s'", ...stage255.STATEMENTS, 'COMMIT',
  ]);
  assert.equal(released, true);
});

it('rolls back all settings if one table cannot be changed', async () => {
  const calls = [];
  const conflict = new Error('lock timeout');
  await assert.rejects(stage255.init({
    database: { getClient: async () => ({
      query: async (sql) => {
        calls.push(sql);
        if (sql === stage255.STATEMENTS[1]) throw conflict;
      },
      release: () => {},
    }) },
    closePool: false,
  }), conflict);
  assert.deepEqual(calls, [
    'BEGIN', "SET LOCAL lock_timeout = '5s'",
    stage255.STATEMENTS[0], stage255.STATEMENTS[1], 'ROLLBACK',
  ]);
});
