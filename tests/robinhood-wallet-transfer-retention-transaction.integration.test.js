process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodTokenTransferRepository } =
  require('../src/models/robinhood-token-transfer-persistence');
const { createRobinhoodWalletTransferRetentionTransaction } =
  require('../src/models/robinhood-wallet-transfer-retention-transaction');
const { createRobinhoodWalletTransferRetentionPilot, __private: pilotProof } =
  require('../src/models/robinhood-wallet-transfer-retention-pilot');
const sampledReport = require('../docs/robinhood-transfer-raw-pilot-2026-07-19-report.json');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const stages = [126, 128, 129, 131, 132, 191, 205, 243, 244, 245]
  .map((stage) => require(`../src/utils/db-init-stage${stage}`));

const DAY = '2026-07-19';
const PARTITION = 'robinhood_token_transfer_events_2026_07_19';
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
    const existing = await db.query(
      "SELECT to_regclass($1) AS partition, EXISTS (SELECT 1 FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version='rh_transfer_v1' AND partition_day=$2::date) AS watermark",
      [`public.${PARTITION}`, DAY]
    );
    assert.equal(existing.rows[0].partition, null);
    assert.equal(existing.rows[0].watermark, false);
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
         '2026-07-19T12:00:00Z', 'finalized', true, NOW(), NOW())`,
      [HASH, PARENT]
    );
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_cursors (
         projection_version, stream, origin_block, next_block, next_block_time,
         safe_head, checkpoint_block, checkpoint_hash, lifecycle_state
       ) VALUES ('rh_transfer_v1', 'live', 1, 101,
         '2026-07-20T00:00:00Z', 100, 100, $1, 'running')`, [HASH]
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
         '2026-07-19T12:00:00Z', 'batch', 'batch', false, NULL,
         '2026-07-22T12:00:00Z')`, [HASH]
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
         '2026-07-20T00:00:00Z', 100, $2, 'unified_transfer_v1', 101,
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
    const input = { day: DAY, expectedWatermarkVersion: '0', now: '2026-09-23T00:00:00Z' };
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

  it('ignores summaries from another day during pilot reconciliation', async () => {
    const token = `0x${'9'.repeat(40)}`;
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_daily_summaries (
        chain, projection_version, summary_day, token_address,
        transfer_count, total_amount_raw, wallet_transfer_count,
        wallet_transfer_amount_raw, dex_flow_count, dex_flow_amount_raw,
        through_block, through_transaction_index, through_log_index, through_block_time
      ) VALUES ('robinhood', 'rh_transfer_v1', '2026-07-20', $1,
        1, 7, 1, 7, 0, 0, 100, 0, 0, '2026-07-20T12:00:00Z')`, [token]
    );
    try {
      const gate = createRobinhoodWalletTransferRetentionTransaction({ database: db });
      await assert.rejects(gate.withVerifiedPartition({
        day: DAY, expectedWatermarkVersion: '0', now: '2026-09-23T00:00:00Z',
      }, async () => { throw new Error('reconciliation passed'); }), /reconciliation passed/);
      await db.query(
        `UPDATE robinhood_wallet_transfer_daily_summaries
            SET summary_day=$1::date, through_block_time='2026-07-19T12:00:00Z'
          WHERE chain='robinhood' AND projection_version='rh_transfer_v1'
            AND summary_day='2026-07-20' AND token_address=$2`, [DAY, token]
      );
      await assert.rejects(gate.withVerifiedPartition({
        day: DAY, expectedWatermarkVersion: '0', now: '2026-09-23T00:00:00Z',
      }, async () => { throw new Error('action must not run'); }), /no longer reconcile/);
    } finally {
      await db.query(
        `DELETE FROM robinhood_wallet_transfer_daily_summaries
          WHERE chain='robinhood' AND projection_version='rh_transfer_v1'
            AND summary_day IN ('2026-07-19', '2026-07-20') AND token_address=$1`, [token]
      );
    }
  });

  it('rejects a raw row added after the verified watermark', async () => {
    await db.query(
      `INSERT INTO public.${PARTITION} (
         chain, block_number, block_hash, block_time, transaction_hash,
         transaction_index, log_index, token_address, from_wallet, to_wallet,
         amount_raw, transfer_kind, classification_version
       ) VALUES ('robinhood', 100, $1, '2026-07-19T12:00:00Z', $2,
         0, 1, $3, $4, $5, 7, 'unknown', 'rh_transfer_v1')`,
      [HASH, `0x${'a'.repeat(64)}`, `0x${'b'.repeat(40)}`,
        `0x${'c'.repeat(40)}`, `0x${'d'.repeat(40)}`]
    );
    const gate = createRobinhoodWalletTransferRetentionTransaction({ database: db });
    await assert.rejects(gate.withVerifiedPartition({
      day: DAY, expectedWatermarkVersion: '0', now: '2026-09-23T00:00:00Z',
    }, async () => { throw new Error('action must not run'); }), /no longer reconcile/);
  });

  it('rolls back a physical DROP when the transaction fails', async () => {
    await db.query(`DELETE FROM public.${PARTITION}`);
    const gate = createRobinhoodWalletTransferRetentionTransaction({ database: db });
    await assert.rejects(gate.withVerifiedPartition({
      day: DAY, expectedWatermarkVersion: '0', now: '2026-09-23T00:00:00Z',
    }, async (client, candidate) => {
      await client.query(`DROP TABLE ${candidate.partition}`);
      throw new Error('abort physical drop');
    }), /abort physical drop/);
    const state = (await db.query(
      "SELECT to_regclass($1) IS NOT NULL AS partition_present, (SELECT lifecycle_state FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version='rh_transfer_v1' AND partition_day=$2::date) AS lifecycle_state",
      [`public.${PARTITION}`, DAY]
    )).rows[0];
    assert.deepEqual(state, { partition_present: true, lifecycle_state: 'verified' });
  });

  it('drops only the approved pilot partition and marks its watermark atomically', async () => {
    const pilot = createRobinhoodWalletTransferRetentionPilot({ database: db });
    const result = await pilot.drop({
      day: DAY, expectedWatermarkVersion: '0', expectedCheckpointHash: HASH,
      now: '2026-09-23T00:00:00Z', apply: true, confirmed: true,
      pilotReport: { day: DAY, watermarkVersion: '0', checkpointHash: HASH,
        archiveReplay: { status: 'matched', evidenceReference: 'test-replay-report' },
        approvedBy: 'test-operator', approvedAt: '2026-09-23T00:00:00Z' },
    });
    assert.equal(result.dropped, true);
    assert.equal(result.partition, `public.${PARTITION}`);
    const state = (await db.query(
      "SELECT to_regclass($1) AS partition, (SELECT lifecycle_state FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version='rh_transfer_v1' AND partition_day=$2::date) AS lifecycle_state",
      [`public.${PARTITION}`, DAY]
    )).rows[0];
    assert.deepEqual(state, { partition: null, lifecycle_state: 'dropped' });
  });

  it('checks sampled exception anchors against persisted rows', async () => {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE sampled_exception_rows (
        chain text, transaction_hash text, log_index integer, block_time timestamptz,
        block_number bigint, block_hash text, transaction_index integer,
        transfer_kind text, classification_version text, from_wallet text, to_wallet text
      ) ON COMMIT DROP`);
      const wallet = `0x${'a'.repeat(40)}`;
      for (const item of sampledReport.archiveReplay.exceptions) {
        await client.query(
          `INSERT INTO sampled_exception_rows VALUES
             ('robinhood', $1, $2, $3::timestamptz, $4, $5, $6,
              'wallet_self', 'rh_transfer_v1', $7, $7)`,
          [item.transactionHash, item.logIndex, item.blockTime, item.blockNumber,
            item.blockHash, item.transactionIndex, wallet]
        );
      }
      await client.query(
        `INSERT INTO sampled_exception_rows
         SELECT 'robinhood', 'extra-' || n::text, n, '2026-07-19T12:00:00Z',
                100, $1, n, 'wallet_self', 'rh_transfer_v1', $2, $2
           FROM generate_series(1, 23) n`, [HASH, wallet]
      );
      await pilotProof.assertSampledExceptions(
        client, 'sampled_exception_rows', sampledReport.archiveReplay
      );
      const first = sampledReport.archiveReplay.exceptions[0];
      await client.query(
        `UPDATE sampled_exception_rows SET block_hash=$1
          WHERE transaction_hash=$2`, [HASH, first.transactionHash]
      );
      await assert.rejects(pilotProof.assertSampledExceptions(
        client, 'sampled_exception_rows', sampledReport.archiveReplay
      ), /pilot exception changed/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
