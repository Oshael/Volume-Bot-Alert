process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodTokenTransferRepository } = require('../src/models/robinhood-token-transfer-persistence');
const { createRobinhoodWalletTransferRetentionPlanner } = require('../src/models/robinhood-wallet-transfer-retention-plan');
const { createRobinhoodWalletTransferRetentionReadiness } = require('../src/models/robinhood-wallet-transfer-retention-readiness');
const { createRobinhoodWalletTransferEvidenceMigration } = require('../src/models/robinhood-wallet-transfer-evidence-migration');
const stage128 = require('../src/utils/db-init-stage128');
const stage132 = require('../src/utils/db-init-stage132');
const stage243 = require('../src/utils/db-init-stage243');
const stage244 = require('../src/utils/db-init-stage244');
const stage191 = require('../src/utils/db-init-stage191');
const stage205 = require('../src/utils/db-init-stage205');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_retention_plan_v1';
const READY_DAY = '2099-01-03';
const MISSING_DAY = '2099-01-04';
const READY_PARTITION = 'robinhood_token_transfer_events_2099_01_03';
const HASH = `0x${'a'.repeat(64)}`;
const UNKNOWN_TX = `0x${'b'.repeat(64)}`;
const MIGRATION_DAY = '2099-01-05';
const MIGRATION_PARTITION = 'robinhood_token_transfer_events_2099_01_05';
const MIGRATION_TXS = ['d', 'e', 'f'].map((digit) => `0x${digit.repeat(64)}`);
let insertedCaptureCursor = false;

async function insertVerified(day, version = VERSION) {
  return db.query(
    `INSERT INTO robinhood_wallet_transfer_compaction_watermarks (
       chain, projection_version, partition_day, lifecycle_state,
       cursor_next_block, cursor_next_transaction_index, cursor_next_log_index,
       cursor_next_block_time, checkpoint_block, checkpoint_hash,
       position_projection_version, position_next_block, summary_reconciled,
       position_complete, evidence_complete, cursor_complete, checkpoint_canonical,
       audited_at, verified_at
     ) VALUES ('robinhood', $1, $2, 'verified', 101, 0, 0,
       ($2::date + INTERVAL '1 day'), 100, $3, 'unified_v1', 101,
       true, true, true, true, true, NOW(), NOW())`,
    [version, day, HASH]
  );
}
async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = $1', [UNKNOWN_TX]);
  await db.query('DELETE FROM robinhood_wallet_transfer_pending_evidence WHERE transaction_hash = $1', [UNKNOWN_TX]);
  await db.query('DELETE FROM robinhood_token_transfer_events WHERE transaction_hash = $1', [UNKNOWN_TX]);
  await db.query('DELETE FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = ANY($1::varchar[])', [MIGRATION_TXS]);
  await db.query('DELETE FROM robinhood_wallet_transfer_pending_evidence WHERE transaction_hash = ANY($1::varchar[])', [MIGRATION_TXS]);
  await db.query('DELETE FROM robinhood_token_transfer_events WHERE transaction_hash = ANY($1::varchar[])', [MIGRATION_TXS]);
  await db.query("DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = 'rh_transfer_v1' AND partition_day = $1", [MIGRATION_DAY]);
  await db.query('DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1', [VERSION]);
}

