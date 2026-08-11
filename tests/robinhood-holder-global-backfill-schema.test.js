const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage120 = require('../src/utils/db-init-stage120');
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
});
