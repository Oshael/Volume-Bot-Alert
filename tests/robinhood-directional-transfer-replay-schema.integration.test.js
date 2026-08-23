process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage154 = require('../src/utils/db-init-stage154');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_directional_transfer_replay_ranges');
  await db.query('DELETE FROM robinhood_directional_transfer_replay_runs');
}

async function insertRun(projectionVersion = 'test_directional_v1') {
  return db.query(
    `INSERT INTO robinhood_directional_transfer_replay_runs (
       projection_version, source_from_block, source_through_block,
       source_through_hash, range_blocks
     ) VALUES ($1, 100, 199, $2, 50) RETURNING id`,
    [projectionVersion, HASH]
  );
}

describe('Robinhood directional transfer replay control schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage154.init({ closePool: false });
    await stage154.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('enforces one active campaign, lease ownership and canonical completion', async () => {
    const run = await insertRun();
    await assert.rejects(insertRun(), /idx_rh_directional_replay_runs_active/);

    const range = await db.query(
      `INSERT INTO robinhood_directional_transfer_replay_ranges (
         run_id, range_start_block, range_end_block
       ) VALUES ($1, 100, 149) RETURNING id`,
      [run.rows[0].id]
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_directional_transfer_replay_ranges
            SET status = 'leased' WHERE id = $1`, [range.rows[0].id]
      ),
      /rh_directional_replay_ranges_lease_check/
    );
    await db.query(
      `UPDATE robinhood_directional_transfer_replay_ranges SET
         status = 'leased', lease_owner = 'test-worker',
         lease_until = NOW() + INTERVAL '1 minute', attempt_count = 1,
         started_at = NOW() WHERE id = $1`,
      [range.rows[0].id]
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_directional_transfer_replay_ranges SET
           status = 'completed', lease_owner = NULL, lease_until = NULL,
           completed_at = NOW(), completed_through_block = 148,
           completed_through_hash = $2 WHERE id = $1`,
        [range.rows[0].id, HASH]
      ),
      /rh_directional_replay_ranges_completion_check/
    );
    await db.query(
      `UPDATE robinhood_directional_transfer_replay_ranges SET
         status = 'completed', lease_owner = NULL, lease_until = NULL,
         blocks_scanned = 50, transfers_scanned = 20,
         edges_considered = 10, edges_written = 8,
         completed_at = NOW(), completed_through_block = range_end_block,
         completed_through_hash = $2 WHERE id = $1`,
      [range.rows[0].id, HASH]
    );
    const completed = await db.query(
      `SELECT status, blocks_scanned::text, transfers_scanned::text,
              edges_considered::text, edges_written::text,
              completed_through_block::text, completed_through_hash
         FROM robinhood_directional_transfer_replay_ranges WHERE id = $1`,
      [range.rows[0].id]
    );
    assert.deepEqual(completed.rows[0], {
      status: 'completed', blocks_scanned: '50', transfers_scanned: '20',
      edges_considered: '10', edges_written: '8',
      completed_through_block: '149', completed_through_hash: HASH,
    });
  });
});
