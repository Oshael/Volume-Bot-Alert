const onchainIngestion = require('./quicknode-onchain-ingestion');
const priceChangeTracker = require('./quicknode-onchain-price-change-tracker');
const priceObservation = require('./quicknode-onchain-price-observation');
const { createOnchainTransactionStream } = require('./quicknode-onchain-transaction-stream');

function createWorkerStats() {
  return {
    summaries: 0,
    batches: 0,
    acceptedSwaps: 0,
    blocked: 0,
    lowVolume: 0,
    skipped: 0,
    priceObservations: 0,
    priceObservationRejected: 0,
    priceChanges1h: 0,
    errors: 0,
  };
}

function createOnchainPriceWorker(options = {}) {
  const stats = createWorkerStats();
  const tracker = options.tracker || priceChangeTracker.createOnchainPriceChangeTracker(options.trackerOptions);
  const evaluateSummary = options.evaluateSummary || onchainIngestion.evaluateTransactionSummary;
  const evaluateSummaries = options.evaluateSummaries || onchainIngestion.evaluateTransactionSummaries;
  const buildObservation = options.buildObservation || priceObservation.buildPriceObservation;
  const onPriceChange = options.onPriceChange || (() => {});
  const onError = options.onError || (() => {});
  let drainPromise = null;
  let pendingSummaries = [];
  let flushTimer = null;
  const batchIntervalMs = Math.max(1, Number(options.batchIntervalMs) || 250);
  const maxBatchSize = Math.max(1, Number(options.maxBatchSize) || 100);

  function processCandidate(candidate) {
    const observation = buildObservation(candidate);
    if (!observation.accepted) {
      stats.priceObservationRejected += 1;
      return observation;
    }

    stats.priceObservations += 1;
    const change = tracker.add(observation);
    if (change.ready) {
      stats.priceChanges1h += 1;
      onPriceChange(change);
    }
    return change;
  }

  async function processSummary(summary) {
    stats.summaries += 1;
    const candidate = await evaluateSummary(summary, {
      minSolVolume: options.minSolVolume,
      minUsdVolume: options.minUsdVolume,
      adminBlockedTokenModel: options.adminBlockedTokenModel,
    });
    if (!candidate.accepted) {
      stats.skipped += 1;
      if (candidate.skipReason === 'admin_blocked') stats.blocked += 1;
      if (candidate.skipReason === 'low_volume') stats.lowVolume += 1;
      return candidate;
    }

    stats.acceptedSwaps += 1;
    return processCandidate(candidate);
  }

  async function processBatch(summaries) {
    if (!summaries.length) return;
    stats.batches += 1;
    stats.summaries += summaries.length;
    const result = await evaluateSummaries(summaries, {
      minSolVolume: options.minSolVolume,
      minUsdVolume: options.minUsdVolume,
      adminBlockedTokenModel: options.adminBlockedTokenModel,
    });
    stats.acceptedSwaps += result.accepted;
    stats.skipped += result.skipped;
    stats.blocked += result.blocked;
    stats.lowVolume += result.lowVolume;
    result.candidates.forEach(processCandidate);
  }

  function flush() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (drainPromise) return drainPromise;
    const batch = pendingSummaries;
    pendingSummaries = [];
    if (!batch.length) return Promise.resolve();
    drainPromise = processBatch(batch)
      .catch((error) => {
        stats.errors += 1;
        onError(error);
      })
      .finally(() => {
        drainPromise = null;
        return pendingSummaries.length ? flush() : undefined;
      });
    return drainPromise;
  }

  function enqueue(summary) {
    pendingSummaries.push(summary);
    if (pendingSummaries.length >= maxBatchSize) return flush();
    if (!flushTimer) flushTimer = setTimeout(flush, batchIntervalMs);
    return drainPromise || Promise.resolve();
  }

  const stream = (options.streamFactory || createOnchainTransactionStream)({
    wsUrl: options.wsUrl,
    rpcUrl: options.rpcUrl,
    programs: options.programs,
    exclude: options.exclude,
    required: options.required,
    reconnectDelayMs: options.reconnectDelayMs,
    fetchConcurrency: options.fetchConcurrency,
    fetchBatchSize: options.fetchBatchSize,
    fetchBatchWaitMs: options.fetchBatchWaitMs,
    fetchAvailabilityDelayMs: options.fetchAvailabilityDelayMs,
    fetchAttempts: options.fetchAttempts,
    fetchRetryMs: options.fetchRetryMs,
    fetchMaxQueueSize: options.fetchMaxQueueSize,
    onSummary: enqueue,
    onStatus: options.onStatus,
    onError: (error) => {
      stats.errors += 1;
      onError(error);
    },
  });

  async function stop() {
    await stream.stop();
    await flush();
  }

  return {
    start: stream.start,
    stop,
    flush,
    processSummary,
    snapshot: () => ({
      ...stats,
      trackedPrices: tracker.size(),
      programs: stream.stats(),
      http: stream.httpStats?.() || null,
    }),
  };
}

module.exports = {
  createOnchainPriceWorker,
  __private: {
    createWorkerStats,
  },
};
