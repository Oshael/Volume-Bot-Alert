const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodWalletTransferLiveWorker,
  __private: { buildRuntime },
} = require('../src/services/robinhood-wallet-transfer-live-worker');

describe('Robinhood wallet transfer LIVE worker', () => {
  it('builds one validated RPC runtime with isolated adapters', async () => {
    const rpcClient = { name: 'rpc' };
    const created = {};
    const factory = (name) => (input) => { created[name] = input; return { name }; };
    const runtime = await buildRuntime({
      addressShardConcurrency: 2, blockEvidenceBatchSize: 20,
      endpointRoleBatchSize: 30, rpcOptions: {},
    }, {
      database: { name: 'db' }, rpcClient,
      validateChainIds: async (client) => {
        assert.equal(client, rpcClient);
        return { public: '4663' };
      },
      transferReaderFactory: factory('transferReader'),
      sourceFactory: factory('source'), rawFactory: factory('raw'),
      projectionFactory: factory('projection'), evidenceFactory: factory('evidence'),
      roleReaderFactory: factory('roles'),
    });

    assert.deepEqual(runtime.providerChainIds, { public: '4663' });
    assert.equal(runtime.tickDeps.evidence.name, 'evidence');
    assert.equal(created.transferReader.addressShardConcurrency, 2);
    assert.equal(created.evidence.blockBatchSize, 20);
    assert.equal(created.roles.batchSize, 30);
    assert.equal(created.source.database.name, 'db');
  });

  it('is opt-in, schedules one active tick and records bounded telemetry', async () => {
    const scheduled = [];
    const worker = createRobinhoodWalletTransferLiveWorker({
      schedule: (fn, delay) => { const task = { fn, delay }; scheduled.push(task); return task; },
      cancelSchedule() {},
      runtimeFactory: async () => ({ providerChainIds: { public: '4663' }, tickDeps: {} }),
      runTick: async () => ({
        status: 'projected', transfers: 2, rawInserted: 2, edgeGroups: 1,
        evidenceCandidates: 3, telemetry: { endpointRoles: { probes: 4 } },
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
});
