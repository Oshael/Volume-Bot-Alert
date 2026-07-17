const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { createOnchainPriceWorker } = require('../src/services/quicknode-onchain-price-worker');
const { resolveProgram } = require('../src/utils/quicknode-transaction-probe');

const PROGRAMS = [
  'pumpswap',
  'meteora-dlmm',
  'raydium-cpmm',
  'raydium-clmm',
  'raydium-amm-v4',
].map(resolveProgram);

function createFakeStreamFactory(state) {
  return (options) => {
    state.options = options;
    return {
      start() {
        state.started = true;
      },
      stop() {
        state.stopped = true;
      },
      stats() {
        return PROGRAMS.map((program) => ({ program: program.label, matches: 0 }));
      },
    };
  };
}

function acceptedCandidate(summary) {
  return Promise.resolve({
    accepted: true,
    program: summary.program,
    signature: summary.signature,
    tokenMint: summary.tokenMint,
    tokenDelta: 10,
    stableMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    stableDelta: -summary.quoteAmount,
    uniqueNonQuoteMintCount: 1,
    observedAtMs: summary.observedAtMs,
  });
}

async function acceptedCandidates(summaries) {
  const candidates = await Promise.all(summaries.map(acceptedCandidate));
  return {
    accepted: candidates.length,
    skipped: 0,
    blocked: 0,
    lowVolume: 0,
    candidates,
    skippedEvents: [],
  };
}

describe('quicknode onchain price worker', () => {
  it('keeps one tracker across streamed events and emits 1h price changes', async () => {
    const streamState = {};
    const changes = [];
    const worker = createOnchainPriceWorker({
      wsUrl: 'wss://example.test/',
      rpcUrl: 'https://example.test/',
      programs: PROGRAMS,
      minSolVolume: 0.01,
      minUsdVolume: 1.5,
      fetchConcurrency: 1,
      fetchBatchSize: 100,
      fetchBatchWaitMs: 200,
      fetchAvailabilityDelayMs: 1500,
      fetchAttempts: 2,
      fetchRetryMs: 750,
      fetchMaxQueueSize: 25,
      streamFactory: createFakeStreamFactory(streamState),
      evaluateSummaries: acceptedCandidates,
      onPriceChange: (change) => changes.push(change),
    });

    worker.start();
    streamState.options.onSummary({
      program: 'pumpswap',
      signature: 'baseline',
      tokenMint: 'WorkerToken111111111111111111111111111111111',
      quoteAmount: 10,
      observedAtMs: 1_000_000,
    });
    streamState.options.onSummary({
      program: 'raydium-amm-v4',
      signature: 'current',
      tokenMint: 'WorkerToken111111111111111111111111111111111',
      quoteAmount: 15,
      observedAtMs: 4_600_000,
    });

    await worker.flush();
    assert.equal(streamState.started, true);
    assert.equal(streamState.options.rpcUrl, 'https://example.test/');
    assert.equal(streamState.options.fetchConcurrency, 1);
    assert.equal(streamState.options.fetchBatchSize, 100);
    assert.equal(streamState.options.fetchBatchWaitMs, 200);
    assert.equal(streamState.options.fetchAvailabilityDelayMs, 1500);
    assert.equal(streamState.options.fetchAttempts, 2);
    assert.equal(streamState.options.fetchRetryMs, 750);
    assert.equal(streamState.options.fetchMaxQueueSize, 25);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].currentPriceChange1h, 50);
    assert.equal(worker.snapshot().priceObservations, 2);
    assert.equal(worker.snapshot().priceChanges1h, 1);
    assert.deepEqual(worker.snapshot().programs.map((item) => item.program), PROGRAMS.map((item) => item.label));
    await worker.stop();
    assert.equal(streamState.stopped, true);
  });

  it('batches streamed summaries into one blocklist evaluation', async () => {
    const streamState = {};
    const batches = [];
    const worker = createOnchainPriceWorker({
      wsUrl: 'wss://example.test/',
      programs: PROGRAMS,
      streamFactory: createFakeStreamFactory(streamState),
      evaluateSummaries: async (summaries) => {
        batches.push(summaries);
        return { accepted: 0, skipped: summaries.length, blocked: 0, lowVolume: summaries.length, candidates: [], skippedEvents: [] };
      },
    });

    streamState.options.onSummary({ signature: 'one' });
    streamState.options.onSummary({ signature: 'two' });
    await worker.flush();

    assert.equal(batches.length, 1);
    assert.equal(batches[0].length, 2);
    assert.equal(worker.snapshot().batches, 1);
    assert.equal(worker.snapshot().lowVolume, 2);
  });

  it('coalesces events arriving while a blocklist batch is in flight', async () => {
    const streamState = {};
    const batches = [];
    let releaseFirstBatch;
    const firstBatchGate = new Promise((resolve) => { releaseFirstBatch = resolve; });
    const worker = createOnchainPriceWorker({
      wsUrl: 'wss://example.test/',
      programs: PROGRAMS,
      streamFactory: createFakeStreamFactory(streamState),
      evaluateSummaries: async (summaries) => {
        batches.push(summaries);
        if (batches.length === 1) await firstBatchGate;
        return { accepted: 0, skipped: summaries.length, blocked: 0, lowVolume: summaries.length, candidates: [], skippedEvents: [] };
      },
    });

    streamState.options.onSummary({ signature: 'first' });
    const draining = worker.flush();
    streamState.options.onSummary({ signature: 'second' });
    streamState.options.onSummary({ signature: 'third' });
    releaseFirstBatch();
    await draining;

    assert.equal(batches.length, 2);
    assert.deepEqual(batches.map((batch) => batch.length), [1, 2]);
  });

  it('counts blocked and low-volume events before price translation', async () => {
    const streamState = {};
    const results = [
      { accepted: false, skipReason: 'admin_blocked' },
      { accepted: false, skipReason: 'low_volume' },
    ];
    const worker = createOnchainPriceWorker({
      wsUrl: 'wss://example.test/',
      programs: PROGRAMS,
      streamFactory: createFakeStreamFactory(streamState),
      evaluateSummary: async () => results.shift(),
    });

    await worker.processSummary({});
    await worker.processSummary({});

    assert.equal(worker.snapshot().acceptedSwaps, 0);
    assert.equal(worker.snapshot().blocked, 1);
    assert.equal(worker.snapshot().lowVolume, 1);
    assert.equal(worker.snapshot().skipped, 2);
  });
});
