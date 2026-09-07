'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  INDEXES, STATEMENTS, init,
} = require('../src/utils/db-init-stage201');
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

describe('Robinhood chain event retention schema', () => {
  it('creates compact concurrent indexes for both unindexed cascade children', () => {
    const sql = STATEMENTS.join('\n');
    assert.equal(STATEMENTS.length, 2);
    assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    assert.match(sql, /robinhood_chain_domain_outbox \(block_hash, log_index\)/);
    assert.match(sql, /robinhood_canonical_head_candidates \(block_hash, log_index\)/);
    assert.doesNotMatch(sql, /ON robinhood_chain_domain_outbox \(chain,/);
  });

  it('removes an interrupted invalid index before rebuilding it', async () => {
    const invalidName = INDEXES[0].name;
    const context = databaseHarness({
      [invalidName]: { indisvalid: false, indisready: true },
    });
    await init({ database: context.database, closePool: false });
    const sql = context.calls.map((call) => call.sql);
    assert.ok(sql.includes(`DROP INDEX CONCURRENTLY IF EXISTS ${invalidName}`));
    assert.equal(sql.filter((statement) => statement.startsWith('CREATE INDEX')).length, 2);
  });

  it('registers both indexes in the runtime schema guard', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage201-robinhood-chain-event-cascade-indexes'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage201.js');
    assert.deepEqual(group.tables.map(({ indexes }) => indexes[0].name), [
      'idx_rh_chain_domain_outbox_event_lookup',
      'idx_rh_canonical_head_candidates_event_lookup',
    ]);
  });
});
