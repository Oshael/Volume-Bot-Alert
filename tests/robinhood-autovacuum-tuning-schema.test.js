'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  SETTINGS, STATEMENTS, TABLES, init,
} = require('../src/utils/db-init-stage202');

describe('high-churn autovacuum tuning schema', () => {
  it('applies bounded vacuum, insert, analyze, freeze and cost settings to every table', () => {
    assert.equal(STATEMENTS.length, 6);
    assert.equal(new Set(TABLES).size, TABLES.length);
    const sql = STATEMENTS.join('\n');
    for (const table of TABLES) assert.match(sql, new RegExp(`ALTER TABLE ${table} SET`));
    for (const [name, value] of Object.entries(SETTINGS)) {
      assert.equal((sql.match(new RegExp(`${name} = ${value}`, 'g')) || []).length, TABLES.length);
    }
    assert.equal(SETTINGS.autovacuum_vacuum_scale_factor, 0.005);
    assert.equal(SETTINGS.autovacuum_freeze_max_age, 150000000);
    assert.equal(SETTINGS.autovacuum_vacuum_cost_delay, 2);
  });

  it('is sequential and keeps the caller-owned pool open', async () => {
    const calls = [];
    await init({
      database: { query: async (sql) => calls.push(sql) },
      closePool: false,
    });
    assert.deepEqual(calls, STATEMENTS);
  });
});
