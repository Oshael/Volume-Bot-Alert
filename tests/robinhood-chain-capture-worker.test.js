const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  CAPTURE_TOPICS, createRobinhoodChainCaptureWorker, __private,
} = require('../src/services/robinhood-chain-capture-worker');
const {
  main: captureMain, __private: captureProcess,
} = require('../src/utils/run-robinhood-chain-capture-worker');

const hash = (character) => `0x${character.repeat(64)}`;
const address = (character) => `0x${character.repeat(40)}`;

function fixture(number, parent = hash('a')) {
  const blockHash = hash(number === 100 ? 'b' : 'c');
  const transactionHash = hash(number === 100 ? 'd' : 'e');
  const block = {
    number: `0x${number.toString(16)}`, hash: blockHash, parentHash: parent,
    timestamp: '0x64', transactions: [{
      hash: transactionHash, transactionIndex: '0x0', from: address('1'), to: address('2'),
      nonce: '0x7', value: '0x2a', blockNumber: `0x${number.toString(16)}`, blockHash,
    }],
  };
  const receipts = [{
    transactionHash, transactionIndex: '0x0', blockNumber: block.number, blockHash,
    status: '0x1', contractAddress: null, logs: [{
      transactionHash, transactionIndex: '0x0', blockNumber: block.number, blockHash,
      logIndex: '0x0', address: address('3'), topics: [CAPTURE_TOPICS[0]], data: '0x',
    }, {
      transactionHash, transactionIndex: '0x0', blockNumber: block.number, blockHash,
      logIndex: '0x1', address: address('4'), topics: [hash('f')], data: '0x',
    }],
  }];
  return { block, receipts };
}

test('receipt reader validates context and retains only domain topics', async () => {
  const sample = fixture(100);
  const rpcClient = { request: async (method) => (
    method === 'eth_getBlockByNumber' ? sample.block : sample.receipts
  ) };
  const result = await __private.readReceiptBlock(rpcClient, 100);
  assert.equal(result.transactions.length, 1);
  assert.equal(result.transactions[0].from, address('1'));
  assert.equal(result.transactions[0].nonce, '7');
  assert.equal(result.transactions[0].valueWei, '42');
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].logIndex, '0');
});

test('receipt reader fails closed while receipts are incomplete', async () => {
  const sample = fixture(100);
  const rpcClient = { request: async (method) => (
    method === 'eth_getBlockByNumber' ? sample.block : []
  ) };
  await assert.rejects(
    __private.readReceiptBlock(rpcClient, 100),
    (error) => error.code === 'capture_receipts_unavailable'
  );
});

test('worker captures sequential blocks without eth_getLogs', async () => {
  const samples = new Map([[100, fixture(100)], [101, fixture(101, hash('b'))]]);
  const methods = []; const commits = []; const snapshotCalls = [];
  const rpcClient = { request: async (method, params) => {
    methods.push(method);
    if (method === 'eth_blockNumber') return '0x65';
    const sample = samples.get(Number(BigInt(params[0])));
    return method === 'eth_getBlockByNumber' ? sample.block : sample.receipts;
  } };
  const journal = {
    getCursor: async () => null,
    commitBlock: async (capture) => {
      commits.push(capture);
      return { status: 'committed', transactions: capture.transactions.length, events: capture.events.length };
    },
  };
  const v3Snapshotter = { captureBlock: async (capture, options) => {
    snapshotCalls.push([capture.block.number, options.readBalances]);
    return { snapshots: [], pools: 0, missedPools: 0 };
  } };
  const worker = createRobinhoodChainCaptureWorker({ rpcClient, journal, v3Snapshotter }, {
    startBlock: '100', maxBlocksPerDrain: 2, confirmations: 2,
  });
  await worker.captureOnce();
  assert.deepEqual(commits.map((capture) => capture.block.number), [100n, 101n]);
  assert.deepEqual(snapshotCalls, [[100n, false], [101n, true]]);
  assert.equal(methods.includes('eth_getLogs'), false);
  const status = worker.getStatus();
  assert.deepEqual(
    [status.nodeHead, status.nextBlock, status.lagBlocks, status.blocks,
      status.transactions, status.events],
    ['101', '102', 0, 2, 2, 2]
  );
});

test('newHeads subscription wakes capture immediately', async () => {
  class FakeSocket extends EventEmitter {
    constructor() { super(); FakeSocket.instance = this; }
    send(payload) { this.sent = JSON.parse(payload); }
    close() {}
  }
  let observed = null;
  const stream = __private.createHeadSubscription('ws://node', (head) => { observed = head; }, {
    WebSocketImpl: FakeSocket,
  });
  stream.start(); FakeSocket.instance.emit('open');
  assert.deepEqual(FakeSocket.instance.sent.params, ['newHeads']);
  FakeSocket.instance.emit('message', JSON.stringify({
    method: 'eth_subscription', params: { result: { number: '0x65' } },
  }));
  assert.equal(observed, 101n);
  stream.stop();
});

test('capture process requires loopback RPC and disables provider throttling', () => {
  assert.throws(
    () => captureProcess.captureRpcOptions({ rpcUrl: 'https://rpc.mainnet.chain.robinhood.com' }),
    (error) => error.code === 'configuration_error'
  );
  const options = captureProcess.captureRpcOptions(
    { rpcUrl: 'http://127.0.0.1:8547' }, { rpcMinIntervalMs: 250, useDrpc: true }
  );
  assert.equal(options.publicRpcUrl, 'http://127.0.0.1:8547/');
  assert.equal(options.rpcMinIntervalMs, 0);
  assert.equal(options.rpcMaxRetries, 0);
  assert.equal(options.useDrpc, false);
});

test('capture process seeds and injects the V3 snapshotter', async () => {
  const seedPools = [{ protocol: 'uniswap-v3', pool_address: address('6') }];
  let snapshotOptions; let workerDeps;
  const process = await captureMain({
    options: { enabled: true, leaseHeartbeatMs: 1000, leaseTtlMs: 5000 },
    rpcOptions: {},
    rpcClientFactory: () => ({ request: async () => null }),
    catalog: { listActivePools: async () => seedPools },
    v3SnapshotterFactory: (_deps, options) => {
      snapshotOptions = options;
      return { captureBlock: async () => ({ snapshots: [], pools: 0, missedPools: 0 }) };
    },
    workerFactory: (deps) => {
      workerDeps = deps;
      return { start() {}, stop: async () => {}, getStatus: () => ({}) };
    },
    leaseManagerFactory: () => ({ start() {}, stop: async () => {} }),
    close: async () => {},
  });

  assert.deepEqual(snapshotOptions.seedPools, seedPools);
  assert.equal(typeof workerDeps.v3Snapshotter.captureBlock, 'function');
  await process.shutdown();
});
