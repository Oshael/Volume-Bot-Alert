const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletTransferLiveWorker,
  __private: { buildRuntime, normalizeOptions },
} = require('../src/services/robinhood-wallet-transfer-live-worker');

describe('Robinhood wallet transfer LIVE worker', () => {
  it('rejects an unsupported LIVE source', () => {
    assert.throws(() => normalizeOptions({ sourceMode: 'invalid' }, {}),
      /must be rpc or canonical_journal/);
  });

  it('builds one validated RPC runtime with isolated adapters', async () => {
    const rpcClient = { name: 'rpc', requestBatch: async () => [] };
    const created = {};
    const factory = (name) => (input) => { created[name] = input; return { name }; };
    const runtime = await buildRuntime({
      addressShardConcurrency: 2, addressFilterLimit: 500,
      blockEvidenceBatchSize: 20, rpcOptions: {},
    }, {
      database: { name: 'db' }, rpcClient,
      validateChainIds: async (client) => {
        assert.equal(client, rpcClient);
        return { public: '4663' };
      },
      transferReaderFactory: factory('transferReader'),
      sourceFactory: factory('source'), rawFactory: factory('raw'),
      projectionFactory: factory('projection'), evidenceFactory: factory('evidence'),
      transactionPositionRepositoryFactory: factory('transactionPositionRepository'),
      transactionPositionResolverFactory: factory('transactionPositions'),
    });

    assert.deepEqual(runtime.providerChainIds, { public: '4663' });
    assert.equal(runtime.tickDeps.evidence.name, 'evidence');
    assert.equal(created.transferReader.addressShardConcurrency, 2);
    assert.equal(created.transferReader.addressFilterLimit, 500);
    assert.equal(created.evidence.blockBatchSize, 20);
    assert.equal(runtime.tickDeps.roles, undefined);
    assert.equal(runtime.tickDeps.transactionPositions.name, 'transactionPositions');
    assert.equal(created.transactionPositions.rpcClient, rpcClient);
    assert.equal(
      created.transactionPositions.repository.name, 'transactionPositionRepository'
    );
    assert.equal(created.source.database.name, 'db');
  });

  it('builds canonical evidence and transaction positions without validating an RPC', async () => {
    const created = {};
    const factory = (name) => (input) => { created[name] = input; return { name }; };
    const canonicalReader = { async assertChain() { created.asserted = true; } };
    const canonicalBlockSource = { async loadBlock(number) { return { number }; } };
    const runtime = await buildRuntime({ sourceMode: 'canonical_journal' }, {
      database: { name: 'db' },
      rpcClientFactory() { throw new Error('must not create RPC'); },
      validateChainIds() { throw new Error('must not validate RPC'); },
      canonicalTransferReaderFactory: () => canonicalReader,
      canonicalEvidenceFactory: factory('evidence'),
      canonicalBlockSourceFactory: () => canonicalBlockSource,
      sourceFactory: factory('source'), rawFactory: factory('raw'),
      projectionFactory: factory('projection'),
      transactionPositionRepositoryFactory: factory('transactionPositionRepository'),
      transactionPositionResolverFactory: factory('transactionPositions'),
    });
    assert.equal(runtime.sourceMode, 'canonical_journal');
    assert.deepEqual(runtime.providerChainIds, { canonical_journal: '4663' });
    assert.equal(created.asserted, true);
    assert.equal(created.evidence.transferReader, canonicalReader);
    const [block] = await created.transactionPositions.rpcClient.requestBatch([{
      method: 'eth_getBlockByNumber', params: ['0x64', true],
    }]);
    assert.deepEqual(block, { number: '100' });
  });

  it('is opt-in, schedules one active tick and records bounded telemetry', async () => {
    const scheduled = [];
    const worker = createRobinhoodWalletTransferLiveWorker({
      schedule: (fn, delay) => { const task = { fn, delay }; scheduled.push(task); return task; },
      cancelSchedule() {},
      runtimeFactory: async () => ({ providerChainIds: { public: '4663' }, tickDeps: {} }),
      runTick: async () => ({
        status: 'projected', transfers: 2, rawInserted: 2, edgeGroups: 1,
        evidenceCandidates: 3, telemetry: {
          filterMode: 'topics-only', requests: 2, splits: 1, addressSplits: 0,
          endpointRoles: { probes: 4 },
        },
        classifications: { wallet_transfer: 2 },
      }),
    });

    assert.equal(worker.start(), false);
    assert.equal(worker.start({ enabled: true }), true);
    assert.equal(scheduled[0].delay, 0);
    await scheduled[0].fn();
    const status = worker.getStatus();
    assert.equal(status.totalRuns, 1);
    assert.equal(status.totalTransfers, 2);
    assert.equal(status.totalRawInserted, 2);
    assert.equal(status.totalEndpointRoleProbes, 4);
    assert.equal(status.lastResult.transferFilterMode, 'topics-only');
    assert.equal(status.lastResult.transferLogRequests, 2);
    assert.equal(status.lastResult.transferRangeSplits, 1);
    assert.deepEqual(status.providerChainIds, { public: '4663' });
    await worker.stop();
  });

  it('halts and propagates a canonical checkpoint mismatch', async () => {
    const fatal = [];
    const worker = createRobinhoodWalletTransferLiveWorker({
      schedule: () => ({ unref() {} }), cancelSchedule() {},
      runtimeFactory: async () => ({ providerChainIds: {}, tickDeps: {} }),
      runTick: async () => ({ status: 'blocked', reason: 'checkpoint_mismatch' }),
    });
    worker.start({ enabled: true, onFatal: async (error) => fatal.push(error.code) });
    const result = await worker.runOnce();

    assert.equal(result.status, 'blocked');
    assert.deepEqual(fatal, ['transfer_checkpoint_mismatch']);
    assert.equal(worker.getStatus().halted, true);
    assert.equal(worker.getStatus().running, false);
  });

  it('wakes a canonical worker from durable capture notifications', async () => {
    const scheduled = [];
    let listenerOptions;
    let stopped = false;
    const worker = createRobinhoodWalletTransferLiveWorker({
      env: { ROBINHOOD_WALLET_TRANSFER_LIVE_SOURCE: 'canonical_journal' },
      schedule: (fn, delay) => { const task = { fn, delay }; scheduled.push(task); return task; },
      cancelSchedule() {},
      listenerFactory: (options) => { listenerOptions = options; return {
        async start() {}, async stop() { stopped = true; },
      }; },
      runtimeFactory: async () => ({
        sourceMode: 'canonical_journal', providerChainIds: { canonical_journal: '4663' }, tickDeps: {},
      }),
      runTick: async () => ({ status: 'caught-up' }),
    });
    assert.equal(worker.start({ enabled: true }), true);
    assert.equal(listenerOptions.channel, 'robinhood_chain_capture');
    listenerOptions.onNotification();
    assert.equal(scheduled.at(-1).delay, 0);
    await worker.stop();
    assert.equal(stopped, true);
  });
});
