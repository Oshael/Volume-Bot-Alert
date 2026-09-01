const assert = require('node:assert/strict');
const { it } = require('node:test');

const stage188 = require('../src/utils/db-init-stage188');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('registers a live-only activation and event-driven redistribution queue', () => {
  const sql = stage188.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage188-robinhood-bundle-redistribution-live-queue'
  ));

  assert.match(sql, /BUNDLED redistribution activation boundary is immutable/);
  assert.match(sql, /BUNDLED redistribution activation must start planned/);
  assert.match(sql, /activation_checkpoint_block >= activation_block/);
  assert.match(sql, /RENAME COLUMN activation_block_hash TO activation_checkpoint_hash/);
  assert.match(sql, /requested_block > activation\.activation_block/);
  assert.match(sql, /activation\.activation_block \+ 1/);
  assert.match(sql, /activation\.status IN \('planned', 'active'\)/);
  assert.match(sql, /allow_insert/);
  assert.match(sql, /AFTER INSERT OR DELETE ON robinhood_wallet_transfer_edges/);
  assert.match(sql, /AFTER UPDATE OF first_wallet_transfer_block/);
  assert.match(sql, /AFTER INSERT OR DELETE ON robinhood_wallet_swaps/);
  assert.match(sql, /event_side = 'sell'/);
  assert.match(sql, /pg_notify\('robinhood_bundle_redistribution_queue'/);
  assert.doesNotMatch(sql, /INSERT INTO robinhood_bundle_redistribution_activations/);
  assert.doesNotMatch(sql, /eth_get|RH_NODE_RPC_URL|source_kind = 'seed'/);
  assert.equal(group.repair, 'node src/utils/db-init-stage188.js');
  assert.deepEqual(group.tables.map(({ table }) => table), [
    'robinhood_bundle_redistribution_activations',
    'robinhood_bundle_redistribution_queue',
  ]);
});
