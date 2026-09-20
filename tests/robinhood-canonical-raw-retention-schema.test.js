'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  INDEXES, STATEMENTS, init,
} = require('../src/utils/db-init-stage240');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

function databaseHarness(initial = {}) {
  const states = new Map(Object.entries(initial));
  const calls = [];
  return {
    calls,
    database: {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.startsWith('SELECT indisvalid')) {
          const state = states.get(params[0]);
          return { rows: state ? [{ ...state }] : [] };
        }
        if (sql.startsWith('DROP INDEX CONCURRENTLY')) {
          states.delete(sql.trim().split(' ').at(-1));
          return { rows: [] };
        }
        if (sql.startsWith('CREATE INDEX CONCURRENTLY')) {
          const index = INDEXES.find(({ statement }) => statement === sql);
          states.set(index.name, { indisvalid: true, indisready: true });
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    },
  };
}

describe('Robinhood canonical raw retention schema', () => {
  it('creates the concurrent indexes required by ordered parent pruning', () => {
    const sql = STATEMENTS.join('\n');
    assert.equal(STATEMENTS.length, 1);
    assert.match(sql,
      /robinhood_chain_blocks \(chain, block_number, block_hash\)/);
    assert.match(sql, /INCLUDE \(block_timestamp\)/);
  });

  it('repairs an interrupted invalid index', async () => {
    const invalidName = INDEXES[0].name;
    const context = databaseHarness({
      [invalidName]: { indisvalid: false, indisready: true },
    });
    await init({ database: context.database, closePool: false });
    const sql = context.calls.map((call) => call.sql);
    assert.ok(sql.includes(`DROP INDEX CONCURRENTLY IF EXISTS ${invalidName}`));
    assert.equal(sql.filter((statement) => statement.startsWith('CREATE INDEX')).length, 1);
  });

  it('registers the block retention index in the runtime schema guard', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage240-robinhood-canonical-raw-retention-indexes'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage240.js');
    assert.deepEqual(group.tables.map(({ indexes }) => indexes[0].name), [
      'idx_rh_chain_blocks_retention',
    ]);
  });
});
