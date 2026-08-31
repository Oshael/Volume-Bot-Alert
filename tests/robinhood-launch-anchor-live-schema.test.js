const assert = require('node:assert/strict');
const { it } = require('node:test');
const stage171 = require('../src/utils/db-init-stage171');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const {
  __private: { MATERIALIZE_SQL },
} = require('../src/models/robinhood-launch-anchor-outbox');

it('registers durable first-buy launch-anchor work without scanning history', () => {
  const sql = stage171.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage171-robinhood-launch-anchor-live-outbox'
  ));
  assert.match(sql, /AFTER INSERT OR UPDATE ON robinhood_wallet_token_first_buys/);
  assert.match(sql, /pg_notify\('robinhood_launch_anchor_outbox'/);
  assert.doesNotMatch(sql, /robinhood_wallet_swaps/);
  assert.match(MATERIALIZE_SQL, /ledger_status = 'live'/);
  assert.match(MATERIALIZE_SQL, /source\.block_time >= target\.first_pool_time/);
  assert.match(MATERIALIZE_SQL, /ORDER BY source\.block_number LIMIT 1/);
  assert.equal(group.repair, 'node src/utils/db-init-stage171.js');
});
