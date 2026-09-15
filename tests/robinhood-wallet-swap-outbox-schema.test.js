'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { STATEMENTS, init } = require('../src/utils/db-init-stage203');
const stage221 = require('../src/utils/db-init-stage221');
const {
  createRobinhoodWalletSwapOutboxRepository,
} = require('../src/models/robinhood-wallet-swap-outbox');
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
    assert.match(sql, /idx_rh_wallet_swap_outbox_active_frontier/);
  });

  it('claims an ordered outbox prefix before checking canonical membership', async () => {
    const calls = [];
    const repository = createRobinhoodWalletSwapOutboxRepository({
      database: { query: async (sql, params) => {
        calls.push({ sql, params });
        return { rows: [] };
      } },
    });

    await repository.claimFinalized({
      owner: 'wallet-test', limit: 2000, leaseMs: 60_000, throughBlock: '123',
    });

    assert.deepEqual(calls[0].params, ['wallet-test', 2000, 60_000, '123']);
    assert.match(calls[0].sql, /AND EXISTS \([\s\S]*robinhood_chain_blocks/);
    assert.match(calls[0].sql, /OFFSET 0[\s\S]*ORDER BY outbox\.block_number/);
    assert.doesNotMatch(calls[0].sql, /INNER JOIN robinhood_chain_blocks/);
  });

  it('installs and guards the active economic frontier index', async () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage221-robinhood-wallet-swap-frontier'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage221.js');
    assert.equal(group.tables[0].indexes[0].name, stage221.INDEX_NAME);
    assert.match(stage221.CREATE_STATEMENT, /block_number/);
    assert.match(stage221.CREATE_STATEMENT, /pending.*leased.*blocked/);

    const calls = [];
    let inspection = 0;
    await stage221.init({
      database: { query: async (statement) => {
        calls.push(statement);
        if (statement.startsWith('SELECT indisvalid')) {
          inspection += 1;
          return inspection === 1
            ? { rows: [] }
            : { rows: [{ indisvalid: true, indisready: true }] };
        }
        return { rows: [] };
      } },
      closePool: false,
    });
    assert.equal(calls[1], stage221.CREATE_STATEMENT);
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
