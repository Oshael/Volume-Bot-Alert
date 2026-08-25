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
      if (method === 'eth_blockNumber') return '0x70';
      if (method === 'eth_getLogs') return [
        log({ transactionHash: `0x${'d'.repeat(64)}`, transactionIndex: '0x2', logIndex: '0x3' }),
        log({ topics: [TRANSFER_TOPIC, ZERO_TOPIC, BOB], data: `0x${'0'.repeat(63)}5` }),
      ];
      throw new Error(`unexpected method ${method}`);
    });
    const reader = createRobinhoodHolderTransferReader({ rpcClient: source.client });
    const result = await reader.readRange({ tokenAddress: TOKEN, fromBlock: 99, toBlock: 100 });
    assert.deepEqual(await reader.getSafeHead(12), {
      head: '112', safeHead: '100', confirmations: 12,
    });
    assert.equal(await reader.matchesCheckpoint({ number: 100, hash: HASH_A }), true);

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
    assert.equal(source.calls.filter(({ method }) => method === 'eth_chainId').length, 1);
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

  it('replays one token from bounded block receipts in limited batches', async () => {
    const batchCalls = [];
    const nft = `0x${'9'.repeat(40)}`;
    const client = {
      async request(method, params) {
        if (method === 'eth_chainId') return '0x1237';
        if (method === 'eth_getBlockByNumber') {
          return { number: params[0], hash: HASH_A };
        }
        throw new Error(`unexpected method ${method}`);
      },
      async requestBatch(requests) {
        batchCalls.push(requests);
        const block = requests[0].params[0];
        return [[{ logs: [block === '0x64' ? log() : log({
          address: nft, blockNumber: '0x65', logIndex: '0x3',
        })] }]];
      },
    };
    const result = await createRobinhoodHolderTransferReader({ rpcClient: client })
      .readReceiptRange({ tokenAddress: TOKEN, fromBlock: 100, toBlock: 101, batchSize: 1 });

    assert.deepEqual(batchCalls, [
      [{ method: 'eth_getBlockReceipts', params: ['0x64'] }],
      [{ method: 'eth_getBlockReceipts', params: ['0x65'] }],
    ]);
    assert.equal(result.transfers.length, 1);
    assert.deepEqual(result.checkpoint, { number: '101', hash: HASH_A });
    assert.deepEqual(result.telemetry, {
      requests: 2, receiptBlocks: 2, receipts: 2, observedLogs: 2, ignoredLogs: 1,
    });
  });

  it('filters global Transfer logs by tracked token addresses at the RPC boundary', async () => {
    const nft = `0x${'9'.repeat(40)}`;
    const source = rpc(async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: HASH_A };
      assert.deepEqual(params[0].address, [TOKEN]);
      return [log(), log({ address: nft, topics: [...log().topics, BOB], data: '0x' })];
    });
    const result = await createRobinhoodHolderTransferReader({
      rpcClient: source.client,
    }).readGlobalRange({ tokenAddresses: [TOKEN], fromBlock: 100, toBlock: 100 });

    assert.equal(result.transfers.length, 1);
    assert.deepEqual(result.telemetry, {
      requests: 1, splits: 0, addressSplits: 0, filterMode: 'address-filtered',
      observedLogs: 2, ignoredLogs: 1,
    });
  });

  it('uses a topic-only query and filters locally when the allowlist is too large', async () => {
    const token2 = `0x${'8'.repeat(40)}`;
    const untracked = `0x${'9'.repeat(40)}`;
    const source = rpc(async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: HASH_A };
      assert.equal(Object.hasOwn(params[0], 'address'), false);
      return [log(), log({ address: untracked, logIndex: '0x3' })];
    });
    const result = await createRobinhoodHolderTransferReader({
      rpcClient: source.client, addressFilterLimit: 1,
    }).readGlobalRange({
      tokenAddresses: [TOKEN, token2], fromBlock: 100, toBlock: 100,
    });

    assert.equal(result.scopeTokens, 2);
    assert.equal(result.transfers.length, 1);
    assert.deepEqual(result.telemetry, {
      requests: 1, splits: 0, addressSplits: 0, filterMode: 'topics-only',
      observedLogs: 2, ignoredLogs: 1,
    });
  });

  it('shards an oversized allowlist when address filtering is forced', async () => {
    const token2 = `0x${'8'.repeat(40)}`;
    const filters = [];
    const source = rpc(async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: HASH_A };
      filters.push(params[0].address);
      return params[0].address[0] === TOKEN ? [log()] : [];
    });
    const result = await createRobinhoodHolderTransferReader({
      rpcClient: source.client, addressFilterLimit: 1,
    }).readGlobalRange({
      tokenAddresses: [TOKEN, token2], forceAddressFiltered: true,
      fromBlock: 100, toBlock: 100,
    });

    assert.deepEqual(filters, [[TOKEN], [token2]]);
    assert.equal(result.transfers.length, 1);
    assert.equal(result.telemetry.filterMode, 'address-filtered');
  });

  it('buffers valid Transfers for tokens that are not tracked yet', async () => {
    const untracked = `0x${'9'.repeat(40)}`;
    const source = rpc(async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: HASH_A };
      assert.equal(Object.hasOwn(params[0], 'address'), false);
      return [
        log(),
        log({ address: untracked, transactionHash: `0x${'c'.repeat(64)}`, logIndex: '0x3' }),
      ];
    });
    const result = await createRobinhoodHolderTransferReader({ rpcClient: source.client })
      .readGlobalRange({
        tokenAddresses: [TOKEN], captureAllTransfers: true,
        fromBlock: 100, toBlock: 100,
      });

    assert.deepEqual(result.transfers.map(({ tokenAddress }) => tokenAddress), [TOKEN, untracked]);
    assert.deepEqual(result.telemetry, {
      requests: 1, splits: 0, addressSplits: 0, filterMode: 'topics-only-buffered',
      observedLogs: 2, ignoredLogs: 0, ignoredMalformedLogs: 0,
      bufferedTokenAddresses: 1,
    });
  });

  it('ignores malformed untracked logs but quarantines malformed tracked logs', async () => {
    const untracked = `0x${'9'.repeat(40)}`;
    const malformed = log({
      address: untracked, topics: [TRANSFER_TOPIC, ALICE],
      transactionHash: `0x${'c'.repeat(64)}`,
    });
    const source = rpc(async (method) => method === 'eth_getBlockByNumber'
      ? { number: '0x64', hash: HASH_A } : [log(), malformed]);
    const reader = createRobinhoodHolderTransferReader({ rpcClient: source.client });
    const buffered = await reader.readGlobalRange({
      tokenAddresses: [TOKEN], captureAllTransfers: true, fromBlock: 100, toBlock: 100,
    });
    assert.equal(buffered.transfers.length, 1);
    assert.equal(buffered.telemetry.ignoredMalformedLogs, 1);

    await assert.rejects(
      reader.readGlobalRange({
        tokenAddresses: [TOKEN, untracked], captureAllTransfers: true,
        fromBlock: 100, toBlock: 100,
      }),
      (error) => error.code === 'holder_transfer_invalid_log'
        && error.tokenAddress === untracked
    );
  });

  it('adaptively shards an address allowlist rejected by the RPC payload boundary', async () => {
    const token2 = `0x${'8'.repeat(40)}`;
    const filters = [];
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const source = rpc(async (method, params) => {
      if (method === 'eth_getBlockByNumber') return { number: '0x64', hash: HASH_A };
      filters.push(params[0].address);
      if (params[0].address.length > 1) {
        const error = new Error('request body too large');
        error.code = 'http_error';
        error.httpStatus = 413;
        throw error;
      }
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      await new Promise((resolve) => setImmediate(resolve));
      activeRequests -= 1;
      return params[0].address[0] === TOKEN ? [log()] : [];
    });
    const reader = createRobinhoodHolderTransferReader({
      rpcClient: source.client, addressShardConcurrency: 2,
    });
    const result = await reader.readGlobalRange({
      tokenAddresses: [TOKEN, token2], fromBlock: 100, toBlock: 100,
    });

    assert.deepEqual(filters, [[TOKEN, token2], [TOKEN], [token2]]);
    assert.equal(result.transfers.length, 1);
    assert.deepEqual(result.telemetry, {
      requests: 3, splits: 0, addressSplits: 1, filterMode: 'address-filtered',
      observedLogs: 1, ignoredLogs: 0,
    });
    filters.length = 0;
    const learned = await reader.readGlobalRange({
      tokenAddresses: [TOKEN, token2], fromBlock: 100, toBlock: 100,
    });
    assert.deepEqual(filters, [[TOKEN], [token2]]);
    assert.equal(maxActiveRequests, 2);
    assert.deepEqual(learned.telemetry, {
      requests: 2, splits: 0, addressSplits: 0, filterMode: 'address-filtered',
      observedLogs: 1, ignoredLogs: 0,
    });
  });

  it('identifies malformed Transfer evidence from an allowed token', async () => {
    const source = rpc(async (method) => method === 'eth_getBlockByNumber'
      ? { number: '0x64', hash: HASH_A }
      : [log({ topics: [TRANSFER_TOPIC, ALICE] })]);
    const reader = createRobinhoodHolderTransferReader({ rpcClient: source.client });
    await assert.rejects(
      reader.readGlobalRange({ tokenAddresses: [TOKEN], fromBlock: 100, toBlock: 100 }),
      (error) => error.code === 'holder_transfer_invalid_log'
        && error.tokenAddress === TOKEN
    );
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
