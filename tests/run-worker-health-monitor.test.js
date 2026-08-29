'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const { main } = require('../src/utils/run-worker-health-monitor');

function harness(options = { enabled: true, runsHere: true }) {
  const calls = [];
  const handlers = {};
  const monitor = {
    start: () => calls.push('start'),
    stop: async () => calls.push('stop'),
  };
  return {
    calls, handlers, monitor,
    deps: {
      options,
      assertSchema: async (input) => calls.push(['schema', input]),
      createMonitor: (input) => { calls.push(['create', input]); return monitor; },
      setInterval: () => 'keep-alive',
      clearInterval: (timer) => calls.push(['clear', timer]),
      close: async () => calls.push('close'),
      logger: { log: (message) => calls.push(['log', message]) },
      process: { once: (signal, handler) => { handlers[signal] = handler; } },
    },
  };
}

describe('dedicated worker health process', () => {
  it('checks schema, starts only the monitor and shuts down cleanly', async () => {
    const test = harness();
    const runtime = await main(test.deps);
    assert.deepEqual(test.calls.slice(0, 3), [
      ['schema', { profile: 'runtime' }],
      ['create', test.deps.options],
      'start',
    ]);
    assert.equal(typeof test.handlers.SIGINT, 'function');
    assert.equal(typeof test.handlers.SIGTERM, 'function');
    assert.match(test.calls[3][1], /WorkerHealthProcess.*expected=0/);

    await runtime.shutdown();
    assert.deepEqual(test.calls.slice(-3), [['clear', 'keep-alive'], 'stop', 'close']);
  });

  it('refuses disabled or non-isolated configuration', async () => {
    await assert.rejects(main(harness({ enabled: false, runsHere: false }).deps),
      /WORKER_HEALTH_MONITOR_ENABLED/);
    await assert.rejects(main(harness({ enabled: true, runsHere: false }).deps),
      /BACKGROUND_WORKER_GROUPS must be worker-health/);
  });
});
