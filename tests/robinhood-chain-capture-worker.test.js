const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const {
  CAPTURE_TOPICS, createRobinhoodChainCaptureWorker, __private,
} = require('../src/services/robinhood-chain-capture-worker');
const {
  main: captureMain, resolveEventShadowEnabled, resolveTransactionShadowEnabled,
  resolveTransactionStorage,
  __private: captureProcess,
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

test('worker prefetches blocks concurrently and commits them sequentially without eth_getLogs', async () => {
  const samples = new Map([[100, fixture(100)], [101, fixture(101, hash('b'))]]);
  const methods = []; const commits = []; const snapshotCalls = [];
  let activeReads = 0; let maximumActiveReads = 0;
  const rpcClient = { request: async (method, params) => {
    methods.push(method);
    if (method === 'eth_blockNumber') return '0x65';
    activeReads += 1; maximumActiveReads = Math.max(maximumActiveReads, activeReads);
    await new Promise((resolve) => setImmediate(resolve));
    const sample = samples.get(Number(BigInt(params[0])));
    const result = method === 'eth_getBlockByNumber' ? sample.block : sample.receipts;
    activeReads -= 1;
    return result;
  } };
  const journal = {
    getCursor: async () => null,
    commitBlocks: async (captures) => {
      commits.push(...captures);
      return captures.map((capture) => ({
        status: 'committed', transactions: capture.transactions.length,
        events: capture.events.length,
      }));
    },
  };
  const v3Snapshotter = { captureBlock: async (capture, options) => {
    snapshotCalls.push([capture.block.number, options.readBalances]);
    return { snapshots: [], pools: 0, missedPools: 0 };
  } };
  const worker = createRobinhoodChainCaptureWorker({ rpcClient, journal, v3Snapshotter }, {
    startBlock: '100', maxBlocksPerDrain: 2, fetchConcurrency: 2, confirmations: 2,
  });
  await worker.captureOnce();
  assert.equal(maximumActiveReads, 4);
  assert.deepEqual(commits.map((capture) => capture.block.number), [100n, 101n]);
  assert.deepEqual(snapshotCalls, [[100n, true], [101n, true]]);
  assert.equal(methods.includes('eth_getLogs'), false);
  const status = worker.getStatus();
  assert.deepEqual(
    [status.nodeHead, status.nextBlock, status.lagBlocks, status.blocks,
      status.transactions, status.events],
    ['101', '102', 0, 2, 2, 2]
  );
  assert.equal(status.fetchConcurrency, 2);
  assert.equal(status.lastTiming.trackerPrepareMs >= 0, true);
  for (const field of [
    'nodeHeadObservedAt', 'lastRunAt', 'lastProgressAt', 'lastCompletedAt',
  ]) assert.equal(Number.isFinite(Date.parse(status[field])), true, field);
  assert.deepEqual(
    [status.inFlight, status.totalErrors, status.consecutiveErrors],
    [false, 0, 0]
  );
});

test('worker bounds V3 reads and commits snapshots in block order after all complete', async () => {
  const samples = new Map([[100, fixture(100)], [101, fixture(101, hash('b'))]]);
  const prepared = []; const released = new Map(); const commits = [];
  let active = 0; let maxActive = 0;
  const worker = createRobinhoodChainCaptureWorker({
    rpcClient: { request: async (method, params) => {
      if (method === 'eth_blockNumber') return '0x65';
      const sample = samples.get(Number(BigInt(params[0])));
      return method === 'eth_getBlockByNumber' ? sample.block : sample.receipts;
    } },
    journal: {
      getCursor: async () => null,
      commitBlocks: async (captures) => {
        commits.push(...captures);
        return captures.map(() => ({ transactions: 1, events: 1, v3Snapshots: 1 }));
      },
    },
    v3Snapshotter: {
      captureBlock: async () => { throw new Error('prepared path required'); },
      beginBatch: () => ({ commit: () => { assert.equal(commits.length, 2); },
        prepareBlock: (capture) => {
          const block = Number(capture.block.number);
          prepared.push(block);
          return () => new Promise((resolve) => {
            active += 1; maxActive = Math.max(maxActive, active);
            released.set(block, () => { active -= 1; resolve({
              snapshots: [{ block }], missedPools: 0,
            }); });
          });
        } }),
    },
  }, { startBlock: '100', maxBlocksPerDrain: 2, fetchConcurrency: 2,
    snapshotConcurrency: 2 });
  const pending = worker.captureOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(prepared, [100, 101]);
  assert.equal(maxActive, 2);
  released.get(101)();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(commits.length, 0);
  released.get(100)();
  await pending;
  assert.deepEqual(commits.map((capture) => capture.block.number), [100n, 101n]);
  assert.deepEqual(commits.map((capture) => capture.v3Snapshots[0].block), [100, 101]);
  assert.equal(worker.getStatus().snapshotConcurrency, 2);
});

test('worker waits for started V3 reads and leaves the batch uncommitted on failure', async () => {
  const samples = new Map([[100, fixture(100)], [101, fixture(101, hash('b'))]]);
  const error = new Error('V3 RPC failed');
  let releaseSecond; let committed = false; let trackerCommitted = false;
  const worker = createRobinhoodChainCaptureWorker({
    rpcClient: { request: async (method, params) => {
      if (method === 'eth_blockNumber') return '0x65';
      const sample = samples.get(Number(BigInt(params[0])));
      return method === 'eth_getBlockByNumber' ? sample.block : sample.receipts;
    } },
    journal: {
      getCursor: async () => null,
      commitBlocks: async () => { committed = true; return []; },
    },
    v3Snapshotter: {
      captureBlock: async () => { throw new Error('prepared path required'); },
      beginBatch: () => ({
        commit: () => { trackerCommitted = true; },
        prepareBlock: (capture) => Number(capture.block.number) === 100
          ? async () => { throw error; }
          : () => new Promise((resolve) => { releaseSecond = resolve; }),
      }),
    },
  }, { startBlock: '100', maxBlocksPerDrain: 2, fetchConcurrency: 2,
    snapshotConcurrency: 2 });
  const pending = worker.captureOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseSecond, 'function');
  assert.equal(worker.getStatus().inFlight, true);
  releaseSecond({ snapshots: [], missedPools: 0 });
  await assert.rejects(pending, error);
  assert.equal(committed, false);
  assert.equal(trackerCommitted, false);
  assert.equal(worker.getStatus().totalErrors, 1);
});

