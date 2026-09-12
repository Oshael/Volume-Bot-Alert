const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const workerLease = require('../src/models/worker-lease');
const { NOTIFY_CHANNEL: CAPTURE_NOTIFY_CHANNEL } = require('../src/models/robinhood-chain-capture-journal');
const {
  createWorkspaceChainReadinessRealtime,
} = require('../src/services/workspace-chain-readiness-realtime');
function snapshot(status) {
  return {
    robinhood: {
      chain: 'robinhood', status, phase: status,
      publicationReady: status === 'ready', workspaceReady: false,
      checkedAt: '2026-09-11T23:00:00.000Z', blockers: [], message: status,
      capabilities: { monitored: status === 'ready' },
    },
  };
}
describe('workspace chain readiness realtime', () => {
  it('publishes only readiness transitions after establishing a baseline', async () => {
    let status = 'ready';
    let invalidations = 0;
    const emitted = [];
    const listenerOptions = [];
    const provider = async () => snapshot(status);
    provider.invalidate = () => { invalidations += 1; };
    const runtime = createWorkspaceChainReadinessRealtime({
      provider,
      emitSignal: (event) => { emitted.push(event); return true; },
      listenerFactory: (options) => {
        listenerOptions.push(options);
        return {
          start: async () => {}, stop: async () => {},
          getStatus: () => ({ channel: options.channel, listening: true }),
        };
      },
      logger: { error() {} },
    });
    await runtime.start({ pool: {} });
    status = 'syncing';
    await runtime.__private.refresh();
    await runtime.__private.refresh();
    status = 'ready';
    await runtime.__private.refresh();
    assert.deepEqual(listenerOptions.map(({ channel }) => channel), [
      workerLease.READINESS_NOTIFY_CHANNEL, CAPTURE_NOTIFY_CHANNEL,
    ]);
    assert.deepEqual(emitted.map(({ version }) => version), [1, 1]);
    assert.notEqual(emitted[0].signature, emitted[1].signature);
    assert.equal(invalidations, 4);
    await runtime.stop();
  });
});
