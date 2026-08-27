process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodBundleFundingBackfillRepository } = require(
  '../src/models/robinhood-bundle-funding-backfill'
);
const { inspectRecovery, resetRun } = require(
  '../src/utils/recover-robinhood-bundle-funding-v1'
);
const stage167 = require('../src/utils/db-init-stage167');
const stage169 = require('../src/utils/db-init-stage169');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const FROM = `0x${'1'.repeat(40)}`;
const TO = `0x${'2'.repeat(40)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_bundle_funding_evidence');
  await db.query('DELETE FROM robinhood_native_funding_edges');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_ranges');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_candidates');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_runs');
}

async function createV1Run() {
  const run = await db.query(`INSERT INTO robinhood_bundle_funding_backfill_runs (
    evidence_version, source_from_block, source_through_block, source_through_hash,
    lookback_blocks, batch_blocks, concurrency, candidate_count, range_count,
    blocks_total, status, started_at
  ) VALUES ('rh_native_funding_v1', 0, 200, $1, 1000, 50, 1, 0, 2, 22,
    'running', NOW()) RETURNING id`, [HASH]);
  await db.query(`INSERT INTO robinhood_bundle_funding_backfill_ranges (
    run_id, range_index, from_block, through_block, status,
    completed_through_hash, blocks_scanned, native_transfers_scanned,
    raw_events_written, edges_written, started_at, completed_at
  ) VALUES ($1, 0, 100, 110, 'completed', $2, 11, 20, 2, 1, NOW(), NOW()),
           ($1, 1, 190, 200, 'pending', NULL, 0, 0, 0, 0, NULL, NULL)`,
  [run.rows[0].id, HASH]);
  await db.query(`INSERT INTO robinhood_native_funding_edges (
    from_wallet, to_wallet, evidence_version,
    first_block_number, first_block_hash, first_block_time,
    first_transaction_hash, first_transaction_index,
    last_block_number, last_block_hash, last_block_time,
    last_transaction_hash, last_transaction_index, transfer_count, total_value_wei
  ) VALUES ($1, $2, 'rh_native_funding_v1', 100, $3, NOW(), $4, 0,
    100, $3, NOW(), $4, 0, 1, 10)`, [FROM, TO, HASH, TX]);
  return String(run.rows[0].id);
}

describe('Robinhood bundle funding v1 recovery persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage167.init({ closePool: false });
    await stage169.init({ closePool: false });
    await cleanup();
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('fails closed on active leases, then resets every range for explicit v2 retry', async () => {
    const runId = await createV1Run();
    await db.query(`UPDATE robinhood_bundle_funding_backfill_ranges SET
      status = 'leased', lease_owner = 'old-runner', lease_until = NOW() + INTERVAL '5 minutes',
      attempt_count = 1, started_at = NOW() WHERE run_id = $1 AND range_index = 1`, [runId]);
    assert.equal((await inspectRecovery(db, runId)).ready, false);
    await assert.rejects(resetRun(db, runId), /active_range_leases/);
    await db.query(`UPDATE robinhood_bundle_funding_backfill_ranges SET
      status = 'pending', lease_owner = NULL, lease_until = NULL
      WHERE run_id = $1 AND range_index = 1`, [runId]);

    const reset = await resetRun(db, runId);
    assert.equal(reset.resetRanges, 2);
    assert.equal(reset.evidenceVersion, 'rh_native_funding_v2');
    assert.deepEqual((await db.query(`SELECT status, evidence_version
      FROM robinhood_bundle_funding_backfill_runs WHERE id = $1`, [runId])).rows[0], {
      status: 'failed', evidence_version: 'rh_native_funding_v2',
    });
    assert.deepEqual((await db.query(`SELECT evidence_version, COUNT(*)::integer count
      FROM robinhood_native_funding_edges GROUP BY evidence_version`)).rows, [{
      evidence_version: 'rh_native_funding_v1', count: 1,
    }]);
    assert.deepEqual((await db.query(`SELECT status, COUNT(*)::integer count,
      SUM(blocks_scanned)::integer blocks, MIN(last_error_code) error
      FROM robinhood_bundle_funding_backfill_ranges WHERE run_id = $1
      GROUP BY status`, [runId])).rows, [{
      status: 'failed', count: 2, blocks: 0, error: 'evidence_version_reset',
    }]);

    const repository = createRobinhoodBundleFundingBackfillRepository({ database: db });
    assert.deepEqual(await repository.resumeFailed(runId), { runId, requeued: 2 });
    assert.deepEqual(await repository.getProgress(runId), {
      status: 'running', total: 2, pending: 2, leased: 0, completed: 0, failed: 0,
    });
  });
});
