const candidateBuilder = require('./pumpfun-fast-5x-candidates');
const { evaluatePumpfunFast5xSignal } = require('./pumpfun-fast-5x-signal');
const detectionStore = require('../models/pumpfun-fast-5x-detection');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const MAX_RECENT_PASSES = 20;
const MAX_TRACKED_DETECTIONS = 100;
const DEFAULT_OUTCOME_WINDOW_MS = 5 * 60 * 60 * 1000;

let timer = null;
let running = false;
let persistedHydrated = false;
let trackedDetections = new Map();
let settings = {
  enabled: false,
  dryRun: true,
  intervalMs: DEFAULT_INTERVAL_MS,
  candidateLimit: 250,
  outcomeWindowMs: DEFAULT_OUTCOME_WINDOW_MS,
};
let status = {
  running: false,
  enabled: false,
  dryRun: true,
  lastRunAt: null,
  lastCandidateCount: 0,
  lastPassedCount: 0,
  lastFailedCount: 0,
  lastPassedCandidates: [],
  trackedDetectionCount: 0,
  trackedDetections: [],
  totalRuns: 0,
  totalCandidates: 0,
  totalPassed: 0,
  totalErrors: 0,
  lastError: null,
};

function resolveOptions(options = {}) {
  return {
    enabled: options.enabled === true,
    dryRun: options.dryRun !== false,
    intervalMs: Math.max(10_000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS),
    candidateLimit: Math.max(1, Math.min(Number(options.candidateLimit) || 250, 500)),
    outcomeWindowMs: Math.max(60_000, Number(options.outcomeWindowMs) || DEFAULT_OUTCOME_WINDOW_MS),
  };
}

function buildPassedCandidate(candidate, result) {
  return {
    address: candidate.address,
    symbol: candidate.symbol,
    name: candidate.name,
    migrationStartedAt: candidate.migrationStartedAt,
    currentBucketAt: candidate.currentBucketAt,
    score: result.score,
    reason: result.reason,
    evidence: result.evidence,
  };
}

