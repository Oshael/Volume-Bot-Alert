'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage224 = require('../src/utils/db-init-stage224');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood head capture shadow state schema', () => {
  it('defines a narrow lifecycle table with a transactional compatibility mirror', () => {
    assert.match(stage224.TABLE_STATEMENT, /CREATE TABLE IF NOT EXISTS robinhood_head_capture_states/);
    assert.doesNotMatch(stage224.TABLE_STATEMENT, /\b(evidence|topics|data|market_key)\b/);
    assert.match(stage224.TABLE_STATEMENT, /REFERENCES robinhood_head_captures/);
    assert.match(stage224.TABLE_STATEMENT, /ON DELETE CASCADE/);
    assert.match(stage224.FUNCTION_STATEMENT, /ON CONFLICT \(chain, transaction_hash, log_index\)/);
    assert.match(stage224.TRIGGER_STATEMENT, /AFTER INSERT OR UPDATE OF processing_status/);
    assert.match(stage224.TRIGGER_STATEMENT, /FOR EACH ROW/);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage224-robinhood-head-capture-state'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage224.js');
    assert.equal(group.tables[0].table, stage224.TABLE_NAME);
    assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), stage224.INDEX_NAMES);
  });

  it('applies the table, mirror and indexes in dependency order', async () => {
    const calls = [];
    const database = {
      pool: { end: async () => {} },
      query: async (sql) => { calls.push(sql); return { rows: [] }; },
    };

    await stage224.init({ database, closePool: false });

    assert.deepEqual(calls, stage224.STATEMENTS);
    assert.equal(calls[0], stage224.TABLE_STATEMENT);
    assert.equal(calls[2], stage224.FUNCTION_STATEMENT);
    assert.equal(calls[3], stage224.TRIGGER_STATEMENT);
  });
});
