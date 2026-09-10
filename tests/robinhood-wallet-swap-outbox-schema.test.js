'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { STATEMENTS, init } = require('../src/utils/db-init-stage203');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet-swap outbox schema', () => {
  it('defines a durable, ordered and idempotent work queue', () => {
    const sql = STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_wallet_swap_outbox/);
    assert.match(sql, /PRIMARY KEY \([\s\S]*chain, transaction_hash, log_index/);
    assert.match(sql, /status IN \('pending', 'leased', 'blocked'\)/);
    assert.match(sql, /jsonb_typeof\(payload\) = 'object'/);
    assert.match(sql, /block_number, transaction_index, log_index, next_attempt_at/);
    assert.match(sql, /WHERE status = 'pending'/);
    assert.match(sql, /lease_until\) WHERE status = 'leased'/);
  });

  it('runs sequentially and is registered in the runtime schema guard', async () => {
    const calls = [];
    await init({
      database: { query: async (sql) => calls.push(sql) },
      closePool: false,
    });
    assert.deepEqual(calls, STATEMENTS);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage203-robinhood-wallet-swap-outbox'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage203.js');
    assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), [
      'idx_rh_wallet_swap_outbox_claim',
      'idx_rh_wallet_swap_outbox_lease',
    ]);
  });
});
