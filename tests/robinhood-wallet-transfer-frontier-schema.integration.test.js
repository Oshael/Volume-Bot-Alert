process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage129 = require('../src/utils/db-init-stage129');
const stage130 = require('../src/utils/db-init-stage130');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_transfer_frontier_v1';
const TOKEN = `0x${'1'.repeat(40)}`;
const LEFT = `0x${'2'.repeat(40)}`;
const RIGHT = `0x${'3'.repeat(40)}`;
const TX = `0x${'a'.repeat(64)}`;

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_edges WHERE classification_version LIKE $1',
    [`${VERSION}%`]
  );
}

describe('Robinhood wallet transfer frontier schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage129.init({ closePool: false });
    await cleanup();
    await stage130.init({ closePool: false });
  });
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('stores exact non-negative log frontiers and remains idempotent', async () => {
    const insert = `INSERT INTO robinhood_wallet_transfer_edges (
      chain, classification_version, token_address, from_wallet, to_wallet,
      transfer_count, total_amount_raw, first_block, first_log_index, first_seen_at,
      first_transaction_hash, last_block, last_log_index, last_seen_at,
      last_transaction_hash, largest_amount_raw, largest_log_index,
      largest_transaction_hash
    ) VALUES ('robinhood', $1, $2, $3, $4, 1, 10, 100, $5, NOW(), $6,
      100, $5, NOW(), $6, 10, $5, $6)`;
    await db.query(insert, [VERSION, TOKEN, LEFT, RIGHT, 7, TX]);
    await stage130.init({ closePool: false });

    const stored = await db.query(
      `SELECT first_log_index, last_log_index, largest_log_index
       FROM robinhood_wallet_transfer_edges WHERE classification_version = $1`,
      [VERSION]
    );
    assert.deepEqual(stored.rows[0], {
      first_log_index: 7, last_log_index: 7, largest_log_index: 7,
    });
    await assert.rejects(
      db.query(insert, [`${VERSION}_negative`, TOKEN, LEFT, RIGHT, -1, TX]),
      /rh_wallet_transfer_edges_log_index_check/
    );
  });
});
