const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const {
  compactReport,
  createClient,
  readOptions,
  runContinuousDryRun,
  summarizeWindows,
} = require('../src/utils/robinhood-continuous-dry-run');

function snapshot() {
  return {
    durationMs: 1000,
    coverage: { caughtUp: true, status: 'complete_within_declared_range' },
    runner: {
      cycles: 2, errors: 0, recoveries: 0, consecutiveErrors: 0, errorKinds: {}, lastError: null,
    },
    pipeline: {
      tracked: { v2: 1, v3: 1, v4: 1 },
      metrics: {
        swapsDecoded: 3,
        swapsAccepted: 2,
        swapsRejected: 1,
        withoutQuoteRate: 0.3333,
        v2ReserveDepleted: 1,
        processingDelayMs: { count: 2, p50: 100, p95: 200 },
      },
      enrichment: { timestamps: { concurrency: 16 }, observationConcurrency: 4 },
      socialMetadata: { enabled: false },
      windows: [{
        protocol: 'uniswap-v4',
        marketKey: 'market-1',
        tokenAddress: 'token-1',
        window: '1m',
        windowMs: 60000,
        swaps: 3,
        txns: 2,
        volumeUsd: '10.5',
        priceChangePct: '12.5',
      }],
    },
    rpc: { 'robinhood-public': { requests: 10 } },
    alchemyEnabled: false,
    noxaComparison: { status: 'not_automated', samples: 0 },
  };
}

describe('Robinhood continuous dry-run CLI', () => {
  it('uses conservative public-only defaults', () => {
    const options = readOptions({});

    assert.equal(options.durationSeconds, 60);
    assert.equal(options.reportIntervalSeconds, 15);
    assert.equal(options.pollIntervalMs, 2000);
    assert.equal(options.lookbackBlocks, 250);
    assert.equal(options.confirmations, 2);
    assert.equal(options.rangeSize, 10);
    assert.equal(options.timestampConcurrency, 16);
    assert.equal(options.observationConcurrency, 4);
    assert.equal(options.useAlchemy, false);
    assert.equal(options.socialMetadataEnabled, false);
    assert.equal(options.startBlock, null);
  });

  it('parses bounded overrides and requires an explicit Alchemy switch', () => {
    const options = readOptions({
      ROBINHOOD_CONTINUOUS_DURATION_SECONDS: '120',
      ROBINHOOD_CONTINUOUS_LOOKBACK_BLOCKS: '500',
      ROBINHOOD_CONTINUOUS_START_BLOCK: '0x64',
      ROBINHOOD_CONTINUOUS_USE_ALCHEMY: 'true',
      ROBINHOOD_CONTINUOUS_TIMESTAMP_CONCURRENCY: '99',
      ROBINHOOD_CONTINUOUS_OBSERVATION_CONCURRENCY: '8',
      ROBINHOOD_CONTINUOUS_SOCIAL_METADATA: 'true',
      ROBINHOOD_ALCHEMY_RPC_URL: 'https://example.test/key',
    });

    assert.equal(options.durationSeconds, 120);
    assert.equal(options.lookbackBlocks, 500);
    assert.equal(options.startBlock, '0x64');
    assert.equal(options.useAlchemy, true);
    assert.equal(options.timestampConcurrency, 32);
    assert.equal(options.observationConcurrency, 8);
    assert.equal(options.socialMetadataEnabled, true);
    assert.throws(() => readOptions({ ROBINHOOD_CONTINUOUS_START_BLOCK: 'latest' }), /decimal or hex/);
  });

  it('adds Alchemy only when explicitly enabled and configured', () => {
    const base = {
      publicRpcUrl: 'https://public.example',
      alchemyRpcUrl: 'https://alchemy.example/key',
    };

    assert.deepEqual(createClient({ ...base, useAlchemy: false }).providers, ['robinhood-public']);
    assert.deepEqual(createClient({ ...base, useAlchemy: true }).providers,
      ['robinhood-public', 'alchemy-free']);
  });

  it('prints compact operational reports without endpoints or metadata payloads', () => {
    const report = compactReport(snapshot());

    assert.equal(report.coverage.caughtUp, true);
    assert.equal(report.swapsAccepted, 2);
    assert.equal(report.enrichment.timestamps.concurrency, 16);
    assert.equal(report.windowSummary.total, 1);
    assert.equal(report.v2ReserveDepleted, 1);
    assert.deepEqual(report.socialMetadata, { enabled: false });
    assert.deepEqual(report.errorKinds, {});
    assert.equal('windows' in report, false);
    assert.deepEqual(report.rpc, { 'robinhood-public': { requests: 10 } });
    assert.equal('pollers' in report, false);
    assert.equal(JSON.stringify(report).includes('https://'), false);
  });

  it('summarizes windows with bounded activity and anomaly samples', () => {
    const windows = Array.from({ length: 8 }, (_, index) => ({
      protocol: index % 2 ? 'uniswap-v3' : 'uniswap-v4',
      marketKey: `market-${index}`,
      tokenAddress: `token-${index}`,
      window: index < 6 ? '5m' : '1h',
      windowMs: index < 6 ? 300000 : 3600000,
      swaps: index,
      txns: index,
      volumeUsd: String(index * 10),
      priceChangePct: String(index === 2 ? 1000000 : index),
    }));
    windows.push({ ...windows[2], window: '1h', windowMs: 3600000, priceChangePct: '10' });
    const summary = summarizeWindows(windows);

    assert.equal(summary.total, 9);
    assert.equal(summary.markets, 8);
    assert.deepEqual(summary.byWindow, { '5m': 6, '1h': 3 });
    assert.equal(summary.activityWindow, '5m');
    assert.equal(summary.topBySwaps.length, 5);
    assert.equal(summary.topBySwaps[0].marketKey, 'market-5');
    assert.equal(summary.topPriceChanges[0].marketKey, 'market-2');
    assert.equal(new Set(summary.topPriceChanges.map((window) => window.marketKey)).size,
      summary.topPriceChanges.length);
  });

  it('orchestrates a bounded read-only run with verified registry seeds', async () => {
    const lines = [];
    let runnerOptions;
    let runOptions;
    const finalSnapshot = snapshot();
    const result = await runContinuousDryRun({
      durationSeconds: 2,
      reportIntervalSeconds: 1,
      pollIntervalMs: 100,
      lookbackBlocks: 20,
      confirmations: 2,
      rangeSize: 10,
      timestampConcurrency: 6,
      observationConcurrency: 3,
      startBlock: null,
      useAlchemy: false,
      socialMetadataEnabled: false,
      alchemyRpcUrl: null,
      rpcClient: { request() {}, providers: ['robinhood-public'] },
      runnerFactory: async (options) => {
        runnerOptions = options;
        return {
          runFor: async (durationMs, optionsForRun) => {
            runOptions = optionsForRun;
            optionsForRun.onReport(finalSnapshot);
            return finalSnapshot;
          },
        };
      },
      logger: { log: (line) => lines.push(line), error: (line) => lines.push(line) },
    });

    assert.equal(result, finalSnapshot);
    assert.equal(runnerOptions.seedLogs.v2.length, 1);
    assert.equal(runnerOptions.seedLogs.v3.length, 1);
    assert.equal(runnerOptions.seedLogs.v4.length, 1);
    assert.equal(runnerOptions.timestampConcurrency, 6);
    assert.equal(runnerOptions.observationConcurrency, 3);
    assert.equal(runOptions.intervalMs, 100);
    assert.equal(lines.length, 3);
    assert.equal(lines.every((line) => line.includes('https://') === false), true);
  });
});
