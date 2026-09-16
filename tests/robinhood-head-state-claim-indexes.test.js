'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage225 = require('../src/utils/db-init-stage225');
const {
  EXPECTED_INDEX, PLAN_QUERIES, collectIndexNames, verifyPlans,
} = require('../src/utils/verify-robinhood-head-state-claim-plans');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

function plan(...indexes) {
  return { rows: [{ 'QUERY PLAN': [{
    Plan: { Plans: indexes.map((name) => ({ 'Index Name': name })) },
  }] }] };
}

describe('Robinhood narrow head-state claim indexes', () => {
  it('defines resumable concurrent indexes for V4, independent market and discovery', () => {
    const sql = stage225.STATEMENTS.join('\n');
    assert.equal(stage225.INDEX_NAMES.length, 3);
    assert.equal((sql.match(/CREATE INDEX CONCURRENTLY/g) || []).length, 3);
    assert.match(sql, /market_key, block_number, transaction_index, log_index/);
    assert.match(sql, /processing_status IN \('pending', 'leased', 'blocked'\)/);
    assert.match(sql, /protocol IS DISTINCT FROM 'uniswap-v4'/);
    assert.match(sql, /stream = 'discovery'/);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage225-robinhood-head-state-claim-indexes'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage225.js');
    assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), stage225.INDEX_NAMES);
  });

  it('removes an interrupted index and validates all indexes', async () => {
    const calls = [];
    const database = { async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT indisvalid')) {
        return { rows: [{ indisvalid: params[0] !== stage225.INDEX_NAMES[1] }] };
      }
      if (sql.includes('ANY($1::regclass[])')) {
        return { rows: stage225.INDEX_NAMES.map((index_name) => ({
          index_name, indisvalid: true, indisready: true,
        })) };
      }
      return { rows: [] };
    } };
    await stage225.init({ database, closePool: false });
    assert.equal(calls.filter(({ sql }) => sql.startsWith('DROP INDEX CONCURRENTLY')).length, 1);
    assert.equal(calls.filter(({ sql }) => sql.startsWith('CREATE INDEX CONCURRENTLY')).length, 3);
  });

  it('accepts only plans containing each expected narrow-state index', async () => {
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
    assert.equal(Object.keys(report.plans).length, 3);
  });

  it('fails the proof when the planner chooses a legacy or sequential path', async () => {
    const database = {
      pool: { end: async () => {} },
      async query() { return plan('idx_rh_head_captures_v4_active_frontier'); },
    };
    const report = await verifyPlans({ database, closePool: false });
    assert.equal(report.safe, false);
    assert.equal(Object.values(report.plans).every(({ safe }) => !safe), true);
    assert.deepEqual(
      collectIndexNames(plan('one', 'two').rows[0]['QUERY PLAN']), ['one', 'two']
    );
  });
});
