const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletSignedOriginReader,
} = require('../src/services/robinhood-wallet-signed-origin-reader');

const HASH = (digit) => `0x${digit.repeat(64)}`;
const WALLET = (digit) => `0x${digit.repeat(40)}`;
const hex = (value) => `0x${BigInt(value).toString(16)}`;

function transaction(blockNumber, index, wallet, nonce = index) {
  return {
    hash: `0x${(BigInt(blockNumber) * 100n + BigInt(index)).toString(16).padStart(64, '0')}`,
    from: wallet, nonce: hex(nonce),
    transactionIndex: hex(index), blockNumber: hex(blockNumber),
    blockHash: HASH('a'),
  };
}

function block(number, transactions = []) {
  return {
    number: hex(number), hash: HASH('a'), timestamp: hex(1_788_112_800 + number),
    transactions,
  };
}

function fakeRpc(blocks, options = {}) {
  const state = { calls: 0, active: 0, maxActive: 0 };
  return {
    state,
    client: {
      request: async () => options.chainId || '0x1237',
      requestBatch: async (requests) => {
        state.calls += 1; state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        await new Promise((resolve) => setImmediate(resolve));
        state.active -= 1;
        return requests.map(({ params }) => blocks.get(BigInt(params[0]).toString()));
      },
    },
  };
}

describe('Robinhood signed-origin full-block reader', () => {
  it('reads bounded concurrent batches and keeps the first sender position', async () => {
    const walletA = WALLET('1'); const walletB = WALLET('2');
    const blocks = new Map([
      ['100', block(100, [transaction(100, 0, walletA), transaction(100, 1, walletB, 3)])],
      ['101', block(101, [transaction(101, 0, walletA, 1)])],
      ['102', block(102)], ['103', block(103, [transaction(103, 0, WALLET('3'))])],
    ]);
    const rpc = fakeRpc(blocks);
    const reader = createRobinhoodWalletSignedOriginReader({
      rpcClient: rpc.client, rpcBatchSize: 1, concurrency: 2, maxBlocks: 4,
      now: () => 1_800_000_000_000,
    });
    const result = await reader.readBlocks({
      blockNumbers: ['100', '101', '102', '103'], coverageOriginBlock: '90',
      safeHead: '103', stream: 'live',
    });
    assert.deepEqual(result.origins.map(({ walletAddress, blockNumber, nonce }) => (
      [walletAddress, blockNumber, nonce]
    )), [[walletA, '100', '0'], [walletB, '100', '3'], [WALLET('3'), '103', '0']]);
    assert.deepEqual(result.metrics, {
      blocksScanned: 4, transactionsScanned: 4, originsFound: 3,
      payloadBytes: result.metrics.payloadBytes, elapsedMs: 1, blocksPerSecond: 4000,
    });
    assert.equal(rpc.state.calls, 4);
    assert.equal(rpc.state.maxActive, 2);
  });

  it('rejects a malformed member before returning any partial result', async () => {
    const bad = block(101, [transaction(100, 0, WALLET('1'))]);
    const rpc = fakeRpc(new Map([['100', block(100)], ['101', bad]]));
    const reader = createRobinhoodWalletSignedOriginReader({
      rpcClient: rpc.client, rpcBatchSize: 2, maxBlocks: 2,
    });
    await assert.rejects(reader.readBlocks({
      blockNumbers: ['100', '101'], coverageOriginBlock: '100',
      safeHead: '101', stream: 'seed',
    }), (error) => error.code === 'signed_origin_rpc_invalid');
  });

  it('uses up to eight concurrent RPC batches for a dedicated Archive node', async () => {
    const blocks = new Map(Array.from({ length: 8 }, (_, index) => {
      const number = 200 + index; return [String(number), block(number)];
    }));
    const rpc = fakeRpc(blocks);
    await createRobinhoodWalletSignedOriginReader({ rpcClient: rpc.client,
      rpcBatchSize: 1, concurrency: 8, maxBlocks: 8 }).readBlocks({
      blockNumbers: [...blocks.keys()], coverageOriginBlock: '200',
      safeHead: '207', stream: 'seed',
    });
    assert.equal(rpc.state.maxActive, 8);
  });

  it('enforces contiguity, safe head, payload, and Robinhood chain', async () => {
    const blocks = new Map([['100', block(100)], ['101', block(101)], ['102', block(102)]]);
    const rpc = fakeRpc(blocks);
    const reader = createRobinhoodWalletSignedOriginReader({
      rpcClient: rpc.client, rpcBatchSize: 1, maxBlocks: 3, maxPayloadBytes: 256,
    });
    const base = { coverageOriginBlock: '100', safeHead: '102', stream: 'live' };
    await assert.rejects(reader.readBlocks({ ...base, blockNumbers: ['100', '102'] }),
      /contiguous/);
    await assert.rejects(reader.readBlocks({ ...base, safeHead: '100', blockNumbers: ['101'] }),
      /safe head/);
    await assert.rejects(reader.readBlocks({ ...base, blockNumbers: ['100', '101', '102'] }),
      /payload/);
    const wrong = createRobinhoodWalletSignedOriginReader({
      rpcClient: fakeRpc(blocks, { chainId: '0x1' }).client,
      rpcBatchSize: 1, maxBlocks: 1,
    });
    await assert.rejects(wrong.readBlocks({ ...base, blockNumbers: ['100'] }),
      (error) => error.code === 'configuration_error');
  });
});