function toDate(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function toIsoOrNull(value) {
  const parsed = toDate(value);
  return parsed ? parsed.toISOString() : null;
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function roundMetric(value, digits = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const factor = 10 ** digits;
  return Math.round(num * factor) / factor;
}

function buildNewDetection(candidate, result, now) {
  const evidence = result.evidence || {};
  const alertMcap = toFiniteNumber(evidence.currentMcap ?? evidence.p95McapRecent ?? evidence.firstMcap);
  const alertTriggeredAt = toIsoOrNull(candidate.currentBucketAt) || now.toISOString();

  return {
    address: candidate.address,
    symbol: candidate.symbol,
    name: candidate.name,
    migrationStartedAt: candidate.migrationStartedAt,
    alertTriggeredAt,
    alertMcap,
    alertMultipleFromFirstMcap: evidence.currentMultiple ?? null,
    score: result.score,
    reason: result.reason,
    evidenceAtAlert: evidence,
    latestMcapSinceAlert: alertMcap,
    latestBucketAt: alertTriggeredAt,
    maxMcapSinceAlert: alertMcap,
    maxMcapBucketAt: alertTriggeredAt,
    maxXSinceAlert: 1,
    firstMatchedAt: now.toISOString(),
    lastMatchedAt: now.toISOString(),
    lastUpdatedAt: now.toISOString(),
    matchedRuns: 1,
  };
}

function upsertDetection(candidate, result, now) {
  const existing = trackedDetections.get(candidate.address);
  if (!existing) {
    trackedDetections.set(candidate.address, buildNewDetection(candidate, result, now));
    return;
  }

  existing.symbol = candidate.symbol || existing.symbol;
  existing.name = candidate.name || existing.name;
  existing.score = result.score;
  existing.reason = result.reason;
  existing.lastMatchedAt = now.toISOString();
  existing.lastUpdatedAt = now.toISOString();
  existing.matchedRuns += 1;
}

function pruneTrackedDetections(now) {
  const cutoff = now.getTime() - settings.outcomeWindowMs;
  for (const [address, detection] of trackedDetections.entries()) {
    const alertAt = toDate(detection.alertTriggeredAt);
    if (!alertAt || alertAt.getTime() < cutoff) {
      trackedDetections.delete(address);
    }
  }

  const detections = Array.from(trackedDetections.values())
    .sort((a, b) => String(b.alertTriggeredAt).localeCompare(String(a.alertTriggeredAt)));
  for (const detection of detections.slice(MAX_TRACKED_DETECTIONS)) {
    trackedDetections.delete(detection.address);
  }
}

function getTrackedDetections() {
  return Array.from(trackedDetections.values())
    .sort((a, b) => String(b.alertTriggeredAt).localeCompare(String(a.alertTriggeredAt)));
}

function syncTrackedStatus() {
  status.trackedDetections = getTrackedDetections();
  status.trackedDetectionCount = status.trackedDetections.length;
}

function getPostAlertHoldMetrics(outcome = {}) {
  return {
    lowX15m: outcome.postAlertLowX15m ?? 0,
    lowX30m: outcome.postAlertLowX30m ?? 0,
    highX30m: outcome.postAlertHighX30m ?? 0,
    volToMcap: outcome.postAlertMaxVolToMcap ?? 0,
  };
}

function classifyConfirmedContinuation(metrics) {
  if (metrics.lowX15m < 0.9 || metrics.lowX30m < 0.9) return null;
  if (metrics.highX30m >= 3) {
    return { status: 'continuation_parabolic', reason: 'held_0_9_and_expanded_3x_by_30m' };
  }
  if (metrics.highX30m >= 2) {
    return { status: 'continuation_strong', reason: 'held_0_9_and_expanded_2x_by_30m' };
  }
  return { status: 'continuation_confirmed', reason: 'held_0_9_and_expanded_1_5x_by_30m' };
}

function classifyPostAlertHold(outcome = {}) {
  const metrics = getPostAlertHoldMetrics(outcome);

  if (!outcome.postAlertMature15m) {
    return { status: 'pending_15m', reason: 'waiting_for_15m_bucket_coverage' };
  }
  if (metrics.lowX15m < 0.8) {
    return { status: 'failed_drawdown_15m', reason: 'low_x_15m_below_0_8' };
  }
  if (!outcome.postAlertMature30m) {
    return { status: 'held_15m_pending_30m', reason: 'held_15m_waiting_for_30m_expansion' };
  }
  if (metrics.lowX30m < 0.8) {
    return { status: 'failed_drawdown_30m', reason: 'low_x_30m_below_0_8' };
  }
  if (metrics.highX30m < 1.5) {
    return { status: 'held_weak_expansion_30m', reason: 'high_x_30m_below_1_5' };
  }
  const continuation = classifyConfirmedContinuation(metrics);
  if (continuation) return continuation;
  if (metrics.volToMcap > 5) {
    return { status: 'held_high_volume_churn', reason: 'held_0_8_with_volume_above_5x_mcap' };
  }
  return { status: 'held_soft_continuation', reason: 'held_0_8_and_expanded_1_5x_by_30m' };
}

async function hydrateTrackedDetections(now, options = {}) {
  if (persistedHydrated && !options.force) return;
  if (trackedDetections.size > 0 && !options.force) {
    persistedHydrated = true;
    return;
  }

  const cutoff = new Date(now.getTime() - settings.outcomeWindowMs);
  const persisted = await detectionStore.listRecentDetections({
    since: cutoff,
    limit: MAX_TRACKED_DETECTIONS,
  });
  trackedDetections = new Map(
    persisted
      .filter((detection) => detection?.address)
      .map((detection) => [detection.address, detection])
  );
  persistedHydrated = true;
  syncTrackedStatus();
}

async function persistTrackedDetections() {
  const tracked = getTrackedDetections();
  for (const detection of tracked) {
    await detectionStore.upsertDetection(detection);
  }
}

async function refreshTrackedOutcomes(now) {
  const tracked = getTrackedDetections();
  if (tracked.length === 0) return;

  const outcomes = await candidateBuilder.listPumpfunFast5xOutcomesSinceAlert(
    tracked.map((detection) => ({
      address: detection.address,
      alertTriggeredAt: detection.alertTriggeredAt,
      alertMcap: detection.alertMcap,
    })),
    { now }
  );

  for (const outcome of outcomes) {
    const detection = trackedDetections.get(outcome.address);
    if (!detection) continue;

    detection.latestMcapSinceAlert = outcome.latestMcapSinceAlert ?? detection.latestMcapSinceAlert;
    detection.latestBucketAt = toIsoOrNull(outcome.latestBucketAt) || detection.latestBucketAt;
    detection.maxMcapSinceAlert = outcome.maxMcapSinceAlert ?? detection.maxMcapSinceAlert;
    detection.maxMcapBucketAt = toIsoOrNull(outcome.maxMcapBucketAt) || detection.maxMcapBucketAt;
    detection.maxXSinceAlert = detection.alertMcap > 0
      ? roundMetric(detection.maxMcapSinceAlert / detection.alertMcap)
      : null;
    detection.postAlertLowX15m = roundMetric(outcome.postAlertLowX15m, 6);
    detection.postAlertLowX30m = roundMetric(outcome.postAlertLowX30m, 6);
    detection.postAlertHighX30m = roundMetric(outcome.postAlertHighX30m, 6);
    detection.postAlertMaxVolToMcap = roundMetric(outcome.postAlertMaxVolToMcap, 6);
    const hold = classifyPostAlertHold(outcome);
    detection.postAlertHoldStatus = hold.status;
    detection.postAlertHoldReason = hold.reason;
    detection.postAlertHoldEvaluatedAt = now.toISOString();
    detection.lastUpdatedAt = now.toISOString();
  }
}

async function evaluateOnce(options = {}) {
  const candidates = await candidateBuilder.listPumpfunFast5xCandidates({
    limit: settings.candidateLimit,
    maxMigrationAgeMs: options.maxMigrationAgeMs,
    now: options.now,
  });
  const passed = [];

  for (const candidate of candidates) {
    const result = evaluatePumpfunFast5xSignal(candidate.signalInput);
    if (result.passes) {
      passed.push(buildPassedCandidate(candidate, result));
    }
  }

  return {
    candidates,
    passed,
    failedCount: Math.max(0, candidates.length - passed.length),
  };
}

async function runOnce(options = {}) {
  if (!running && !options.force) return null;

  const now = toDate(options.now) || new Date();
  status.lastRunAt = now.toISOString();
  status.totalRuns += 1;

  try {
    await hydrateTrackedDetections(now);
    const summary = await evaluateOnce(options);
    status.lastCandidateCount = summary.candidates.length;
    status.lastPassedCount = summary.passed.length;
    status.lastFailedCount = summary.failedCount;
    status.lastPassedCandidates = summary.passed.slice(0, MAX_RECENT_PASSES);
    status.totalCandidates += summary.candidates.length;
    status.totalPassed += summary.passed.length;
    status.lastError = null;

    for (const passedCandidate of summary.passed) {
      const candidate = summary.candidates.find((item) => item.address === passedCandidate.address);
      if (candidate) {
        upsertDetection(candidate, {
          score: passedCandidate.score,
          reason: passedCandidate.reason,
          evidence: passedCandidate.evidence,
        }, now);
      }
    }
    pruneTrackedDetections(now);
    await refreshTrackedOutcomes(now);
    await persistTrackedDetections();
    syncTrackedStatus();

    if (summary.passed.length > 0) {
      console.log(
        `[PumpFunFast5xDryRun] candidates=${summary.candidates.length} passed=${summary.passed.length} dryRun=${settings.dryRun}`
      );
    }

    return {
      ...summary,
      detections: status.trackedDetections,
    };
  } catch (err) {
    status.totalErrors += 1;
    status.lastError = err.message;
    console.error('[PumpFunFast5xDryRun] Evaluation failed:', err.message);
    return null;
  }
}

function schedule() {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      await runOnce();
    } finally {
      schedule();
    }
  }, settings.intervalMs);
}

