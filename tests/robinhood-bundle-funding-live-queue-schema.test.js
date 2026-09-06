const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage172 = require('../src/utils/db-init-stage172');
const stage199 = require('../src/utils/db-init-stage199');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('queues versioned Archive work after a committed launch anchor', () => {
  const sql = stage172.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage172-robinhood-bundle-funding-live-queue'
  ));
  assert.match(sql, /AFTER INSERT OR UPDATE ON robinhood_token_launch_anchors/);
  assert.match(sql, /requested_version = .*requested_version \+ 1/s);
  assert.match(sql, /pg_notify\('robinhood_bundle_funding_live_queue'/);
  assert.match(sql, /completed_version = requested_version/);
  assert.doesNotMatch(sql, /eth_get|RH_NODE_RPC_URL|robinhood_wallet_swaps/);
  assert.equal(group.repair, 'node src/utils/db-init-stage172.js');
});

it('does not reopen unchanged anchors already marked for Archive repair', () => {
  const sql = stage199.STATEMENTS.join('\n');
  assert.match(sql, /last_error_code\s+IS DISTINCT FROM 'archive_required'/);
  assert.match(sql, /anchor_block = EXCLUDED\.anchor_block/);
});
