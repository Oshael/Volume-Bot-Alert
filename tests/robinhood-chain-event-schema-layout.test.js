'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  getGroupsForProfile, groupsForPartitionedChainEvents,
} = require('../src/utils/runtime-schema');

test('runtime schema checks the partitioned active table after event cutover', () => {
  const legacy = getGroupsForProfile('runtime');
  const groups = groupsForPartitionedChainEvents(legacy);
  const byKey = (key) => groups.find((group) => group.key === key);
  const active = byKey('stage191-robinhood-canonical-chain-journal').tables
    .find((table) => table.table === 'robinhood_chain_events');
  assert.ok(active.constraints.find((constraint) => (
    constraint.name === 'rh_chain_events_shadow_pkey'
      && constraint.includes.includes('block_number')
  )));
  assert.ok(active.indexes.find((index) => index.name === 'idx_rh_chain_events_shadow_hash'));
  assert.deepEqual(byKey('stage247-robinhood-chain-events-shadow').tables
    .map((table) => table.table), ['robinhood_chain_v3_balance_snapshots']);
  for (const key of ['stage249-robinhood-domain-outbox-cutover',
    'stage250-robinhood-chain-event-children']) {
    const definitions = byKey(key).tables.flatMap((table) => (
      (table.constraints || []).flatMap((constraint) => constraint.includes || [])
    ));
    assert.equal(definitions.some((part) => part.includes('robinhood_chain_events_shadow')), false);
  }
  assert.ok(legacy.find((group) => group.key === 'stage247-robinhood-chain-events-shadow')
    .tables.some((table) => table.table === 'robinhood_chain_events_shadow'));
});
