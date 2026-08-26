const assert = require('node:assert/strict');
const { test } = require('node:test');

const stage167 = require('../src/utils/db-init-stage167');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

test('adds bounded native-funding evidence and resumable seed control', () => {
  const sql = stage167.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage167-robinhood-native-funding-persistence'
  ));
  assert.match(sql, /robinhood_native_funding_events[\s\S]+PARTITION BY RANGE \(block_time\)/);
  assert.match(sql, /robinhood_native_funding_edges/);
  assert.match(sql, /first_transaction_index/);
  assert.match(sql, /robinhood_bundle_funding_backfill_runs/);
  assert.match(sql, /robinhood_bundle_funding_backfill_candidates/);
  assert.match(sql, /first_buy_block BETWEEN launch_block AND launch_block \+ 3/);
  assert.match(sql, /robinhood_bundle_funding_backfill_ranges/);
  assert.match(sql, /idx_rh_bundle_funding_ranges_claim/);
  assert.doesNotMatch(sql, /INSERT INTO|\bUPDATE\b|DELETE FROM/i);
  assert.equal(group.repair, 'node src/utils/db-init-stage167.js');
  assert.deepEqual(group.tables.map(({ table }) => table), [
    'robinhood_native_funding_events', 'robinhood_native_funding_edges',
    'robinhood_bundle_funding_backfill_runs',
    'robinhood_bundle_funding_backfill_candidates',
    'robinhood_bundle_funding_backfill_ranges',
  ]);
});
