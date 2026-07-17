const helius = require('./helius');
const tokenRiskCandidateSelector = require('./token-risk-candidate-selector');
const tokenRiskEnrichment = require('../models/token-risk-enrichment');
const { buildStructuralSignals } = require('./token-risk-structural-signals');

const LOOP_INTERVAL_MS = 30 * 1000;
const DEFAULT_SCAN_LIMIT = 120;
const DEFAULT_BATCH_LIMIT = 3;
const DEFAULT_FRESH_ENRICHMENT_TTL_MS = 60 * 60 * 1000;

let timer = null;
let running = false;
let activeRunPromise = null;
let status = {
  running: false,
  inFlight: false,
  lastRunAt: null,
  lastCompletedAt: null,
  lastRunDurationMs: 0,
  lastScheduledDelayMs: LOOP_INTERVAL_MS,
  lastScanLimit: DEFAULT_SCAN_LIMIT,
  lastBatchLimit: DEFAULT_BATCH_LIMIT,
  lastFreshEnrichmentTtlMs: DEFAULT_FRESH_ENRICHMENT_TTL_MS,
  lastCandidateCount: 0,
  lastProcessed: 0,
  lastSucceeded: 0,
  lastFailed: 0,
  totalProcessed: 0,
  totalSucceeded: 0,
  totalFailed: 0,
  totalErrors: 0,
  lastError: null,
};

function normalizeLimit(value, fallback, max = 500) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

function normalizeDelayMs(value, fallback = LOOP_INTERVAL_MS) {
  const delayMs = Number(value);
  if (!Number.isFinite(delayMs)) {
    return fallback;
  }
  return Math.max(0, Math.round(delayMs));
}

function computeNextDelayMs(runDurationMs) {
  return normalizeDelayMs(LOOP_INTERVAL_MS - normalizeDelayMs(runDurationMs));
}

function normalizeOptions(options = {}) {
  return {
    scanLimit: normalizeLimit(options.scanLimit, DEFAULT_SCAN_LIMIT, 5000),
    batchLimit: normalizeLimit(options.batchLimit, DEFAULT_BATCH_LIMIT, 25),
    freshEnrichmentTtlMs: normalizeDelayMs(options.freshEnrichmentTtlMs, DEFAULT_FRESH_ENRICHMENT_TTL_MS),
  };
}

function normalizeErrorMessage(error) {
  const message = String(error?.message || error || '').trim();
  return message ? message.slice(0, 1000) : 'Unknown enrichment error';
}

function normalizeAddressCandidates(addresses = []) {
  return [...new Set(
    (Array.isArray(addresses) ? addresses : [])
      .map((address) => String(address || '').trim())
      .filter(Boolean)
  )].map((address) => ({ address }));
}

async function fetchStructuralPayload(address, deps = {}) {
  const heliusApi = deps.heliusApi || helius;
  const [asset, tokenAccounts, tokenSupply, largestAccounts] = await Promise.all([
    heliusApi.getAsset(address),
    heliusApi.getTokenAccounts({ mint: address }),
    heliusApi.getTokenSupply(address),
    heliusApi.getTokenLargestAccounts(address),
  ]);

  return {
    asset,
    tokenAccounts,
    tokenSupply,
    largestAccounts,
  };
}

async function enrichCandidate(candidate, deps = {}) {
  const address = String(candidate?.address || '').trim();
  if (!address) {
    throw new Error('Candidate address is required');
  }

  const now = new Date();
  const payload = await fetchStructuralPayload(address, deps);
  const signals = buildStructuralSignals(payload);
  const enrichmentStore = deps.tokenRiskEnrichmentModel || tokenRiskEnrichment;

  const saved = await enrichmentStore.upsertEnrichment({
    chain: 'solana',
    tokenAddress: address,
    source: 'helius',
    lastAttemptedAt: now,
    lastEnrichedAt: now,
    ...signals,
  });

  return {
    address,
    candidate,
    signals,
    saved,
  };
}

async function handleCandidateFailure(candidate, error, deps = {}) {
  const address = String(candidate?.address || '').trim();
  const enrichmentStore = deps.tokenRiskEnrichmentModel || tokenRiskEnrichment;
  const message = normalizeErrorMessage(error);

  if (address) {
    await enrichmentStore.recordError(address, message, {
      chain: 'solana',
      source: 'helius',
      lastAttemptedAt: new Date(),
    });
  }

  return {
    address,
    error: message,
  };
}

