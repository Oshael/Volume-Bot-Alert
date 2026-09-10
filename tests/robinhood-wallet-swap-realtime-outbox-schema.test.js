'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { STATEMENTS, init } = require('../src/utils/db-init-stage204');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

describe('Robinhood wallet-swap realtime lifecycle outbox schema', () => {
  it('defines an append-only lifecycle queue with durable delivery state', () => {
    const sql = STATEMENTS.join('\n');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS robinhood_wallet_swap_realtime_outbox/);
    assert.match(sql, /PRIMARY KEY \([\s\S]*event_kind/);
    assert.match(sql, /event_kind IN \('observed', 'finalized', 'invalidate'\)/);
    assert.match(sql, /status IN \('pending', 'leased', 'complete', 'blocked'\)/);
    assert.match(sql, /\(status = 'complete'\) = \(published_at IS NOT NULL\)/);
    assert.match(sql, /WHERE event_kind = 'observed' AND status = 'complete'/);
  });

  it('runs sequentially and is registered in the runtime schema guard', async () => {
    const calls = [];
    await init({
      database: { query: async (sql) => calls.push(sql) },
      closePool: false,
    });
    assert.deepEqual(calls, STATEMENTS);
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage204-robinhood-wallet-swap-realtime-outbox'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage204.js');
    assert.deepEqual(group.tables[0].indexes.map(({ name }) => name), [
      'idx_rh_wallet_swap_realtime_outbox_claim',
      'idx_rh_wallet_swap_realtime_outbox_lease',
      'idx_rh_wallet_swap_realtime_outbox_canonical',
    ]);
  });
});
