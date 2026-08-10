const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderLedgerRepository,
} = require('../src/models/robinhood-holder-ledger');

const HASH_A = `0x${'1'.repeat(64)}`;
const HASH_B = `0x${'2'.repeat(64)}`;
const TOKEN = `0x${'3'.repeat(40)}`;
const TOKEN_2 = `0x${'6'.repeat(40)}`;
const ALICE = `0x${'4'.repeat(40)}`;
const BOB = `0x${'5'.repeat(40)}`;

after(() => db.pool.end());

function capture(blockNumber, blockHash, expectedVersion, rangeStart, overrides = {}) {
  return {
    transfers: [{
      blockNumber, blockHash, transactionHash: HASH_A,
      transactionIndex: 0, logIndex: 0, tokenAddress: TOKEN,
      fromWallet: ALICE, toWallet: BOB, amountRaw: '4',
      ...overrides,
    }],
    cursor: {
      rangeStart, nextBlock: String(Number(blockNumber) + 1), safeHead: '200', expectedVersion,
      checkpoint: { number: blockNumber, hash: blockHash },
    },
  };
}

describe('Robinhood holder ledger persistence', () => {
  it('commits a capture and rolls back conflicting evidence in PostgreSQL', async () => {
    const client = await db.getClient();
    try {
      await client.query(`CREATE TEMP TABLE robinhood_holder_transfer_journal
        (LIKE public.robinhood_holder_transfer_journal INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_cursors
        (LIKE public.robinhood_holder_cursors INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_balances
        (LIKE public.robinhood_holder_balances INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_token_states
        (LIKE public.robinhood_holder_token_states INCLUDING ALL)`);
      const database = {
        getClient: async () => ({
          query: client.query.bind(client),
          release() {},
        }),
      };
      const repository = createRobinhoodHolderLedgerRepository({ database });
      await client.query(
        `INSERT INTO robinhood_holder_token_states
          (token_address, holder_count, ledger_status) VALUES ($1, 1, 'shadow')`, [TOKEN]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 10, 99, $3, 0)`, [TOKEN, ALICE, HASH_B]
      );
      const initial = capture('100', HASH_A, null, '100');
      initial.transfers.push({ ...initial.transfers[0] });
      const first = await repository.appendCapturedRange(initial);
      assert.deepEqual(first, {
        insertedTransfers: 1, duplicateTransfers: 1, cursorVersion: 0,
      });
      assert.deepEqual(await repository.applyNextPendingEvent(), {
        status: 'applied', tokenAddress: TOKEN, holderCount: '2', holderDelta: 1,
      });
      const applied = await client.query(
        `SELECT wallet_address, balance_raw FROM robinhood_holder_balances ORDER BY wallet_address`
      );
      assert.deepEqual(applied.rows.map((row) => [row.wallet_address, String(row.balance_raw)]), [
        [ALICE, '6'], [BOB, '4'],
      ]);
      const journal = await client.query(
        `SELECT applied, from_balance_before, to_balance_after
           FROM robinhood_holder_transfer_journal`
      );
      assert.deepEqual(journal.rows.map((row) => ({
        applied: row.applied,
        fromBefore: String(row.from_balance_before),
        toAfter: String(row.to_balance_after),
      })), [{ applied: true, fromBefore: '10', toAfter: '4' }]);

      await assert.rejects(
        repository.appendCapturedRange(capture('101', HASH_B, 0, '101')),
        (error) => error.code === 'holder_capture_conflict'
      );
      const { rows } = await client.query(
        `SELECT next_block, checkpoint_block, version FROM robinhood_holder_cursors`
      );
      assert.deepEqual(rows.map((row) => ({
        nextBlock: String(row.next_block),
        checkpointBlock: String(row.checkpoint_block),
        version: Number(row.version),
      })), [{ nextBlock: '101', checkpointBlock: '100', version: 0 }]);

      await client.query(
        `INSERT INTO robinhood_holder_token_states
          (token_address, holder_count, ledger_status) VALUES ($1, 1, 'shadow')`, [TOKEN_2]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 1, 100, $3, 0)`, [TOKEN_2, ALICE, HASH_A]
      );
      await repository.appendCapturedRange(capture('101', HASH_B, 0, '101', {
        transactionHash: HASH_B, tokenAddress: TOKEN_2,
      }));
      assert.deepEqual(await repository.applyNextPendingEvent(), {
        status: 'drifted', tokenAddress: TOKEN_2, reason: 'holder_negative_balance',
      });
      const drifted = await client.query(
        `SELECT state.ledger_status, journal.applied
           FROM robinhood_holder_token_states state
           INNER JOIN robinhood_holder_transfer_journal journal
             ON journal.token_address = state.token_address
          WHERE state.token_address = $1`, [TOKEN_2]
      );
      assert.deepEqual(drifted.rows, [{ ledger_status: 'drifted', applied: false }]);
    } finally {
      client.release();
    }
  });
});
