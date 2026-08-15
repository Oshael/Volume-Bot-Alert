process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage128 = require('../src/utils/db-init-stage128');
const stage138 = require('../src/utils/db-init-stage138');
const {
  createRobinhoodTokenTransferRepository,
} = require('../src/models/robinhood-token-transfer-persistence');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TOKEN = `0x${'1'.repeat(40)}`;

function event(day, suffix, overrides = {}) {
  return {
    blockNumber: String(100 + suffix), blockHash: `0x${'a'.repeat(63)}${suffix}`,
    blockTime: `${day}T${suffix ? '00:00:00' : '23:59:59'}.000Z`,
    transactionHash: `0x${'b'.repeat(63)}${suffix}`,
    transactionIndex: String(suffix), logIndex: String(suffix), tokenAddress: TOKEN,
    fromWallet: `0x${'0'.repeat(40)}`, toWallet: `0x${'2'.repeat(40)}`,
    amountRaw: String(suffix), ...overrides,
  };
}

describe('Robinhood token transfer persistence integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage128.init({ closePool: false });
    await stage138.init({ closePool: false });
    await db.query('DELETE FROM robinhood_token_transfer_events WHERE token_address = $1', [TOKEN]);
  });
  after(async () => {
    await db.query('DELETE FROM robinhood_token_transfer_events WHERE token_address = $1', [TOKEN]);
    await db.query('DROP TABLE IF EXISTS robinhood_token_transfer_events_2098_12_31');
    await db.query('DROP TABLE IF EXISTS robinhood_token_transfer_events_2099_01_01');
    await db.pool.end();
  });

  it('persists and deduplicates evidence across a UTC partition boundary', async () => {
    const repository = createRobinhoodTokenTransferRepository({ database: db });
    const rows = [
      event('2098-12-31', 0),
      event('2099-01-01', 1, {
        fromWallet: `0x${'2'.repeat(40)}`, transferKind: 'wallet_self',
        classificationVersion: 'rh_transfer_v1',
      }),
    ];
    const first = await repository.insertTransferEvents(rows);
    const duplicate = await repository.insertTransferEvents(rows);
    await assert.rejects(db.query(
      `INSERT INTO robinhood_token_transfer_events (
         chain, block_number, block_hash, block_time, transaction_hash,
         transaction_index, log_index, token_address, from_wallet, to_wallet,
         amount_raw, transfer_kind, classification_version
       ) SELECT chain, block_number, block_hash, block_time + INTERVAL '1 second',
         transaction_hash, transaction_index, log_index, token_address,
         from_wallet, to_wallet, amount_raw, 'mint', NULL
       FROM robinhood_token_transfer_events WHERE token_address = $1 LIMIT 1`,
      [TOKEN]
    ), /rh_token_transfer_events_classification_check/);
    const stored = await db.query(
      `SELECT block_time, amount_raw::text, transfer_kind, classification_version
       FROM robinhood_token_transfer_events WHERE token_address = $1 ORDER BY block_time`,
      [TOKEN]
    );

    assert.deepEqual(first, { inserted: 2, ensuredDays: ['2098-12-31', '2099-01-01'] });
    assert.equal(duplicate.inserted, 0);
    assert.deepEqual(stored.rows.map((row) => row.amount_raw), ['0', '1']);
    assert.deepEqual(stored.rows.map(({ transfer_kind: kind, classification_version: version }) => (
      { kind, version }
    )), [
      { kind: 'unclassified', version: null },
      { kind: 'wallet_self', version: 'rh_transfer_v1' },
    ]);
  });
});
