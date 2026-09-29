process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');
const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingTokenDecimalsRepository,
} = require('../src/models/robinhood-wallet-ranking-token-decimals');

const TOKEN = `0x${'a'.repeat(40)}`;
const MISSING = `0x${'b'.repeat(40)}`;

describe('Robinhood ranking durable token decimals', () => {
  after(async () => db.pool.end());

  it('uses the latest known swap decimals at or before asOf and leaves gaps unknown', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_wallet_swaps (
        chain varchar, token_address varchar, token_decimals smallint,
        block_time timestamptz, block_number bigint, action_index int
      ) ON COMMIT DROP`);
      await client.query(`INSERT INTO robinhood_wallet_swaps VALUES
        ('robinhood', $1, 6, '2026-09-25T12:00:00Z', 100, 0),
        ('robinhood', $1, 18, '2026-09-27T11:00:00Z', 101, 0),
        ('robinhood', $1, null, '2026-09-27T11:30:00Z', 102, 0),
        ('robinhood', $1, 8, '2026-09-28T12:00:00Z', 103, 0)`, [TOKEN]);
      const repository = createRobinhoodWalletRankingTokenDecimalsRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });
      assert.deepEqual(await repository.getDecimals({
        tokenAddresses: [MISSING, TOKEN], asOf: '2026-09-27T12:00:00Z',
      }), [{ tokenAddress: TOKEN, tokenDecimals: 18 },
        { tokenAddress: MISSING, tokenDecimals: null }]);
      assert.deepEqual(await repository.getDecimals({
        tokenAddresses: [TOKEN], asOf: '2026-09-26T12:00:00Z',
      }), [{ tokenAddress: TOKEN, tokenDecimals: 6 }]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects oversized input before querying', async () => {
    const repository = createRobinhoodWalletRankingTokenDecimalsRepository({
      database: { queryWithStatementTimeout() { throw new Error('unexpected query'); } },
    });
    await assert.rejects(repository.getDecimals({
      tokenAddresses: Array(101).fill(TOKEN), asOf: '2026-09-27T12:00:00Z',
    }), /at most 100/);
  });
});
