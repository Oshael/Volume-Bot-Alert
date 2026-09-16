'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage226 = require('../src/utils/db-init-stage226');
const {
  EXPECTED_INDEX, PLAN_QUERIES, verifyPlans,
} = require('../src/utils/verify-robinhood-head-state-auxiliary-plans');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

function plan(...indexes) {
  return { rows: [{ 'QUERY PLAN': [{
    Plan: { Plans: indexes.map((name) => ({ 'Index Name': name })) },
  }] }] };
}

describe('Robinhood narrow head-state auxiliary indexes', () => {
  it('defines resumable concurrent indexes for active lifecycle and recovery', () => {
    const sql = stage226.STATEMENTS.join('\n');
    assert.equal(stage226.INDEX_NAMES.length, 2);
    assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 2);
    assert.match(sql, /stream, processing_status, block_number/);
    assert.match(sql, /processing_status IN \('pending', 'leased', 'blocked'\)/);
    assert.match(sql, /processing_status = 'blocked'/);
    assert.match(sql, /V4 liquidity range update conflicted or became negative/);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage226-robinhood-head-state-auxiliary-indexes'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage226.js');
    assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), stage226.INDEX_NAMES);
  });

  it('removes an interrupted index and validates both indexes', async () => {
    const calls = [];
    const database = { async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT indisvalid')) {
        return { rows: [{ indisvalid: params[0] !== stage226.INDEX_NAMES[1] }] };
      }
      if (sql.includes('ANY($1::regclass[])')) {
        return { rows: stage226.INDEX_NAMES.map((index_name) => ({
          index_name, indisvalid: true, indisready: true,
        })) };
      }
      return { rows: [] };
    } };
    await stage226.init({ database, closePool: false });
    assert.equal(calls.filter(({ sql }) => sql.startsWith('DROP INDEX CONCURRENTLY')).length, 1);
    assert.equal(calls.filter(({ sql }) => sql.startsWith('CREATE INDEX CONCURRENTLY')).length, 2);
  });

  it('accepts only plans containing each expected auxiliary index', async () => {
    const names = Object.keys(PLAN_QUERIES);
    let call = 0;
    const database = {
      pool: { end: async () => {} },
      async query(sql) {
        assert.match(sql, /^EXPLAIN \(FORMAT JSON\)/);
        return plan(EXPECTED_INDEX[names[call++]]);
      },
    };
    const report = await verifyPlans({ database, closePool: false });
    assert.equal(report.safe, true);
    assert.equal(Object.keys(report.plans).length, 4);
  });

  it('fails closed when any auxiliary plan misses its expected index', async () => {
    const database = {
      pool: { end: async () => {} },
      async query() { return plan('legacy_or_sequential_path'); },
    };
    const report = await verifyPlans({ database, closePool: false });
    assert.equal(report.safe, false);
    assert.equal(Object.values(report.plans).every(({ safe }) => !safe), true);
  });
});
