process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingPositionFrontierRepository,
} = require('../src/models/robinhood-wallet-ranking-position-frontier');

const VERSION = 'unified_transfer_v1';
const AS_OF = '2026-09-27T12:00:00.000Z';
const HASH = `0x${'a'.repeat(64)}`;
const OTHER_HASH = `0x${'b'.repeat(64)}`;

describe('Robinhood ranking position frontier', () => {
  it('requires seed/live continuity, exact time, and the checkpoint hash on the canonical branch', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_wallet_position_cursors (
        chain varchar, projection_version varchar, stream varchar,
        lifecycle_state varchar, origin_block bigint, next_block bigint,
        safe_head bigint, next_block_time timestamptz, completed_at timestamptz,
        checkpoint_block bigint, checkpoint_hash varchar
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
        chain varchar, block_number bigint, block_hash varchar, canonical boolean,
        block_timestamp timestamptz
      ) ON COMMIT DROP`);
      await client.query(
        `INSERT INTO robinhood_wallet_position_cursors VALUES
         ('robinhood', $1, 'seed', 'complete', 90, 101, 100, NULL, NOW(), NULL, NULL),
         ('robinhood', $1, 'live', 'running', 101, 106, 105, $2, NULL, 105, $3)`,
        [VERSION, AS_OF, HASH],
      );
      await client.query(
        `INSERT INTO robinhood_chain_blocks VALUES ('robinhood', 105, $1, true, $2)`,
        [HASH, AS_OF],
      );
      const repository = createRobinhoodWalletRankingPositionFrontierRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });
      const aligned = await repository.inspectAsOf({ projectionVersion: VERSION, asOf: AS_OF });
      assert.equal(aligned.frontierChecksPassed, true);
      assert.equal(aligned.frontierBlock, '105');
      assert.equal(aligned.frontierTime, AS_OF);

      const wrongTime = await repository.inspectAsOf({ projectionVersion: VERSION,
        asOf: '2026-09-27T12:00:01.000Z' });
      assert.deepEqual(wrongTime.reasons, ['position_as_of_mismatch']);

      await client.query(`UPDATE robinhood_chain_blocks
        SET block_timestamp = $1 WHERE block_hash = $2`,
      ['2026-09-27T12:00:01.000Z', HASH]);
      const wrongCheckpointTime = await repository.inspectAsOf({
        projectionVersion: VERSION, asOf: AS_OF,
      });
      assert.deepEqual(wrongCheckpointTime.reasons, ['position_checkpoint_unproven']);
      await client.query(`UPDATE robinhood_chain_blocks
        SET block_timestamp = $1 WHERE block_hash = $2`, [AS_OF, HASH]);

      await client.query(`UPDATE robinhood_wallet_position_cursors
        SET origin_block = 102 WHERE stream = 'live'`);
      const gap = await repository.inspectAsOf({ projectionVersion: VERSION, asOf: AS_OF });
      assert.deepEqual(gap.reasons, ['position_seed_live_gap']);
      await client.query(`UPDATE robinhood_wallet_position_cursors
        SET origin_block = 101 WHERE stream = 'live'`);

      await client.query(`UPDATE robinhood_chain_blocks SET canonical = false`);
      await client.query(`INSERT INTO robinhood_chain_blocks VALUES
        ('robinhood', 105, $1, true, $2)`, [OTHER_HASH, AS_OF]);
      const reorged = await repository.inspectAsOf({ projectionVersion: VERSION, asOf: AS_OF });
      assert.deepEqual(reorged.reasons, ['position_checkpoint_unproven']);
      assert.equal(reorged.frontierChecksPassed, false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
