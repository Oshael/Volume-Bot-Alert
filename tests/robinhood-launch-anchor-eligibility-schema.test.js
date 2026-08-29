const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage177 = require('../src/utils/db-init-stage177');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

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
