process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage181 = require('../src/utils/db-init-stage181');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const WALLET = `0x${'9'.repeat(40)}`;
const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;

async function cleanup() {
  await db.query("DELETE FROM robinhood_wallet_signed_origins WHERE chain = 'robinhood'");
  await db.query("DELETE FROM robinhood_wallet_signed_origin_cursors WHERE chain = 'robinhood'");
}

describe('Robinhood wallet signed origin schema', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage181.init({ closePool: false });
    await stage181.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('registers both tables in the runtime schema contract', () => {
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage181-robinhood-wallet-signed-origins'
    ));
    assert.equal(group.repair, 'node src/utils/db-init-stage181.js');
    assert.deepEqual(group.tables.map(({ table }) => table), [
      'robinhood_wallet_signed_origins',
      'robinhood_wallet_signed_origin_cursors',
    ]);
  });

  it('persists a canonical origin and an ordered cursor', async () => {
    await db.query(`INSERT INTO robinhood_wallet_signed_origin_cursors (
      stream, origin_block, next_block, safe_head, checkpoint_block,
      checkpoint_hash, checkpoint_timestamp, lifecycle_state
    ) VALUES ('live', 100, 111, 120, 110, $1, '2026-08-30T12:00:00Z', 'running')`,
    [HASH]);
    await db.query(`INSERT INTO robinhood_wallet_signed_origins (
      wallet_address, first_block_number, first_block_hash, first_block_time,
      first_transaction_hash, first_transaction_index, first_nonce,
      coverage_origin_block, source_stream, observed_at
    ) VALUES ($1, 105, $2, '2026-08-30T11:59:55Z', $3, 2, 0,
      100, 'live', '2026-08-30T12:00:00Z')`, [WALLET, HASH, TX]);
    assert.deepEqual((await db.query(`SELECT first_block_number::text,
      first_transaction_index, first_nonce::text, coverage_origin_block::text
      FROM robinhood_wallet_signed_origins WHERE wallet_address = $1`, [WALLET])).rows[0], {
      first_block_number: '105', first_transaction_index: 2,
      first_nonce: '0', coverage_origin_block: '100',
    });
  });

  it('rejects duplicate wallets, invalid coverage, and false caught-up cursors', async () => {
    await assert.rejects(db.query(`INSERT INTO robinhood_wallet_signed_origins (
      wallet_address, first_block_number, first_block_hash, first_block_time,
      first_transaction_hash, first_transaction_index, first_nonce,
      coverage_origin_block, source_stream, observed_at
    ) VALUES ($1, 106, $2, NOW(), $3, 0, 0, 100, 'live', NOW())`,
    [WALLET, HASH, `0x${'c'.repeat(64)}`]), /rh_wallet_signed_origins_pkey/);
    await assert.rejects(db.query(`INSERT INTO robinhood_wallet_signed_origins (
      wallet_address, first_block_number, first_block_hash, first_block_time,
      first_transaction_hash, first_transaction_index, first_nonce,
      coverage_origin_block, source_stream, observed_at
    ) VALUES ($1, 99, $2, NOW(), $3, 0, 0, 100, 'seed', NOW())`,
    [`0x${'8'.repeat(40)}`, HASH, `0x${'d'.repeat(64)}`]),
    /rh_wallet_signed_origins_contract_check/);
    await assert.rejects(db.query(`INSERT INTO robinhood_wallet_signed_origin_cursors (
      stream, origin_block, next_block, checkpoint_block, checkpoint_timestamp
    ) VALUES ('seed', 100, 110, 109, NOW())`),
    /rh_wallet_signed_origin_cursors_checkpoint_check/);
    await assert.rejects(db.query(`INSERT INTO robinhood_wallet_signed_origin_cursors (
      stream, origin_block, next_block, safe_head, checkpoint_block,
      checkpoint_hash, checkpoint_timestamp, lifecycle_state
    ) VALUES ('seed', 100, 110, 120, 109, $1, NOW(), 'completed')`, [HASH]),
    /rh_wallet_signed_origin_cursors_frontier_check/);
  });
});
