const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRealtimeLatencyWindow } = require('../src/services/realtime-latency-window');

test('summarizes bounded realtime latency percentiles by stage', () => {
  const latency = createRealtimeLatencyWindow({ limit: 10, now: () => 1125 });
  for (let index = 1; index <= 10; index += 1) {
    const publishedAt = 1000 + index * 10;
    latency.record({
      receiptsAvailableAt: new Date(1000).toISOString(),
      captureCommittedAt: new Date(1005).toISOString(),
      projectionCommittedAt: new Date(1008).toISOString(),
    }, new Date(publishedAt).toISOString());
  }

  const snapshot = latency.snapshot();
  assert.equal(snapshot.sampleCount, 10);
  assert.equal(snapshot.lastEventAgeMs, 25);
  assert.equal(snapshot.stages.receiptToPublishedMs.p50Ms, 50);
  assert.equal(snapshot.stages.receiptToPublishedMs.p95Ms, 100);
  assert.equal(snapshot.stages.captureToPublishedMs.p99Ms, 95);
  assert.equal(snapshot.stages.projectionToPublishedMs.maxMs, 92);
});

test('ignores invalid and negative realtime timestamps', () => {
  const latency = createRealtimeLatencyWindow();
  assert.equal(latency.record({}, 'invalid'), false);
  assert.equal(latency.record({ receiptsAvailableAt: new Date(2000).toISOString() },
    new Date(1000).toISOString()), false);
  assert.equal(latency.snapshot().sampleCount, 0);
});

test('supports flow-specific stage definitions', () => {
  const latency = createRealtimeLatencyWindow({
    stages: { observedToPublishedMs: 'eventObservedAt' },
    now: () => 1500,
  });
  latency.record({ eventObservedAt: new Date(1000).toISOString() }, new Date(1250).toISOString());
  const snapshot = latency.snapshot();
  assert.equal(snapshot.stages.observedToPublishedMs.p95Ms, 250);
  assert.equal(snapshot.stages.receiptToPublishedMs, undefined);
});
