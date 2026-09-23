'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const retention = require('../src/services/robinhood-retention-worker');
const stage191 = require('../src/utils/db-init-stage191');
const stage245 = require('../src/utils/db-init-stage245');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'retention_test_v1';
const HASH = `0x${'1'.repeat(64)}`;

async function clear() {
  await db.query(
    'DELETE FROM robinhood_wallet_position_reorg_preimages WHERE projection_version=$1',
    [VERSION]
  );
  await db.query("DELETE FROM robinhood_chain_capture_cursor WHERE chain='robinhood'");
}

describe('Robinhood wallet-position preimage retention', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage191.init({ closePool: false });
    await stage245.init({ closePool: false });
    await clear();
  });
  after(async () => {
    await clear().catch(() => {});
    await db.pool.end().catch(() => {});
  });

  it('deletes only expired rows through the finalized head and respects batch limit', async () => {
    await db.query(
      `INSERT INTO robinhood_chain_capture_cursor (
         chain, next_block, checkpoint_block, checkpoint_hash, node_head, finalized_head
       ) VALUES ('robinhood', 102, 101, $1, 105, 100)`,
      [HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_position_reorg_preimages (
         chain, projection_version, from_block, through_block, checkpoint_hash,
         block_time, record_kind, identity_key, had_previous, previous_row, expires_at
       ) VALUES
         ('robinhood',$1,100,100,$2,NOW()-INTERVAL '4 days',
          'batch','batch',FALSE,NULL,NOW()-INTERVAL '1 day'),
         ('robinhood',$1,100,100,$2,NOW()-INTERVAL '4 days',
          'position',$3,FALSE,NULL,NOW()-INTERVAL '1 day'),
         ('robinhood',$1,101,101,$2,NOW()-INTERVAL '4 days',
          'batch','batch',FALSE,NULL,NOW()-INTERVAL '1 day'),
         ('robinhood',$1,99,99,$2,NOW()-INTERVAL '2 days',
          'batch','batch',FALSE,NULL,NOW()+INTERVAL '1 day')`,
      [VERSION, HASH, `0x${'2'.repeat(40)}:0x${'3'.repeat(40)}`]
    );

    const options = { batchLimit: 1, statementTimeoutMs: 2500 };
    assert.equal(await retention.__private.deleteExpiredPositionPreimages(db, options), 1);
    assert.equal(await retention.__private.deleteExpiredPositionPreimages(db, options), 1);
    assert.equal(await retention.__private.deleteExpiredPositionPreimages(db, options), 0);
    const remaining = await db.query(
      `SELECT through_block::text, record_kind
        FROM robinhood_wallet_position_reorg_preimages
        WHERE projection_version=$1
        ORDER BY robinhood_wallet_position_reorg_preimages.through_block`,
      [VERSION]
    );
    assert.deepEqual(remaining.rows, [
      { through_block: '99', record_kind: 'batch' },
      { through_block: '101', record_kind: 'batch' },
    ]);
  });
});
