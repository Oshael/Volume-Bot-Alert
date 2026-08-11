const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderLedgerRepository,
} = require('../src/models/robinhood-holder-ledger');
const {
  createRobinhoodHolderJournalRetention,
} = require('../src/models/robinhood-holder-journal-retention');

const HASH_A = `0x${'1'.repeat(64)}`;
const HASH_B = `0x${'2'.repeat(64)}`;
const HASH_C = `0x${'7'.repeat(64)}`;
const TOKEN = `0x${'3'.repeat(40)}`;
const TOKEN_2 = `0x${'6'.repeat(40)}`;
const TOKEN_3 = `0x${'8'.repeat(40)}`;
const ALICE = `0x${'4'.repeat(40)}`;
const BOB = `0x${'5'.repeat(40)}`;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;

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
  it('commits captures and atomically rewinds orphaned evidence in PostgreSQL', async () => {
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
        query: client.query.bind(client),
        getClient: async () => ({
          query: client.query.bind(client),
          release() {},
        }),
      };
      const repository = createRobinhoodHolderLedgerRepository({ database });
      const retention = createRobinhoodHolderJournalRetention({ database });
      await client.query(
        `INSERT INTO robinhood_holder_token_states
          (token_address, holder_count, ledger_status, backfill_next_block)
         VALUES ($1, 1, 'shadow', 100), ($2, 0, 'shadow', 101)`, [TOKEN, TOKEN_3]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 10, 99, $3, 0)`, [TOKEN, ALICE, HASH_B]
      );
      const initial = capture('100', HASH_A, null, '100');
      initial.transfers.push({ ...initial.transfers[0] });
      initial.transfers.push({
        ...initial.transfers[0], transactionHash: HASH_C,
        transactionIndex: 1, logIndex: 1, fromWallet: BOB,
        toWallet: ALICE, amountRaw: '1',
      });
      const first = await repository.appendCapturedRange(initial);
      assert.deepEqual(first, {
        insertedTransfers: 2, duplicateTransfers: 1, cursorVersion: 0,
      });
      assert.deepEqual(await repository.applyNextPendingEvent(), {
        status: 'applied', tokenAddress: TOKEN, holderCount: '2', holderDelta: 1,
      });
      assert.deepEqual(await repository.applyNextPendingEvent(), {
        status: 'applied', tokenAddress: TOKEN, holderCount: '2', holderDelta: 0,
      });
      const applied = await client.query(
        `SELECT wallet_address, balance_raw FROM robinhood_holder_balances ORDER BY wallet_address`
      );
      assert.deepEqual(applied.rows.map((row) => [row.wallet_address, String(row.balance_raw)]), [
        [ALICE, '7'], [BOB, '3'],
      ]);
      const journal = await client.query(
        `SELECT transaction_hash, applied, from_balance_before, to_balance_after,
                from_last_block_before, from_last_transaction_hash_before,
                from_last_log_index_before, to_last_block_before,
                to_last_transaction_hash_before, to_last_log_index_before
           FROM robinhood_holder_transfer_journal ORDER BY transaction_index, log_index`
      );
      assert.deepEqual(journal.rows.map((row) => ({
        transactionHash: row.transaction_hash,
        applied: row.applied,
        fromBefore: String(row.from_balance_before),
        toAfter: String(row.to_balance_after),
        fromPrior: [
          String(row.from_last_block_before), row.from_last_transaction_hash_before,
          Number(row.from_last_log_index_before),
        ],
        toPrior: [
          row.to_last_block_before, row.to_last_transaction_hash_before,
          row.to_last_log_index_before,
        ],
      })), [{
        transactionHash: HASH_A, applied: true, fromBefore: '10', toAfter: '4',
        fromPrior: ['99', HASH_B, 0], toPrior: [null, null, null],
      }, {
        transactionHash: HASH_C, applied: true, fromBefore: '4', toAfter: '7',
        fromPrior: ['100', HASH_A, 0], toPrior: ['100', HASH_A, 0],
      }]);
      assert.deepEqual(await repository.listJournalBlockCheckpoints({
        fromBlock: '100', toBlock: '100',
      }), [{ number: '100', hash: HASH_A }]);

      await assert.rejects(
        repository.appendCapturedRange(capture('101', HASH_B, 0, '101')),
        (error) => error.code === 'holder_capture_conflict'
      );
      const { rows } = await client.query(
        `SELECT next_block, checkpoint_block, journal_floor_block, version
           FROM robinhood_holder_cursors`
      );
      assert.deepEqual(rows.map((row) => ({
        nextBlock: String(row.next_block),
        checkpointBlock: String(row.checkpoint_block),
        journalFloorBlock: String(row.journal_floor_block),
        version: Number(row.version),
      })), [{
        nextBlock: '101', checkpointBlock: '100', journalFloorBlock: '100', version: 0,
      }]);

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

      await client.query(
        `UPDATE robinhood_holder_balances SET balance_raw = 5
          WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, BOB]
      );
      await assert.rejects(
        repository.rewindOrphanedRange({
          nextBlock: '100', safeHead: '199', expectedVersion: 1,
          checkpoint: { number: '99', hash: HASH_B },
        }),
        (error) => error.code === 'holder_rollback_conflict'
      );
      const failedRollback = await client.query(
        `SELECT balance_raw FROM robinhood_holder_balances
          WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, ALICE]
      );
      assert.equal(String(failedRollback.rows[0].balance_raw), '7');
      await client.query(
        `UPDATE robinhood_holder_balances SET balance_raw = 3
          WHERE token_address = $1 AND wallet_address = $2`, [TOKEN, BOB]
      );
      await client.query(
        `UPDATE robinhood_holder_token_states SET ledger_status = 'live'
          WHERE token_address = ANY($1::varchar[])`, [[TOKEN, TOKEN_3]]
      );

      const rewoundResult = await repository.rewindOrphanedRange({
        nextBlock: '100', safeHead: '199', expectedVersion: 1,
        checkpoint: { number: '99', hash: HASH_B },
      });
      const { publications, ...rewindSummary } = rewoundResult;
      assert.deepEqual(rewindSummary, {
        status: 'rewound', revertedEvents: 2, affectedTokens: 1,
        resyncingTokens: 1, removedEvents: 3, cursorVersion: 2,
      });
      assert.deepEqual(publications.map(({ observedAt, ...publication }) => {
        assert.ok(observedAt instanceof Date);
        return publication;
      }).sort((left, right) => left.tokenAddress.localeCompare(right.tokenAddress)), [{
        tokenAddress: TOKEN, holderCount: '1', ledgerVersion: '4',
        liveThroughBlock: '99', liveThroughHash: HASH_B,
      }, {
        tokenAddress: TOKEN_3, invalidated: true, ledgerVersion: '1',
        liveThroughBlock: '99', liveThroughHash: HASH_B,
      }]);
      const restored = await client.query(
        `SELECT wallet_address, balance_raw, last_block_number,
                last_transaction_hash, last_log_index
           FROM robinhood_holder_balances WHERE token_address = $1`, [TOKEN]
      );
      assert.deepEqual(restored.rows.map((row) => ({
        wallet: row.wallet_address, balance: String(row.balance_raw),
        block: String(row.last_block_number), transactionHash: row.last_transaction_hash,
        logIndex: Number(row.last_log_index),
      })), [{
        wallet: ALICE, balance: '10', block: '99',
        transactionHash: HASH_B, logIndex: 0,
      }]);
      const rewound = await client.query(
        `SELECT state.token_address, state.holder_count, state.ledger_status,
                state.live_through_block, state.live_through_hash,
                cursor.next_block, cursor.safe_head, cursor.checkpoint_block,
                cursor.checkpoint_hash, cursor.version,
                (SELECT COUNT(*) FROM robinhood_holder_transfer_journal) AS journal_count
           FROM robinhood_holder_token_states state
           CROSS JOIN robinhood_holder_cursors cursor
          WHERE state.token_address = $1`, [TOKEN]
      );
      assert.deepEqual(rewound.rows.map((row) => ({
        holderCount: String(row.holder_count), ledgerStatus: row.ledger_status,
        liveThroughBlock: String(row.live_through_block), liveThroughHash: row.live_through_hash,
        nextBlock: String(row.next_block), safeHead: String(row.safe_head),
        checkpointBlock: String(row.checkpoint_block), checkpointHash: row.checkpoint_hash,
        version: Number(row.version), journalCount: Number(row.journal_count),
      })), [{
        holderCount: '1', ledgerStatus: 'live', liveThroughBlock: '99',
        liveThroughHash: HASH_B, nextBlock: '100', safeHead: '199',
        checkpointBlock: '99', checkpointHash: HASH_B, version: 2, journalCount: 0,
      }]);
      const stillDrifted = await client.query(
        `SELECT ledger_status FROM robinhood_holder_token_states WHERE token_address = $1`,
        [TOKEN_2]
      );
      assert.equal(stillDrifted.rows[0].ledger_status, 'drifted');
      const crossedBaseline = await client.query(
        `SELECT ledger_status FROM robinhood_holder_token_states WHERE token_address = $1`,
        [TOKEN_3]
      );
      assert.equal(crossedBaseline.rows[0].ledger_status, 'resyncing');

      await client.query(
        `UPDATE robinhood_holder_cursors
            SET next_block = 20150, safe_head = 20200,
                checkpoint_block = 20149, checkpoint_hash = $1
          WHERE chain = 'robinhood' AND stream = 'live'`, [HASH_A]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index,
           log_index, token_address, from_wallet, to_wallet, amount_raw,
           from_balance_before, from_balance_after,
           to_balance_before, to_balance_after, holder_delta, applied, applied_at
         ) VALUES
           (100, $1, $1, 0, 0, $4, $5, $6, 1,
             NULL, NULL, 0, 1, 1, true, NOW()),
           (102, $1, $2, 1, 1, $4, $5, $7, 1,
             NULL, NULL, 0, 1, 1, true, NOW()),
           (101, $1, $3, 2, 2, $4, $7, $6, 1,
             NULL, NULL, NULL, NULL, NULL, false, NULL)`,
        [HASH_A, HASH_C, HASH_B, TOKEN, ZERO_ADDRESS, BOB, ALICE]
      );
      assert.deepEqual(await retention.pruneOnce({ batchLimit: 1 }), {
        status: 'blocked', reason: 'pending_event_before_cutoff', deletedEvents: 0,
        cutoffBlock: '150', journalFloorBlock: '100',
      });
      await client.query(
        `DELETE FROM robinhood_holder_transfer_journal WHERE applied = false`
      );
      assert.deepEqual(await retention.pruneOnce({ batchLimit: 1 }), {
        status: 'draining', deletedEvents: 1,
        cutoffBlock: '150', journalFloorBlock: '100',
      });
      assert.deepEqual(await retention.pruneOnce({ batchLimit: 1 }), {
        status: 'pruned', deletedEvents: 1,
        cutoffBlock: '150', journalFloorBlock: '150',
      });
      const pruned = await client.query(
        `SELECT journal_floor_block,
                (SELECT COUNT(*) FROM robinhood_holder_transfer_journal) AS journal_count
           FROM robinhood_holder_cursors`
      );
      assert.deepEqual(pruned.rows.map((row) => ({
        journalFloorBlock: String(row.journal_floor_block),
        journalCount: Number(row.journal_count),
      })), [{ journalFloorBlock: '150', journalCount: 0 }]);
      await assert.rejects(
        repository.rewindOrphanedRange({
          nextBlock: '149', safeHead: '20149', expectedVersion: 2,
          checkpoint: { number: '148', hash: HASH_B },
        }),
        (error) => error.code === 'holder_rewind_below_floor'
      );
    } finally {
      client.release();
    }
  });
});
