const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const stage119 = require('../src/utils/db-init-stage119');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood holder publication schema', () => {
  it('creates a non-materialized live-first view without another data table', () => {
    const sql = stage119.STATEMENTS.join('\n');
    assert.match(sql, /CREATE OR REPLACE VIEW robinhood_published_holder_summaries/);
    assert.doesNotMatch(sql, /CREATE\s+(?:UNLOGGED\s+)?TABLE/i);
    assert.doesNotMatch(sql, /MATERIALIZED\s+VIEW/i);
    assert.match(sql, /live_state\.ledger_status = 'live'/);
    assert.match(sql, /THEN live_state\.holder_count ELSE fallback\.holder_count/);
    assert.match(sql, /THEN 'ledger_live'/);
    assert.match(sql, /THEN live_state\.updated_at ELSE fallback\.observed_at/);
    assert.match(sql, /THEN live_cursor\.updated_at ELSE fallback\.checked_at/);
  });

  it('allows ledger snapshots and registers the view in the runtime guard', () => {
    const sql = stage119.STATEMENTS.join('\n');
    assert.match(sql, /source IN \('blockscout', 'ledger_live'\)/);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage119-robinhood-holder-publication-view'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage119.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_token_holder_daily_snapshots',
      'robinhood_published_holder_summaries',
    ]);
    assert.equal(group.tables[1].columns.includes('ledger_version'), true);
    assert.equal(group.tables[1].columns.includes('live_through_block'), true);
  });
});
