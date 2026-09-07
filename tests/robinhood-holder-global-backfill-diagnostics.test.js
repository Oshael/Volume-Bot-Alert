const assert = require('node:assert/strict');
const { it } = require('node:test');
const { createRobinhoodHolderGlobalBackfillDiagnostics } = require('../src/services/robinhood-holder-global-backfill-diagnostics');

it('reports concurrent RPC work with bounded, detached snapshots and preserves errors', async () => {
  let clock = 1000;
  const diagnostics = createRobinhoodHolderGlobalBackfillDiagnostics({ now: () => clock });
  const pending = [];
  const rpc = diagnostics.wrap({
    request() { return new Promise((resolve, reject) => pending.push({ resolve, reject })); },
  }, 'rpc');
  diagnostics.startTick();
  const calls = Array.from({ length: 12 }, (_, index) => rpc.request('eth_getLogs', [{
    fromBlock: `0x${(100 + index).toString(16)}`, toBlock: '0xc8',
    address: ['0xabc', '0xdef'], secret: 'never-publish-this',
  }]));
  const results = Promise.allSettled(calls);
  clock += 15000;
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.activeCount, 12);
  assert.equal(snapshot.activeRpc.length, 8);
  assert.equal(snapshot.activeRpc[0].fromBlock, '100');
  assert.equal(snapshot.activeRpc[0].elapsedMs, 15000);
  assert.equal(snapshot.activeRpc[0].addressCount, 2);
  assert.equal(snapshot.activeRpc[0].filterMode, 'address-filtered');
  assert.equal(JSON.stringify(snapshot).includes('never-publish-this'), false);
  snapshot.activeRpc[0].method = 'modified';
  assert.equal(diagnostics.snapshot().activeRpc[0].method, 'eth_getLogs');
  const error = Object.assign(new Error('private endpoint'), { code: 'timeout' });
  pending[0].reject(error);
  pending.slice(1).forEach(({ resolve }) => resolve([]));
  assert.equal((await results)[0].reason, error);
  diagnostics.finishTick();
  const completed = diagnostics.snapshot();
  assert.equal(completed.activeCount, 0);
  assert.equal(completed.completedOperations, 11);
  assert.equal(completed.failedOperations, 1);
  assert.equal(completed.lastFailure.code, 'timeout');
  assert.equal(JSON.stringify(completed).includes('private endpoint'), false);
  clock += 1000;
  assert.equal(diagnostics.snapshot().tickElapsedMs, 15000);
  diagnostics.startTick();
  assert.equal(diagnostics.snapshot().lastFailure, null);
  assert.equal(diagnostics.snapshot().completedOperations, 0);
});

it('shows a topics-only scan and internal timeout subdivision while the reader is still pending', async () => {
  const { createRobinhoodHolderTransferReader } = require('../src/services/robinhood-holder-transfer-reader');
  const diagnostics = createRobinhoodHolderGlobalBackfillDiagnostics();
  let releaseInitial;
  let releaseSplit;
  let initialStarted;
  let splitStarted;
  let logCalls = 0;
  const initial = new Promise((resolve) => { initialStarted = resolve; });
  const split = new Promise((resolve) => { splitStarted = resolve; });
  const rpc = diagnostics.wrap({
    request: async (method) => {
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getBlockByNumber') return { number: '0x65', hash: `0x${'a'.repeat(64)}` };
      assert.equal(method, 'eth_getLogs');
      logCalls += 1;
      if (logCalls === 1) {
        initialStarted();
        return new Promise((resolve, reject) => { releaseInitial = reject; });
      }
      if (logCalls === 2) {
        splitStarted();
        return new Promise((resolve) => { releaseSplit = resolve; });
      }
      return [];
    },
  }, 'rpc');
  const reader = diagnostics.wrap(createRobinhoodHolderTransferReader({ rpcClient: rpc }), 'reader');
  diagnostics.startTick();
  const pending = reader.readGlobalRange({
    fromBlock: '100', toBlock: '101',
    tokenAddresses: Array.from({ length: 101 }, (_, index) => `0x${index.toString(16).padStart(40, '0')}`),
  });
  await initial;
  assert.equal(diagnostics.snapshot().activeRpc[0].filterMode, 'topics-only');
  assert.equal(diagnostics.snapshot().activeOperations[0].scopeTokens, 101);
  releaseInitial(Object.assign(new Error('timed out'), { code: 'timeout' }));
  await split;
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.lastFailure.code, 'timeout');
  assert.equal(snapshot.activeRpc[0].fromBlock, '100');
  assert.equal(snapshot.activeRpc[0].toBlock, '100');
  assert.equal(snapshot.activeOperations[0].toBlock, '101');
  releaseSplit([]);
  assert.equal((await pending).telemetry.splits, 1);
  assert.equal(diagnostics.snapshot().activeCount, 0);
});

it('keeps repository waits observable and preserves receiver, arguments and result', async () => {
  const diagnostics = createRobinhoodHolderGlobalBackfillDiagnostics();
  const input = { runId: '9', fromBlock: '100', toBlock: '200' };
  let finish;
  const result = { status: 'committed' };
  const repository = {
    marker: 42,
    commitRange(value) {
      assert.equal(this.marker, 42);
      assert.equal(value, input);
      return new Promise((resolve) => { finish = resolve; });
    },
  };
  const pending = diagnostics.wrap(repository, 'commit').commitRange(input);
  const observed = diagnostics.snapshot().activeOperations[0];
  assert.equal(observed.operation, 'commitRange');
  assert.equal(observed.runId, '9');
  assert.equal(observed.toBlock, '200');
  finish(result);
  assert.equal(await pending, result);
  assert.equal(diagnostics.snapshot().activeCount, 0);
});
