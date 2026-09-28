process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const db = require('../src/models/db');
const { assertUsingTestDatabase } = require('./helpers/test-db');
const {
  createRobinhoodWalletRankingPositionReadRepository,
} = require('../src/models/robinhood-wallet-ranking-position-read');

const TOKEN_A = `0x${'a'.repeat(40)}`;
const TOKEN_B = `0x${'b'.repeat(40)}`;
const WALLET_A = `0x${'1'.repeat(40)}`;
const WALLET_B = `0x${'2'.repeat(40)}`;
const VERSION = 'unified_transfer_v1';

describe('Robinhood ranking open-position candidate read', () => {
  it('pages open positions by token/wallet without mixing projection versions', async () => {
    await assertUsingTestDatabase(db);
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      await client.query(`CREATE TEMP TABLE robinhood_wallet_token_positions (
        chain varchar NOT NULL, projection_version varchar NOT NULL,
        token_address varchar NOT NULL, wallet_address varchar NOT NULL,
        quantity_raw numeric NOT NULL, cost_basis_usd numeric NOT NULL,
        cost_basis_source varchar NOT NULL, zero_cost_received_raw numeric NOT NULL,
        quality varchar NOT NULL, through_block bigint NOT NULL,
        through_log_index bigint NOT NULL,
        PRIMARY KEY (chain, projection_version, token_address, wallet_address)
      ) ON COMMIT DROP`);
      await client.query(
        `INSERT INTO robinhood_wallet_token_positions VALUES
         ('robinhood', $1, $2, $4, 10, 2.5, 'swap_only', 0, 'exact_swap_only', 100, 1),
         ('robinhood', $1, $2, $5, 0, 0, 'swap_only', 0, 'exact_swap_only', 101, 1),
         ('robinhood', $1, $3, $4, 20, 5, 'swap_only', 0, 'exact_swap_only', 102, 1),
         ('robinhood', $1, $3, $5, 30, 9, 'transferred_assumed_zero', 3,
          'transferred_assumed_zero', 103, 2),
         ('robinhood', 'swap_only_v1', $2, $5, 50, 4, 'swap_only', 0,
          'exact_swap_only', 104, 1)`, [VERSION, TOKEN_A, TOKEN_B, WALLET_A, WALLET_B]
      );
      const repository = createRobinhoodWalletRankingPositionReadRepository({
        database: { queryWithStatementTimeout: (sql, params) => client.query(sql, params) },
      });
      const input = { projectionVersion: VERSION,
        tokenAddresses: [TOKEN_B, TOKEN_A], limit: 2 };
      const first = await repository.getOpenPositions(input);
      assert.deepEqual(first.positions.map(({ tokenAddress, walletAddress }) => (
        [tokenAddress, walletAddress]
      )), [[TOKEN_A, WALLET_A], [TOKEN_B, WALLET_A]]);
      assert.equal(first.positions[0].costBasisUsd, '2.5');
      assert.equal(first.hasMore, true);
      assert.deepEqual(first.nextAfter, { tokenAddress: TOKEN_B, walletAddress: WALLET_A });
      assert.equal(first.snapshotConsistent, false);

      const second = await repository.getOpenPositions({ ...input, after: first.nextAfter });
      assert.deepEqual(second.positions.map(({ walletAddress }) => walletAddress), [WALLET_B]);
      assert.equal(second.positions[0].zeroCostReceivedRaw, '3');
      assert.equal(second.hasMore, false);
      assert.equal(second.nextAfter, null);

      const globalFirst = await repository.getGlobalOpenPositions({
        projectionVersion: VERSION, limit: 2,
      });
      assert.deepEqual(globalFirst.positions.map(({ tokenAddress, walletAddress }) => (
        [tokenAddress, walletAddress]
      )), [[TOKEN_A, WALLET_A], [TOKEN_B, WALLET_A]]);
      assert.equal(globalFirst.hasMore, true);
      assert.equal(globalFirst.snapshotConsistent, false);
      const globalLast = await repository.getGlobalOpenPositions({
        projectionVersion: VERSION, limit: 2, after: globalFirst.nextAfter,
      });
      assert.deepEqual(globalLast.positions.map(({ walletAddress }) => walletAddress),
        [WALLET_B]);
      assert.equal(globalLast.hasMore, false);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('rejects unbounded token sets and cursors outside the requested set', async () => {
    const repository = createRobinhoodWalletRankingPositionReadRepository({
      database: { queryWithStatementTimeout() { throw new Error('unexpected query'); } },
    });
    const base = { projectionVersion: VERSION, tokenAddresses: [TOKEN_A] };
    await assert.rejects(repository.getOpenPositions({ ...base,
      tokenAddresses: Array(51).fill(TOKEN_A),
    }), /at most 50/);
    await assert.rejects(repository.getOpenPositions({ ...base,
      after: { tokenAddress: TOKEN_B, walletAddress: WALLET_A },
    }), /outside the requested set/);
    await assert.rejects(repository.getOpenPositions({ ...base, limit: 101 }),
      /limit must be between/);
    await assert.rejects(repository.getGlobalOpenPositions({
      projectionVersion: VERSION, limit: 101,
    }), /limit must be between/);
    await assert.rejects(repository.getGlobalOpenPositions({
      projectionVersion: VERSION,
      after: { tokenAddress: TOKEN_A, walletAddress: 'not-a-wallet' },
    }), /address|wallet/i);
    assert.deepEqual(await repository.getOpenPositions({
      projectionVersion: VERSION, tokenAddresses: [],
    }), { projectionVersion: VERSION, positions: [], hasMore: false,
      nextAfter: null, snapshotConsistent: false });
  });
});
