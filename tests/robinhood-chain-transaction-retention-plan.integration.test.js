'use strict';

const assert = require('node:assert/strict');
const { after, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  FK_INVENTORY_SQL,
} = require('../src/utils/plan-robinhood-chain-transaction-retention');

after(() => db.pool.end());

it('parses the event FK inventory query in PostgreSQL', async () => {
  await assertUsingTestDatabase(db);
  const { rows } = await db.query(FK_INVENTORY_SQL, [
    'rh_chain_events_shadow_transaction_fkey',
    'rh_chain_events_transaction_shadow_fkey',
  ]);
  assert.ok(Array.isArray(rows));
});
