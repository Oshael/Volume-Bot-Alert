'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage222 = require('../src/utils/db-init-stage222');
const v2 = require('../src/services/uniswap-v2-decoder');
const v3 = require('../src/services/uniswap-v3-decoder');
const v4 = require('../src/services/uniswap-v4-decoder');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood stock/USD journal lookup indexes', () => {
  it('defines protocol-specific concurrent tail indexes and registers them', () => {
    const sql = stage222.STATEMENTS.join('\n');
    assert.match(sql, /CREATE INDEX CONCURRENTLY/);
    assert.match(sql, new RegExp(v2.TOPICS.sync));
    assert.match(sql, new RegExp(v3.TOPICS.swap));
    assert.match(sql, new RegExp(v4.TOPICS.swap));
    assert.match(sql, /topics ->> 1/);
    assert.deepEqual(stage222.INDEX_NAMES, [
      'idx_rh_chain_events_v2_v3_pool_tail',
      'idx_rh_chain_events_v4_pool_tail',
    ]);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage222-robinhood-stock-usd-journal-indexes'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage222.js');
    assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), stage222.INDEX_NAMES);
  });

  it('repairs invalid indexes and verifies each index before continuing', async () => {
    const calls = [];
    const inspections = new Map();
    await stage222.init({
      database: { query: async (statement, params = []) => {
        calls.push({ statement, params });
        if (!statement.startsWith('SELECT indisvalid')) return { rows: [] };
        const count = (inspections.get(params[0]) || 0) + 1;
        inspections.set(params[0], count);
        return count === 1
          ? { rows: [{ indisvalid: false, indisready: false }] }
          : { rows: [{ indisvalid: true, indisready: true }] };
      } },
      closePool: false,
    });
    for (const definition of stage222.INDEX_DEFINITIONS) {
      assert.ok(calls.some(({ statement }) => (
        statement === `DROP INDEX CONCURRENTLY IF EXISTS ${definition.name}`
      )));
      assert.ok(calls.some(({ statement }) => statement === definition.statement));
    }
  });
});
