const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const gmgnDiscoveryWorker = require('../src/services/gmgn-discovery-worker');

describe('gmgn discovery worker', () => {
  beforeEach(() => {
    gmgnDiscoveryWorker.__private.resetStatus();
  });

  it('skips runOnce when disabled without calling ingestion', async () => {
    let calls = 0;
    const result = await gmgnDiscoveryWorker.runOnce(
      { enabled: false, intervalMs: 2000 },
      {},
      {
        gmgnCatalogIngestion: {
          async runGmgnDiscoveryIngestionCycle() {
            calls += 1;
          },
        },
      }
    );

    assert.deepEqual(result, { skipped: true, reason: 'disabled' });
    assert.equal(calls, 0);
    const status = gmgnDiscoveryWorker.getStatus();
    assert.equal(status.enabled, false);
    assert.equal(status.lastSkippedReason, 'disabled');
  });

  it('updates operational counters after a successful ingestion cycle', async () => {
    const result = await gmgnDiscoveryWorker.runOnce(
      {
        enabled: true,
        intervalMs: 2000,
        apiKeyConfigured: true,
        schedulerOptions: { requestWindowMs: 2000 },
        ingestionOptions: { alertEvaluationMinIntervalMs: 3000 },
      },
      {},
      {
        gmgnCatalogIngestion: {
          async runGmgnDiscoveryIngestionCycle(options) {
            assert.deepEqual(options.schedulerOptions, { requestWindowMs: 2000 });
            assert.equal(options.alertEvaluationMinIntervalMs, 3000);
            return {
              discovery: {
                skipped: false,
                rateLimited: false,
                backoffRemainingMs: 0,
                requests: 5,
                tokens: [{ address: 'a' }, { address: 'b' }],
                uniqueTokens: [{ address: 'a' }],
              },
              ingestion: {
                processed: 1,
                catalogUpdated: 1,
                volumeBucketsWritten: 1,
                matcherEvaluations: 1,
                matcherEmitted: 2,
                matcherSkippedGmgnSafeguard: 3,
                gmgn1mAlerts: 1,
                matcherErrors: 0,
              },
              panel: { seenCount: 1, staleCount: 1, handoffCount: 1 },
              panelSkippedReason: null,
            };
          },
        },
      }
    );

    assert.equal(result.discovery.requests, 5);
    const status = gmgnDiscoveryWorker.getStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.apiKeyConfigured, true);
    assert.equal(status.lastRequests, 5);
    assert.equal(status.lastRawTokens, 2);
    assert.equal(status.lastUniqueTokens, 1);
    assert.equal(status.lastMatcherEmitted, 2);
    assert.equal(status.lastMatcherSkippedGmgnSafeguard, 3);
    assert.equal(status.totalMatcherSkippedGmgnSafeguard, 3);
    assert.equal(status.lastGmgn1mAlerts, 1);
    assert.equal(status.lastPanelHandoffCount, 1);
    assert.equal(status.totalSuccessfulRuns, 1);
  });

  it('records failures without leaving the worker in flight', async () => {
    await assert.rejects(
      () => gmgnDiscoveryWorker.runOnce(
        { enabled: true, intervalMs: 2000 },
        {},
        {
          gmgnCatalogIngestion: {
            async runGmgnDiscoveryIngestionCycle() {
              throw new Error('gmgn unavailable');
            },
          },
        }
      ),
      /gmgn unavailable/
    );

    const status = gmgnDiscoveryWorker.getStatus();
    assert.equal(status.inFlight, false);
    assert.equal(status.totalErrors, 1);
    assert.equal(status.lastError, 'gmgn unavailable');
  });
});
