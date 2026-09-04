'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const {
  createRobinhoodCanonicalHeadRuntime,
} = require('../src/services/robinhood-canonical-head-runtime');
const { createRobinhoodLiveRpcGuard } = require('../src/services/robinhood-live-rpc-guard');

describe('Robinhood canonical head runtime', () => {
  it('seeds the capture pipeline from persisted pools and disables mutable projections', async () => {
    const seedPools = [{ protocol: 'uniswap-v3', market_key: 'pool-a' }];
    const outbox = {}; const candidateRepository = {}; let pipelineOptions; let runnerDeps;
    const runtime = await createRobinhoodCanonicalHeadRuntime({
      rpcClient: { request: async () => 'ok' },
      catalog: {
        listActivePools: async () => seedPools,
        listCurrentV4LiquidityRanges: async () => [],
      },
      outbox,
      candidateRepositoryFactory: () => candidateRepository,
      pipelineFactory: (options) => {
        pipelineOptions = options;
        return { snapshot: () => ({ tracked: { v2: 1, v3: 2, v4: 3 } }) };
      },
      runnerFactory: (deps) => {
        runnerDeps = deps;
        return { owner: 'canonical-test', runOnce: async () => ({ claimed: 0 }) };
      },
    }, { leaseMs: 30_000, observationConcurrency: 4 });

    assert.equal(pipelineOptions.captureMode, true);
    assert.equal(pipelineOptions.retainRollbackState, false);
    assert.equal(pipelineOptions.windowAggregationEnabled, false);
    assert.equal(pipelineOptions.seedPools, seedPools);
    assert.equal(pipelineOptions.observationConcurrency, 4);
    assert.equal(runnerDeps.outbox, outbox);
    assert.equal(runnerDeps.headRepository, candidateRepository);
    assert.equal(runnerDeps.options.leaseMs, 30_000);
    assert.deepEqual(await runtime.runOnce(), { claimed: 0 });
    assert.deepEqual(runtime.snapshot(), {
      owner: 'canonical-test', tracked: { v2: 1, v3: 2, v4: 3 },
      rpcGuard: {
        role: 'canonical-head', forbiddenMethod: 'eth_getLogs', forbiddenAttempts: 0,
      },
    });
  });

  it('blocks single and batched eth_getLogs before they reach the node', async () => {
    const calls = [];
    const guard = createRobinhoodLiveRpcGuard({
      request: async (method) => { calls.push(method); return 'ok'; },
      requestBatch: async (requests) => { calls.push(...requests.map(({ method }) => method)); return []; },
    }, { role: 'canonical-head' });

    assert.equal(await guard.request('eth_call', []), 'ok');
    await assert.rejects(
      Promise.resolve().then(() => guard.request('eth_getLogs', [{}])),
      (error) => error.code === 'live_rpc_method_forbidden' && error.retryable === false
    );
    await assert.rejects(
      Promise.resolve().then(() => guard.requestBatch([
        { method: 'eth_call', params: [] }, { method: 'eth_getLogs', params: [{}] },
      ])),
      (error) => error.code === 'live_rpc_method_forbidden'
    );
    assert.deepEqual(calls, ['eth_call']);
    assert.equal(guard.getGuardStatus().forbiddenAttempts, 2);
  });
});
