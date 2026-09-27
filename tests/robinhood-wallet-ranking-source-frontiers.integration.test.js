process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingSourceFrontiersRepository,
} = require('../src/models/robinhood-wallet-ranking-source-frontiers');

const HASH = `0x${'a'.repeat(64)}`;
const AS_OF = '2026-09-27T12:00:00.000Z';

describe('Robinhood ranking source frontier audit', () => {
  it('checks cursor continuity, time frontier and canonical checkpoints', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_wallet_swap_cursors (
        chain varchar, stream varchar, lifecycle_state varchar,
        origin_block bigint, next_block bigint, safe_head bigint,
        checkpoint_block bigint, checkpoint_hash varchar,
        checkpoint_timestamp timestamptz, completed_at timestamptz
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_wallet_transfer_cursors (
        chain varchar, projection_version varchar, stream varchar,
        lifecycle_state varchar, origin_block bigint, next_block bigint,
        safe_head bigint, checkpoint_block bigint, checkpoint_hash varchar,
        next_block_time timestamptz, completed_at timestamptz
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
        chain varchar, block_number bigint, block_hash varchar, canonical boolean
      ) ON COMMIT DROP`);
      await client.query(`INSERT INTO robinhood_wallet_swap_cursors VALUES
        ('robinhood', 'seed', 'complete', 90, 101, 100, 100, $1,
         '2026-09-26T00:00:00Z', NOW()),
        ('robinhood', 'live', 'running', 100, 201, 200, 200, $1,
         '2026-09-28T00:00:00Z', NULL)`, [HASH]);
      await client.query(`INSERT INTO robinhood_wallet_transfer_cursors VALUES
        ('robinhood', 'rh_transfer_v1', 'seed', 'complete', 90, 101, 100,
         100, $1, '2026-09-26T00:00:00Z', NOW()),
        ('robinhood', 'rh_transfer_v1', 'live', 'running', 100, 201, 200,
         200, $1, '2026-09-28T00:00:00Z', NULL)`, [HASH]);
      await client.query(`INSERT INTO robinhood_chain_blocks VALUES
        ('robinhood', 200, $1, true)`, [HASH]);
      const repository = createRobinhoodWalletRankingSourceFrontiersRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });
      const input = { asOf: AS_OF };
      const ready = await repository.inspectAsOf(input);
      assert.equal(ready.cursorChecksPassed, true);
      assert.equal(ready.sourceCoverageVerified, false);
      assert.deepEqual(ready.sources.map((source) => source.source), ['swap', 'transfer']);

      await client.query(`UPDATE robinhood_chain_blocks SET canonical=false`);
      const reorged = await repository.inspectAsOf(input);
      assert.equal(reorged.cursorChecksPassed, false);
      assert.deepEqual(reorged.sources[0].reasons, ['swap_checkpoint_unproven']);
      await client.query(`UPDATE robinhood_chain_blocks SET canonical=true`);

      await client.query(`UPDATE robinhood_wallet_transfer_cursors
        SET origin_block=102, next_block_time='2026-09-27T12:00:00Z'
        WHERE stream='live'`);
      const lagged = await repository.inspectAsOf(input);
      assert.deepEqual(lagged.sources[1].reasons,
        ['transfer_seed_live_gap', 'transfer_behind_as_of']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects an invalid asOf or transfer version before querying', async () => {
    const repository = createRobinhoodWalletRankingSourceFrontiersRepository({
      database: { queryWithStatementTimeout() { throw new Error('unexpected query'); } },
    });
    await assert.rejects(repository.inspectAsOf({ asOf: 'invalid' }), /asOf is invalid/);
    await assert.rejects(repository.inspectAsOf({ asOf: AS_OF, transferVersion: 'bad version' }),
      /transferVersion is invalid/);
  });
});
