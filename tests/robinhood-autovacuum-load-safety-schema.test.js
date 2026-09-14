'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  SETTINGS, STATEMENTS, TABLES, init,
} = require('../src/utils/db-init-stage219');

describe('Robinhood autovacuum load-safety schema', () => {
  it('starts earlier and throttles every high-churn table without enabling it', () => {
    assert.equal(STATEMENTS.length, 8);
    assert.equal(new Set(TABLES).size, TABLES.length);
    assert.ok(TABLES.includes('robinhood_chain_events'));
    assert.ok(TABLES.includes('robinhood_holder_transfer_journal'));
    assert.ok(TABLES.includes('robinhood_token_holder_daily_snapshots'));

    const sql = STATEMENTS.join('\n');
    for (const table of TABLES) assert.match(sql, new RegExp(`ALTER TABLE ${table} SET`));
    for (const [name, value] of Object.entries(SETTINGS)) {
      assert.equal((sql.match(new RegExp(`${name} = ${value}`, 'g')) || []).length, TABLES.length);
    }

    assert.equal(SETTINGS.autovacuum_vacuum_scale_factor, 0.001);
    assert.equal(SETTINGS.autovacuum_vacuum_cost_delay, 10);
    assert.equal(SETTINGS.autovacuum_vacuum_cost_limit, 300);
    assert.doesNotMatch(sql, /autovacuum_enabled/);
  });

  it('applies the settings sequentially and keeps a caller-owned pool open', async () => {
    const calls = [];
    await init({
      database: { query: async (sql) => calls.push(sql) },
      closePool: false,
    });
    assert.deepEqual(calls, STATEMENTS);
  });
});
