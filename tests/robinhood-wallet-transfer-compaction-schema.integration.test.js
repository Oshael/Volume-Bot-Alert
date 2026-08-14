process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage132 = require('../src/utils/db-init-stage132');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const VERSION = 'test_transfer_compaction_v1';
const DAY = '2099-01-01';
const HASH = `0x${'a'.repeat(64)}`;

async function cleanup() {
  await db.query(
    'DELETE FROM robinhood_wallet_transfer_compaction_watermarks WHERE projection_version = $1',
    [VERSION]
  );
}

function verifyWatermark(summaryCount) {
  return db.query(
    `UPDATE robinhood_wallet_transfer_compaction_watermarks SET
       lifecycle_state = 'verified', raw_event_count = 3,
       target_classified_event_count = 3, eligible_transfer_count = 2,
       eligible_amount_raw = 50, summary_transfer_count = $3,
       summary_amount_raw = 50, raw_last_block = 100,
       raw_last_transaction_index = 4, raw_last_log_index = 7,
       cursor_next_block = 101, cursor_next_transaction_index = 0,
       cursor_next_log_index = 0, cursor_next_block_time = '2099-01-02T00:00:00Z',
       checkpoint_block = 100, checkpoint_hash = $4,
       position_projection_version = 'unified_v1', position_next_block = 101,
       summary_reconciled = true, position_complete = true,
       evidence_complete = true, cursor_complete = true,
       checkpoint_canonical = true, audited_at = NOW(), verified_at = NOW(),
       version = version + 1, updated_at = NOW()
     WHERE chain = 'robinhood' AND projection_version = $1 AND partition_day = $2`,
    [VERSION, DAY, summaryCount, HASH]
  );
}

describe('Robinhood wallet transfer compaction watermark schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage132.init({ closePool: false });
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('allows verified only after every reconciliation gate passes', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_compaction_watermarks (
         chain, projection_version, partition_day
       ) VALUES ('robinhood', $1, $2)`,
      [VERSION, DAY]
    );
    await assert.rejects(
      verifyWatermark(1),
      /rh_wallet_transfer_compaction_reconciliation_check/
    );
    await verifyWatermark(2);
    await stage132.init({ closePool: false });

    const stored = await db.query(
      `SELECT lifecycle_state, raw_event_count::text,
              target_classified_event_count::text, eligible_transfer_count::text,
              summary_transfer_count::text, version::text
       FROM robinhood_wallet_transfer_compaction_watermarks
       WHERE projection_version = $1`,
      [VERSION]
    );
    assert.deepEqual(stored.rows[0], {
      lifecycle_state: 'verified', raw_event_count: '3',
      target_classified_event_count: '3', eligible_transfer_count: '2',
      summary_transfer_count: '2', version: '1',
    });
    await assert.rejects(
      db.query(
        `UPDATE robinhood_wallet_transfer_compaction_watermarks
         SET lifecycle_state = 'dropped' WHERE projection_version = $1`,
        [VERSION]
      ),
      /rh_wallet_transfer_compaction_lifecycle_check/
    );
  });
});