function start(options = {}) {
  if (running) return;
  settings = resolveOptions(options);
  status.enabled = settings.enabled;
  status.dryRun = settings.dryRun;

  if (!settings.enabled) {
    return;
  }
  if (!settings.dryRun) {
    status.lastError = 'alert_emission_not_implemented';
    console.warn('[PumpFunFast5xDryRun] Not started: alert emission is not implemented yet');
    return;
  }

  running = true;
  status.running = true;
  void runOnce();
  schedule();
  console.log(
    `[PumpFunFast5xDryRun] Started intervalMs=${settings.intervalMs} candidateLimit=${settings.candidateLimit} dryRun=${settings.dryRun}`
  );
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
  return {
    ...status,
    intervalMs: settings.intervalMs,
    candidateLimit: settings.candidateLimit,
    outcomeWindowMs: settings.outcomeWindowMs,
  };
}

function resetStatus() {
  stop();
  settings = {
    enabled: false,
    dryRun: true,
    intervalMs: DEFAULT_INTERVAL_MS,
    candidateLimit: 250,
    outcomeWindowMs: DEFAULT_OUTCOME_WINDOW_MS,
  };
  trackedDetections = new Map();
  persistedHydrated = false;
  status = {
    running: false,
    enabled: false,
    dryRun: true,
    lastRunAt: null,
    lastCandidateCount: 0,
    lastPassedCount: 0,
    lastFailedCount: 0,
    lastPassedCandidates: [],
    trackedDetectionCount: 0,
    trackedDetections: [],
    totalRuns: 0,
    totalCandidates: 0,
    totalPassed: 0,
    totalErrors: 0,
    lastError: null,
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  runOnce,
  evaluateOnce,
  __private: {
    resolveOptions,
    resetStatus,
    hydrateTrackedDetections,
    classifyPostAlertHold,
  },
};
