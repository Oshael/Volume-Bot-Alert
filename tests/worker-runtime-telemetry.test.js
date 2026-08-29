'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createWorkerRuntimeTelemetry } = require('../src/services/worker-runtime-telemetry');

test('worker runtime telemetry captures bounded process pressure and caches filesystem reads', () => {
  let nowMs = Date.parse('2026-08-29T12:00:00.000Z');
  let statCalls = 0;
  let resets = 0;
  const telemetry = createWorkerRuntimeTelemetry({
    now: () => nowMs, cacheMs: 15_000,
    memoryUsage: () => ({ rss: 200, heapUsed: 50 }),
    heapStatistics: () => ({ heap_size_limit: 100 }),
    statfs: () => { statCalls += 1; return { blocks: 100n, bavail: 25n, bsize: 10n }; },
    histogram: {
      enable() {}, disable() {}, percentile: () => 600_000_000,
      max: 800_000_000, reset: () => { resets += 1; },
    },
  });

  const first = telemetry.snapshot();
  nowMs += 1_000;
  const cached = telemetry.snapshot();

  assert.equal(first.rssBytes, 200);
  assert.equal(first.heapUsedPercent, 50);
  assert.equal(first.eventLoopP99Ms, 600);
  assert.equal(first.disk.freePercent, 25);
  assert.equal(cached, first);
  assert.equal(statCalls, 1);
  assert.equal(resets, 1);
  telemetry.stop();
});
