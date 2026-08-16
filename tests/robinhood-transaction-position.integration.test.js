process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const { after, before, describe, it } = require('node:test');

const db = require('../src/models/db');
const {
  createRobinhoodTransactionPositionRepository,
} = require('../src/models/robinhood-transaction-position');
const stage139 = require('../src/utils/db-init-stage139');
const { assertUsingTestDatabase } = require('./helpers/test-db');

const TX = `0x${'c'.repeat(64)}`;
const BLOCK_A = `0x${'d'.repeat(64)}`;
const BLOCK_B = `0x${'e'.repeat(64)}`;

describe('Robinhood transaction position persistence', () => {
  before(async () => {
    await assertUsingTestDatabase(db);
    await stage139.init({ closePool: false });
    await db.query(
      'DELETE FROM robinhood_transaction_positions WHERE transaction_hash = $1', [TX]
    );
  });

  after(async () => {
    await db.query(
      'DELETE FROM robinhood_transaction_positions WHERE transaction_hash = $1', [TX]
    );
    await db.pool.end();
  });

  it('persists idempotently and replaces canonical position evidence', async () => {
    const repository = createRobinhoodTransactionPositionRepository({ database: db });
    const first = await repository.upsertPositions([{
      transactionHash: TX, blockNumber: '100', blockHash: BLOCK_A, transactionIndex: '4',
    }]);
    const duplicate = await repository.upsertPositions([{
      transactionHash: TX, blockNumber: '100', blockHash: BLOCK_A, transactionIndex: '4',
    }]);
    const replaced = await repository.upsertPositions([{
      transactionHash: TX, blockNumber: '101', blockHash: BLOCK_B, transactionIndex: '1',
    }]);
    const stored = await repository.loadPositions([TX]);

    assert.deepEqual(first, { requested: 1, persisted: 1 });
    assert.deepEqual(duplicate, { requested: 1, persisted: 0 });
    assert.deepEqual(replaced, { requested: 1, persisted: 1 });
    assert.deepEqual(stored, [{
      transactionHash: TX, blockNumber: '101', blockHash: BLOCK_B, transactionIndex: '1',
    }]);
  });
});
