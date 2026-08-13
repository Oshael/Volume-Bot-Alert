const assert = require('node:assert/strict');
const { before, describe, it } = require('node:test');

let buildSparklineDiagnosticReport;
let parseSparklineServerTiming;

before(async () => {
  ({
    buildSparklineDiagnosticReport,
    parseSparklineServerTiming,
  } = await import('../frontend/src/state/sparkline-diagnostic-report.ts'));
});

describe('frontend sparkline diagnostic report', () => {
  it('parses server timing into comparable backend phases', () => {
    assert.deepEqual(parseSparklineServerTiming('total;dur=120.4, query;dur=95, build;dur=4.2'), {
      total: 120.4,
      query: 95,
      build: 4.2,
    });
  });

  it('reports every token in each batch and classifies missing and empty series', () => {
    const report = buildSparklineDiagnosticReport({
      startedAt: 1_000,
      completedAt: 1_300,
      cacheByIdentity: {
        'robinhood:0x1': {
          loading: false, seriesPoints: 2, bucketCount: 2,
          firstBucketAt: null, latestBucketAt: null, refreshedAt: 1_250,
        },
      },
      batches: [{
        startedAt: 1_020,
        headersAt: 1_120,
        completedAt: 1_220,
        hours: 24,
        granularityMinutes: 5,
        allAvailable: false,
        queryAllAvailable: false,
        identities: [
          { key: 'robinhood:0x1', chain: 'robinhood', address: '0x1' },
          { key: 'robinhood:0x2', chain: 'robinhood', address: '0x2' },
          { key: 'robinhood:0x3', chain: 'robinhood', address: '0x3' },
        ],
        response: {
          status: 200, ok: true,
          rateLimit: null, rateLimitPolicy: null, rateLimitLimit: null,
          rateLimitRemaining: null, rateLimitReset: null, retryAfter: null,
          serverTiming: 'total;dur=90, query;dur=70, build;dur=5',
          perfLabel: 'catalog.sparklines', perfResponseBytes: '512',
        },
        returned: [
          { key: 'robinhood:0x1', seriesPoints: 2, bucketCount: 2 },
          { key: 'robinhood:0x2', seriesPoints: 0, bucketCount: 0 },
        ],
        error: null,
      }],
    });

    assert.deepEqual(report.summary, {
      batches: 1,
      uniqueTokens: 3,
      tokenRequests: 3,
      statusCounts: { ready: 1, 'empty-series': 1, missing: 1 },
      slowestBatchMs: 200,
      backendPerfAvailable: true,
    });
    assert.deepEqual(report.tokens.map(({ key, status }) => ({ key, status })), [
      { key: 'robinhood:0x1', status: 'ready' },
      { key: 'robinhood:0x2', status: 'empty-series' },
      { key: 'robinhood:0x3', status: 'missing' },
    ]);
    assert.deepEqual(report.batches[0].timing, {
      headersMs: 100,
      totalMs: 200,
      backend: { total: 90, query: 70, build: 5 },
    });
  });
});
