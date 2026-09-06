const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const retentionWorker = require('../src/services/robinhood-retention-worker');

after(() => db.pool.end());

describe('Robinhood retention safety integration', () => {
  it('deletes completed aggregation evidence but preserves nonterminal work', async () => {
    const client = await db.getClient();
    await client.query('BEGIN');
    try {
      await client.query(`CREATE TEMP TABLE robinhood_processed_logs (
        chain text NOT NULL,
        transaction_hash text NOT NULL,
        log_index bigint NOT NULL,
        expires_at timestamptz NOT NULL,
        PRIMARY KEY (chain, transaction_hash, log_index)
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_market_observations (
        chain text NOT NULL,
        transaction_hash text NOT NULL,
        log_index bigint NOT NULL,
        block_number bigint NOT NULL,
        protocol text NOT NULL,
        market_key text NOT NULL,
        token_address text NOT NULL,
        quote_address text NOT NULL,
        status text NOT NULL,
        observed_at timestamptz NOT NULL,
        PRIMARY KEY (chain, transaction_hash, log_index),
        FOREIGN KEY (chain, transaction_hash, log_index)
          REFERENCES robinhood_processed_logs(chain, transaction_hash, log_index)
          ON DELETE CASCADE
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_market_buckets_1m (
        chain text NOT NULL,
        protocol text NOT NULL,
        market_key text NOT NULL,
        token_address text NOT NULL,
        quote_address text NOT NULL,
        bucket_ts timestamptz NOT NULL,
        first_block_number bigint NOT NULL,
        first_log_index bigint NOT NULL,
        last_block_number bigint NOT NULL,
        last_log_index bigint NOT NULL
      ) ON COMMIT DROP`);
      await client.query(`CREATE TEMP TABLE robinhood_backfill_aggregation_outbox (
        chain text NOT NULL,
        transaction_hash text NOT NULL,
        log_index bigint NOT NULL,
        status text NOT NULL,
        PRIMARY KEY (chain, transaction_hash, log_index),
        FOREIGN KEY (chain, transaction_hash, log_index)
          REFERENCES robinhood_market_observations(chain, transaction_hash, log_index)
          ON DELETE CASCADE
      ) ON COMMIT DROP`);

      for (const [identity, status] of [['done', 'completed'], ['open', 'pending']]) {
        await client.query(
          `INSERT INTO robinhood_processed_logs VALUES ('robinhood', $1, 1, NOW() - INTERVAL '1 day')`,
          [identity]
        );
        await client.query(
          `INSERT INTO robinhood_market_observations VALUES (
             'robinhood', $1, 1, 100, 'uniswap-v2', 'market', 'token', 'quote',
             'accepted', '2026-09-06T00:00:10Z'
           )`,
          [identity]
        );
        await client.query(
          `INSERT INTO robinhood_backfill_aggregation_outbox VALUES ('robinhood', $1, 1, $2)`,
          [identity, status]
        );
      }
      await client.query(`INSERT INTO robinhood_market_buckets_1m VALUES (
        'robinhood', 'uniswap-v2', 'market', 'token', 'quote',
        '2026-09-06T00:00:00Z', 100, 1, 100, 1
      )`);

      const summary = await retentionWorker.runOnce(
        { batchLimit: 100, maxBatches: 1 },
        {},
        {
          database: {
            queryWithStatementTimeout: (sql, params) => client.query(sql, params),
          },
          watermarkRepository: {
            loadRetentionGate: async () => ({
              valid: true,
              completeThroughBlock: '100',
              sourceFrontierBlock: '100',
              updatedAt: new Date().toISOString(),
            }),
          },
        }
      );

      assert.equal(summary.processedLogs, 1);
      assert.equal(summary.observations, 1);
      assert.equal(summary.candidatesProtectedByAggregation, 1);
      const remaining = await client.query(
        `SELECT transaction_hash FROM robinhood_processed_logs ORDER BY transaction_hash`
      );
      assert.deepEqual(remaining.rows, [{ transaction_hash: 'open' }]);
      const outbox = await client.query(
        `SELECT transaction_hash, status FROM robinhood_backfill_aggregation_outbox`
      );
      assert.deepEqual(outbox.rows, [{ transaction_hash: 'open', status: 'pending' }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
