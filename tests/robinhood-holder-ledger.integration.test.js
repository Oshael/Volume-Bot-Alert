const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const { HOT_QUEUE_REPAIR_STATEMENTS, STATEMENTS: HOT_QUEUE_DDL } = require('../src/utils/db-init-stage180');
const {
  createRobinhoodHolderLedgerRepository, __private,
} = require('../src/models/robinhood-holder-ledger');
const {
  createRobinhoodHolderJournalRetention,
} = require('../src/models/robinhood-holder-journal-retention');
const { runBatch } = require('../src/utils/prune-robinhood-holder-journal');

const HASH_A = `0x${'1'.repeat(64)}`;
const HASH_B = `0x${'2'.repeat(64)}`;
const HASH_C = `0x${'7'.repeat(64)}`;
const HASH_D = `0x${'d'.repeat(64)}`;
const HASH_E = `0x${'e'.repeat(64)}`;
const HASH_F = `0x${'f'.repeat(64)}`;
const HASH_6 = `0x${'6'.repeat(64)}`;
const HASH_8 = `0x${'8'.repeat(64)}`;
const HASH_0 = `0x${'0'.repeat(64)}`;
const TOKEN = `0x${'3'.repeat(40)}`;
const TOKEN_2 = `0x${'6'.repeat(40)}`;
const TOKEN_3 = `0x${'8'.repeat(40)}`;
const TOKEN_4 = `0x${'a'.repeat(40)}`;
const TOKEN_5 = `0x${'9'.repeat(40)}`;
const TOKEN_BATCH = `0x${'b'.repeat(40)}`;
const TOKEN_NO_TAIL = `0x${'c'.repeat(40)}`;
const TOKEN_WIDE_TAIL = `0x${'d'.repeat(40)}`;
const TOKEN_DRIFT_TAIL = `0x${'e'.repeat(40)}`;
const TOKEN_UNTRACKED = `0x${'7'.repeat(40)}`;
const HASH_9 = `0x${'9'.repeat(64)}`;
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

