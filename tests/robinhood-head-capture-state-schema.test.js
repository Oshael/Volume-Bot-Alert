'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage224 = require('../src/utils/db-init-stage224');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood head capture shadow state schema', () => {
  it('defines a narrow lifecycle table with a transactional compatibility mirror', () => {
    assert.match(stage224.TABLE_STATEMENT, /CREATE TABLE IF NOT EXISTS robinhood_head_capture_states/);
    assert.doesNotMatch(stage224.TABLE_STATEMENT, /\b(evidence|topics|data)\b/);
    assert.match(stage224.ROUTING_COLUMNS_STATEMENT, /ADD COLUMN IF NOT EXISTS market_key/);
    assert.match(stage224.TABLE_STATEMENT, /REFERENCES robinhood_head_captures/);
    assert.match(stage224.TABLE_STATEMENT, /ON DELETE CASCADE/);
    assert.match(stage224.FUNCTION_STATEMENT, /ON CONFLICT \(chain, transaction_hash, log_index\)/);
    assert.match(stage224.FUNCTION_STATEMENT, /market_key = EXCLUDED.market_key/);
    assert.match(stage224.TRIGGER_STATEMENT, /AFTER INSERT OR UPDATE OF processing_status/);
    assert.match(stage224.TRIGGER_STATEMENT, /FOR EACH ROW/);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage224-robinhood-head-capture-state'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage224.js');
    assert.equal(group.tables[0].table, stage224.TABLE_NAME);
    for (const column of ['stream', 'protocol', 'market_key', 'block_number', 'transaction_index']) {
      assert.ok(group.tables[0].columns.includes(column));
    }
    assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), stage224.INDEX_NAMES);
  });

  it('applies the table, mirror and indexes in dependency order', async () => {
    const calls = [];
    const database = {
      pool: { end: async () => {} },
      query: async (sql) => { calls.push(sql); return { rows: [] }; },
      getClient: async () => ({
        query: async (sql) => { calls.push(sql); return { rows: [] }; },
        release: () => {},
      }),
    };

    await stage224.init({ database, closePool: false });

    assert.deepEqual(calls, [
      'BEGIN', "SET LOCAL lock_timeout = '1s'",
      ...stage224.STATEMENTS.slice(0, -stage224.INDEX_NAMES.length),
      'COMMIT', ...stage224.STATEMENTS.slice(-stage224.INDEX_NAMES.length),
    ]);
    assert.equal(calls[2], stage224.TABLE_STATEMENT);
    assert.equal(calls[3], stage224.ROUTING_COLUMNS_STATEMENT);
    assert.equal(calls[5], stage224.FUNCTION_STATEMENT);
    assert.equal(calls[6], stage224.TRIGGER_STATEMENT);
  });

  it('rolls back a lock timeout before replacing the trigger or building indexes', async () => {
    const calls = [];
    let released = false;
    const database = {
      pool: { end: async () => {} },
      query: async () => { throw new Error('index build must not start'); },
      getClient: async () => ({
        query: async (sql) => {
          calls.push(sql);
          if (sql === stage224.ROUTING_COLUMNS_STATEMENT) {
            throw new Error('canceling statement due to lock timeout');
          }
        },
        release: () => { released = true; },
      }),
    };

    await assert.rejects(
      stage224.init({ database, closePool: false }),
      /lock timeout/
    );
    assert.deepEqual(calls, [
      'BEGIN', "SET LOCAL lock_timeout = '1s'",
      stage224.TABLE_STATEMENT, stage224.ROUTING_COLUMNS_STATEMENT,
      'ROLLBACK',
    ]);
    assert.equal(released, true);
  });
});
