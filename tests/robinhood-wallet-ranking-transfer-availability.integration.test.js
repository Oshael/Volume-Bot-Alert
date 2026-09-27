process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingTransferAvailabilityRepository,
} = require('../src/models/robinhood-wallet-ranking-transfer-availability');

const START = '2026-09-26T12:00:00.000Z';
const END = '2026-09-27T12:00:00.000Z';

describe('Robinhood ranking raw-transfer availability', () => {
  it('checks daily partition bounds, attachment, and compaction markers', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_token_transfer_events (
        block_time timestamptz NOT NULL
      ) PARTITION BY RANGE (block_time) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_token_transfer_events_2026_09_26
        PARTITION OF robinhood_token_transfer_events
        FOR VALUES FROM ('2026-09-26T00:00:00Z') TO ('2026-09-27T00:00:00Z')`);
      await client.query(`CREATE TEMP TABLE robinhood_token_transfer_events_2026_09_27
        PARTITION OF robinhood_token_transfer_events
        FOR VALUES FROM ('2026-09-27T00:00:00Z') TO ('2026-09-28T00:00:00Z')`);
      await client.query(`CREATE TEMP TABLE robinhood_wallet_transfer_compaction_watermarks (
        chain varchar, partition_day date, lifecycle_state varchar, dropped_at timestamptz
      ) ON COMMIT DROP`);
      const repository = createRobinhoodWalletRankingTransferAvailabilityRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });
      const input = { windowStart: START, asOf: END };
      const complete = await repository.inspectWindow(input);
      assert.deepEqual(complete.partitions.map((item) => item.day),
        ['2026-09-26', '2026-09-27']);
      assert.equal(complete.rawTransferAvailable, true);
      assert.equal(complete.sourceCoverageVerified, false);

      await client.query(`INSERT INTO robinhood_wallet_transfer_compaction_watermarks
        VALUES ('robinhood', '2026-09-26', 'dropped', NOW())`);
      const compacted = await repository.inspectWindow(input);
      assert.equal(compacted.rawTransferAvailable, false);
      assert.deepEqual(compacted.partitions[0].reasons, ['raw_transfer_partition_compacted']);
      await client.query('DELETE FROM robinhood_wallet_transfer_compaction_watermarks');

      await client.query(`ALTER TABLE robinhood_token_transfer_events
        DETACH PARTITION robinhood_token_transfer_events_2026_09_27`);
      const detached = await repository.inspectWindow(input);
      assert.deepEqual(detached.partitions[1].reasons, ['raw_transfer_partition_detached']);

      await client.query('DROP TABLE robinhood_token_transfer_events_2026_09_27');
      await client.query(`CREATE TEMP TABLE robinhood_token_transfer_events_2026_09_27
        PARTITION OF robinhood_token_transfer_events
        FOR VALUES FROM ('2026-09-28T00:00:00Z') TO ('2026-09-29T00:00:00Z')`);
      const wrongBound = await repository.inspectWindow(input);
      assert.deepEqual(wrongBound.partitions[1].reasons,
        ['raw_transfer_partition_bound_mismatch']);

      await client.query('DROP TABLE robinhood_token_transfer_events_2026_09_27');
      const missing = await repository.inspectWindow(input);
      assert.deepEqual(missing.partitions[1].reasons, ['raw_transfer_partition_missing']);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects windows beyond the bounded ranking period', async () => {
    const repository = createRobinhoodWalletRankingTransferAvailabilityRepository({
      database: { queryWithStatementTimeout() { throw new Error('unexpected query'); } },
    });
    await assert.rejects(repository.inspectWindow({ windowStart: '2026-08-01', asOf: END }),
      /at most 30 days/);
  });
});
