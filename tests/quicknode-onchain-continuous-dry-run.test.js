const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const continuousDryRun = require('../src/utils/quicknode-onchain-continuous-dry-run');

describe('quicknode continuous dry run', () => {
  it('uses every required DEX and the agreed gates by default', () => {
    const previous = { ...process.env };
    try {
      process.env.QUICKNODE_SOLANA_WS_URL = 'wss://example.test/token/';
      delete process.env.QUICKNODE_CONTINUOUS_PROGRAMS;
      delete process.env.QUICKNODE_CONTINUOUS_MIN_SOL_VOLUME;
      delete process.env.QUICKNODE_CONTINUOUS_MIN_USD_VOLUME;

      const options = continuousDryRun.readContinuousOptions();

      assert.deepEqual(options.programs.map((program) => program.label), [
        'pumpswap',
        'meteora-dlmm',
        'raydium-cpmm',
        'raydium-clmm',
        'raydium-amm-v4',
      ]);
      assert.equal(options.minSolVolume, 0.01);
      assert.equal(options.minUsdVolume, 1.5);
      assert.equal(options.durationSeconds, 60);
      assert.equal(options.transport, 'full');
      assert.equal(options.rpcUrl, null);
      assert.equal(options.fetchConcurrency, 2);
      assert.equal(options.fetchBatchSize, 50);
      assert.equal(options.fetchBatchWaitMs, 50);
      assert.equal(options.fetchAvailabilityDelayMs, 500);
      assert.equal(options.fetchAttempts, 4);
      assert.equal(options.fetchRetryMs, 250);
      assert.equal(options.fetchMaxQueueSize, 2_000);
    } finally {
      process.env = previous;
    }
  });

  it('requires and normalizes HTTP RPC only for logs transport', () => {
    const previous = { ...process.env };
    try {
      process.env.QUICKNODE_SOLANA_WS_URL = 'wss://example.test/token/';
      process.env.QUICKNODE_SOLANA_RPC_URL = 'https://example.test/token/';
      process.env.QUICKNODE_CONTINUOUS_TRANSPORT = 'logs';
      process.env.QUICKNODE_CONTINUOUS_FETCH_CONCURRENCY = '1';
      process.env.QUICKNODE_CONTINUOUS_FETCH_BATCH_SIZE = '100';
      process.env.QUICKNODE_CONTINUOUS_FETCH_BATCH_WAIT_MS = '200';
      process.env.QUICKNODE_CONTINUOUS_FETCH_AVAILABILITY_DELAY_MS = '1500';
      process.env.QUICKNODE_CONTINUOUS_FETCH_ATTEMPTS = '2';
      process.env.QUICKNODE_CONTINUOUS_FETCH_RETRY_MS = '750';
      process.env.QUICKNODE_CONTINUOUS_FETCH_MAX_QUEUE_SIZE = '25';

      const options = continuousDryRun.readContinuousOptions();

      assert.equal(options.transport, 'logs');
      assert.equal(options.rpcUrl, 'https://example.test/token/');
      assert.equal(options.fetchConcurrency, 1);
      assert.equal(options.fetchBatchSize, 100);
      assert.equal(options.fetchBatchWaitMs, 200);
      assert.equal(options.fetchAvailabilityDelayMs, 1500);
      assert.equal(options.fetchAttempts, 2);
      assert.equal(options.fetchRetryMs, 750);
      assert.equal(options.fetchMaxQueueSize, 25);
    } finally {
      process.env = previous;
    }
  });

  it('aggregates received bytes and QuickNode credit estimates', () => {
    const traffic = continuousDryRun.summarizeTraffic([
      { traffic: { receivedBytes: 100_000 } },
      { traffic: { receivedBytes: 50_000 } },
    ]);

    assert.deepEqual(traffic, {
      receivedBytes: 150_000,
      estimatedCredits: 22.5,
    });
  });

  it('bounds shutdown waits for an external operation that never settles', async () => {
    const settled = await continuousDryRun.settleWithin(new Promise(() => {}), 5);
    assert.equal(settled, false);
  });

  it('runs and stops an injected continuous worker at the configured duration', async () => {
    const state = {};
    const snapshot = await continuousDryRun.runContinuousDryRun({
      wsUrl: 'wss://example.test/token/',
      programs: [],
      durationSeconds: 0.005,
      reportIntervalSeconds: 60,
      minSolVolume: 0.01,
      minUsdVolume: 1.5,
      shutdownTimeoutMs: 50,
      workerFactory: () => ({
        start() { state.started = true; },
        async stop() { state.stopped = true; },
        snapshot() { return { programs: [], summaries: 0 }; },
      }),
    });

    assert.equal(state.started, true);
    assert.equal(state.stopped, true);
    assert.equal(snapshot.drainTimedOut, false);
  });
});
