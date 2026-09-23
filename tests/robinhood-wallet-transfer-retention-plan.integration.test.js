process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodTokenTransferRepository } = require('../src/models/robinhood-token-transfer-persistence');
const { createRobinhoodWalletTransferRetentionPlanner } = require('../src/models/robinhood-wallet-transfer-retention-plan');
const { createRobinhoodWalletTransferRetentionReadiness } = require('../src/models/robinhood-wallet-transfer-retention-readiness');
const stage128 = require('../src/utils/db-init-stage128');
const stage132 = require('../src/utils/db-init-stage132');
const stage243 = require('../src/utils/db-init-stage243');
const stage244 = require('../src/utils/db-init-stage244');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_retention_plan_v1';
const READY_DAY = '2099-01-03';
const MISSING_DAY = '2099-01-04';
const READY_PARTITION = 'robinhood_token_transfer_events_2099_01_03';
const HASH = `0x${'a'.repeat(64)}`;
const UNKNOWN_TX = `0x${'b'.repeat(64)}`;

async function insertVerified(day) {
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
    [VERSION, day, HASH]
  );
}
async function cleanup() {
  await db.query('DELETE FROM robinhood_wallet_transfer_evidence_dispositions WHERE transaction_hash = $1', [UNKNOWN_TX]);
  await db.query('DELETE FROM robinhood_wallet_transfer_pending_evidence WHERE transaction_hash = $1', [UNKNOWN_TX]);
  await db.query('DELETE FROM robinhood_token_transfer_events WHERE transaction_hash = $1', [UNKNOWN_TX]);
  await db.query('DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1', [VERSION]);
}

describe('Robinhood wallet transfer retention plan integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage128.init({ closePool: false });
    await stage132.init({ closePool: false });
    await stage243.init({ closePool: false });
    await stage244.init({ closePool: false });
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.query(`DROP TABLE IF EXISTS ${READY_PARTITION}`);
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
});
