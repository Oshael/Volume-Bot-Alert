process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodTokenTransferRepository } =
  require('../src/models/robinhood-token-transfer-persistence');
const { createRobinhoodWalletTransferRetentionTransaction } =
  require('../src/models/robinhood-wallet-transfer-retention-transaction');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const stages = [126, 128, 129, 131, 132, 191, 205, 243, 244, 245]
  .map((stage) => require(`../src/utils/db-init-stage${stage}`));

const DAY = '2099-01-09';
const PARTITION = 'robinhood_token_transfer_events_2099_01_09';
const HASH = `0x${'7'.repeat(63)}8`;
const PARENT = `0x${'6'.repeat(64)}`;
let previousCapture;
let previousTransfer;
let previousPosition;

async function cleanup() {
  await db.query("DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version='rh_transfer_v1' AND partition_day=$1",
    [DAY]);
  await db.query('DELETE FROM robinhood_wallet_position_reorg_preimages WHERE checkpoint_hash=$1',
    [HASH]);
  await db.query("DELETE FROM robinhood_wallet_position_cursors WHERE projection_version='unified_transfer_v1' AND stream='live'");
  await db.query("DELETE FROM robinhood_wallet_transfer_cursors WHERE projection_version='rh_transfer_v1' AND stream='live'");
  await db.query('DELETE FROM robinhood_chain_blocks WHERE block_hash=$1', [HASH]);
  await db.query(`DROP TABLE IF EXISTS public.${PARTITION}`);
}

