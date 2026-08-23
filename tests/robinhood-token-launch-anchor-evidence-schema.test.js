const assert = require('node:assert/strict');
const { test } = require('node:test');

const stage157 = require('../src/utils/db-init-stage157');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

test('adds typed optional anchor detail without starting a backfill', () => {
  const sql = stage157.STATEMENTS.join('\n');
  const group = SCHEMA_GROUPS.find(({ key }) => (
    key === 'stage157-robinhood-token-launch-anchor-evidence'
  ));
  assert.match(sql, /ADD COLUMN IF NOT EXISTS launch_block_time TIMESTAMPTZ/);
  assert.match(sql, /anchor_transaction_index >= 0/);
  assert.match(sql, /anchor_side IN \('buy', 'sell'\)/);
  assert.doesNotMatch(sql, /INSERT INTO|UPDATE|DELETE FROM/);
  assert.equal(group.repair, 'node src/utils/db-init-stage157.js');
});
