const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodTransactionPositionResolver,
} = require('../src/services/robinhood-transaction-position-resolver');

const TX_A = `0x${'a'.repeat(64)}`;
const TX_B = `0x${'b'.repeat(64)}`;
const BLOCK_HASH = `0x${'c'.repeat(64)}`;
const WALLET = `0x${'d'.repeat(40)}`;

function swap(transactionHash, overrides = {}) {
  return {
    transaction_hash: transactionHash, block_number: '100', action_index: '3',
    transaction_index: null, ...overrides,
  };
}

function block(transactions, overrides = {}) {
  return {
    number: '0x64', hash: BLOCK_HASH, timestamp: '0x60000000',
    transactions, ...overrides,
  };
}

function harness(response) {
  const calls = { rpc: [], persisted: [] };
  return {
    calls,
    resolver: createRobinhoodTransactionPositionResolver({
      rpcClient: { requestBatch: async (requests) => {
        calls.rpc.push(requests);
        return [response];
      } },
      repository: { upsertPositions: async (positions) => {
        calls.persisted.push(positions);
        return { persisted: positions.length };
      } },
    }),
  };
}

describe('Robinhood transaction-position historical resolver', () => {
  it('fetches only missing positions and keeps dry-run read-only', async () => {
    const test = harness(block([
      { hash: TX_A, from: WALLET },
      { hash: TX_B, from: WALLET },
    ]));
    const result = await test.resolver.resolveSwaps([
      swap(TX_A, { transaction_index: '0' }), swap(TX_B), swap(TX_B, { action_index: '4' }),
    ]);

    assert.deepEqual(result.swaps.map(({ transaction_index: index }) => index), ['0', '1', '1']);
    assert.deepEqual(result.telemetry, {
      required: 2, resolved: 1, persisted: 0, rpcBlocks: 1, rpcBatches: 1,
    });
    assert.deepEqual(test.calls.rpc[0], [{
      method: 'eth_getBlockByNumber', params: ['0x64', true],
    }]);
    assert.equal(test.calls.persisted.length, 0);
  });

  it('persists newly resolved canonical positions only when confirmed', async () => {
    const test = harness(block([
      { hash: TX_A, from: WALLET },
      { hash: TX_B, from: WALLET },
    ]));
    const result = await test.resolver.resolveSwaps([swap(TX_B)], { commit: true });

    assert.equal(result.telemetry.persisted, 1);
    assert.deepEqual(test.calls.persisted[0], [{
      transactionHash: TX_B, blockNumber: '100',
      blockHash: BLOCK_HASH, transactionIndex: '1',
    }]);
  });

  it('fails closed on inconsistent evidence or a transaction absent from the block', async () => {
    const test = harness(block([{ hash: TX_A, from: WALLET }]));
    await assert.rejects(test.resolver.resolveSwaps([swap(TX_B)]), /absent from its canonical block/);
    await assert.rejects(test.resolver.resolveSwaps([
      swap(TX_A, { transaction_index: '0' }),
      swap(TX_A, { block_number: '101', transaction_index: '1' }),
    ]), /evidence is inconsistent/);
  });
});
