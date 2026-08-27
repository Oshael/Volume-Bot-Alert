const assert = require('node:assert/strict');
const { test } = require('node:test');

const stage168 = require('../src/utils/db-init-stage168');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

test('adds versioned possible-bundle groups without publishing a wallet tag', () => {
  const sql = stage168.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage168-robinhood-possible-bundle-snapshots'
  ));
  assert.match(sql, /robinhood_possible_bundle_states/);
  assert.match(sql, /minimum_value_wei > 0/);
  assert.match(sql, /source_kind = 'seed'/);
  assert.match(sql, /robinhood_possible_bundle_groups/);
  assert.match(sql, /member_count >= 2/);
  assert.match(sql, /robinhood_possible_bundle_members/);
  assert.match(sql, /first_buy_block BETWEEN launch_block AND launch_block \+ 3/);
  assert.match(sql, /connected_funding_ancestor/);
  assert.doesNotMatch(sql, /INSERT INTO|\bUPDATE\b|DELETE FROM/i);
  assert.equal(group.repair, 'node src/utils/db-init-stage168.js');
  assert.deepEqual(group.tables.map(({ table }) => table), [
    'robinhood_possible_bundle_states', 'robinhood_possible_bundle_groups',
    'robinhood_possible_bundle_members',
  ]);
});
