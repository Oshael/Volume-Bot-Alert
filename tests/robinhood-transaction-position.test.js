const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodTransactionPositionRepository,
  __private,
} = require('../src/models/robinhood-transaction-position');
const stage139 = require('../src/utils/db-init-stage139');
const { SCHEMA_GROUPS } = require('../src/utils/runtime-schema');

const TX = `0x${'a'.repeat(64)}`;
const BLOCK_HASH = `0x${'b'.repeat(64)}`;

function position(overrides = {}) {
  return {
    transactionHash: TX, blockNumber: '10', blockHash: BLOCK_HASH,
    transactionIndex: '2', ...overrides,
  };
}

describe('Robinhood transaction positions', () => {
  it('defines a narrow canonical sidecar in Stage 139', () => {
    const sql = stage139.STATEMENTS.join('\n');
    const group = SCHEMA_GROUPS.find(({ key }) => (
      key === 'stage139-robinhood-transaction-positions'
    ));

    assert.match(sql, /PRIMARY KEY \(chain, transaction_hash\)/);
    assert.match(sql, /transaction_index INTEGER NOT NULL/);
    assert.match(sql, /idx_robinhood_transaction_positions_block/);
    assert.equal(group.repair, 'node src/utils/db-init-stage139.js');
    assert.deepEqual(group.tables[0].constraints.map(({ name }) => name), [
      'robinhood_transaction_positions_pkey',
      'robinhood_transaction_positions_chain_check',
      'robinhood_transaction_positions_tx_hash_check',
      'robinhood_transaction_positions_block_hash_check',
      'robinhood_transaction_positions_block_check',
      'robinhood_transaction_positions_index_check',
    ]);
  });

  it('deduplicates equal evidence and rejects conflicts inside one batch', () => {
    assert.deepEqual(__private.compactPositions([position(), position()]), [
      {
        transaction_hash: TX, block_number: '10', block_hash: BLOCK_HASH,
        transaction_index: '2',
      },
    ]);
    assert.throws(() => __private.compactPositions([
      position(), position({ transactionIndex: '3' }),
    ]), /conflicting evidence/);
    assert.throws(() => __private.normalizePosition(
      position({ transactionIndex: '2147483648' })
    ), /exceeds INTEGER range/);
  });

  it('writes normalized positions and loads unique hashes', async () => {
    const calls = [];
    const database = { query: async (sql, params) => {
      calls.push({ sql, params });
      if (/^SELECT/.test(sql.trim())) return { rows: [{
        transaction_hash: TX, block_number: 10, block_hash: BLOCK_HASH,
        transaction_index: 2,
      }] };
      return { rowCount: 1 };
    } };
    const repository = createRobinhoodTransactionPositionRepository({ database });

    assert.deepEqual(await repository.upsertPositions([position()]), {
      requested: 1, persisted: 1,
    });
    assert.deepEqual(await repository.loadPositions([TX.toUpperCase(), TX]), [{
      transactionHash: TX, blockNumber: '10', blockHash: BLOCK_HASH,
      transactionIndex: '2',
    }]);
    assert.deepEqual(calls[1].params, ['robinhood', [TX]]);
  });
});