describe('Robinhood wallet transfer retention plan integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage128.init({ closePool: false });
    await stage132.init({ closePool: false });
    await stage243.init({ closePool: false });
    await stage244.init({ closePool: false });
    await stage191.init({ closePool: false });
    await stage205.init({ closePool: false });
    await cleanup();
    const cursor = await db.query(
      `INSERT INTO robinhood_chain_capture_cursor(chain, next_block)
       VALUES ('robinhood', 1) ON CONFLICT (chain) DO NOTHING RETURNING chain`
    );
    insertedCaptureCursor = cursor.rowCount === 1;
  });
  after(async () => {
    await cleanup();
    if (insertedCaptureCursor) {
      await db.query("DELETE FROM robinhood_chain_capture_cursor WHERE chain = 'robinhood'");
    }
    await db.query(`DROP TABLE IF EXISTS ${READY_PARTITION}`);
    await db.query(`DROP TABLE IF EXISTS ${MIGRATION_PARTITION}`);
    await db.pool.end();
  });

  it('separates exact attached partitions from blocked catalog candidates', async () => {
    const raw = createRobinhoodTokenTransferRepository({ database: db });
    await raw.ensurePartitionForDay(READY_DAY);
    await insertVerified(READY_DAY);
    await insertVerified(MISSING_DAY);
    const planner = createRobinhoodWalletTransferRetentionPlanner({ database: db });
    const plan = await planner.plan({
      projectionVersion: VERSION, limit: 10, now: '2099-02-15T00:00:00Z',
    });
    assert.equal(plan.destructive, false);
    assert.equal(plan.catalogReady, 1);
    assert.equal(plan.blocked, 1);
    assert.equal(plan.candidates[0].catalogReady, true);
    assert.equal(plan.candidates[0].requiresCanonicalRevalidation, true);
    assert.deepEqual(plan.candidates[1].blockedReasons, ['partition_missing']);
  });

  it('requires a current, finalized canonical checkpoint for retention readiness', async () => {
    const client = await db.getClient();
    const day = '2099-01-07';
    const checkpointBlock = '9999999999';
    const checkpointHash = `0x${'7'.repeat(64)}`;
    const partition = 'robinhood_token_transfer_events_2099_01_07';
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO robinhood_wallet_transfer_compaction_watermarks (
           chain, projection_version, partition_day, lifecycle_state,
           cursor_next_block, cursor_next_transaction_index, cursor_next_log_index,
           cursor_next_block_time, checkpoint_block, checkpoint_hash,
           position_projection_version, position_next_block, summary_reconciled,
           position_complete, evidence_complete, cursor_complete, checkpoint_canonical,
           audited_at, verified_at
         ) VALUES ('robinhood', $1, $2, 'verified', 10000000000, 0, 0,
           '2099-01-08T00:00:00Z', $3::bigint, $4,
           'unified_transfer_v1', 10000000000, true, true, true, true, true, NOW(), NOW())`,
        [VERSION, day, checkpointBlock, checkpointHash]
      );
      await client.query(
        `INSERT INTO robinhood_chain_capture_cursor (
           chain, next_block, checkpoint_block, checkpoint_hash,
           node_head, finalized_head, recovery_state
         ) VALUES ('robinhood', 10000000000, $1::bigint, $2,
           10000000000, $1::bigint, 'running')
         ON CONFLICT (chain) DO UPDATE SET
           next_block=EXCLUDED.next_block, checkpoint_block=EXCLUDED.checkpoint_block,
           checkpoint_hash=EXCLUDED.checkpoint_hash, node_head=EXCLUDED.node_head,
           finalized_head=EXCLUDED.finalized_head, recovery_state='running',
           recovery_plan=NULL, recovery_detected_at=NULL`,
        [checkpointBlock, checkpointHash]
      );
      await client.query(
        `INSERT INTO robinhood_chain_blocks (
           chain, block_number, block_hash, parent_hash, capture_digest,
           block_timestamp, finality, canonical, head_observed_at, receipts_available_at
         ) VALUES ('robinhood', $1::bigint, $2, $3, $2,
           '2099-01-07T23:59:59Z', 'finalized', true, NOW(), NOW())`,
        [checkpointBlock, checkpointHash, `0x${'6'.repeat(64)}`]
      );
      const readiness = createRobinhoodWalletTransferRetentionReadiness({
        database: { queryWithStatementTimeout: (sql, params) => (
          sql.includes('FROM robinhood_wallet_transfer_compaction_watermarks watermark')
            ? client.query(sql, params) : Promise.resolve({ rows: [{ present: false }] })
        ) },
        planner: { plan: async () => ({
          retentionDays: 30, cutoffDay: '2099-02-01', limit: 1, hasMore: false,
          candidates: [{ partitionDay: day, expectedPartition: partition,
            actualPartition: partition, watermarkVersion: '0', catalogReady: true,
            blockedReasons: [] }],
        }) },
      });
      const inspect = async () => (await readiness.inspect({ projectionVersion: VERSION }))
        .candidates[0];
      assert.equal((await inspect()).dependencies.canonicalCheckpointNotProven.status, 'absent');
      await client.query('DELETE FROM robinhood_chain_blocks WHERE block_hash=$1',
        [checkpointHash]);
      const missing = await inspect();
      assert.equal(missing.dependencies.canonicalCheckpointNotProven.status, 'candidate');
      assert.deepEqual(missing.blockedReasons, ['canonicalCheckpointNotProven_candidate']);
      assert.equal(missing.readyForDrop, false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('requires exact active evidence for each unknown transfer', async () => {
    const raw = createRobinhoodTokenTransferRepository({ database: db });
    await raw.ensurePartitionForDay(READY_DAY);
    await db.query(
      `INSERT INTO robinhood_token_transfer_events (
         chain, block_number, block_hash, block_time, transaction_hash,
         transaction_index, log_index, token_address, from_wallet, to_wallet,
         amount_raw, transfer_kind, classification_version
       ) VALUES ('robinhood', 100, $1, '2099-01-03T12:00:00Z', $2,
         1, 2, $3, $4, $5, 75, 'unknown', $6)`,
      [HASH, UNKNOWN_TX, `0x${'c'.repeat(40)}`, `0x${'d'.repeat(40)}`,
        `0x${'e'.repeat(40)}`, VERSION]
    );
    const database = { queryWithStatementTimeout: (sql, params, timeout) => (
      sql.includes('robinhood_wallet_transfer_pending_evidence evidence')
        ? db.queryWithStatementTimeout(sql, params, timeout)
        : Promise.resolve({ rows: [{ present: false }] })
    ) };
    const readiness = createRobinhoodWalletTransferRetentionReadiness({
      database,
      planner: { plan: async () => ({
        retentionDays: 30, cutoffDay: '2099-02-01', limit: 1, hasMore: false,
        candidates: [{ partitionDay: READY_DAY, expectedPartition: READY_PARTITION,
          actualPartition: READY_PARTITION, catalogReady: true, blockedReasons: [] }],
      }) },
    });
    const coverage = async () => (await readiness.inspect()).candidates[0].dependencies.unpreservedUnknown.status;
    assert.equal(await coverage(), 'candidate');
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_pending_evidence (
         chain, block_number, block_hash, block_time, transaction_hash,
         transaction_index, log_index, token_address, from_wallet, to_wallet,
         amount_raw, classification_version
       ) SELECT chain, block_number, block_hash, block_time, transaction_hash,
           transaction_index, log_index, token_address, from_wallet, to_wallet,
           amount_raw, classification_version
         FROM robinhood_token_transfer_events WHERE transaction_hash = $1`,
      [UNKNOWN_TX]
    );
    assert.equal(await coverage(), 'absent');
    await db.query('UPDATE robinhood_wallet_transfer_pending_evidence SET amount_raw = 76 WHERE transaction_hash = $1', [UNKNOWN_TX]);
    assert.equal(await coverage(), 'candidate');
    await db.query('UPDATE robinhood_wallet_transfer_pending_evidence SET amount_raw = 75 WHERE transaction_hash = $1', [UNKNOWN_TX]);
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_evidence_dispositions (
         chain, transaction_hash, log_index, block_time, disposition, block_hash
       ) VALUES ('robinhood', $1, 2, '2099-01-03T12:00:00Z', 'orphaned', $2)`,
      [UNKNOWN_TX, HASH]
    );
    assert.equal(await coverage(), 'candidate');
  });

  it('migrates only unknowns in bounded, resumable and idempotent batches', async () => {
    const raw = createRobinhoodTokenTransferRepository({ database: db,
      preservePendingEvidence: false });
    const blockTime = `${MIGRATION_DAY}T12:00:00Z`;
    await raw.insertTransferEvents(MIGRATION_TXS.map((transactionHash, index) => ({
      blockNumber: '100', blockHash: HASH, blockTime, transactionHash,
      transactionIndex: String(index), logIndex: String(index),
      tokenAddress: `0x${'c'.repeat(40)}`, fromWallet: `0x${'d'.repeat(40)}`,
      toWallet: `0x${'e'.repeat(40)}`, amountRaw: '75',
      transferKind: index === 1 ? 'wallet_transfer' : 'unknown',
      classificationVersion: 'rh_transfer_v1',
    })));
    await insertVerified(MIGRATION_DAY, 'rh_transfer_v1');
    const migration = createRobinhoodWalletTransferEvidenceMigration({ database: db });
    const input = { day: MIGRATION_DAY, batchSize: 2, maxBatches: 1 };
    const preview = await migration.run(input);
    assert.deepEqual([preview.mode, preview.scanned, preview.unknown, preview.inserted],
      ['read-only', 2, 1, 0]);
    const count = async () => Number((await db.query(
      'SELECT COUNT(*) AS total FROM robinhood_wallet_transfer_pending_evidence WHERE transaction_hash = ANY($1::varchar[])',
      [MIGRATION_TXS]
    )).rows[0].total);
    assert.equal(await count(), 0);
    const first = await migration.run({ ...input, apply: true, confirmed: true });
    assert.deepEqual([first.scanned, first.unknown, first.inserted, first.scanComplete],
      [2, 1, 1, false]);
    assert.equal(await count(), 1);
    const repeated = await migration.run({ ...input, apply: true, confirmed: true });
    assert.equal(repeated.inserted, 0);
    const second = await migration.run({ ...input, after: first.nextCursor,
      apply: true, confirmed: true });
    assert.deepEqual([second.scanned, second.unknown, second.inserted, second.scanComplete],
      [1, 1, 1, true]);
    assert.equal(await count(), 2);
    await db.query('UPDATE robinhood_wallet_transfer_pending_evidence SET amount_raw = 76 WHERE transaction_hash = $1', [MIGRATION_TXS[0]]);
    await assert.rejects(migration.run({ ...input, apply: true, confirmed: true }),
      /conflicts with raw/);
    assert.equal(await count(), 2);
  });
});