async function observeReorgFenceMode(client, mode) {
  await client.query('BEGIN');
  try {
    await __private.lockReorgFence(client, mode);
    const result = await client.query(
      `SELECT mode FROM pg_locks
        WHERE pid = pg_backend_pid() AND locktype = 'advisory' AND granted`
    );
    return result.rows.map((row) => row.mode).sort();
  } finally {
    await client.query('ROLLBACK');
  }
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
      await client.query(HOT_QUEUE_DDL[0].replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMP TABLE'));
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_runs
        (LIKE public.robinhood_holder_global_backfill_runs INCLUDING ALL)`);
      await client.query(`CREATE TEMP TABLE robinhood_holder_global_backfill_tokens
        (LIKE public.robinhood_holder_global_backfill_tokens INCLUDING ALL)`);
      await client.query(HOT_QUEUE_REPAIR_STATEMENTS[0]);
      await client.query(`CREATE TRIGGER rh_holder_journal_hot_enqueue_temp
        AFTER INSERT ON robinhood_holder_transfer_journal
        REFERENCING NEW TABLE AS inserted_holder_transfers
        FOR EACH STATEMENT EXECUTE FUNCTION public.enqueue_robinhood_holder_hot()`);
      const database = {
        query: client.query.bind(client),
        getClient: async () => ({
          query: client.query.bind(client),
          release() {},
        }),
      };
      const repository = createRobinhoodHolderLedgerRepository({ database });
      const retention = createRobinhoodHolderJournalRetention({ database });
      assert.deepEqual(await observeReorgFenceMode(client, 'shared'), ['ShareLock']);
      assert.deepEqual(await observeReorgFenceMode(client, 'exclusive'), ['ExclusiveLock']);
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index, log_index,
           token_address, from_wallet, to_wallet, amount_raw
         ) VALUES (99, $1, $2, 0, 0, $3, $4, $5, 1)`,
        [HASH_A, HASH_9, TOKEN_UNTRACKED, ZERO_ADDRESS, BOB]
      );
      const untrackedQueue = await client.query(
        `SELECT 1 FROM robinhood_holder_hot_queue WHERE token_address = $1`,
        [TOKEN_UNTRACKED]
      );
      assert.equal(untrackedQueue.rowCount, 0);
      await client.query(
        `DELETE FROM robinhood_holder_transfer_journal WHERE token_address = $1`,
        [TOKEN_UNTRACKED]
      );
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
      const conflictingBatch = capture('100', HASH_A, null, '100');
      conflictingBatch.transfers.push({
        ...conflictingBatch.transfers[0], amountRaw: '5',
      });
      await assert.rejects(
        repository.appendCapturedRange(conflictingBatch),
        (error) => error.code === 'holder_capture_conflict'
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
      await client.query(
        `UPDATE robinhood_holder_token_states SET ledger_status = 'live'
          WHERE token_address = $1`, [TOKEN_3]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index, log_index,
           token_address, from_wallet, to_wallet, amount_raw
         ) VALUES (101, $1, $2, 0, 0, $3, $4, $5, 1)`,
        [HASH_A, HASH_8, TOKEN_3, ZERO_ADDRESS, BOB]
      );
      assert.deepEqual(
        await repository.listHotPendingTokenAddresses({ limit: 10 }), [TOKEN_3, TOKEN]
      );
      assert.deepEqual(await repository.listHotPendingTokenAddresses({
        limit: 10, priorityClass: 'fresh-live',
      }), [TOKEN_3]);
      assert.deepEqual(await repository.listHotPendingTokenAddresses({
        limit: 10, priorityClass: 'recent-shadow',
      }), [TOKEN]);
      assert.deepEqual(await repository.listHotPendingTokenAddresses({
        limit: 10, priorityClass: 'stale-live',
      }), []);
      await client.query(
        `UPDATE robinhood_holder_cursors SET next_block = 20101
          WHERE chain = 'robinhood' AND stream = 'live'`
      );
      assert.deepEqual(await repository.listHotPendingTokenAddresses({
        limit: 10, priorityClass: 'recent-shadow',
      }), []);
      assert.deepEqual(await repository.listHotPendingTokenAddresses({
        limit: 10, priorityClass: 'stale-shadow',
      }), [TOKEN]);
      await client.query(
        `UPDATE robinhood_holder_cursors SET next_block = 101
          WHERE chain = 'robinhood' AND stream = 'live'`
      );
      assert.deepEqual(
        await repository.listPendingTokenAddresses({ limit: 10 }),
        [TOKEN_3, TOKEN]
      );
      await client.query(
        `DELETE FROM robinhood_holder_transfer_journal WHERE transaction_hash = $1`, [HASH_8]
      );
      await client.query(
        `DELETE FROM robinhood_holder_hot_queue WHERE token_address = $1`, [TOKEN_3]
      );
      await client.query(
        `UPDATE robinhood_holder_token_states SET ledger_status = 'shadow'
          WHERE token_address = $1`, [TOKEN_3]
      );
      assert.deepEqual(await repository.listPendingTokenAddresses({ limit: 10 }), [TOKEN]);
      assert.deepEqual(await repository.listPendingTokenAddresses({
        limit: 10, excludeTokenAddresses: [TOKEN],
      }), []);
      assert.deepEqual(await repository.applyNextPendingEvent({ maxEvents: 3 }), {
        status: 'applied', tokenAddress: TOKEN, holderCount: '2', holderDelta: 0,
        appliedEvents: 2, attemptedEvents: 2, tokenDrained: true,
      });
      assert.deepEqual(await repository.getHotQueueFreshness(), {
        pendingTokens: 0, freshLiveTokens: 0, recentShadowTokens: 0,
        staleShadowTokens: 0, staleLiveTokens: 0, worstLagBlocks: 0, oldestAgeMs: 0,
      });
      await client.query(
        `INSERT INTO robinhood_holder_token_states
          (token_address, holder_count, ledger_status, deployment_block, backfill_next_block)
         VALUES ($1, 7, 'shadow', 99, 99), ($2, 8, 'shadow', 99, 99)`,
        [TOKEN_4, TOKEN_5]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index, log_index,
           token_address, from_wallet, to_wallet, amount_raw
         ) VALUES (100, $1, $2, 2, 0, $3, $4, $5, 1)`,
        [HASH_A, HASH_D, TOKEN_5, ALICE, BOB]
      );
      const localPromotion = await repository.promoteReadyShadowTokens({
        limit: 10, tokenAddress: TOKEN_4,
      });
      assert.equal(localPromotion.promotedTokens, 1);
      assert.equal(localPromotion.publications[0].tokenAddress, TOKEN_4);
      assert.equal(localPromotion.publications[0].holderCount, '7');
      assert.equal(localPromotion.publications[0].liveThroughBlock, '100');
      const promotionStates = await client.query(
        `SELECT token_address, ledger_status FROM robinhood_holder_token_states
          WHERE token_address = ANY($1::varchar[]) ORDER BY token_address`,
        [[TOKEN_4, TOKEN_5]]
      );
      assert.deepEqual(promotionStates.rows, [
        { token_address: TOKEN_5, ledger_status: 'shadow' },
        { token_address: TOKEN_4, ledger_status: 'live' },
      ]);
      await client.query(
        `DELETE FROM robinhood_holder_transfer_journal WHERE token_address = $1`, [TOKEN_5]
      );
      await client.query(
        `DELETE FROM robinhood_holder_token_states WHERE token_address = ANY($1::varchar[])`,
        [[TOKEN_4, TOKEN_5]]
      );
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

      await client.query(
        `INSERT INTO robinhood_holder_token_states (
           token_address, holder_count, ledger_status, backfill_next_block,
           live_through_block, live_through_hash
         ) VALUES ($1, 1, 'live', 100, 99, $2)`, [TOKEN_BATCH, HASH_B]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 5, 99, $3, 0)`, [TOKEN_BATCH, ALICE, HASH_B]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index,
           log_index, token_address, from_wallet, to_wallet, amount_raw, captured_at
         ) VALUES
           (100, $1, $2, 10, 10, $5, $6, $7, 2, NOW() - INTERVAL '1 day'),
           (100, $1, $3, 11, 11, $5, $7, $6, 1, NOW()),
           (100, $1, $4, 12, 12, $5, $7, $6, 9, NOW())`,
        [HASH_A, HASH_F, HASH_6, HASH_8, TOKEN_BATCH, ALICE, BOB]
      );
      const queuedBefore = await client.query(
        `SELECT first_enqueued_at FROM robinhood_holder_hot_queue WHERE token_address = $1`,
        [TOKEN_BATCH]
      );
      const partial = await repository.applyNextPendingEvent({
        onlyTokenAddress: TOKEN_BATCH, maxEvents: 3,
      });
      const queuedAfter = await client.query(
        `SELECT first_pending_block, last_pending_block, first_enqueued_at
           FROM robinhood_holder_hot_queue WHERE token_address = $1`, [TOKEN_BATCH]
      );
      assert.deepEqual(queuedAfter.rows, [{
        first_pending_block: '100', last_pending_block: '100',
        first_enqueued_at: queuedBefore.rows[0].first_enqueued_at,
      }]);
      assert.deepEqual({
        status: partial.status, tokenAddress: partial.tokenAddress,
        appliedEvents: partial.appliedEvents, attemptedEvents: partial.attemptedEvents,
        failedTransactionHash: partial.failedTransactionHash,
        recoverySafe: partial.recoverySafe,
      }, {
        status: 'drift-suspected', tokenAddress: TOKEN_BATCH,
        appliedEvents: 2, attemptedEvents: 3,
        failedTransactionHash: HASH_8, recoverySafe: false,
      });
      assert.deepEqual({ ...partial.publication, observedAt: undefined }, {
        tokenAddress: TOKEN_BATCH, holderCount: '2', ledgerVersion: '2',
        liveThroughBlock: '100', liveThroughHash: HASH_A, observedAt: undefined,
      });
      assert.ok(partial.publication.observedAt instanceof Date);
      const partialState = await client.query(
        `SELECT holder_count, version, live_through_block
           FROM robinhood_holder_token_states WHERE token_address = $1`, [TOKEN_BATCH]
      );
      assert.deepEqual(partialState.rows.map((row) => ({
        holderCount: String(row.holder_count), version: Number(row.version),
        liveThroughBlock: String(row.live_through_block),
      })), [{ holderCount: '2', version: 2, liveThroughBlock: '100' }]);
      const partialBalances = await client.query(
        `SELECT wallet_address, balance_raw FROM robinhood_holder_balances
          WHERE token_address = $1 ORDER BY wallet_address`, [TOKEN_BATCH]
      );
      assert.deepEqual(partialBalances.rows.map((row) => [
        row.wallet_address, String(row.balance_raw),
      ]), [[ALICE, '4'], [BOB, '1']]);
      const partialJournal = await client.query(
        `SELECT transaction_hash, applied, from_last_transaction_hash_before,
                to_last_transaction_hash_before
           FROM robinhood_holder_transfer_journal
          WHERE token_address = $1 ORDER BY transaction_index`, [TOKEN_BATCH]
      );
      assert.deepEqual(partialJournal.rows, [{
        transaction_hash: HASH_F, applied: true,
        from_last_transaction_hash_before: HASH_B,
        to_last_transaction_hash_before: null,
      }, {
        transaction_hash: HASH_6, applied: true,
        from_last_transaction_hash_before: HASH_F,
        to_last_transaction_hash_before: HASH_F,
      }, {
        transaction_hash: HASH_8, applied: false,
        from_last_transaction_hash_before: null,
        to_last_transaction_hash_before: null,
      }]);
      await client.query(
        `DELETE FROM robinhood_holder_transfer_journal WHERE token_address = $1`, [TOKEN_BATCH]
      );
      await client.query(
        `DELETE FROM robinhood_holder_balances WHERE token_address = $1`, [TOKEN_BATCH]
      );
      await client.query(
        `DELETE FROM robinhood_holder_token_states WHERE token_address = $1`, [TOKEN_BATCH]
      );
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
        `INSERT INTO robinhood_holder_token_states (
           token_address, holder_count, ledger_status, deployment_block,
           backfill_next_block, live_through_block, live_through_hash
         ) VALUES ($1, 1, 'live', 50, 101, 100, $2)`, [TOKEN_4, HASH_A]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 1, 100, $3, 9)`, [TOKEN_4, ALICE, HASH_D]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index,
           log_index, token_address, from_wallet, to_wallet, amount_raw, applied
         ) VALUES (100, $1, $2, 9, 9, $3, $4, $5, 1, false)`,
        [HASH_A, HASH_D, TOKEN_4, ZERO_ADDRESS, ALICE]
      );
      assert.deepEqual(await repository.quarantineMalformedToken({ tokenAddress: TOKEN_4 }), {
        status: 'quarantined', tokenAddress: TOKEN_4, priorStatus: 'live', version: '1',
        deletedBalances: 1, deletedJournalEvents: 1, excludedCohortTokens: 0,
      });
      const quarantined = await client.query(
        `SELECT holder_count, ledger_status, backfill_next_block, live_through_block,
                (SELECT COUNT(*) FROM robinhood_holder_balances
                  WHERE token_address = $1)::int AS balances,
                (SELECT COUNT(*) FROM robinhood_holder_transfer_journal
                  WHERE token_address = $1)::int AS journal
           FROM robinhood_holder_token_states WHERE token_address = $1`, [TOKEN_4]
      );
      assert.deepEqual(quarantined.rows, [{
        holder_count: '0', ledger_status: 'drifted', backfill_next_block: '50',
        live_through_block: null, balances: 0, journal: 0,
      }]);

      await client.query(
        `INSERT INTO robinhood_holder_token_states
          (token_address, holder_count, ledger_status, backfill_next_block,
           live_through_block, live_through_hash)
         VALUES ($1, 1, 'shadow', 101, 100, $2)`, [TOKEN_2, HASH_A]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 1, 100, $3, 0)`, [TOKEN_2, ALICE, HASH_A]
      );
      await repository.appendCapturedRange(capture('101', HASH_B, 0, '101', {
        transactionHash: HASH_B, transactionIndex: 1, tokenAddress: TOKEN_2,
      }));
      assert.deepEqual(await repository.applyNextPendingEvent({
        excludeTokenAddresses: [TOKEN_2],
      }), { status: 'idle' });
      const suspicion = await repository.applyNextPendingEvent();
      assert.deepEqual({
        status: suspicion.status, tokenAddress: suspicion.tokenAddress,
        failedBlock: suspicion.failedBlock, recoveryFromBlock: suspicion.recoveryFromBlock,
        recoverySafe: suspicion.recoverySafe,
      }, {
        status: 'drift-suspected', tokenAddress: TOKEN_2,
        failedBlock: '101', recoveryFromBlock: '101', recoverySafe: true,
      });
      assert.deepEqual(await repository.repairCapturedRange({
        tokenAddress: TOKEN_2, fromBlock: '101', toBlock: '101',
        checkpoint: { number: '101', hash: HASH_B },
        transfers: [{
          blockNumber: '101', blockHash: HASH_B, transactionHash: HASH_D,
          transactionIndex: 0, logIndex: 1, tokenAddress: TOKEN_2,
          fromWallet: ZERO_ADDRESS, toWallet: ALICE, amountRaw: '3',
        }],
      }), {
        status: 'repaired', tokenAddress: TOKEN_2,
        insertedTransfers: 1, duplicateTransfers: 0,
      });
      const repairedBatch = await repository.applyNextPendingEvent({ maxEvents: 2 });
      assert.equal(repairedBatch.status, 'applied');
      assert.equal(repairedBatch.appliedEvents, 2);
      assert.equal(repairedBatch.attemptedEvents, 2);
      await repository.repairCapturedRange({
        tokenAddress: TOKEN_2, fromBlock: '101', toBlock: '101',
        checkpoint: { number: '101', hash: HASH_B },
        transfers: [{
          blockNumber: '101', blockHash: HASH_B,
          transactionHash: `0x${'9'.repeat(64)}`,
          transactionIndex: 2, logIndex: 2, tokenAddress: TOKEN_2,
          fromWallet: ALICE, toWallet: BOB, amountRaw: '1',
        }],
      });
      await client.query(
        `UPDATE robinhood_holder_token_states SET ledger_status = 'live'
          WHERE token_address = $1`, [TOKEN_2]
      );
      const persistent = await repository.applyNextPendingEvent();
      assert.equal(persistent.status, 'drift-suspected');
      assert.equal(persistent.recoverySafe, false);
      const rolledBack = await repository.rollbackAppliedTail({
        tokenAddress: persistent.tokenAddress,
        backfillNextBlock: persistent.recoveryFromBlock,
        failedBlock: persistent.failedBlock,
        failedTransactionHash: persistent.failedTransactionHash,
        failedLogIndex: persistent.failedLogIndex,
      });
      const { publication, ...rollbackSummary } = rolledBack;
      assert.deepEqual(rollbackSummary, {
        status: 'requeued', tokenAddress: TOKEN_2, priorStatus: 'live',
        backfillNextBlock: '101', revertedEvents: 2,
      });
      assert.deepEqual({ ...publication, observedAt: undefined }, {
        tokenAddress: TOKEN_2, invalidated: true, ledgerVersion: '3',
        liveThroughBlock: '101', liveThroughHash: HASH_B, observedAt: undefined,
      });
      assert.ok(publication.observedAt instanceof Date);
      const recoveredTail = await client.query(
        `SELECT state.holder_count, state.ledger_status, state.live_through_block,
                COUNT(*) FILTER (WHERE journal.applied = false)::int AS pending,
                COUNT(*) FILTER (WHERE journal.applied = true)::int AS applied
           FROM robinhood_holder_token_states state
           INNER JOIN robinhood_holder_transfer_journal journal
             ON journal.token_address = state.token_address
          WHERE state.token_address = $1
          GROUP BY state.holder_count, state.ledger_status, state.live_through_block`, [TOKEN_2]
      );
      assert.deepEqual(recoveredTail.rows, [{
        holder_count: '1', ledger_status: 'backfilling', live_through_block: null,
        pending: 3, applied: 0,
      }]);
      const restoredTailBalances = await client.query(
        `SELECT wallet_address, balance_raw FROM robinhood_holder_balances
          WHERE token_address = $1 ORDER BY wallet_address`, [TOKEN_2]
      );
      assert.deepEqual(restoredTailBalances.rows.map((row) => [
        row.wallet_address, String(row.balance_raw),
      ]), [[ALICE, '1']]);

      await client.query(
        `INSERT INTO robinhood_holder_token_states
          (token_address, holder_count, ledger_status, deployment_block,
           backfill_next_block, live_through_block, live_through_hash, version)
         VALUES ($1, 1, 'drifted', 50, 101, 101, $2, 7)`,
        [TOKEN_DRIFT_TAIL, HASH_B]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 1, 101, $3, 0)`,
        [TOKEN_DRIFT_TAIL, BOB, HASH_0]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index, log_index,
           token_address, from_wallet, to_wallet, amount_raw, applied,
           from_balance_before, from_balance_after, to_balance_before, to_balance_after,
           holder_delta, from_last_block_before, from_last_transaction_hash_before,
           from_last_log_index_before, applied_at
         ) VALUES
           (101, $1, $2, 0, 0, $3, $4, $5, 1, true,
            1, 0, 0, 1, 0, 100, $6, 0, NOW()),
           (101, $1, $2, 0, 1, $3, $5, $4, 2, false,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
        [HASH_B, HASH_0, TOKEN_DRIFT_TAIL, ALICE, BOB, HASH_E]
      );
      assert.deepEqual(await repository.inspectDriftedAppliedTail({
        tokenAddress: TOKEN_DRIFT_TAIL, backfillNextBlock: '101', expectedVersion: '7',
      }), {
        eligible: true, reason: null, tokenAddress: TOKEN_DRIFT_TAIL,
        appliedEvents: 1, pendingEvents: 1,
      });
      assert.deepEqual(await repository.rollbackDriftedAppliedTail({
        tokenAddress: TOKEN_DRIFT_TAIL, backfillNextBlock: '101', expectedVersion: '7',
      }), {
        status: 'requeued', tokenAddress: TOKEN_DRIFT_TAIL, priorStatus: 'drifted',
        backfillNextBlock: '101', revertedEvents: 1,
      });
      const restoredDrift = await client.query(
        `SELECT state.holder_count, state.ledger_status, state.live_through_block,
                (SELECT COUNT(*) FROM robinhood_holder_transfer_journal journal
                  WHERE journal.token_address = state.token_address
                    AND journal.applied = true)::int AS applied,
                (SELECT balance_raw FROM robinhood_holder_balances balance
                  WHERE balance.token_address = state.token_address
                    AND balance.wallet_address = $2) AS alice_balance
           FROM robinhood_holder_token_states state WHERE state.token_address = $1`,
        [TOKEN_DRIFT_TAIL, ALICE]
      );
      assert.deepEqual(restoredDrift.rows, [{
        holder_count: '1', ledger_status: 'backfilling', live_through_block: null,
        applied: 0, alice_balance: '1',
      }]);
      await client.query(
        `DELETE FROM robinhood_holder_transfer_journal WHERE token_address = $1`,
        [TOKEN_DRIFT_TAIL]
      );
      await client.query(
        `DELETE FROM robinhood_holder_balances WHERE token_address = $1`, [TOKEN_DRIFT_TAIL]
      );
      await client.query(
        `DELETE FROM robinhood_holder_token_states WHERE token_address = $1`, [TOKEN_DRIFT_TAIL]
      );

      await client.query(
        `INSERT INTO robinhood_holder_token_states
          (token_address, holder_count, ledger_status, deployment_block,
           backfill_next_block, live_through_block, live_through_hash)
         VALUES ($1, 0, 'shadow', 50, 100, 99, $2)`,
        [TOKEN_WIDE_TAIL, HASH_B]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index,
           log_index, token_address, from_wallet, to_wallet, amount_raw
         ) VALUES (500, $1, $2, 30, 30, $3, $4, $5, 2)`,
        [HASH_A, HASH_E, TOKEN_WIDE_TAIL, ALICE, BOB]
      );
      const wideSuspicion = await repository.applyNextPendingEvent({
        onlyTokenAddress: TOKEN_WIDE_TAIL,
      });
      assert.equal(wideSuspicion.status, 'drift-suspected');
      assert.deepEqual(await repository.requeueWideShadowTail({
        tokenAddress: TOKEN_WIDE_TAIL, backfillNextBlock: '100', failedBlock: '500',
        failedTransactionHash: HASH_E, failedLogIndex: 30, receiptBlockLimit: 250,
      }), {
        status: 'requeued', recovery: 'wide-shadow-tail',
        tokenAddress: TOKEN_WIDE_TAIL, backfillNextBlock: '100',
        receiptBlocks: '401', revertedEvents: 0, version: '1',
      });
      assert.deepEqual(await repository.requeueWideShadowTail({
        tokenAddress: TOKEN_WIDE_TAIL, backfillNextBlock: '100', failedBlock: '500',
        failedTransactionHash: HASH_E, failedLogIndex: 30, receiptBlockLimit: 250,
      }), { status: 'not-requeued', reason: 'state-not-safe' });
      const wideState = await client.query(
        `SELECT ledger_status, holder_count, backfill_next_block,
                live_through_block,
                (SELECT COUNT(*) FROM robinhood_holder_transfer_journal journal
                  WHERE journal.token_address = state.token_address)::int AS journal_events
           FROM robinhood_holder_token_states state WHERE token_address = $1`,
        [TOKEN_WIDE_TAIL]
      );
      assert.deepEqual(wideState.rows[0], {
        ledger_status: 'backfilling', holder_count: '0',
        backfill_next_block: '100', live_through_block: '99', journal_events: 1,
      });
      await client.query(
        `DELETE FROM robinhood_holder_transfer_journal WHERE token_address = $1`,
        [TOKEN_WIDE_TAIL]
      );
      await client.query(
        `DELETE FROM robinhood_holder_token_states WHERE token_address = $1`,
        [TOKEN_WIDE_TAIL]
      );

      await client.query(
        `INSERT INTO robinhood_holder_token_states
          (token_address, holder_count, ledger_status, backfill_next_block,
           live_through_block, live_through_hash)
         VALUES ($1, 1, 'live', 101, 101, $2)`, [TOKEN_NO_TAIL, HASH_B]
      );
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index,
           log_index, token_address, from_wallet, to_wallet, amount_raw
         ) VALUES (101, $1, $2, 20, 20, $3, $4, $5, 2)`,
        [HASH_B, HASH_E, TOKEN_NO_TAIL, ALICE, BOB]
      );
      await assert.rejects(repository.rollbackAppliedTail({
        tokenAddress: TOKEN_NO_TAIL, backfillNextBlock: '101', failedBlock: '101',
        failedTransactionHash: HASH_E, failedLogIndex: 20,
      }), (error) => error.code === 'holder_tail_rollback_unavailable');
      await client.query(
        `DELETE FROM robinhood_holder_transfer_journal WHERE token_address = $1`,
        [TOKEN_NO_TAIL]
      );
      await client.query(
        `DELETE FROM robinhood_holder_token_states WHERE token_address = $1`,
        [TOKEN_NO_TAIL]
      );

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
      await client.query(
        `UPDATE robinhood_holder_cursors SET buffer_floor_block = 101`
      );

      const rewoundResult = await repository.rewindOrphanedRange({
        nextBlock: '100', safeHead: '199', expectedVersion: 1,
        checkpoint: { number: '99', hash: HASH_B },
      });
      const { publications, ...rewindSummary } = rewoundResult;
      assert.deepEqual(rewindSummary, {
        status: 'rewound', revertedEvents: 2, affectedTokens: 1,
        resyncingTokens: 1, removedEvents: 5, cursorVersion: 2,
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
                cursor.checkpoint_hash, cursor.buffer_floor_block, cursor.version,
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
        bufferFloorBlock: row.buffer_floor_block == null
          ? null : String(row.buffer_floor_block),
        version: Number(row.version), journalCount: Number(row.journal_count),
      })), [{
        holderCount: '1', ledgerStatus: 'live', liveThroughBlock: '99',
        liveThroughHash: HASH_B, nextBlock: '100', safeHead: '199',
        checkpointBlock: '99', checkpointHash: HASH_B, bufferFloorBlock: null,
        version: 2, journalCount: 0,
      }]);
      const stillRecovering = await client.query(
        `SELECT ledger_status FROM robinhood_holder_token_states WHERE token_address = $1`,
        [TOKEN_2]
      );
      assert.equal(stillRecovering.rows[0].ledger_status, 'backfilling');
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
        `INSERT INTO robinhood_holder_token_states (
           token_address, holder_count, ledger_status, deployment_block,
           backfill_next_block
         ) VALUES ($1, 0, 'drifted', 50, 100)`, [TOKEN_5]
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
             NULL, NULL, NULL, NULL, NULL, false, NULL),
           (103, $1, $8, 3, 3, $9, $5, $6, 1,
             NULL, NULL, NULL, NULL, NULL, false, NULL)`,
        [HASH_A, HASH_C, HASH_B, TOKEN, ZERO_ADDRESS, BOB, ALICE, HASH_E, TOKEN_5]
      );
      assert.deepEqual(await runBatch(client, { beforeBlock: '150', batchLimit: 1 }), {
        status: 'blocked', reason: 'pending_event_before_cutoff', deletedEvents: 0,
        discardedBufferedEvents: 0, totalDeleted: 0,
        cutoffBlock: '150', journalFloorBlock: '100',
      });
      assert.equal((await client.query(
        'SELECT COUNT(*)::int AS count FROM robinhood_holder_transfer_journal'
      )).rows[0].count, 4);
      assert.deepEqual(await retention.pruneOnce({ batchLimit: 1 }), {
        status: 'blocked', reason: 'pending_event_before_cutoff', deletedEvents: 0,
        discardedBufferedEvents: 1,
        cutoffBlock: '150', journalFloorBlock: '100',
      });
      const protectedPending = await client.query(
        `SELECT token_address FROM robinhood_holder_transfer_journal
          WHERE applied = false ORDER BY token_address`
      );
      assert.deepEqual(protectedPending.rows, [{ token_address: TOKEN }]);
      await client.query(
        `DELETE FROM robinhood_holder_transfer_journal WHERE applied = false`
      );
      assert.deepEqual(await retention.pruneOnce({ batchLimit: 1 }), {
        status: 'draining', deletedEvents: 1,
        discardedBufferedEvents: 0,
        cutoffBlock: '150', journalFloorBlock: '100',
      });
      assert.deepEqual(await retention.pruneOnce({ batchLimit: 1 }), {
        status: 'pruned', deletedEvents: 1,
        discardedBufferedEvents: 0,
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

      await client.query(`UPDATE robinhood_holder_cursors SET next_block = 20202,
        safe_head = 20202, checkpoint_block = 20201`);
      await client.query(
        `INSERT INTO robinhood_holder_transfer_journal (
           block_number, block_hash, transaction_hash, transaction_index,
           log_index, token_address, from_wallet, to_wallet, amount_raw
         ) VALUES (200, $1, $1, 0, 0, $3, $5, $6, 1),
                  (200, $1, $2, 0, 1, $3, $5, $6, 1),
                  (201, $1, $2, 0, 2, $4, $5, $6, 1)`,
        [HASH_A, HASH_C, TOKEN_UNTRACKED, TOKEN, ZERO_ADDRESS, BOB]
      );
      await client.query(
        `INSERT INTO robinhood_holder_global_backfill_runs (
           id, catalog_cutoff, barrier_block, barrier_checkpoint_block,
           barrier_checkpoint_hash, barrier_attached_at
         ) VALUES (123456789, NOW(), 199, 198, $1, NOW())`, [HASH_A]
      );
      await client.query(`INSERT INTO robinhood_holder_global_backfill_tokens
        (run_id, token_address) VALUES (123456789, $1)`, [TOKEN_UNTRACKED]);
      const campaign = await runBatch(client, { beforeBlock: '201', batchLimit: 1 });
      assert.equal(campaign.status, 'blocked');
      assert.equal(campaign.totalDeleted, 0);
      await client.query(`UPDATE robinhood_holder_global_backfill_runs
        SET status = 'completed', completed_at = NOW() WHERE id = 123456789`);
      await assert.rejects(runBatch({
        async query(sql, params) {
          const result = await client.query(sql, params);
          if (sql.includes('DELETE FROM robinhood_holder_transfer_journal')) {
            throw new Error('injected failure after deletion');
          }
          return result;
        },
      }, { beforeBlock: '201', batchLimit: 1 }), /injected failure/);
      assert.equal((await client.query(
        'SELECT COUNT(*)::int AS count FROM robinhood_holder_transfer_journal'
      )).rows[0].count, 3);
      const boundedFirst = await runBatch(client, { beforeBlock: '201', batchLimit: 1 });
      assert.equal(boundedFirst.status, 'draining');
      assert.equal(boundedFirst.totalDeleted, 1);
      assert.equal(boundedFirst.journalFloorBlock, '150');
      const boundedLast = await runBatch(client, { beforeBlock: '201', batchLimit: 1 });
      assert.equal(boundedLast.status, 'pruned');
      assert.equal(boundedLast.totalDeleted, 1);
      assert.equal(boundedLast.cutoffBlock, '201');
      assert.equal(boundedLast.journalFloorBlock, '201');
      assert.deepEqual((await client.query(
        'SELECT block_number::text, applied FROM robinhood_holder_transfer_journal'
      )).rows, [{ block_number: '201', applied: false }]);
      const retry = await runBatch(client, { beforeBlock: '201', batchLimit: 1 });
      assert.equal(retry.status, 'idle');
      assert.equal(retry.totalDeleted, 0);
      const recent = await runBatch(client, { beforeBlock: '999999', batchLimit: 1 });
      assert.equal(recent.status, 'blocked');
      assert.equal(recent.cutoffBlock, '202'); // Explicit cutoff cannot shorten the retention window.
      assert.equal(recent.totalDeleted, 0);
      assert.equal((await client.query('SHOW lock_timeout')).rows[0].lock_timeout, '0');
      await assert.rejects(
        repository.rewindOrphanedRange({
          nextBlock: '149', safeHead: '20149', expectedVersion: 2,
          checkpoint: { number: '148', hash: HASH_B },
        }),
        (error) => error.code === 'holder_rewind_below_floor'
      );
      await client.query(`DELETE FROM robinhood_holder_cursors`);
      await assert.rejects(
        repository.applyNextPendingEvent(),
        (error) => error.code === 'holder_cursor_missing'
      );
    } finally {
      client.release();
    }
  });
});
