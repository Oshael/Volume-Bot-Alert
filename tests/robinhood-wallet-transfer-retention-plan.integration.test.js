process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodTokenTransferRepository } = require('../src/models/robinhood-token-transfer-persistence');
const { createRobinhoodWalletTransferRetentionPlanner } = require('../src/models/robinhood-wallet-transfer-retention-plan');
const stage128 = require('../src/utils/db-init-stage128');
const stage132 = require('../src/utils/db-init-stage132');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_retention_plan_v1';
const READY_DAY = '2099-01-03';
const MISSING_DAY = '2099-01-04';
const READY_PARTITION = 'robinhood_token_transfer_events_2099_01_03';
const HASH = `0x${'a'.repeat(64)}`;

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
  await db.query('DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1', [VERSION]);
}

describe('Robinhood wallet transfer retention plan integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage128.init({ closePool: false });
    await stage132.init({ closePool: false });
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
});
