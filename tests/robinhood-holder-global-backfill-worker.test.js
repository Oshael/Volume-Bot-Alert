const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  createRobinhoodHolderGlobalBackfillWorker,
  __private: { normalizeOptions, runCampaignTick },
} = require('../src/services/robinhood-holder-global-backfill-worker');
const CUTOFF = '2026-08-10T00:00:00.000Z';
function campaign(status, overrides = {}) {
  return {
    id: '1', status, catalogCutoff: CUTOFF, createdAt: CUTOFF,
    nextBlock: '100', barrierBlock: null, cohortTokenCount: '2', version: '0', ...overrides,
  };
}
describe('Robinhood holder global backfill worker', () => {
  it('keeps preview explicit and advances scan, attach, materialization and completion', async () => {
    let run = null;
    let attachReady = false;
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
      materializer: { materializeOnce: async () => {
        if (run.status === 'attached') {
          run = campaign('materializing', { barrierBlock: '105' });
          return { status: 'materializing', materializedTokens: 2 };
        }
        return { status: 'idle' };
      } },
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
    assert.equal((await runCampaignTick(runtime, active)).status, 'completed');
    assert.equal(telemetry.at(-1).telemetry.liveLagBlocks, '6');
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
});
