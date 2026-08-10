const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const { createRobinhoodHolderHandoffRepository } = require('../src/models/robinhood-holder-handoff');
const { createRobinhoodHolderLedgerRepository } = require('../src/models/robinhood-holder-ledger');

const TOKEN = `0x${'1'.repeat(40)}`;
const OTHER_TOKEN = `0x${'2'.repeat(40)}`;
const ALICE = `0x${'3'.repeat(40)}`;
const BOB = `0x${'4'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;
const HASH_C = `0x${'c'.repeat(64)}`;

after(() => db.pool.end());

function journal(token, block, hash, index, overrides = {}) {
  return {
    token, block, hash, transactionHash: `0x${String(index).padStart(64, '0')}`,
    transactionIndex: index, logIndex: index, fromWallet: ALICE,
    toWallet: BOB, amountRaw: '4', ...overrides,
  };
}

describe('Robinhood holder live handoff persistence', () => {
  it('promotes from a retained barrier and applies the preserved live tail', async () => {
    const client = await db.getClient();
    try {
      for (const table of [
        'robinhood_holder_transfer_journal', 'robinhood_holder_cursors',
        'robinhood_holder_balances', 'robinhood_holder_token_states',
      ]) {
        await client.query(`CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING ALL)`);
      }
      const database = {
        query: client.query.bind(client),
        getClient: async () => ({ query: client.query.bind(client), release() {} }),
      };
      const handoff = createRobinhoodHolderHandoffRepository({ database });
      const ledger = createRobinhoodHolderLedgerRepository({ database });
      await client.query(
        `INSERT INTO robinhood_holder_cursors (
           next_block, safe_head, checkpoint_block, checkpoint_hash, journal_floor_block
         ) VALUES (107, 106, 106, $1, 100)`, [HASH_C]
      );
      await client.query(
         `INSERT INTO robinhood_holder_token_states (
           token_address, holder_count, ledger_status, deployment_block,
           backfill_next_block, live_through_block, live_through_hash
         ) VALUES ($1, 1, 'backfilling', 90, 105, 104, $3),
                  ($2, 0, 'backfilling', 90, 99, 98, $3)`,
        [TOKEN, OTHER_TOKEN, HASH_A]
      );
      await client.query(
        `INSERT INTO robinhood_holder_balances (
           token_address, wallet_address, balance_raw, last_block_number,
           last_transaction_hash, last_log_index
         ) VALUES ($1, $2, 10, 104, $3, 1)`,
        [TOKEN, ALICE, `0x${'1'.padStart(64, '0')}`]
      );
      const events = [
        journal(TOKEN, 104, HASH_A, 1, { toWallet: ALICE }),
        journal(TOKEN, 105, HASH_B, 2),
        journal(OTHER_TOKEN, 104, HASH_A, 3),
      ];
      for (const event of events) {
        await client.query(
          `INSERT INTO robinhood_holder_transfer_journal (
             block_number, block_hash, transaction_hash, transaction_index,
             log_index, token_address, from_wallet, to_wallet, amount_raw
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            event.block, event.hash, event.transactionHash, event.transactionIndex,
            event.logIndex, event.token, event.fromWallet, event.toWallet, event.amountRaw,
          ]
        );
      }
      assert.deepEqual(await handoff.getNextCandidate(), {
        tokenAddress: TOKEN, backfillNextBlock: '105',
        checkpoint: { number: '104', hash: HASH_A }, version: 0,
      });
      assert.deepEqual(await handoff.promoteAtLiveBarrier({
        tokenAddress: TOKEN, verifiedCheckpoint: { number: '104', hash: HASH_A },
      }), {
        status: 'shadow', tokenAddress: TOKEN, holderCount: '1', version: 1,
        discardedOverlapEvents: 1,
        journalFloorBlock: '100', liveCursorNextBlock: '107',
      });
      assert.deepEqual(await ledger.applyNextPendingEvent(), {
        status: 'applied', tokenAddress: TOKEN, holderCount: '2', holderDelta: 1,
      });
      await ledger.appendCapturedRange({
        transfers: [{
          blockNumber: '107', blockHash: HASH_B,
          transactionHash: `0x${'9'.repeat(64)}`, transactionIndex: 0, logIndex: 0,
          tokenAddress: TOKEN, fromWallet: ALICE, toWallet: BOB, amountRaw: '4',
        }],
        cursor: {
          rangeStart: '107', nextBlock: '108', safeHead: '107', expectedVersion: 0,
          checkpoint: { number: '107', hash: HASH_B },
        },
      });
      assert.deepEqual(await ledger.applyNextPendingEvent(), {
        status: 'applied', tokenAddress: TOKEN, holderCount: '2', holderDelta: 0,
      });
      const balances = await client.query(
        `SELECT wallet_address, balance_raw FROM robinhood_holder_balances
          WHERE token_address = $1 ORDER BY wallet_address`, [TOKEN]
      );
      assert.deepEqual(balances.rows.map((row) => [
        row.wallet_address, String(row.balance_raw),
      ]), [[ALICE, '2'], [BOB, '8']]);
      const state = await client.query(
        `SELECT ledger_status, backfill_next_block FROM robinhood_holder_token_states
          WHERE token_address = $1`, [TOKEN]
      );
      assert.deepEqual(state.rows[0], { ledger_status: 'shadow', backfill_next_block: '105' });
      await assert.rejects(
        handoff.promoteAtLiveBarrier({
          tokenAddress: OTHER_TOKEN, verifiedCheckpoint: { number: '98', hash: HASH_A },
        }),
        (error) => error.code === 'holder_handoff_below_floor'
      );
      const remaining = await client.query(
        `SELECT token_address, block_number, applied FROM robinhood_holder_transfer_journal
          ORDER BY token_address, block_number`
      );
      assert.deepEqual(remaining.rows.map((row) => [
        row.token_address, String(row.block_number), row.applied,
      ]), [[TOKEN, '105', true], [TOKEN, '107', true], [OTHER_TOKEN, '104', false]]);
    } finally {
      client.release();
    }
  });
});
