const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage120 = require('../src/utils/db-init-stage120');
const stage142 = require('../src/utils/db-init-stage142');
const stage184 = require('../src/utils/db-init-stage184');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood holder global backfill schema', () => {
  it('defines a durable campaign, frozen cohort and active-run invariant', () => {
    const sql = stage120.STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_global_backfill_runs/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_holder_global_backfill_tokens/);
    assert.match(sql, /CREATE UNIQUE INDEX[\s\S]+WHERE status <> 'completed'/);
    assert.match(sql, /barrier_checkpoint_block = barrier_block - 1/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage120-robinhood-holder-global-backfill'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage120.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_holder_global_backfill_runs',
      'robinhood_holder_global_backfill_tokens',
    ]);
  });

  it('indexes applied journal evidence used by materialized handoff', () => {
    const sql = stage142.STATEMENTS.join('\n');
    assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/);
    assert.match(sql, /idx_rh_holder_journal_applied_token_block/);
    assert.match(sql, /chain, token_address, block_number ASC/);
    assert.match(sql, /WHERE applied = true/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage142-robinhood-holder-applied-journal-index'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage142.js');
    assert.equal(group.tables[0].indexes[0].name,
      'idx_rh_holder_journal_applied_token_block');
  });

  it('indexes the bounded catalog scan and excluded-token anti-join', () => {
    const sql = stage184.STATEMENTS.join('\n');
    assert.match(sql, /CREATE INDEX CONCURRENTLY IF NOT EXISTS/g);
    assert.match(sql, /idx_token_catalog_robinhood_first_seen_address/);
    assert.match(sql, /token_catalog\(first_seen_at ASC, address ASC\)/);
    assert.match(sql, /WHERE chain = 'robinhood'/);
    assert.match(sql, /idx_rh_holder_global_excluded_token/);
    assert.match(sql, /robinhood_holder_global_backfill_tokens\(chain, token_address\)/);
    assert.match(sql, /WHERE status = 'excluded'/);
    assert.doesNotMatch(sql, /DROP\s+(?:TABLE|COLUMN|CONSTRAINT|INDEX)/i);

    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage184-robinhood-holder-delta-selection-indexes'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage184.js');
    assert.deepEqual(group.tables.flatMap(({ indexes }) => (
      indexes.map(({ name }) => name)
    )), [
      'idx_token_catalog_robinhood_first_seen_address',
      'idx_rh_holder_global_excluded_token',
    ]);
  });
});
