process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage167 = require('../src/utils/db-init-stage167');
const stage169 = require('../src/utils/db-init-stage169');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;
const CANDIDATE = `0x${'2'.repeat(40)}`;
const FUNDER = `0x${'3'.repeat(40)}`;
const ANCESTOR = `0x${'4'.repeat(40)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_bundle_funding_evidence');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_ranges');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_candidates');
  await db.query('DELETE FROM robinhood_bundle_funding_backfill_runs');
}

describe('Robinhood token-scoped funding evidence schema', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage167.init({ closePool: false });
    await stage169.init({ closePool: false });
    await cleanup();
  });
  after(async () => { await cleanup(); await db.pool.end(); });

  it('binds exact one/two-hop events to a frozen candidate', async () => {
    const run = await db.query(`INSERT INTO robinhood_bundle_funding_backfill_runs (
      source_from_block, source_through_block, source_through_hash, lookback_blocks,
      batch_blocks, concurrency, candidate_count, range_count, blocks_total
    ) VALUES (0, 200, $1, 1000, 50, 1, 1, 1, 100) RETURNING id`, [HASH]);
    const runId = run.rows[0].id;
    await db.query(`INSERT INTO robinhood_bundle_funding_backfill_candidates (
      run_id, token_address, wallet_address, launch_block,
      first_buy_block, first_buy_transaction_index
    ) VALUES ($1, $2, $3, 100, 101, 5)`, [runId, TOKEN, CANDIDATE]);
    const insert = (hop, from, to, value, suffix) => db.query(
      `INSERT INTO robinhood_bundle_funding_evidence (
         run_id, token_address, candidate_wallet, hop, block_number, block_hash,
         block_time, transaction_hash, transaction_index, from_wallet, to_wallet, value_wei
       ) VALUES ($1, $2, $3, $4, 100, $5, NOW(), $6, 0, $7, $8, $9)`,
      [runId, TOKEN, CANDIDATE, hop, HASH, `0x${suffix.repeat(64)}`, from, to, value]
    );
    await insert(1, FUNDER, CANDIDATE, 10, 'b');
    await insert(2, ANCESTOR, FUNDER, 20, 'c');
    await assert.rejects(insert(1, ANCESTOR, FUNDER, 10, 'd'),
      /rh_bundle_funding_evidence_hop_check/);
    await assert.rejects(insert(2, CANDIDATE, FUNDER, 10, 'e'),
      /rh_bundle_funding_evidence_hop_check/);
    await assert.rejects(insert(1, FUNDER, CANDIDATE, 0, 'f'),
      /rh_bundle_funding_evidence_value_check/);
    assert.equal((await db.query(
      'SELECT COUNT(*)::integer count FROM robinhood_bundle_funding_evidence'
    )).rows[0].count, 2);
  });
});
