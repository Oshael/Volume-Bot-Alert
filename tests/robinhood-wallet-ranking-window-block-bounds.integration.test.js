process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingWindowBlockBoundsRepository,
} = require('../src/models/robinhood-wallet-ranking-window-block-bounds');

const START = '2026-09-27T12:00:00.000Z';
const AS_OF = '2026-09-27T12:05:00.000Z';
const INPUT = { windowStart: START, asOf: AS_OF,
  originBlock: '90', throughBlock: '110' };

describe('Robinhood ranking window block bounds', () => {
  after(async () => db.pool.end());

  it('anchors both inclusive time boundaries to adjacent canonical blocks', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_chain_blocks (
        chain text, block_number bigint, canonical boolean,
        block_timestamp timestamptz
      ) ON COMMIT DROP`);
      await client.query(`INSERT INTO robinhood_chain_blocks
        SELECT 'robinhood', number, true,
          '2026-09-27T12:00:00Z'::timestamptz
            + (number - 100) * INTERVAL '1 minute'
        FROM generate_series(90, 110) AS number`);
      const repository = createRobinhoodWalletRankingWindowBlockBoundsRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });
      assert.deepEqual(await repository.resolveWindow(INPUT), {
        verified: true, fromBlock: '100', throughBlock: '105', reasons: [],
      });
      assert.deepEqual(await repository.resolveWindow({ ...INPUT,
        asOf: '2026-09-27T12:05:30Z' }), {
        verified: true, fromBlock: '100', throughBlock: '105', reasons: [],
      });
      await client.query('UPDATE robinhood_chain_blocks SET canonical=false WHERE block_number=100');
      assert.deepEqual((await repository.resolveWindow(INPUT)).reasons,
        ['transfer_window_block_gap']);
      await client.query('UPDATE robinhood_chain_blocks SET canonical=true WHERE block_number=100');
      await client.query('UPDATE robinhood_chain_blocks SET canonical=false WHERE block_number=99');
      assert.deepEqual((await repository.resolveWindow(INPUT)).reasons,
        ['transfer_window_block_gap']);
      assert.deepEqual((await repository.resolveWindow({ ...INPUT,
        asOf: '2026-09-27T12:10:00Z' })).reasons,
      ['transfer_window_outside_frontier']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects invalid input before querying', async () => {
    const repository = createRobinhoodWalletRankingWindowBlockBoundsRepository({
      database: { queryWithStatementTimeout() { throw new Error('unexpected query'); } },
    });
    await assert.rejects(repository.resolveWindow({ ...INPUT, asOf: START }),
      /windowStart\/asOf/);
    await assert.rejects(repository.resolveWindow({ ...INPUT, throughBlock: '80' }),
      /block bounds are inverted/);
  });
});