describe('Robinhood transfer retention transaction SQL', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    for (const stage of stages) await stage.init({ closePool: false });
    previousCapture = (await db.query(
      "SELECT * FROM robinhood_chain_capture_cursor WHERE chain='robinhood'"
    )).rows[0] || null;
    previousTransfer = (await db.query("SELECT * FROM robinhood_wallet_transfer_cursors WHERE projection_version='rh_transfer_v1' AND stream='live'" )).rows[0] || null;
    previousPosition = (await db.query("SELECT * FROM robinhood_wallet_position_cursors WHERE projection_version='unified_transfer_v1' AND stream='live'" )).rows[0] || null;
    await cleanup();
    await createRobinhoodTokenTransferRepository({ database: db }).ensurePartitionForDay(DAY);
    await db.query(
      `INSERT INTO robinhood_chain_capture_cursor (
         chain, next_block, checkpoint_block, checkpoint_hash,
         node_head, finalized_head, recovery_state
       ) VALUES ('robinhood', 101, 100, $1, 100, 100, 'running')
       ON CONFLICT (chain) DO UPDATE SET next_block=101, checkpoint_block=100,
         checkpoint_hash=$1, node_head=100, finalized_head=100,
         recovery_state='running', recovery_plan=NULL, recovery_detected_at=NULL`,
      [HASH]
    );
    await db.query(
      `INSERT INTO robinhood_chain_blocks (
         chain, block_number, block_hash, parent_hash, capture_digest,
         block_timestamp, finality, canonical, head_observed_at, receipts_available_at
       ) VALUES ('robinhood', 100, $1, $2, $1,
         '2099-01-09T12:00:00Z', 'finalized', true, NOW(), NOW())`,
      [HASH, PARENT]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_cursors (
         projection_version, stream, origin_block, next_block, next_block_time,
         safe_head, checkpoint_block, checkpoint_hash, lifecycle_state
       ) VALUES ('rh_transfer_v1', 'live', 1, 101,
         '2099-01-10T00:00:00Z', 100, 100, $1, 'running')`, [HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_position_cursors (
         projection_version, stream, origin_block, next_block, safe_head,
         checkpoint_block, checkpoint_hash, lifecycle_state
       ) VALUES ('unified_transfer_v1', 'live', 1, 101, 100, 100, $1, 'running')`,
      [HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_position_reorg_preimages (
         chain, projection_version, from_block, through_block, checkpoint_hash,
         block_time, record_kind, identity_key, had_previous, previous_row, expires_at
       ) VALUES ('robinhood', 'unified_transfer_v1', 100, 100, $1,
         '2099-01-09T12:00:00Z', 'batch', 'batch', false, NULL,
         '2099-01-12T12:00:00Z')`, [HASH]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_compaction_watermarks (
         chain, projection_version, partition_day, lifecycle_state,
         cursor_next_block, cursor_next_transaction_index, cursor_next_log_index,
         cursor_next_block_time, checkpoint_block, checkpoint_hash,
         position_projection_version, position_next_block, summary_reconciled,
         position_complete, evidence_complete, cursor_complete, checkpoint_canonical,
         audited_at, verified_at
       ) VALUES ('robinhood', 'rh_transfer_v1', $1, 'verified', 101, 0, 0,
         '2099-01-10T00:00:00Z', 100, $2, 'unified_transfer_v1', 101,
         true, true, true, true, true, NOW(), NOW())`, [DAY, HASH]
    );
  });

  after(async () => {
    await cleanup();
    if (previousTransfer) await db.query(
      'INSERT INTO robinhood_wallet_transfer_cursors SELECT * FROM json_populate_record(NULL::robinhood_wallet_transfer_cursors, $1::json)',
      [JSON.stringify(previousTransfer)]
    );
    if (previousPosition) await db.query(
      'INSERT INTO robinhood_wallet_position_cursors SELECT * FROM json_populate_record(NULL::robinhood_wallet_position_cursors, $1::json)',
      [JSON.stringify(previousPosition)]
    );
    if (previousCapture) {
      await db.query(
        `UPDATE robinhood_chain_capture_cursor SET next_block=$1,
           checkpoint_block=$2, checkpoint_hash=$3, node_head=$4,
           finalized_head=$5, recovery_state=$6, recovery_plan=$7,
           recovery_detected_at=$8 WHERE chain='robinhood'`,
        [previousCapture.next_block, previousCapture.checkpoint_block,
          previousCapture.checkpoint_hash, previousCapture.node_head,
          previousCapture.finalized_head, previousCapture.recovery_state,
          previousCapture.recovery_plan, previousCapture.recovery_detected_at]
      );
    } else await db.query("DELETE FROM robinhood_chain_capture_cursor WHERE chain='robinhood'");
    await db.pool.end();
  });

  it('revalidates a real empty partition and rolls back a rejected action', async () => {
    const gate = createRobinhoodWalletTransferRetentionTransaction({ database: db });
    const input = { day: DAY, expectedWatermarkVersion: '0', now: '2099-02-15T00:00:00Z' };
    let ran = false;
    await assert.rejects(gate.withVerifiedPartition(input, async (client) => {
      ran = true;
      await client.query('UPDATE robinhood_wallet_transfer_compaction_watermarks SET version=1 WHERE partition_day=$1',
        [DAY]);
      throw new Error('abort test action');
    }), /abort test action/);
    assert.equal(ran, true);
    const state = (await db.query(
      'SELECT version::text FROM robinhood_wallet_transfer_compaction_watermarks WHERE partition_day=$1',
      [DAY]
    )).rows[0];
    assert.equal(state.version, '0');
  });

  it('rejects a raw row added after the verified watermark', async () => {
    await db.query(
      `INSERT INTO public.${PARTITION} (
         chain, block_number, block_hash, block_time, transaction_hash,
         transaction_index, log_index, token_address, from_wallet, to_wallet,
         amount_raw, transfer_kind, classification_version
       ) VALUES ('robinhood', 100, $1, '2099-01-09T12:00:00Z', $2,
         0, 1, $3, $4, $5, 7, 'unknown', 'rh_transfer_v1')`,
      [HASH, `0x${'a'.repeat(64)}`, `0x${'b'.repeat(40)}`,
        `0x${'c'.repeat(40)}`, `0x${'d'.repeat(40)}`]
    );
    const gate = createRobinhoodWalletTransferRetentionTransaction({ database: db });
    await assert.rejects(gate.withVerifiedPartition({
      day: DAY, expectedWatermarkVersion: '0', now: '2099-02-15T00:00:00Z',
    }, async () => { throw new Error('action must not run'); }), /no longer reconcile/);
  });
});
