const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');
const esbuild = require('../frontend/node_modules/esbuild');

let latency;

before(async () => {
  const result = await esbuild.build({
    entryPoints: ['frontend/src/services/socket/realtime-latency.ts'],
    bundle: true,
    format: 'esm',
    platform: 'node',
    write: false,
  });
  const source = Buffer.from(result.outputFiles[0].text).toString('base64');
  latency = await import(`data:text/javascript;base64,${source}`);
});

describe('frontend market bucket latency telemetry', () => {
  it('summarizes receipt-to-apply and browser-local stages', () => {
    latency.resetMarketBucketLatency();
    const appliedAt = Date.parse('2026-07-15T12:00:00.500Z');
    assert.equal(latency.recordMarketBucketApplied({
      latency: {
        receiptsAvailableAt: '2026-07-15T12:00:00.100Z',
        captureCommittedAt: '2026-07-15T12:00:00.150Z',
        projectionCommittedAt: '2026-07-15T12:00:00.200Z',
        publishedAt: '2026-07-15T12:00:00.300Z',
        clientReceivedAt: '2026-07-15T12:00:00.350Z',
      },
    }, appliedAt), true);

    const snapshot = latency.getMarketBucketLatencySnapshot(appliedAt + 25);
    assert.equal(snapshot.lastEventAgeMs, 25);
    assert.deepEqual(snapshot.stages.receiptToAppliedMs, {
      samples: 1, p50Ms: 400, p95Ms: 400, p99Ms: 400, maxMs: 400,
    });
    assert.equal(snapshot.stages.publishedToReceivedMs.p95Ms, 50);
    assert.equal(snapshot.stages.receivedToAppliedMs.p95Ms, 150);
  });

  it('keeps trade and alert latency windows separate', () => {
    latency.resetRealtimeLatency('market:trade');
    latency.resetRealtimeLatency('alert:event');
    const appliedAt = Date.parse('2026-09-09T12:00:00.600Z');
    latency.recordMarketTradeApplied({ latency: {
      receiptsAvailableAt: '2026-09-09T12:00:00.100Z',
      publishedAt: '2026-09-09T12:00:00.400Z',
      clientReceivedAt: '2026-09-09T12:00:00.450Z',
    } }, appliedAt);
    latency.recordAlertApplied({ latency: {
      eventObservedAt: '2026-09-09T12:00:00.200Z',
      projectionCommittedAt: '2026-09-09T12:00:00.300Z',
      publishedAt: '2026-09-09T12:00:00.450Z',
      clientReceivedAt: '2026-09-09T12:00:00.500Z',
    } }, appliedAt);

    assert.equal(latency.getRealtimeLatencySnapshot(
      'market:trade', appliedAt,
    ).stages.receiptToAppliedMs.p95Ms, 500);
    assert.equal(latency.getRealtimeLatencySnapshot(
      'alert:event', appliedAt,
    ).stages.observedToAppliedMs.p95Ms, 400);
  });

  it('ignores events without valid latency marks', () => {
    latency.resetMarketBucketLatency();
    assert.equal(latency.recordMarketBucketApplied({ latency: {} }, 1000), false);
    assert.equal(latency.getMarketBucketLatencySnapshot(1000).sampleCount, 0);
  });

  it('isolates holder, liquidity and readiness latency including poll cadence', () => {
    for (const flow of ['holder:count', 'liquidity', 'readiness']) {
      latency.resetRealtimeLatency(flow);
    }
    const first = Date.parse('2026-09-09T12:00:00.600Z');
    latency.recordHolderApplied({ latency: {
      receiptsAvailableAt: '2026-09-09T12:00:00.100Z',
      projectionCommittedAt: '2026-09-09T12:00:00.300Z',
      clientReceivedAt: '2026-09-09T12:00:00.500Z',
    } }, first);
    assert.equal(latency.recordLiquidityApplied([{
      chain: 'robinhood', address: '0x1',
      liquidityProjectionCommittedAt: '2026-09-09T12:00:00.200Z',
    }], first), 0);
    assert.equal(latency.recordLiquidityApplied([{
      chain: 'robinhood', address: '0x1',
      liquidityProjectionCommittedAt: '2026-09-09T12:00:00.200Z',
    }], first + 100), 0);
    assert.equal(latency.recordLiquidityApplied([{
      chain: 'robinhood', address: '0x1',
      liquidityProjectionCommittedAt: '2026-09-09T12:00:00.700Z',
    }], first + 500), 1);
    latency.recordReadinessApplied({ robinhood: {
      checkedAt: '2026-09-09T12:00:00.400Z',
    } }, first);
    latency.recordReadinessApplied({ robinhood: {
      checkedAt: '2026-09-09T12:00:30.400Z',
    } }, first + 30_000);

    assert.equal(latency.getRealtimeLatencySnapshot(
      'holder:count', first,
    ).stages.receiptToAppliedMs.p95Ms, 500);
    assert.equal(latency.getRealtimeLatencySnapshot(
      'liquidity', first + 500,
    ).stages.projectionToAppliedMs.p95Ms, 400);
    assert.equal(latency.getRealtimeLatencySnapshot(
      'readiness', first + 30_000,
    ).stages.pollGapMs.p95Ms, 30_000);
  });
});
