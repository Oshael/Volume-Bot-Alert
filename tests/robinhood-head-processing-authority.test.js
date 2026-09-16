'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const stage228 = require('../src/utils/db-init-stage228');
const {
  REQUIRED_STATE_INDEXES, selectHeadProcessingRepository,
} = require('../src/models/robinhood-head-processing-authority');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

function databaseWith(rows) {
  let call = 0;
  return { query: async () => ({ rows: rows[call++] }) };
}

describe('Robinhood head processing authority', () => {
  it('installs an inert legacy authority with guarded state activation', () => {
    const sql = stage228.STATEMENTS.join('\n');
    assert.match(sql, /authority VARCHAR\(16\) NOT NULL DEFAULT 'legacy'/);
    assert.match(sql, /activation_report JSONB/);
    assert.match(sql, /requires audited reconciliation before rollback/);
    assert.match(sql, /activation requires generation and audit report/);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage228-robinhood-head-processing-authority'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage228.js');
    assert.equal(group.tables[0].table, stage228.TABLE_NAME);
  });

  it('selects legacy without evaluating state-only prerequisites', async () => {
    const legacy = {};
    const selected = await selectHeadProcessingRepository({
      database: databaseWith([[{
        authority: 'legacy', generation: '0', activated_at: null, activation_report: null,
      }]]),
      legacyFactory: () => legacy,
    });
    assert.equal(selected.repository, legacy);
    assert.equal(selected.authority.authority, 'legacy');
  });

  it('fails closed when state authority lacks an insert-only mirror', async () => {
    const database = databaseWith([
      [{ authority: 'state', generation: '1', activated_at: new Date(), activation_report: {} }],
      [{ invalid_indexes: [], trigger_enabled: true, trigger_insert_only: false }],
    ]);
    await assert.rejects(
      selectHeadProcessingRepository({ database, stateFactory: () => ({}) }),
      /trigger is not insert-only/
    );
  });

  it('selects state only after every runtime prerequisite is valid', async () => {
    const state = {};
    const database = databaseWith([
      [{ authority: 'state', generation: '1', activated_at: new Date(), activation_report: {} }],
      [{ invalid_indexes: [], trigger_enabled: true, trigger_insert_only: true }],
    ]);
    const selected = await selectHeadProcessingRepository({
      database, stateFactory: () => state,
    });
    assert.equal(selected.repository, state);
    assert.equal(REQUIRED_STATE_INDEXES.length, 8);
  });
});
