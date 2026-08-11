const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderBackfillRepository,
} = require('../src/models/robinhood-holder-backfill');
const {
  __private: { requeueCandidate },
} = require('../src/utils/robinhood-holder-drift-recovery');

const TOKEN = `0x${'1'.repeat(40)}`;
const DRIFT_TOKEN = `0x${'2'.repeat(40)}`;
const PRIORITY_TOKEN = `0x${'5'.repeat(40)}`;
const ALICE = `0x${'3'.repeat(40)}`;
const BOB = `0x${'4'.repeat(40)}`;
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

describe('Robinhood holder backfill persistence', () => {
  it('commits a range atomically, rejects restart gaps and isolates drift', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE robinhood_holder_balances
        (LIKE public.robinhood_holder_balances INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_token_states
        (LIKE public.robinhood_holder_token_states INCLUDING ALL)`);
      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, ledger_status, deployment_block, backfill_next_block
         ) VALUES ($1, 'backfilling', 100, 100), ($2, 'backfilling', 200, 200)`,
        [TOKEN, DRIFT_TOKEN]
      );
      const repository = createRobinhoodHolderBackfillRepository({
        database: {
          query: client.query.bind(client),
          getClient: async () => ({ query: client.query.bind(client), release() {} }),
        },
      });
      const range = {
        tokenAddress: TOKEN, fromBlock: 100, toBlock: 101,
        checkpoint: { number: 101, hash: HASH_B },
        transfers: [
          transfer(TOKEN, {
            blockNumber: 101, blockHash: HASH_B, transactionHash: HASH_B,
            transactionIndex: 0, logIndex: 2, fromWallet: ALICE,
            toWallet: ZERO, amountRaw: '6',
          }),
          transfer(TOKEN),
          transfer(TOKEN, {
            transactionHash: `0x${'c'.repeat(64)}`, transactionIndex: 1, logIndex: 1,
            fromWallet: ALICE, toWallet: BOB, amountRaw: '4',
          }),
        ],
      };
      assert.deepEqual(await repository.commitRange(range), {
        status: 'committed', tokenAddress: TOKEN, transfers: 3, touchedWallets: 2,
        holderDelta: 1, holderCount: '1', backfillNextBlock: '102',
        liveThroughBlock: '101', liveThroughHash: HASH_B, version: 1,
      });
      await assert.rejects(
        repository.commitRange(range),
        (error) => error.code === 'holder_backfill_cursor_stale'
      );
      assert.equal((await repository.commitRange({
        tokenAddress: TOKEN, fromBlock: 102, toBlock: 102,
        checkpoint: { number: 102, hash: HASH_C }, transfers: [],
      })).backfillNextBlock, '103');
      const driftRange = {
        tokenAddress: DRIFT_TOKEN, fromBlock: 200, toBlock: 200,
        checkpoint: { number: 200, hash: HASH_B },
        transfers: [transfer(DRIFT_TOKEN, {
          blockNumber: 200, blockHash: HASH_B, fromWallet: ALICE,
          toWallet: BOB, amountRaw: '1',
        })],
      };
      const suspected = await repository.commitRange(driftRange);
      assert.equal(suspected.status, 'drift-suspected');
      assert.equal(suspected.reason, 'holder_negative_balance');
      assert.equal(suspected.failedBlock, '200');
      assert.match(suspected.fingerprint, new RegExp(HASH_B));
      const pendingState = await client.query(
        `SELECT ledger_status FROM robinhood_holder_token_states WHERE token_address = $1`,
        [DRIFT_TOKEN]
      );
      assert.equal(pendingState.rows[0].ledger_status, 'backfilling');
      const drifted = await repository.commitRange({ ...driftRange, confirmDrift: true });
      assert.deepEqual(drifted, {
        status: 'drifted', tokenAddress: DRIFT_TOKEN, reason: 'holder_negative_balance',
      });
      const balances = await client.query(
        `SELECT token_address, wallet_address, balance_raw
           FROM robinhood_holder_balances ORDER BY token_address, wallet_address`
      );
      assert.deepEqual(balances.rows.map((row) => [
        row.token_address, row.wallet_address, String(row.balance_raw),
      ]), [[TOKEN, BOB, '4']]);
      const states = await client.query(
        `SELECT token_address, holder_count, ledger_status, backfill_next_block,
                live_through_block FROM robinhood_holder_token_states ORDER BY token_address`
      );
      assert.deepEqual(states.rows.map((row) => ({
        token: row.token_address, count: String(row.holder_count), status: row.ledger_status,
        next: String(row.backfill_next_block), live: row.live_through_block == null
          ? null : String(row.live_through_block),
      })), [
        { token: TOKEN, count: '1', status: 'backfilling', next: '103', live: '102' },
        { token: DRIFT_TOKEN, count: '0', status: 'drifted', next: '200', live: null },
      ]);
      assert.equal(await repository.getNextToken({ throughBlock: '102' }), null);
      assert.deepEqual(await repository.getNextToken({ throughBlock: '103' }), {
        tokenAddress: TOKEN, deploymentBlock: '100', backfillNextBlock: '103',
        liveThroughBlock: '102', liveThroughHash: HASH_C, version: 2,
      });
      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, ledger_status, deployment_block, backfill_next_block
         ) VALUES ($1, 'backfilling', 150, 150)`, [PRIORITY_TOKEN]
      );
      assert.deepEqual(await repository.getNextToken({ throughBlock: '200' }), {
        tokenAddress: PRIORITY_TOKEN, deploymentBlock: '150', backfillNextBlock: '150',
        liveThroughBlock: null, liveThroughHash: null, version: 0,
      });
      assert.deepEqual(await repository.getNextToken({
        throughBlock: '200', excludeTokenAddresses: [PRIORITY_TOKEN],
      }), {
        tokenAddress: TOKEN, deploymentBlock: '100', backfillNextBlock: '103',
        liveThroughBlock: '102', liveThroughHash: HASH_C, version: 2,
      });
      assert.deepEqual(await repository.markResyncing({
        tokenAddress: TOKEN, backfillNextBlock: '103',
      }), { status: 'resyncing', tokenAddress: TOKEN });
      assert.equal(await repository.getNextToken({ throughBlock: '103' }), null);
      assert.equal(await requeueCandidate(client, {
        tokenAddress: DRIFT_TOKEN, version: '1', backfillNextBlock: '200',
      }), true);
      assert.equal(await requeueCandidate(client, {
        tokenAddress: DRIFT_TOKEN, version: '1', backfillNextBlock: '200',
      }), false);
      const recovered = await client.query(
        `SELECT ledger_status, version FROM robinhood_holder_token_states
          WHERE token_address = $1`, [DRIFT_TOKEN]
      );
      assert.deepEqual(recovered.rows[0], { ledger_status: 'backfilling', version: '2' });
    } finally {
      client.release();
    }
  });
});
