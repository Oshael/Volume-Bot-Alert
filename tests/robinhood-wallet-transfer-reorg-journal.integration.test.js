'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, it } = require('node:test');

const db = require('../src/models/db');
const retention = require('../src/services/robinhood-retention-worker');
const stage191 = require('../src/utils/db-init-stage191');
const stage208 = require('../src/utils/db-init-stage208');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'1'.repeat(64)}`;

async function clear() {
  await db.query('DELETE FROM robinhood_wallet_transfer_reorg_journal');
  await db.query("DELETE FROM robinhood_chain_capture_cursor WHERE chain='robinhood'");
}

describe('Robinhood wallet-transfer reorg journal retention', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage191.init({ closePool: false });
    await stage208.init({ closePool: false });
  });
  beforeEach(clear);
  after(async () => {
    await clear().catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('deletes expired preimages only through the finalized frontier', async () => {
    await db.query(
      `INSERT INTO robinhood_chain_capture_cursor(
         chain, next_block, checkpoint_block, checkpoint_hash, node_head, finalized_head
       ) VALUES ('robinhood', 102, 101, $1, 105, 100)`,
      [HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_reorg_journal(
         chain, projection_version, block_number, block_hash, block_time,
         aggregate_kind, identity_key, had_previous, previous_row, expires_at
       ) VALUES
         ('robinhood','rh_transfer_v1',100,$1,NOW()-INTERVAL '4 days',
          'block_marker','block',FALSE,NULL,NOW()-INTERVAL '1 day'),
         ('robinhood','rh_transfer_v1',101,$2,NOW()-INTERVAL '4 days',
          'block_marker','block',FALSE,NULL,NOW()-INTERVAL '1 day')`,
      [HASH, `0x${'2'.repeat(64)}`]
    );

    assert.equal(await retention.__private.deleteExpiredTransferReorgJournal(db, {
      batchLimit: 100, statementTimeoutMs: 2500,
    }), 1);
    const remaining = await db.query(
      `SELECT block_number::text FROM robinhood_wallet_transfer_reorg_journal`
    );
    assert.deepEqual(remaining.rows, [{ block_number: '101' }]);
  });
});
