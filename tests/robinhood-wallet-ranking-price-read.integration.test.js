process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingPriceReadRepository,
} = require('../src/models/robinhood-wallet-ranking-price-read');

const TOKENS = ['a', 'b', 'c', 'd'].map((letter) => `0x${letter.repeat(40)}`);
const AS_OF = '2026-09-27T12:00:00.000Z';
const MARKET = 'robinhood:uniswap-v3:ranking-primary';
const OTHER_MARKET = 'robinhood:uniswap-v3:ranking-other';

async function seed(client) {
  await client.query(`CREATE TEMP TABLE robinhood_market_buckets_agg (
    chain varchar, token_address varchar, granularity_minutes int,
    source_granularity_minutes int, bucket_ts timestamptz,
    last_observed_at timestamptz, valuation_protocol varchar,
    valuation_market_key varchar
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE robinhood_market_buckets_1m (
    chain varchar, token_address varchar, protocol varchar, market_key varchar,
    bucket_ts timestamptz, last_observed_at timestamptz,
    last_block_number bigint, last_log_index bigint, close_price_usd numeric
  ) ON COMMIT DROP`);
  await client.query(`CREATE TEMP TABLE robinhood_market_buckets_1h (
    chain varchar, token_address varchar, protocol varchar, market_key varchar,
    bucket_ts timestamptz, last_observed_at timestamptz,
    last_block_number bigint, last_log_index bigint, close_price_usd numeric
  ) ON COMMIT DROP`);
  for (const token of TOKENS.slice(0, 3)) {
    await client.query(
      `INSERT INTO robinhood_market_buckets_agg VALUES
       ('robinhood', $1, 5, 1, '2026-09-27 11:55+00',
        '2026-09-27 11:59+00', 'uniswap-v3', $2)`, [token, MARKET]
    );
    await client.query(
      `INSERT INTO robinhood_market_buckets_1m VALUES
       ('robinhood', $1, 'uniswap-v3', $2, '2026-09-27 11:59+00',
        '2026-09-27 11:59+00', 1, 0, 4)`, [token, MARKET]
    );
  }
  await client.query(
    `INSERT INTO robinhood_market_buckets_1m VALUES
     ('robinhood', $1, 'uniswap-v3', $2, '2026-09-26 11:59+00',
      '2026-09-26 11:59+00', 1, 0, 2),
     ('robinhood', $1, 'uniswap-v3', $2, '2026-09-20 11:59+00',
      '2026-09-20 11:59+00', 1, 0, 1),
     ('robinhood', $3, 'uniswap-v3', $4, '2026-09-26 11:59+00',
      '2026-09-26 11:59+00', 1, 0, 1)`,
    [TOKENS[0], MARKET, TOKENS[2], OTHER_MARKET]
  );
  await client.query(
    `INSERT INTO robinhood_market_buckets_1h VALUES
     ('robinhood', $1, 'uniswap-v3', $2, '2026-08-28 11:00+00',
      '2026-08-28 11:59+00', 1, 0, 0.5),
     ('robinhood', $1, 'uniswap-v3', $2, '2026-08-28 12:00+00',
      '2026-08-28 12:05+00', 2, 0, 0.6)`, [TOKENS[0], MARKET]
  );
}

describe('Robinhood wallet ranking price references', () => {
  it('reads bounded prices from one valuation market and reports missing coverage', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await seed(client);
      const repository = createRobinhoodWalletRankingPriceReadRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });

      for (const [window, expectedPrice] of [
        ['24h', '2'], ['7d', '1'], ['30d', '0.5'], ['ALL', null],
      ]) {
        const rows = await repository.getPrices({
          tokenAddresses: [...TOKENS, `0x${'A'.repeat(40)}`], window, asOf: AS_OF,
        });
        assert.equal(rows.length, 4);
        assert.equal(rows[0].currentPriceUsd, '4');
        assert.equal(rows[0].windowStartPriceUsd, expectedPrice);
        assert.equal(rows[0].coverage, 'complete');
        assert.equal(rows[0].marketKey, MARKET);
        assert.equal(rows[0].windowStart, window === 'ALL' ? null
          : new Date(Date.parse(AS_OF) - { '24h': 86400000,
            '7d': 604800000, '30d': 2592000000 }[window]).toISOString());
        assert.equal(rows[1].coverage, window === 'ALL' ? 'complete' : 'partial');
        assert.equal(rows[2].windowStartPriceUsd, null);
        assert.equal(rows[3].coverage, 'partial');
        assert.deepEqual(rows[3].reasons.includes('current_price_unavailable'), true);
      }
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects unbounded batches and invalid windows before querying', async () => {
    const repository = createRobinhoodWalletRankingPriceReadRepository({
      database: { queryWithStatementTimeout() { throw new Error('unexpected query'); } },
    });
    await assert.rejects(repository.getPrices({ tokenAddresses: TOKENS, window: 'overall' }),
      /window is invalid/);
    await assert.rejects(repository.getPrices({
      tokenAddresses: Array(101).fill(TOKENS[0]), window: '24h',
    }), /at most 100/);
    assert.deepEqual(await repository.getPrices({ tokenAddresses: [], window: 'ALL' }), []);
  });
});
