const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderGlobalBackfillCommitRepository,
} = require('../src/models/robinhood-holder-global-backfill-commit');

const TOKEN_A = `0x${'1'.repeat(40)}`;
const TOKEN_B = `0x${'2'.repeat(40)}`;
const ALICE = `0x${'3'.repeat(40)}`;
const BOB = `0x${'4'.repeat(40)}`;
const CAROL = `0x${'5'.repeat(40)}`;
const ZERO = `0x${'0'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;

after(() => db.pool.end());

function transfer(tokenAddress, overrides = {}) {
  return {
    blockNumber: '100', blockHash: HASH_A, transactionHash: HASH_A,
    transactionIndex: 0, logIndex: 0, tokenAddress,
    fromWallet: ZERO, toWallet: ALICE, amountRaw: '10', ...overrides,
  };
}

describe('Robinhood holder global backfill range commit', () => {
  it('atomically commits multiple tokens, rejects gaps/deficits and cleans exclusions', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE robinhood_holder_balances
        (LIKE public.robinhood_holder_balances INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_runs
        (LIKE public.robinhood_holder_global_backfill_runs INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_tokens
        (LIKE public.robinhood_holder_global_backfill_tokens INCLUDING ALL)`);
      const run = await client.query(
        `INSERT INTO robinhood_holder_global_backfill_runs (
           status, catalog_cutoff, next_block, version
         ) VALUES ('scanning', NOW(), 100, 1) RETURNING id`
      );
      const runId = String(run.rows[0].id);
      await client.query(
        `INSERT INTO robinhood_holder_global_backfill_tokens (run_id, token_address)
         VALUES ($1, $2), ($1, $3)`, [runId, TOKEN_A, TOKEN_B]
      );
      const database = {
        getClient: async () => ({ query: client.query.bind(client), release() {} }),
      };
      const repository = createRobinhoodHolderGlobalBackfillCommitRepository({ database });
      const range = {
        runId, fromBlock: 100, toBlock: 101,
        checkpoint: { number: 101, hash: HASH_B },
        transfers: [
          transfer(TOKEN_A, {
            blockNumber: 101, blockHash: HASH_B, transactionHash: HASH_B,
            fromWallet: ALICE, toWallet: ZERO, amountRaw: '6',
          }),
          transfer(TOKEN_B, { transactionHash: HASH_C, logIndex: 2, toWallet: CAROL, amountRaw: '3' }),
          transfer(TOKEN_A),
          transfer(TOKEN_A, {
            transactionHash: HASH_C, transactionIndex: 1, logIndex: 1,
            fromWallet: ALICE, toWallet: BOB, amountRaw: '4',
          }),
        ],
      };
      assert.deepEqual(await repository.commitRange(range), {
        status: 'committed', runId, fromBlock: '100', toBlock: '101', nextBlock: '102',
        checkpointHash: HASH_B, transfers: 4, touchedTokens: 2, touchedWallets: 3,
        version: '2',
      });
      await assert.rejects(
        repository.commitRange(range), { code: 'holder_global_backfill_cursor_stale' }
      );
      assert.equal((await repository.commitRange({
        runId, fromBlock: 102, toBlock: 102,
        checkpoint: { number: 102, hash: HASH_C }, transfers: [],
      })).nextBlock, '103');

      await assert.rejects(repository.commitRange({
        runId, fromBlock: 103, toBlock: 103,
        checkpoint: { number: 103, hash: HASH_C },
        transfers: [
          transfer(TOKEN_A, {
            blockNumber: 103, blockHash: HASH_C, transactionHash: HASH_C,
            toWallet: ALICE, amountRaw: '2',
          }),
          transfer(TOKEN_B, {
            blockNumber: 103, blockHash: HASH_C,
            fromWallet: BOB, toWallet: ALICE, amountRaw: '1', logIndex: 3,
          }),
        ],
      }), (error) => error.code === 'holder_negative_balance'
        && error.tokenAddress === TOKEN_B && error.failedBlock === '103');

      const beforeExclusion = await client.query(
        `SELECT token_address, holder_count FROM robinhood_holder_global_backfill_tokens
          ORDER BY token_address`
      );
      assert.deepEqual(beforeExclusion.rows.map((row) => [
        row.token_address, String(row.holder_count),
      ]), [[TOKEN_A, '1'], [TOKEN_B, '1']]);
      const cursor = await client.query(
        `SELECT next_block, checkpoint_block FROM robinhood_holder_global_backfill_runs
          WHERE id = $1`, [runId]
      );
      assert.deepEqual(cursor.rows[0], { next_block: '103', checkpoint_block: '102' });

      assert.deepEqual(await repository.excludeToken({
        runId, tokenAddress: TOKEN_A, reason: 'malformed_transfer_log',
      }), { status: 'excluded', tokenAddress: TOKEN_A, deletedBalances: 1 });
      await assert.rejects(repository.commitRange({
        runId, fromBlock: 103, toBlock: 103,
        checkpoint: { number: 103, hash: HASH_C },
        transfers: [transfer(TOKEN_A, {
          blockNumber: 103, blockHash: HASH_C, transactionHash: HASH_C,
        })],
      }), { code: 'holder_global_backfill_token_unavailable' });
      assert.deepEqual(await repository.excludeToken({
        runId, tokenAddress: TOKEN_A, reason: 'malformed_transfer_log',
      }), { status: 'excluded', tokenAddress: TOKEN_A, deletedBalances: 0 });
      const balances = await client.query(
        `SELECT token_address, wallet_address, balance_raw
           FROM robinhood_holder_balances ORDER BY token_address, wallet_address`
      );
      assert.deepEqual(balances.rows.map((row) => [
        row.token_address, row.wallet_address, String(row.balance_raw),
      ]), [[TOKEN_B, CAROL, '3']]);
      const excluded = await client.query(
        `SELECT holder_count, status, exclusion_reason
           FROM robinhood_holder_global_backfill_tokens WHERE token_address = $1`, [TOKEN_A]
      );
      assert.deepEqual(excluded.rows[0], {
        holder_count: '0', status: 'excluded', exclusion_reason: 'malformed_transfer_log',
      });
    } finally {
      client.release();
    }
  });
});
