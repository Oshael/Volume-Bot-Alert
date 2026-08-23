process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const stage153 = require('../src/utils/db-init-stage153');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_directional_evidence_v1';
const TOKEN = `0x${'1'.repeat(40)}`;
const CREATOR = `0x${'2'.repeat(40)}`;
const PURE = `0x${'3'.repeat(40)}`;
const MIXED = `0x${'4'.repeat(40)}`;
const TX = `0x${'a'.repeat(64)}`;

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version = $1',
    [VERSION]
  );
}

async function insertEdge(wallet, counts) {
  await db.query(
    `INSERT INTO robinhood_wallet_transfer_edges (
       chain, classification_version, token_address, from_wallet, to_wallet,
       transfer_count, total_amount_raw, wallet_transfer_count, dex_flow_count,
       first_block, first_log_index, first_seen_at, first_transaction_hash,
       last_block, last_log_index, last_seen_at, last_transaction_hash,
       largest_amount_raw, largest_log_index, largest_transaction_hash
     ) VALUES ('robinhood', $1, $2, $3, $4, $5, 10, $6, $7,
       100, 1, '2099-01-01T00:00:00Z', $8,
       101, 2, '2099-01-01T00:01:00Z', $8, 10, 2, $8)`,
    [VERSION, TOKEN, CREATOR, wallet, counts.wallet + counts.dex,
      counts.wallet, counts.dex, TX]
  );
}

describe('Robinhood directional wallet-transfer evidence schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage129.init({ closePool: false });
    await stage130.init({ closePool: false });
    await stage153.init({ closePool: false });
    await cleanup();
    await insertEdge(PURE, { wallet: 1, dex: 0 });
    await insertEdge(MIXED, { wallet: 1, dex: 1 });
  });
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('leaves historical edges untouched and remains idempotent', async () => {
    await stage153.init({ closePool: false });
    await stage153.init({ closePool: false });

    const { rows } = await db.query(
      `SELECT to_wallet, first_wallet_transfer_block::text AS block_number,
              first_wallet_transfer_transaction_hash AS transaction_hash
         FROM robinhood_wallet_transfer_edges
        WHERE classification_version = $1 ORDER BY to_wallet`,
      [VERSION]
    );
    assert.deepEqual(rows, [
      { to_wallet: PURE, block_number: null, transaction_hash: null },
      { to_wallet: MIXED, block_number: null, transaction_hash: null },
    ]);
  });

  it('rejects partial or out-of-range evidence', async () => {
    await assert.rejects(
      db.query(
        `UPDATE robinhood_wallet_transfer_edges
            SET first_wallet_transfer_block = 100
          WHERE classification_version = $1 AND to_wallet = $2`,
        [VERSION, MIXED]
      ),
      /rh_wallet_transfer_edges_first_wallet_transfer_check/
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_wallet_transfer_edges
            SET first_wallet_transfer_block = 99,
                first_wallet_transfer_log_index = 1,
                first_wallet_transfer_at = first_seen_at,
                first_wallet_transfer_transaction_hash = $2,
                first_wallet_transfer_amount_raw = 1
          WHERE classification_version = $1 AND to_wallet = $3`,
        [VERSION, TX, MIXED]
      ),
      /rh_wallet_transfer_edges_first_wallet_transfer_check/
    );
  });
});
