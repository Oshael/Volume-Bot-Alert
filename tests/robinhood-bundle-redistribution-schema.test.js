const assert = require('node:assert/strict');
const { it } = require('node:test');

const stage187 = require('../src/utils/db-init-stage187');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('registers isolated causal snapshots for BUNDLED redistribution', () => {
  const sql = stage187.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage187-robinhood-bundle-redistribution-snapshots'
  ));

  assert.match(sql, /rh_possible_bundle_redistribution_v/);
  assert.match(sql, /rh_token_redistribution_v/);
  assert.match(sql, /member_count = connection_count \+ 1/);
  assert.match(sql, /connection_kind = 'redistribution_source'/);
  assert.match(sql, /connection_kind = 'rapid_sell_recipient'/);
  assert.match(sql, /source_buy_transaction_hash/);
  assert.match(sql, /transfer_transaction_hash/);
  assert.match(sql, /sell_transaction_hash/);
  assert.match(sql, /sell_delay_ms BETWEEN 0 AND 300000/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_rh_bundle_redistribution_groups_source/);
  assert.doesNotMatch(sql, /rh_native_funding|launch_block|qualifying_value_wei/);
  assert.equal(group.repair, 'node src/utils/db-init-stage187.js');
  assert.deepEqual(group.tables.map(({ table }) => table), [
    'robinhood_bundle_redistribution_states',
    'robinhood_bundle_redistribution_groups',
    'robinhood_bundle_redistribution_members',
  ]);
});