async function processCandidates(candidates = [], deps = {}) {
  const batch = Array.isArray(candidates) ? candidates : [];
  const results = [];

  for (const candidate of batch) {
    try {
      const result = await enrichCandidate(candidate, deps);
      status.totalProcessed += 1;
      status.totalSucceeded += 1;
      results.push({
        address: result.address,
        ok: true,
        result,
      });
    } catch (error) {
      const failure = await handleCandidateFailure(candidate, error, deps);
      status.totalProcessed += 1;
      status.totalFailed += 1;
      status.totalErrors += 1;
      status.lastError = failure.error;
      results.push({
        address: failure.address,
        ok: false,
        error: failure.error,
      });
    }
  }

  return results;
}

function schedule(options = {}) {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      await runOnce(options, { ifRunning: 'join' });
    } catch (err) {
      console.error('[TokenRiskEnrichmentWorker] Scheduled run failed:', err.message);
    } finally {
      schedule(options);
    }
  }, LOOP_INTERVAL_MS);
}

async function runCandidateBatch(candidates = [], options = {}, meta = {}, deps = {}) {
  const normalizedOptions = normalizeOptions(options);
  const ifRunning = String(meta.ifRunning || 'reject').trim().toLowerCase();

  if (activeRunPromise) {
    if (ifRunning === 'join') {
      return activeRunPromise;
    }
    throw new Error('Token risk enrichment worker already has an active run');
  }

  activeRunPromise = (async () => {
    const startedAtMs = Date.now();
    const normalizedCandidates = Array.isArray(candidates) ? candidates : [];

    status.inFlight = true;
    status.lastRunAt = new Date(startedAtMs).toISOString();
    status.lastScanLimit = normalizedOptions.scanLimit;
    status.lastBatchLimit = normalizedOptions.batchLimit;
    status.lastFreshEnrichmentTtlMs = normalizedOptions.freshEnrichmentTtlMs;
    status.lastProcessed = 0;
    status.lastSucceeded = 0;
    status.lastFailed = 0;
    status.lastError = null;

    try {
      const results = await processCandidates(normalizedCandidates, deps);

      status.lastCandidateCount = normalizedCandidates.length;
      status.lastProcessed = results.length;
      status.lastSucceeded = results.filter((row) => row.ok).length;
      status.lastFailed = results.filter((row) => !row.ok).length;
      status.lastCompletedAt = new Date().toISOString();
      status.lastRunDurationMs = Date.now() - startedAtMs;
      status.lastScheduledDelayMs = computeNextDelayMs(status.lastRunDurationMs);

      return {
        startedAt: status.lastRunAt,
        completedAt: status.lastCompletedAt,
        candidateCount: normalizedCandidates.length,
        processed: results.length,
        succeeded: status.lastSucceeded,
        failed: status.lastFailed,
        results,
      };
    } catch (error) {
      status.totalErrors += 1;
      status.lastError = normalizeErrorMessage(error);
      status.lastCompletedAt = new Date().toISOString();
      status.lastRunDurationMs = Date.now() - startedAtMs;
      status.lastScheduledDelayMs = computeNextDelayMs(status.lastRunDurationMs);
      throw error;
    } finally {
      status.inFlight = false;
      activeRunPromise = null;
    }
  })();

  return activeRunPromise;
}

async function runOnce(options = {}, meta = {}, deps = {}) {
  const normalizedOptions = normalizeOptions(options);
  const selector = deps.candidateSelector || tokenRiskCandidateSelector;
  const candidates = await selector.listCandidates({
    scanLimit: normalizedOptions.scanLimit,
    resultLimit: normalizedOptions.batchLimit,
    freshEnrichmentTtlMs: normalizedOptions.freshEnrichmentTtlMs,
  });

  return runCandidateBatch(candidates, normalizedOptions, meta, deps);
}

async function runAddressesOnce(addresses = [], meta = {}, deps = {}) {
  const candidates = normalizeAddressCandidates(addresses);
  const options = {
    scanLimit: candidates.length || DEFAULT_SCAN_LIMIT,
    batchLimit: candidates.length || DEFAULT_BATCH_LIMIT,
  };

  return runCandidateBatch(candidates, options, meta, deps);
}

function start(options = {}) {
  if (running) return;
  running = true;
  status.running = true;
  void runOnce(options, { ifRunning: 'join' }).catch((err) => {
    console.error('[TokenRiskEnrichmentWorker] Initial run failed:', err.message);
  });
  schedule(options);
  console.log('[TokenRiskEnrichmentWorker] Started');
}

function stop() {
  running = false;
  status.running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function getStatus() {
  return { ...status };
}

module.exports = {
  getStatus,
  runAddressesOnce,
  runOnce,
  start,
  stop,
  __private: {
    computeNextDelayMs,
    enrichCandidate,
    fetchStructuralPayload,
    handleCandidateFailure,
    normalizeDelayMs,
    normalizeErrorMessage,
    normalizeAddressCandidates,
    normalizeLimit,
    normalizeOptions,
    processCandidates,
    runCandidateBatch,
  },
};
