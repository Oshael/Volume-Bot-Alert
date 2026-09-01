const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderGlobalBackfillWorker,
  __private: { buildRuntime, normalizeOptions, runCampaignTick },
} = require('../src/services/robinhood-holder-global-backfill-worker');
const CUTOFF = '2026-08-10T00:00:00.000Z';
function campaign(status, overrides = {}) {
  return {
    id: '1', status, catalogCutoff: CUTOFF, createdAt: CUTOFF,
    nextBlock: '100', barrierBlock: null, cohortTokenCount: '2', version: '0',
    telemetry: {}, ...overrides,
  };
}
describe('Robinhood holder global backfill worker', () => {
  it('keeps preview explicit and advances scan, attach, materialization and completion', async () => {
    let run = null;
    let attachReady = false;
    let handoffDone = false;
    const telemetry = [];
    const runtime = {
      lifecycle: {
        getLatestRun: async () => run,
        createRun: async () => { run = campaign('frozen'); return run; },
        startRun: async () => { run = campaign('scanning', { version: '1' }); return run; },
        attachToLive: async () => {
          if (!attachReady) throw Object.assign(new Error('far'), {
            code: 'holder_global_backfill_attach_unavailable',
          });
          run = campaign('attached', { barrierBlock: '105', version: '2' });
          return run;
        },
        recordTelemetry: async (value) => telemetry.push(value),
        syncCompletion: async () => { run = campaign('completed'); return { status: 'completed' }; },
      },
      ledger: { getCursor: async () => ({ nextBlock: '105' }) },
      reader: { getSafeHead: async () => ({ safeHead: '110' }) },
      scanner: {
        getStatus: () => ({ prefetch: 1 }),
        runOnce: async () => run.status === 'attached'
          ? { status: 'caught-up' } : { status: 'committed', nextBlock: '101' },
      },
      materializer: {
        materializeOnce: async () => {
          if (run.status === 'attached') {
            run = campaign('materializing', { barrierBlock: '105' });
            return { status: 'materializing', materializedTokens: 2 };
          }
          return { status: 'idle' };
        },
        handoffOnce: async () => {
          if (handoffDone) return { status: 'idle' };
          handoffDone = true;
          return { status: 'handed-off', handedOffTokens: 2 };
        },
      },
    };
    const preview = normalizeOptions({ enabled: true, catalogCutoff: CUTOFF });
    assert.equal((await runCampaignTick(runtime, preview)).status, 'frozen-preview');
    assert.equal((await runCampaignTick(runtime, preview)).status, 'frozen-preview');
    const active = normalizeOptions({ enabled: true, autoStart: true, catalogCutoff: CUTOFF });
    assert.equal((await runCampaignTick(runtime, active)).status, 'scanning');
    assert.equal((await runCampaignTick(runtime, active)).status, 'committed');
    attachReady = true;
    assert.equal((await runCampaignTick(runtime, active)).status, 'attached');
    assert.equal((await runCampaignTick(runtime, active)).status, 'materializing');
    assert.equal((await runCampaignTick(runtime, active)).status, 'handed-off');
    assert.equal((await runCampaignTick(runtime, active)).status, 'completed');
    assert.equal(telemetry.at(-1).telemetry.liveLagBlocks, '6');
  });
  it('measures delta throughput from its nonzero start block', async () => {
    const telemetry = [];
    const run = campaign('scanning', {
      createdAt: new Date(Date.now() - 1000).toISOString(),
      nextBlock: '150', telemetry: { startBlock: '100' },
    });
    const runtime = {
      lifecycle: {
        getLatestRun: async () => run,
        attachToLive: async () => { throw Object.assign(new Error('far'), {
          code: 'holder_global_backfill_attach_unavailable',
        }); },
        recordTelemetry: async (value) => telemetry.push(value),
      },
      ledger: { getCursor: async () => ({ nextBlock: '160' }) },
      reader: { getSafeHead: async () => ({ safeHead: '170' }) },
      scanner: { runOnce: async () => ({ status: 'committed' }), getStatus: () => ({}) },
    };
    await runCampaignTick(runtime, normalizeOptions({ enabled: true, catalogCutoff: CUTOFF }));
    assert.equal(telemetry[0].telemetry.startBlock, '100');
    assert.ok(telemetry[0].telemetry.blocksPerSecond <= 50);
    assert.ok(telemetry[0].telemetry.blocksPerSecond > 40);
  });
  it('freezes a rolling wide-gap cohort after the previous run completes', async () => {
    const inputs = [];
    const runtime = {
      lifecycle: { getLatestRun: async () => campaign('completed') },
      delta: {
        previewRun: async (input) => { inputs.push(input); return { candidateTokens: 120 }; },
        createRun: async (input) => {
          inputs.push(input); return { runId: '2', cohortTokens: 120 };
        },
      },
    };
    const result = await runCampaignTick(runtime, normalizeOptions({
      enabled: true, autoStart: true, catalogCutoff: CUTOFF, rollingEnabled: true,
      rollingDelayMs: 60_000, rollingMinTokens: 100, rollingMinGapBlocks: 20_000,
    }));
    assert.equal(result.status, 'frozen-preview');
    assert.equal(result.runId, '2');
    assert.equal(inputs.length, 2);
    assert.equal(inputs[0].includeBackfilling, false);
    assert.equal(inputs[0].minimumGapBlocks, 20_000);
  });
  it('does not strand a single eligible rolling token by default', async () => {
    const inputs = [];
    const runtime = {
      lifecycle: { getLatestRun: async () => campaign('completed') },
      delta: {
        previewRun: async (input) => { inputs.push(input); return { candidateTokens: 1 }; },
        createRun: async (input) => {
          inputs.push(input); return { runId: '2', cohortTokens: 1 };
        },
      },
    };
    const result = await runCampaignTick(runtime, normalizeOptions({
      enabled: true, autoStart: true, catalogCutoff: CUTOFF, rollingEnabled: true,
    }));
    assert.equal(result.status, 'frozen-preview');
    assert.equal(result.cohortTokens, 1);
    assert.equal(inputs.length, 2);
  });
  it('keeps a sub-threshold rolling cohort pending without creating a run', async () => {
    const runtime = {
      lifecycle: { getLatestRun: async () => campaign('completed') },
      delta: {
        previewRun: async () => ({ candidateTokens: 99 }),
        createRun: async () => { throw new Error('must not create'); },
      },
    };
    const result = await runCampaignTick(runtime, normalizeOptions({
      enabled: true, autoStart: true, catalogCutoff: CUTOFF,
      rollingEnabled: true, rollingMinTokens: 100,
    }));
    assert.equal(result.status, 'rolling-idle');
    assert.equal(result.candidateTokens, 99);
  });
  it('is opt-in and rejects an enabled run without cutoff', async () => {
    const scheduled = [];
    const worker = createRobinhoodHolderGlobalBackfillWorker({
      schedule: (callback, delayMs) => {
        const timer = { callback, delayMs, unref() {} }; scheduled.push(timer); return timer;
      },
      cancelSchedule() {},
      runtimeFactory: async () => ({
        providerName: 'test', lifecycle: { getLatestRun: async () => campaign('completed') },
      }),
    });
    assert.equal(worker.start(), false);
    assert.throws(() => worker.start({ enabled: true }), { code: 'configuration_error' });
    assert.equal(worker.start({ enabled: true, catalogCutoff: CUTOFF }), true);
    assert.equal(scheduled[0].delayMs, 0);
    await scheduled[0].callback();
    assert.equal(worker.getStatus().lastResult.status, 'completed');
    await worker.stop();
  });

  it('passes dedicated RPC, shard concurrency and commit pressure threshold', async () => {
    const calls = [];
    const reader = { assertChain: async () => {}, getSafeHead() {} };
    await buildRuntime(normalizeOptions({
      enabled: true, catalogCutoff: CUTOFF, addressShardConcurrency: 3,
      maxCommitMs: 10_000,
    }), {
      env: {
        ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547',
        ROBINHOOD_HOLDER_GLOBAL_BACKFILL_RPC_URL: 'http://127.0.0.1:18547',
      },
      rpcClientFactory: (input) => { calls.push(input); return 'rpc-client'; },
      lifecycleFactory: () => ({}), committerFactory: () => ({}),
      ledgerFactory: () => ({}),
      readerFactory: (input) => { calls.push(input); return reader; },
      scannerFactory: (input) => { calls.push(input); return {}; },
      attachFactory: () => ({}), database: 'database',
    });

    assert.equal(calls[0].providers[0].url, 'http://127.0.0.1:18547');
    assert.deepEqual(calls[1], { rpcClient: 'rpc-client', addressShardConcurrency: 3 });
    assert.equal(calls[2].options.maxCommitMs, 10_000);
  });

  it('falls back to the shared holder RPC when the dedicated URL is absent', async () => {
    const calls = [];
    const reader = { assertChain: async () => {} };
    await buildRuntime(normalizeOptions({ enabled: true, catalogCutoff: CUTOFF }), {
      env: { ROBINHOOD_RPC_URL: 'http://127.0.0.1:8547' },
      rpcClientFactory: (input) => { calls.push(input); return 'rpc-client'; },
      lifecycleFactory: () => ({}), committerFactory: () => ({}),
      ledgerFactory: () => ({}), readerFactory: () => reader,
      scannerFactory: () => ({}), attachFactory: () => ({}), database: 'database',
    });

    assert.equal(calls[0].providers[0].url, 'http://127.0.0.1:8547');
  });
});