test('worker does not publish staged V3 pools when the journal rejects a batch', async () => {
  const sample = fixture(100);
  const error = new Error('journal failed');
  let trackerCommitted = false;
  const worker = createRobinhoodChainCaptureWorker({
    rpcClient: { request: async (method) => (
      method === 'eth_blockNumber' ? '0x64'
        : method === 'eth_getBlockByNumber' ? sample.block : sample.receipts
    ) },
    journal: {
      getCursor: async () => null,
      commitBlocks: async () => { throw error; },
    },
    v3Snapshotter: {
      captureBlock: async () => { throw new Error('prepared path required'); },
      beginBatch: () => ({
        prepareBlock: () => async () => ({ snapshots: [], missedPools: 0 }),
        commit: () => { trackerCommitted = true; },
      }),
    },
  }, { startBlock: '100', maxBlocksPerDrain: 1 });
  await assert.rejects(worker.captureOnce(), error);
  assert.equal(trackerCommitted, false);
  assert.equal(worker.getStatus().blocks, 0);
});

test('worker reports failed capture attempts without presenting stale success', async () => {
  const error = Object.assign(new Error('node unavailable'), { code: 'rpc_timeout' });
  const worker = createRobinhoodChainCaptureWorker({
    rpcClient: { request: async () => { throw error; } },
    journal: { getCursor: async () => null },
    v3Snapshotter: { captureBlock: async () => ({ snapshots: [], missedPools: 0 }) },
  });

  await assert.rejects(worker.captureOnce(), error);
  const status = worker.getStatus();
  assert.equal(status.inFlight, false);
  assert.equal(status.lastCompletedAt, null);
  assert.equal(status.totalErrors, 1);
  assert.equal(status.consecutiveErrors, 1);
  assert.deepEqual(
    { code: status.lastError.code, message: status.lastError.message },
    { code: 'rpc_timeout', message: 'node unavailable' }
  );
  assert.equal(Number.isFinite(Date.parse(status.lastError.at)), true);
});

test('partitioned capture provisions the next range before the boundary commit', async () => {
  const calls = []; const sample = fixture(74750000);
  const worker = createRobinhoodChainCaptureWorker({
    rpcClient: { request: async (method) => (
      method === 'eth_blockNumber' ? '0x4749830'
        : method === 'eth_getBlockByNumber' ? sample.block : sample.receipts
    ) },
    journal: {
      getCursor: async () => ({ next_block: '74750000', checkpoint_hash: hash('a') }),
      commitBlocks: async () => {
        calls.push('commit');
        return [{ transactions: 1, events: 1 }];
      },
    },
    ensurePartition: async (start) => { calls.push(start); },
    v3Snapshotter: { captureBlock: async () => ({ snapshots: [], missedPools: 0 }) },
  }, { transactionPartitioned: true, maxBlocksPerDrain: 1 });
  await worker.captureOnce();
  assert.deepEqual(calls, [74750000, 'commit']);
});

