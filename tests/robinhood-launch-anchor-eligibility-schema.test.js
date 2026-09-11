const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage177 = require('../src/utils/db-init-stage177');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const {
  __private: { invalidateLaunchAnchors },
} = require('../src/models/robinhood-discovery-derived-reorg-rollback');

it('registers holder-live eligibility and recoverable outbox cleanup', () => {
  const sql = stage177.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage177-robinhood-launch-anchor-eligibility'
  ));
  assert.match(sql, /eligibility_version = 'rh_holder_live_v1'/);
  assert.match(sql, /state\.ledger_status = 'live'/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /AFTER INSERT OR UPDATE OF ledger_status, live_through_block/);
  assert.match(sql, /robinhood_wallet_token_first_buys/);
  assert.match(sql, /DELETE FROM robinhood_launch_anchor_outbox/);
  assert.equal(group.repair, 'node src/utils/db-init-stage177.js');
});

it('keeps reorg launch-anchor work restricted to holder-live tokens', async () => {
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    if (calls.length === 1) return { rows: [{ token_address: `0x${'a'.repeat(40)}` }] };
    if (calls.length === 2) return { rowCount: 3 };
    if (calls.length === 5) return { rows: [{ rows: 0 }] };
    return { rowCount: 0 };
  } };
  await invalidateLaunchAnchors(client, { fromBlock: '100' });
  assert.match(calls[1], /NOT EXISTS \(\s*SELECT 1 FROM robinhood_holder_token_states/);
  assert.match(calls[2], /AND EXISTS \(\s*SELECT 1 FROM robinhood_holder_token_states/);
  assert.match(calls[2], /state\.ledger_status='live'/);
});
