process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage167 = require('../src/utils/db-init-stage167');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;
const TX = `0x${'b'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const FROM = `0x${'2'.repeat(40)}`;
const TO = `0x${'3'.repeat(40)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_native_funding_events');
  await db.query('DELETE FROM robinhood_native_funding_edges');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_ranges');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_candidates');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_runs');
}

describe('Robinhood native funding schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage167.init({ closePool: false });
    await db.query(`CREATE TABLE IF NOT EXISTS robinhood_native_funding_events_stage167_test
      PARTITION OF robinhood_native_funding_events
      FOR VALUES FROM ('2026-08-26') TO ('2026-08-27')`);
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('enforces positive native evidence and permanent edge identity', async () => {
    await db.query(`INSERT INTO robinhood_native_funding_events (
      block_number, block_hash, block_time, transaction_hash, transaction_index,
      from_wallet, to_wallet, value_wei
    ) VALUES (100, $1, '2026-08-26T12:00:00Z', $2, 0, $3, $4, 10)`,
    [HASH, TX, FROM, TO]);
    await assert.rejects(db.query(`INSERT INTO robinhood_native_funding_events (
      block_number, block_hash, block_time, transaction_hash, transaction_index,
      from_wallet, to_wallet, value_wei
    ) VALUES (101, $1, '2026-08-26T12:01:00Z', $2, 1, $3, $4, 0)`,
    [HASH, TX, FROM, TO]), /rh_native_funding_events_value_check/);
    await db.query(`INSERT INTO robinhood_native_funding_edges (
      from_wallet, to_wallet, evidence_version,
      first_block_number, first_block_hash, first_block_time,
      first_transaction_hash, first_transaction_index,
      last_block_number, last_block_hash, last_block_time,
      last_transaction_hash, last_transaction_index, transfer_count, total_value_wei
    ) VALUES ($1, $2, 'rh_native_funding_v1', 100, $3, '2026-08-26T12:00:00Z',
      $4, 0, 100, $3, '2026-08-26T12:00:00Z', $4, 0, 1, 10)`,
    [FROM, TO, HASH, TX]);
    assert.equal((await db.query(
      'SELECT total_value_wei::text FROM robinhood_native_funding_edges'
    )).rows[0].total_value_wei, '10');
  });

  it('freezes launch candidates and requires owned range leases', async () => {
    const run = await db.query(`INSERT INTO robinhood_bundle_funding_backfill_runs (
      source_from_block, source_through_block, source_through_hash, lookback_blocks,
      batch_blocks, concurrency, candidate_count, range_count, blocks_total
    ) VALUES (0, 200, $1, 1000, 50, 16, 1, 1, 101) RETURNING id`, [HASH]);
    const runId = run.rows[0].id;
    await db.query(`INSERT INTO robinhood_bundle_funding_backfill_candidates (
      run_id, token_address, wallet_address, launch_block,
      first_buy_block, first_buy_transaction_index
    ) VALUES ($1, $2, $3, 100, 103, 1)`, [runId, TOKEN, TO]);
    await assert.rejects(db.query(`INSERT INTO robinhood_bundle_funding_backfill_candidates (
      run_id, token_address, wallet_address, launch_block,
      first_buy_block, first_buy_transaction_index
    ) VALUES ($1, $2, $3, 100, 104, 1)`, [runId, TOKEN, FROM]),
    /rh_bundle_funding_candidates_position_check/);
    await db.query(`INSERT INTO robinhood_bundle_funding_backfill_ranges (
      run_id, range_index, from_block, through_block
    ) VALUES ($1, 0, 100, 200)`, [runId]);
    await assert.rejects(db.query(`UPDATE robinhood_bundle_funding_backfill_ranges
      SET status = 'leased' WHERE run_id = $1`, [runId]),
    /rh_bundle_funding_ranges_lease_check/);
    await db.query(`UPDATE robinhood_bundle_funding_backfill_ranges SET
      status = 'completed', completed_at = NOW(), completed_through_hash = $2,
      blocks_scanned = 101 WHERE run_id = $1`, [runId, HASH]);
  });
});