test('partitioned capture prepares the next range once before reaching it', async () => {
  const starts = []; const sample = fixture(74748000);
  const worker = createRobinhoodChainCaptureWorker({
    rpcClient: { request: async (method) => (
      method === 'eth_blockNumber' ? '0x4749060'
        : method === 'eth_getBlockByNumber' ? sample.block : sample.receipts
    ) },
    journal: {
      getCursor: async () => ({ next_block: '74748000', checkpoint_hash: hash('a') }),
      commitBlocks: async () => [{ transactions: 1, events: 1 }],
    },
    ensurePartition: async (start) => { starts.push(start); },
    v3Snapshotter: { captureBlock: async () => ({ snapshots: [], missedPools: 0 }) },
  }, { transactionPartitioned: true, maxBlocksPerDrain: 1 });
  await worker.captureOnce();
  await worker.captureOnce();
  assert.deepEqual(starts, [74750000]);
});

test('partition creation failure prevents capture commit and remains visible', async () => {
  const error = Object.assign(new Error('partition lock timeout'), { code: '55P03' });
  let commits = 0; let attempts = 0;
  const worker = createRobinhoodChainCaptureWorker({
    rpcClient: { request: async () => '0x4749830' },
    journal: {
      getCursor: async () => ({ next_block: '74750000' }),
      commitBlocks: async () => { commits += 1; return []; },
    },
    ensurePartition: async () => { attempts += 1; throw error; },
    v3Snapshotter: { captureBlock: async () => ({ snapshots: [], missedPools: 0 }) },
  }, { transactionPartitioned: true });
  await assert.rejects(worker.captureOnce(), error);
  await assert.rejects(worker.captureOnce(), error);
  assert.equal(commits, 0);
  assert.equal(attempts, 1);
  assert.equal(worker.getStatus().lastError.code, '55P03');
});

test('worker persists a bounded recovery plan and halts before projection work', async () => {
  const sample = fixture(101, hash('d')); const plans = []; let snapshots = 0;
  const plan = {
    generation: '7', reason: 'parent_hash_mismatch', recoverable: true,
    checkpoint: { blockNumber: '100', blockHash: hash('a') },
  };
  const journal = {
    getCursor: async () => ({
      next_block: '101', checkpoint_block: '100', checkpoint_hash: hash('a'),
      generation: '7', recovery_state: 'running',
    }),
    markRecoveryRequired: async ({ plan: value }) => { plans.push(value); },
  };
  const worker = createRobinhoodChainCaptureWorker({
    journal,
    rpcClient: { request: async (method) => (
      method === 'eth_blockNumber' ? '0x65'
        : method === 'eth_getBlockByNumber' ? sample.block : sample.receipts
    ) },
    recoveryPlanner: { plan: async () => ({ recoveryRequired: true, plan }) },
    v3Snapshotter: { captureBlock: async () => { snapshots += 1; return {}; } },
  });
  await assert.rejects(
    worker.captureOnce(),
    (error) => error.code === 'capture_recovery_required' && error.fatal === true
  );
  assert.deepEqual(plans, [plan]); assert.equal(snapshots, 0);
  const status = worker.getStatus();
  assert.equal(status.halted, true); assert.equal(status.running, false);
  assert.equal(status.recoveryState, 'recovery_required');
  assert.deepEqual(status.recoveryPlan, plan);
});

test('worker preserves a durable recovery halt across process restart', async () => {
  const plan = { generation: '7', reason: 'ancestor_not_found', recoverable: false };
  const methods = [];
  const worker = createRobinhoodChainCaptureWorker({
    journal: { getCursor: async () => ({
      next_block: '101', checkpoint_block: '100', checkpoint_hash: hash('a'),
      generation: '7', recovery_state: 'recovery_required', recovery_plan: plan,
    }) },
    rpcClient: { request: async (method) => { methods.push(method); return '0x65'; } },
    v3Snapshotter: { captureBlock: async () => { throw new Error('must not capture'); } },
  });
  await assert.rejects(
    worker.captureOnce(), (error) => error.code === 'capture_recovery_required'
  );
  assert.deepEqual(methods, ['eth_blockNumber']);
  assert.equal(worker.getStatus().halted, true);
  assert.deepEqual(worker.getStatus().recoveryPlan, plan);
});

