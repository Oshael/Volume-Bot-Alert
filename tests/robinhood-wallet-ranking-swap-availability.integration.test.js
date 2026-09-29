process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingSwapAvailabilityRepository,
} = require('../src/models/robinhood-wallet-ranking-swap-availability');

const START = '2026-09-26T12:00:00.000Z';
const END = '2026-09-27T12:00:00.000Z';

describe('Robinhood ranking swap partition availability', () => {
  it('detects missing, detached and incorrectly bounded days', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_wallet_swaps (
        block_time timestamptz NOT NULL
      ) PARTITION BY RANGE (block_time) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_wallet_swaps_2026_09_26
        PARTITION OF robinhood_wallet_swaps
        FOR VALUES FROM ('2026-09-26T00:00:00Z') TO ('2026-09-27T00:00:00Z')`);
      await client.query(`CREATE TEMP TABLE robinhood_wallet_swaps_2026_09_27
        PARTITION OF robinhood_wallet_swaps
        FOR VALUES FROM ('2026-09-27T00:00:00Z') TO ('2026-09-28T00:00:00Z')`);
      const repository = createRobinhoodWalletRankingSwapAvailabilityRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });
      const input = { windowStart: START, asOf: END };
      const ready = await repository.inspectWindow(input);
      assert.equal(ready.swapPartitionsAvailable, true);
      assert.equal(ready.sourceCoverageVerified, false);

      await client.query(`ALTER TABLE robinhood_wallet_swaps
        DETACH PARTITION robinhood_wallet_swaps_2026_09_27`);
      const detached = await repository.inspectWindow(input);
      assert.deepEqual(detached.partitions[1].reasons, ['swap_partition_detached']);

      await client.query('DROP TABLE robinhood_wallet_swaps_2026_09_27');
      await client.query(`CREATE TEMP TABLE robinhood_wallet_swaps_2026_09_27
        PARTITION OF robinhood_wallet_swaps
        FOR VALUES FROM ('2026-09-28T00:00:00Z') TO ('2026-09-29T00:00:00Z')`);
      const wrongBound = await repository.inspectWindow(input);
      assert.deepEqual(wrongBound.partitions[1].reasons,
        ['swap_partition_bound_mismatch']);

      await client.query('DROP TABLE robinhood_wallet_swaps_2026_09_27');
      const missing = await repository.inspectWindow(input);
      assert.deepEqual(missing.partitions[1].reasons, ['swap_partition_missing']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects a window longer than 30 days', async () => {
    const repository = createRobinhoodWalletRankingSwapAvailabilityRepository({
      database: { queryWithStatementTimeout() { throw new Error('unexpected query'); } },
    });
    await assert.rejects(repository.inspectWindow({ windowStart: '2026-08-01', asOf: END }),
      /at most 30 days/);
  });
});
