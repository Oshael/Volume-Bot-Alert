process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const stage154 = require('../src/utils/db-init-stage154');
const stage158 = require('../src/utils/db-init-stage158');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const HASH = `0x${'a'.repeat(64)}`;
const TOKEN = `0x${'1'.repeat(40)}`;

async function cleanup() {
  await db.query('DELETE FROM robinhood_directional_transfer_replay_tokens');
  await db.query('DELETE FROM robinhood_wallet_transfer_token_coverage');
  await db.query('DELETE FROM robinhood_directional_transfer_replay_ranges');
  await db.query('DELETE FROM robinhood_directional_transfer_replay_runs');
}

describe('Robinhood token-scoped transfer coverage schema integration', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage154.init({ closePool: false });
    await stage158.init({ closePool: false });
    await stage158.init({ closePool: false });
    await cleanup();
  });

  after(async () => {
    await cleanup();
    await db.pool.end();
  });

  it('enforces resumable completion and one immutable token identity per replay', async () => {
    await db.query(
      `INSERT INTO robinhood_wallet_transfer_token_coverage (
         token_address, source_from_block, next_block,
         source_through_block, source_through_hash
       ) VALUES ($1, 100, 100, 199, $2)`,
      [TOKEN, HASH]
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_wallet_transfer_token_coverage SET
           status = 'complete', completed_at = NOW()
         WHERE token_address = $1`,
        [TOKEN]
      ),
      /rh_wallet_transfer_token_coverage_completion_check/
    );
    await assert.rejects(
      db.query(
        `UPDATE robinhood_wallet_transfer_token_coverage SET
           status = 'leased' WHERE token_address = $1`,
        [TOKEN]
      ),
      /rh_wallet_transfer_token_coverage_lease_check/
    );
    await db.query(
      `UPDATE robinhood_wallet_transfer_token_coverage SET
         next_block = 200, status = 'complete', completed_at = NOW()
       WHERE token_address = $1`,
      [TOKEN]
    );
    const run = await db.query(
      `INSERT INTO robinhood_directional_transfer_replay_runs (
         source_from_block, source_through_block, source_through_hash, range_blocks
       ) VALUES (100, 199, $1, 50) RETURNING id`,
      [HASH]
    );
    await db.query(
      `INSERT INTO robinhood_directional_transfer_replay_tokens (
         run_id, token_address, coverage_from_block,
         coverage_through_block, coverage_through_hash
       ) VALUES ($1, $2, 100, 199, $3)`,
      [run.rows[0].id, TOKEN, HASH]
    );
    await assert.rejects(
      db.query(
        `INSERT INTO robinhood_directional_transfer_replay_tokens (
           run_id, token_address, coverage_from_block,
           coverage_through_block, coverage_through_hash
         ) VALUES ($1, $2, 100, 199, $3)`,
        [run.rows[0].id, TOKEN, HASH]
      ),
      /rh_directional_replay_tokens_pkey/
    );
    const coverage = await db.query(
      `SELECT status, source_from_block::text, next_block::text,
              source_through_block::text, completed_at IS NOT NULL AS completed
         FROM robinhood_wallet_transfer_token_coverage
        WHERE token_address = $1`,
      [TOKEN]
    );
    assert.deepEqual(coverage.rows[0], {
      status: 'complete', source_from_block: '100', next_block: '200',
      source_through_block: '199', completed: true,
    });
  });
});