test('capture reads V3 balances on every block across catch-up drains', async () => {
  const commits = []; const commitFences = []; const snapshotCalls = [];
  const rpcClient = { request: async (method, params) => {
    if (method === 'eth_blockNumber') return '0xc8';
    const sample = fixture(Number(BigInt(params[0])));
    return method === 'eth_getBlockByNumber' ? sample.block : sample.receipts;
  } };
  const journal = {
    getCursor: async () => ({ next_block: String(100 + commits.length), generation: '4' }),
    commitBlock: async (capture, fence) => {
      commitFences.push(fence);
      commits.push(capture);
      return { transactions: 1, events: 1, v3Snapshots: capture.v3Snapshots.length };
    },
  };
  const snapshot = { logIndex: '0', tokenBalanceRaw: '123', quoteBalanceRaw: '456' };
  const v3Snapshotter = { captureBlock: async (capture, { readBalances }) => {
    snapshotCalls.push([capture.block.number, readBalances]);
    return { snapshots: readBalances ? [snapshot] : [], pools: 1,
      missedPools: 0, skippedPools: readBalances ? 0 : 1 };
  } };
  const worker = createRobinhoodChainCaptureWorker({ rpcClient, journal, v3Snapshotter }, {
    maxBlocksPerDrain: 2,
  });
  await worker.captureOnce();
  await worker.captureOnce();
  assert.deepEqual(snapshotCalls, [[100n, true], [101n, true],
    [102n, true], [103n, true]]);
  assert.deepEqual(commitFences, Array(4).fill({ expectedGeneration: '4' }));
  assert.deepEqual(commits.map((capture) => capture.v3Snapshots),
    [[snapshot], [snapshot], [snapshot], [snapshot]]);
  const status = worker.getStatus();
  assert.equal(status.v3Snapshots, 4);
  assert.equal(status.nextBlock, '104');
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
    resolveEventShadowEnabled: async () => false,
    resolveTransactionStorage: async () => ({ partitioned: false, shadowEnabled: false }),
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
  assert.equal(typeof workerDeps.recoveryPlanner.plan, 'function');
  await process.shutdown();
});

test('capture process wires the guarded provisioner for partitioned storage', async () => {
  let workerDeps; const calls = [];
  const database = {};
  const process = await captureMain({
    options: { enabled: true, leaseHeartbeatMs: 1000, leaseTtlMs: 5000 },
    database,
    resolveEventShadowEnabled: async () => false,
    resolveTransactionStorage: async () => ({ partitioned: true, shadowEnabled: false }),
    rpcOptions: {}, rpcClientFactory: () => ({}),
    catalog: { listActivePools: async () => [] },
    v3Snapshotter: { captureBlock: async () => ({}) },
    partitionProvisioner: { run: async (...args) => { calls.push(args); } },
    workerFactory: (deps) => {
      workerDeps = deps;
      return { start() {}, stop: async () => {}, getStatus: () => ({}) };
    },
    leaseManagerFactory: () => ({ start() {}, stop: async () => {} }),
    close: async () => {},
  });
  await workerDeps.ensurePartition(74750000);
  assert.deepEqual(calls, [[{ start: 74750000, apply: true },
    { database, closePool: false }]]);
  await process.shutdown();
});

test('partitioned active events disable the legacy mirror even if its flag stays on', async () => {
  const database = { query: async () => ({ rows: [{
    active_kind: 'p', shadow_present: false,
  }] }) };
  assert.equal(await resolveEventShadowEnabled(database, true), false);
  await assert.rejects(resolveEventShadowEnabled({ query: async () => ({ rows: [{
    active_kind: 'p', shadow_present: true,
  }] }) }, true), /still have a shadow relation/);
  await assert.rejects(resolveEventShadowEnabled({ query: async () => ({ rows: [{
    active_kind: 'r', shadow_present: false,
  }] }) }, true), /shadow is unavailable/);
});

test('transaction mirror requires a partitioned shadow and a monolithic active table',
  async () => {
    assert.equal(await resolveTransactionShadowEnabled({}, false), false);
    const database = { query: async () => ({ rows: [{
      active_kind: 'r', shadow_kind: 'p',
    }] }) };
    assert.equal(await resolveTransactionShadowEnabled(database, true), true);
    await assert.rejects(resolveTransactionShadowEnabled({ query: async () => ({
      rows: [{ active_kind: 'r', shadow_kind: null }],
    }) }, true), /unavailable/);
    await assert.rejects(resolveTransactionShadowEnabled({ query: async () => ({
      rows: [{ active_kind: 'p', shadow_kind: 'p' }],
    }) }, true), /still have a shadow relation/);
  });

test('transaction storage selects the active partitioned layout and disables the old mirror',
  async () => {
    const partitioned = { query: async () => ({ rows: [{
      active_kind: 'p', shadow_kind: null,
    }] }) };
    assert.deepEqual(await resolveTransactionStorage(partitioned, true),
      { partitioned: true, shadowEnabled: false });
    await assert.rejects(resolveTransactionStorage({ query: async () => ({ rows: [{
      active_kind: 'p', shadow_kind: 'p',
    }] }) }, true), /still have a shadow relation/);
    const monolith = { query: async () => ({ rows: [{
      active_kind: 'r', shadow_kind: 'p',
    }] }) };
    assert.deepEqual(await resolveTransactionStorage(monolith, true),
      { partitioned: false, shadowEnabled: true });
  });
