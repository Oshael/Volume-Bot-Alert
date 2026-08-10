const assert = require('node:assert/strict');
const { after, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodHolderLedgerRepository,
} = require('../src/models/robinhood-holder-ledger');

const HASH_A = `0x${'1'.repeat(64)}`;
const HASH_B = `0x${'2'.repeat(64)}`;
const TOKEN = `0x${'3'.repeat(40)}`;
const ALICE = `0x${'4'.repeat(40)}`;
const BOB = `0x${'5'.repeat(40)}`;

after(() => db.pool.end());

function capture(blockNumber, blockHash, expectedVersion, rangeStart) {
  return {
    transfers: [{
      blockNumber, blockHash, transactionHash: HASH_A,
      transactionIndex: 0, logIndex: 0, tokenAddress: TOKEN,
      fromWallet: ALICE, toWallet: BOB, amountRaw: '123456789012345678901234567890',
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
      const database = {
        getClient: async () => ({
          query: client.query.bind(client),
          release() {},
        }),
      };
      const repository = createRobinhoodHolderLedgerRepository({ database });
      const initial = capture('100', HASH_A, null, '100');
      initial.transfers.push({ ...initial.transfers[0] });
      const first = await repository.appendCapturedRange(initial);
      assert.deepEqual(first, {
        insertedTransfers: 1, duplicateTransfers: 1, cursorVersion: 0,
      });

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
    } finally {
      client.release();
    }
  });
});
