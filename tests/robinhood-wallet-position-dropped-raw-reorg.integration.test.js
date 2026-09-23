'use strict';

process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodWalletPositionRepository } = require('../src/models/robinhood-wallet-position');
const { createRobinhoodWalletReorgRollback } = require('../src/models/robinhood-wallet-reorg-rollback');
const stage90 = require('../src/utils/db-init-stage90');
const stage91 = require('../src/utils/db-init-stage91');
const stage109 = require('../src/utils/db-init-stage109');
const stage126 = require('../src/utils/db-init-stage126');
const stage127 = require('../src/utils/db-init-stage127');
const stage128 = require('../src/utils/db-init-stage128');
const stage132 = require('../src/utils/db-init-stage132');
const stage137 = require('../src/utils/db-init-stage137');
const stage139 = require('../src/utils/db-init-stage139');
const stage191 = require('../src/utils/db-init-stage191');
const stage203 = require('../src/utils/db-init-stage203');
const stage204 = require('../src/utils/db-init-stage204');
const stage205 = require('../src/utils/db-init-stage205');
const stage245 = require('../src/utils/db-init-stage245');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'unified_transfer_v1';
const DAY = '2099-09-29';
const TOKEN = `0x${'7'.repeat(40)}`;
const WALLET = `0x${'8'.repeat(40)}`;
const QUOTE = `0x${'9'.repeat(40)}`;
const HASH99 = `0x${'a'.repeat(64)}`;
const HASH100 = `0x${'b'.repeat(64)}`;
const HASH101 = `0x${'c'.repeat(64)}`;
const HASH102 = `0x${'d'.repeat(64)}`;
const TX100 = `0x${'e'.repeat(64)}`;
const TX101 = `0x${'f'.repeat(64)}`;
const AT100 = `${DAY}T00:01:00Z`;
const AT101 = `${DAY}T00:02:00Z`;
const AT102 = `${DAY}T00:03:00Z`;

