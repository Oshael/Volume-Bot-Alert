const assert = require('node:assert/strict');
const { it } = require('node:test');

const stage180 = require('../src/utils/db-init-stage180');
const stage189 = require('../src/utils/db-init-stage189');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

it('keeps the holder hot queue scoped to tracked token states', () => {
  const installSql = stage180.STATEMENTS.join('\n');
  const repairSql = stage189.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage180-robinhood-holder-hot-queue'
  ));
  const foreignKey = group.tables[0].constraints.find(({ name }) => (
    name === 'rh_holder_hot_queue_state_fkey'
  ));

  for (const sql of [installSql, repairSql]) {
    assert.match(sql, /INNER JOIN robinhood_holder_token_states state/);
    assert.match(sql, /state\.ledger_status IN \('backfilling', 'shadow', 'live'\)/);
    assert.match(sql, /DELETE FROM robinhood_holder_hot_queue queue/);
    assert.match(sql, /rh_holder_hot_queue_state_fkey/);
    assert.match(sql, /ON DELETE CASCADE/);
  }
  assert.deepEqual(foreignKey.includes, [
    'FOREIGN KEY', 'chain', 'token_address',
    'robinhood_holder_token_states', 'ON DELETE CASCADE',
  ]);
});
