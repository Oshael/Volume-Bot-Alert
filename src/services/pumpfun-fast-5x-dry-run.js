const candidateBuilder = require('./pumpfun-fast-5x-candidates');
const { evaluatePumpfunFast5xSignal } = require('./pumpfun-fast-5x-signal');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const MAX_RECENT_PASSES = 20;

let timer = null;
let running = false;
let settings = {
  enabled: false,
  dryRun: true,
  intervalMs: DEFAULT_INTERVAL_MS,
  candidateLimit: 250,
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

  status.lastRunAt = new Date().toISOString();
  status.totalRuns += 1;

  try {
    const summary = await evaluateOnce(options);
    status.lastCandidateCount = summary.candidates.length;
    status.lastPassedCount = summary.passed.length;
    status.lastFailedCount = summary.failedCount;
    status.lastPassedCandidates = summary.passed.slice(0, MAX_RECENT_PASSES);
    status.totalCandidates += summary.candidates.length;
    status.totalPassed += summary.passed.length;
    status.lastError = null;

    if (summary.passed.length > 0) {
      console.log(
        `[PumpFunFast5xDryRun] candidates=${summary.candidates.length} passed=${summary.passed.length} dryRun=${settings.dryRun}`
      );
    }

    return summary;
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
  };
}

function resetStatus() {
  stop();
  settings = {
    enabled: false,
    dryRun: true,
    intervalMs: DEFAULT_INTERVAL_MS,
    candidateLimit: 250,
  };
  status = {
    running: false,
    enabled: false,
    dryRun: true,
    lastRunAt: null,
    lastCandidateCount: 0,
    lastPassedCount: 0,
    lastFailedCount: 0,
    lastPassedCandidates: [],
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
  },
};
