const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage178 = require('../src/utils/db-init-stage178');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('registers a frozen 14-day FRESH activation and event-driven work queue', () => {
  const sql = stage178.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage178-robinhood-fresh-wallet-foundation'
  ));
  assert.match(sql, /seed_cutoff_at = activation_at - INTERVAL '14 days'/);
  assert.match(sql, /FRESH activation boundary is immutable/);
  assert.match(sql, /FRESH seed cohort is immutable/);
  assert.match(sql, /NEW\.block_number > activation\.activation_block/);
  assert.match(sql, /source_kind = 'live' AND seed_run_id IS NULL/);
  assert.match(sql, /coverage_scope IN \('seed', 'live', 'partial'\)/);
  assert.match(sql, /status <> 'ready'.*coverage_scope <> 'partial'/s);
  assert.match(sql, /AFTER INSERT OR UPDATE OF transaction_hash, block_number/);
  assert.match(sql, /idx_rh_fresh_wallet_queue_claim[\s\S]*WHERE status = 'pending'/);
  assert.match(sql, /GET DIAGNOSTICS queued_count = ROW_COUNT/);
  assert.doesNotMatch(sql, /eth_get|RH_NODE_RPC_URL|ROBINHOOD_RPC_URL/);
  assert.equal(group.repair, 'node src/utils/db-init-stage178.js');
});