async function fixture(client) {
  // The real rollback filters on this production version; restore any existing
  // test-database rows when the surrounding transaction rolls back.
  await client.query(
    'DELETE FROM robinhood_wallet_position_reorg_preimages WHERE projection_version=$1',
    [VERSION]
  );
  await client.query(
    'DELETE FROM robinhood_wallet_token_positions WHERE projection_version=$1',
    [VERSION]
  );
  await client.query(
    'DELETE FROM robinhood_wallet_position_cursors WHERE projection_version=$1',
    [VERSION]
  );
  await client.query("DELETE FROM robinhood_wallet_swap_cursors WHERE chain='robinhood' AND stream='live'");
  await client.query("DELETE FROM robinhood_chain_capture_cursor WHERE chain='robinhood'");
  await client.query(
    `CREATE TABLE robinhood_wallet_swaps_dropped_raw_reorg_test
       PARTITION OF robinhood_wallet_swaps
       FOR VALUES FROM ('2099-09-29T00:00:00Z') TO ('2099-09-30T00:00:00Z')`
  );
  await client.query(
    `INSERT INTO robinhood_chain_blocks (
       chain, block_number, block_hash, parent_hash, capture_digest,
       block_timestamp, head_observed_at, receipts_available_at
     ) VALUES
       ('robinhood',100,$1,$2,$1,$5,$5,$5),
       ('robinhood',101,$3,$1,$3,$6,$6,$6),
       ('robinhood',102,$4,$3,$4,$7,$7,$7)`,
    [HASH100, HASH99, HASH101, HASH102, AT100, AT101, AT102]
  );
  await client.query(
    `INSERT INTO robinhood_chain_transactions (
       chain, block_hash, transaction_hash, transaction_index,
       from_address, receipt_succeeded
     ) VALUES
       ('robinhood',$1,$3,0,$5,true),
       ('robinhood',$2,$4,0,$5,true)`,
    [HASH100, HASH101, TX100, TX101, WALLET]
  );
  await client.query(
    `INSERT INTO robinhood_transaction_positions (
       chain, transaction_hash, block_number, block_hash, transaction_index
     ) VALUES ('robinhood',$1,100,$3,0), ('robinhood',$2,101,$4,0)`,
    [TX100, TX101, HASH100, HASH101]
  );
  await client.query(
    `INSERT INTO robinhood_wallet_swaps (
       chain, wallet_address, transaction_hash, action_index, block_number,
       block_time, protocol, market_key, token_address, quote_address,
       side, token_amount_raw, quote_amount_raw, volume_usd, parser_version
     ) VALUES
       ('robinhood',$1,$4,1,100,$6,'uniswap-v2','reorg-test',$2,$3,
        'buy',10,20,10,'reorg-test'),
       ('robinhood',$1,$5,1,101,$7,'uniswap-v2','reorg-test',$2,$3,
        'buy',10,20,10,'reorg-test')`,
    [WALLET, TOKEN, QUOTE, TX100, TX101, AT100, AT101]
  );
  await client.query(
    `INSERT INTO robinhood_wallet_position_cursors (
       chain, projection_version, stream, origin_block, next_block,
       safe_head, checkpoint_block, checkpoint_hash, next_block_time,
       lifecycle_state, completed_at
     ) VALUES ('robinhood',$1,'seed',99,100,99,99,$2,$3,'complete',NOW())`,
    [VERSION, HASH99, `${DAY}T00:00:00Z`]
  );
  const position = createRobinhoodWalletPositionRepository({
    database: client, positionPreimageEnabled: true,
  });
  await position.initCursor({
    projectionVersion: VERSION, stream: 'live', originBlock: '100',
    nextBlock: '100', safeHead: '102', nextBlockTime: `${DAY}T00:00:00Z`,
  });
  await client.query(
    `INSERT INTO robinhood_wallet_token_positions (
       chain, projection_version, token_address, wallet_address,
       quantity_raw, cost_basis_usd, through_block, through_log_index
     ) VALUES ('robinhood',$1,$2,$3,5,5,99,0)`,
    [VERSION, TOKEN, WALLET]
  );
  const committed = await position.commitBatch({
    projectionVersion: VERSION, stream: 'live', expectedVersion: 0,
    nextBlock: '103', safeHead: '102', checkpointBlock: '102',
    checkpointHash: HASH102, nextBlockTime: AT102,
    positions: [{ tokenAddress: TOKEN, walletAddress: WALLET,
      quantityRaw: '25', costBasisUsd: '25', throughBlock: '102', throughLogIndex: '1' }],
    transactionClient: client,
  });
  assert.equal(committed.committed, true);
  await client.query(
    `INSERT INTO robinhood_wallet_swap_cursors (
       chain, stream, next_block, safe_head, checkpoint_block,
       checkpoint_hash, checkpoint_timestamp
     ) VALUES ('robinhood','live',103,102,102,$1,$2)`,
    [HASH102, AT102]
  );
  await client.query(
    `INSERT INTO robinhood_chain_capture_cursor (
       chain, next_block, checkpoint_block, checkpoint_hash,
       node_head, finalized_head, generation, recovery_state,
       recovery_plan, recovery_detected_at
     ) VALUES ('robinhood',103,102,$1,102,99,1,'recovery_required','{}',NOW())`,
    [HASH102]
  );
  await client.query(
    `INSERT INTO robinhood_wallet_transfer_compaction_watermarks (
       chain, projection_version, partition_day, lifecycle_state,
       cursor_next_block, cursor_next_transaction_index, cursor_next_log_index,
       cursor_next_block_time, checkpoint_block, checkpoint_hash,
       position_projection_version, position_next_block,
       summary_reconciled, position_complete, evidence_complete,
       cursor_complete, checkpoint_canonical, audited_at, verified_at, dropped_at
     ) VALUES ('robinhood','rh_transfer_v1',$1::date,'dropped',
       103,0,0,'2099-09-30T00:00:00Z',102,$2,$3,103,
       true,true,true,true,true,NOW(),NOW(),NOW())`,
    [DAY, HASH102, VERSION]
  );
  const raw = await client.query(
    `SELECT COUNT(*)::int AS count FROM robinhood_token_transfer_events
      WHERE block_time >= $1::timestamptz AND block_time < $2::timestamptz`,
    [`${DAY}T00:00:00Z`, '2099-09-30T00:00:00Z']
  );
  assert.equal(raw.rows[0].count, 0);
}

