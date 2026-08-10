const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { TRANSFER_TOPIC, ZERO_TOPIC } = require('../src/services/evm-erc20-supply-delta');
const {
  createRobinhoodHolderTransferReader,
} = require('../src/services/robinhood-holder-transfer-reader');

const TOKEN = `0x${'1'.repeat(40)}`;
const ALICE = `0x${'0'.repeat(24)}${'2'.repeat(40)}`;
const BOB = `0x${'0'.repeat(24)}${'3'.repeat(40)}`;
const HASH_A = `0x${'a'.repeat(64)}`;
const HASH_B = `0x${'b'.repeat(64)}`;

function log(overrides = {}) {
  return {
    address: TOKEN, topics: [TRANSFER_TOPIC, ALICE, BOB],
    data: `0x${'f'.repeat(64)}`, blockNumber: '0x64', blockHash: HASH_A,
    transactionHash: HASH_B, transactionIndex: '0x1', logIndex: '0x2', removed: false,
    ...overrides,
  };
}

function rpc(handler) {
  const calls = [];
  return {
    calls,
    client: { async request(method, params = []) {
      calls.push({ method, params });
      if (method === 'eth_chainId') return '0x1237';
      return handler(method, params);
    } },
  };
}

describe('Robinhood holder Transfer reader', () => {
  it('decodes, orders and checkpoints one bounded token range', async () => {
    const source = rpc(async (method) => {
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: HASH_A };
      if (method === 'eth_getLogs') return [
        log({ transactionHash: `0x${'d'.repeat(64)}`, transactionIndex: '0x2', logIndex: '0x3' }),
        log({ topics: [TRANSFER_TOPIC, ZERO_TOPIC, BOB], data: `0x${'0'.repeat(63)}5` }),
      ];
      throw new Error(`unexpected method ${method}`);
    });
    const reader = createRobinhoodHolderTransferReader({ rpcClient: source.client });
    const result = await reader.readRange({ tokenAddress: TOKEN, fromBlock: 99, toBlock: 100 });

    assert.deepEqual({
      tokenAddress: result.tokenAddress, fromBlock: result.fromBlock,
      toBlock: result.toBlock, nextBlock: result.nextBlock, checkpoint: result.checkpoint,
      telemetry: result.telemetry,
    }, {
      tokenAddress: TOKEN, fromBlock: '99', toBlock: '100', nextBlock: '101',
      checkpoint: { number: '100', hash: HASH_A }, telemetry: { requests: 1, splits: 0 },
    });
    assert.deepEqual(result.transfers.map(({ fromWallet, amountRaw, transactionIndex }) => (
      { fromWallet, amountRaw, transactionIndex }
    )), [
      { fromWallet: `0x${'0'.repeat(40)}`, amountRaw: '5', transactionIndex: 1 },
      { fromWallet: `0x${'2'.repeat(40)}`, amountRaw: BigInt(`0x${'f'.repeat(64)}`).toString(),
        transactionIndex: 2 },
    ]);
    assert.deepEqual(source.calls.find(({ method }) => method === 'eth_getLogs').params[0], {
      address: TOKEN, fromBlock: '0x63', toBlock: '0x64', topics: [TRANSFER_TOPIC],
    });
  });

  it('splits range-limit failures without widening the requested window', async () => {
    const ranges = [];
    const source = rpc(async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { number: '0x4', hash: HASH_A };
      const filter = params[0];
      ranges.push([filter.fromBlock, filter.toBlock]);
      if (filter.fromBlock === '0x1' && filter.toBlock === '0x4') {
        const error = new Error('range too large');
        error.code = 'log_range_error';
        throw error;
      }
      return [];
    });
    const result = await createRobinhoodHolderTransferReader({
      rpcClient: source.client,
    }).readRange({ tokenAddress: TOKEN, fromBlock: 1, toBlock: 4 });

    assert.deepEqual(ranges, [['0x1', '0x4'], ['0x1', '0x2'], ['0x3', '0x4']]);
    assert.deepEqual(result.telemetry, { requests: 3, splits: 1 });
    assert.deepEqual(result.transfers, []);
  });

  it('fails closed on wrong chain, oversized ranges and conflicting evidence', async () => {
    const wrongChain = { request: async () => '0x1' };
    await assert.rejects(
      createRobinhoodHolderTransferReader({ rpcClient: wrongChain }).readRange({
        tokenAddress: TOKEN, fromBlock: 1, toBlock: 1,
      }), /unexpected Robinhood chain ID/
    );
    const source = rpc(async (method) => method === 'eth_getBlockByNumber'
      ? { number: '0x64', hash: HASH_A }
      : [log({ address: `0x${'9'.repeat(40)}` })]);
    const reader = createRobinhoodHolderTransferReader({ rpcClient: source.client });
    await assert.rejects(
      reader.readRange({ tokenAddress: TOKEN, fromBlock: 1, toBlock: 5001 }),
      /exceeds 5000 blocks/
    );
    await assert.rejects(
      reader.readRange({ tokenAddress: TOKEN, fromBlock: 100, toBlock: 100 }),
      /token does not match filter/
    );
  });
});
