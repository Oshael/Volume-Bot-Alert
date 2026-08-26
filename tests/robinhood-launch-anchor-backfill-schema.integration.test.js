process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage166 = require('../src/utils/db-init-stage166');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const FAILED_TOKEN = `0x${'2'.repeat(40)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_launch_anchor_backfill_targets');
  await db.query('DELETE FROM robinhood_launch_anchor_backfill_runs');
}

describe('Robinhood launch-anchor backfill control schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage166.init({ closePool: false });
    await stage166.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('enforces one active run, lease ownership and terminal outcomes', async () => {
    const run = await db.query(
      `INSERT INTO robinhood_launch_anchor_backfill_runs(source_through_block)
       VALUES (200) RETURNING id`
    );
    await assert.rejects(
      db.query(`INSERT INTO robinhood_launch_anchor_backfill_runs(source_through_block)
                VALUES (300)`),
      /idx_rh_launch_anchor_backfill_runs_active/
    );
    await db.query(
      `INSERT INTO robinhood_launch_anchor_backfill_targets(
         run_id, token_address, first_pool_block,
         source_through_block, source_through_hash
       ) VALUES ($1, $2, 100, 200, $4), ($1, $3, 100, 200, $4)`,
      [run.rows[0].id, TOKEN, FAILED_TOKEN, HASH]
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_launch_anchor_backfill_targets
            SET status = 'leased' WHERE run_id = $1 AND token_address = $2`,
        [run.rows[0].id, TOKEN]
      ),
      /rh_launch_anchor_backfill_targets_lease_check/
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_launch_anchor_backfill_targets SET
           status = 'completed', completed_at = NOW(),
           anchor_block = 99, anchors_written = 1
         WHERE run_id = $1 AND token_address = $2`,
        [run.rows[0].id, TOKEN]
      ),
      /rh_launch_anchor_backfill_targets_completion_check/
    );
    await db.query(
      `UPDATE robinhood_launch_anchor_backfill_targets SET
         status = 'completed', completed_at = NOW(),
         anchor_block = 101, anchors_written = 1, swaps_considered = 4
       WHERE run_id = $1 AND token_address = $2`,
      [run.rows[0].id, TOKEN]
    );
    const target = await db.query(
      `SELECT status, anchor_block::text, swaps_considered::text, anchors_written
         FROM robinhood_launch_anchor_backfill_targets
        WHERE run_id = $1 AND token_address = $2`,
      [run.rows[0].id, TOKEN]
    );
    assert.deepEqual(target.rows[0], {
      status: 'completed', anchor_block: '101',
      swaps_considered: '4', anchors_written: 1,
    });
    await assert.rejects(
      db.query(
        `UPDATE robinhood_launch_anchor_backfill_targets
            SET status = 'failed' WHERE run_id = $1 AND token_address = $2`,
        [run.rows[0].id, FAILED_TOKEN]
      ),
      /rh_launch_anchor_backfill_targets_completion_check/
    );
    await db.query(
      `UPDATE robinhood_launch_anchor_backfill_targets SET
         status = 'failed', completed_at = NOW(),
         last_error_code = 'retry_exhausted', last_error_message = 'timed out'
       WHERE run_id = $1 AND token_address = $2`,
      [run.rows[0].id, FAILED_TOKEN]
    );
  });
});