async function state(client) {
  const position = await client.query(
    `SELECT quantity_raw::text AS quantity, cost_basis_usd::text AS cost
       FROM robinhood_wallet_token_positions
      WHERE chain='robinhood' AND projection_version=$1
        AND token_address=$2 AND wallet_address=$3`,
    [VERSION, TOKEN, WALLET]
  );
  const cursor = await client.query(
    `SELECT next_block::text, checkpoint_block::text, checkpoint_hash,
            version::text FROM robinhood_wallet_position_cursors
      WHERE chain='robinhood' AND projection_version=$1 AND stream='live'`,
    [VERSION]
  );
  return { position: position.rows[0], cursor: cursor.rows[0] };
}

describe('Robinhood position reorg after transfer raw was dropped', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of [stage90, stage91, stage109, stage126, stage127, stage128,
      stage132, stage137, stage139, stage191, stage203, stage204, stage205,
      stage245]) await stage.init({ closePool: false });
  });
  after(async () => { await db.pool.end().catch(() => {}); });

  it('fails closed on a preimage gap, then restores and replays the canonical prefix', async () => {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await fixture(client);
      const range = {
        generation: '1', checkpointHash: HASH102,
        ancestorBlock: '100', ancestorHash: HASH100, ancestorTimestamp: AT100,
        fromBlock: '101', throughBlock: '102',
        fromTimestamp: AT101, throughTimestamp: AT102,
      };
      const before = await state(client);
      assert.deepEqual(before.position, { quantity: '25', cost: '25' });
      await client.query('SAVEPOINT complete_fixture');
      await client.query(
        `DELETE FROM robinhood_wallet_position_reorg_preimages
          WHERE chain='robinhood' AND projection_version=$1 AND record_kind='batch'`,
        [VERSION]
      );
      await client.query('SAVEPOINT bad_attempt');
      await assert.rejects(
        createRobinhoodWalletReorgRollback().rollback(client, range),
        { code: 'archive_required', message: /position preimage gap/ }
      );
      await client.query('ROLLBACK TO SAVEPOINT bad_attempt');
      assert.deepEqual(await state(client), before);
      await client.query('ROLLBACK TO SAVEPOINT complete_fixture');
      await client.query('SAVEPOINT position_evidence_fixture');
      await client.query(
        `DELETE FROM robinhood_wallet_position_reorg_preimages
          WHERE chain='robinhood' AND projection_version=$1 AND record_kind='position'`,
        [VERSION]
      );
      await client.query('SAVEPOINT missing_position_attempt');
      await assert.rejects(
        createRobinhoodWalletReorgRollback().rollback(client, range),
        { code: 'archive_required', message: /position preimage is missing/ }
      );
      await client.query('ROLLBACK TO SAVEPOINT missing_position_attempt');
      assert.deepEqual(await state(client), before);
      await client.query('ROLLBACK TO SAVEPOINT position_evidence_fixture');

      const summary = await createRobinhoodWalletReorgRollback().rollback(client, range);
      assert.deepEqual(summary.positionRollback, {
        projections: 1, affectedPositions: 1, removedPositions: 2,
        rebuiltPositions: 2, cursorsRewound: 1,
      });
      assert.equal(summary.cursorRewound, true);
      assert.equal(summary.deletedSwaps, 1);
      assert.equal(summary.deletedTransactionPositions, 1);
      const remainingSwaps = await client.query(
        `SELECT transaction_hash FROM robinhood_wallet_swaps
          WHERE transaction_hash IN ($1,$2) ORDER BY transaction_hash`,
        [TX100, TX101]
      );
      assert.deepEqual(remainingSwaps.rows, [{ transaction_hash: TX100 }]);
      const after = await state(client);
      assert.deepEqual(after.position, { quantity: '15', cost: '15' });
      assert.deepEqual(after.cursor, {
        next_block: '101', checkpoint_block: '100', checkpoint_hash: HASH100,
        version: '2',
      });
      const markers = await client.query(
        `SELECT from_block::text, through_block::text, checkpoint_hash
           FROM robinhood_wallet_position_reorg_preimages
          WHERE chain='robinhood' AND projection_version=$1 AND record_kind='batch'`,
        [VERSION]
      );
      assert.deepEqual(markers.rows, [{
        from_block: '100', through_block: '100', checkpoint_hash: HASH100,
      }]);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
