const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketBidZoneRun = require('../models/token-market-bid-zone-run');

const LOOP_INTERVAL_MS = 5 * 60 * 1000;
const MANUAL_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
const SNAPSHOT_RETENTION_MS = tokenMarketBidZoneRun.DEFAULT_RETENTION_MS;
const DEFAULT_OPTIONS = Object.freeze({
  hours: tokenMarketBidZoneRun.DEFAULT_REQUESTED_HOURS,
  minMcap: tokenMarketBidZoneRun.DEFAULT_MIN_MCAP,
  minVol1h: tokenMarketBidZoneRun.DEFAULT_MIN_VOL_1H,
  minVol24h: tokenMarketBidZoneRun.DEFAULT_MIN_VOL_24H,
  limit: 50,
  statementTimeoutMs: 15_000,
  candidateScanLimit: 400,
});

let timer = null;
let running = false;
let activeRunPromise = null;
let scheduledOptions = { ...DEFAULT_OPTIONS };
let manualRefreshCooldownUntil = 0;
let status = {
  running: false,
  inFlight: false,
  lastRunAt: null,
  lastCompletedAt: null,
  lastRunDurationMs: 0,
  lastRunId: null,
  lastRunStatus: null,
  lastRequestedHours: DEFAULT_OPTIONS.hours,
  lastMinMcap: DEFAULT_OPTIONS.minMcap,
  lastMinVol1h: DEFAULT_OPTIONS.minVol1h,
  lastMinVol24h: DEFAULT_OPTIONS.minVol24h,
  lastLimit: DEFAULT_OPTIONS.limit,
  lastStatementTimeoutMs: DEFAULT_OPTIONS.statementTimeoutMs,
  lastCandidateScanLimit: DEFAULT_OPTIONS.candidateScanLimit,
  lastCandidateCount: 0,
  lastResultCount: 0,
  totalRuns: 0,
  totalErrors: 0,
  lastCleanupAt: null,
  lastCleanupDeletedRuns: 0,
  lastManualTriggerAt: null,
  refreshAvailableAt: new Date(0).toISOString(),
};

function normalizeOptions(input = {}) {
  return {
    hours: Math.max(1, Math.min(Number(input.hours) || DEFAULT_OPTIONS.hours, 48)),
    minMcap: Math.max(DEFAULT_OPTIONS.minMcap, Number(input.minMcap) || DEFAULT_OPTIONS.minMcap),
    minVol1h: Math.max(0, Number(input.minVol1h) || DEFAULT_OPTIONS.minVol1h),
    minVol24h: Math.max(0, Number(input.minVol24h) || DEFAULT_OPTIONS.minVol24h),
    limit: Math.max(1, Math.min(Number(input.limit) || DEFAULT_OPTIONS.limit, 200)),
    statementTimeoutMs: Math.max(1000, Number(input.statementTimeoutMs) || DEFAULT_OPTIONS.statementTimeoutMs),
    candidateScanLimit: Math.max(50, Math.min(Number(input.candidateScanLimit) || DEFAULT_OPTIONS.candidateScanLimit, 5000)),
  };
}

function computeRefreshAvailableAt(now = Date.now()) {
  return new Date(Math.max(now, manualRefreshCooldownUntil)).toISOString();
}

function syncRefreshStatus(now = Date.now()) {
  status.refreshAvailableAt = computeRefreshAvailableAt(now);
}

function schedule() {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      await runOnce(scheduledOptions, { triggeredBy: 'worker', ifRunning: 'join' });
    } catch (err) {
      console.error('[BidZoneWorker] Scheduled run failed:', err.message);
    } finally {
      schedule();
    }
  }, LOOP_INTERVAL_MS);
}

async function cleanupExpiredSnapshots() {
  const deletedRuns = await tokenMarketBidZoneRun.cleanupExpiredRuns({ maxAgeMs: SNAPSHOT_RETENTION_MS });
  status.lastCleanupAt = new Date().toISOString();
  status.lastCleanupDeletedRuns = deletedRuns;
  return deletedRuns;
}

async function runOnce(options = {}, meta = {}) {
  const normalizedOptions = normalizeOptions(options);
  const ifRunning = String(meta.ifRunning || 'reject').trim().toLowerCase();
  if (activeRunPromise) {
    if (ifRunning === 'join') {
      return activeRunPromise;
    }
    throw new Error('Bid-zone worker already has an active run');
  }

  const notes = String(meta.notes || '').trim() || null;
  const triggeredBy = String(meta.triggeredBy || 'worker').trim().toLowerCase() || 'worker';

  activeRunPromise = (async () => {
    const startedAtMs = Date.now();
    let run = null;
    status.inFlight = true;
    status.lastRunAt = new Date(startedAtMs).toISOString();
    status.lastRunStatus = 'running';
    status.lastRequestedHours = normalizedOptions.hours;
    status.lastMinMcap = normalizedOptions.minMcap;
    status.lastMinVol1h = normalizedOptions.minVol1h;
    status.lastMinVol24h = normalizedOptions.minVol24h;
    status.lastLimit = normalizedOptions.limit;
    status.lastStatementTimeoutMs = normalizedOptions.statementTimeoutMs;
    status.lastCandidateScanLimit = normalizedOptions.candidateScanLimit;

    try {
      run = await tokenMarketBidZoneRun.startRun({
        requestedHours: normalizedOptions.hours,
        minMcap: normalizedOptions.minMcap,
        minVol1h: normalizedOptions.minVol1h,
        minVol24h: normalizedOptions.minVol24h,
        notes,
        triggeredBy,
      });
      const allCandidates = await tokenMarketBucket1m.computeBidZoneCandidates(normalizedOptions);
      const persistedCandidates = allCandidates.slice(0, normalizedOptions.limit);
      const completedRun = await tokenMarketBidZoneRun.completeRun(run.id, {
        candidateCount: allCandidates.length,
        candidates: persistedCandidates,
      });

      status.lastCompletedAt = completedRun?.completed_at || new Date().toISOString();
      status.lastRunDurationMs = Date.now() - startedAtMs;
      status.lastRunId = run.id;
      status.lastRunStatus = 'completed';
      status.lastCandidateCount = allCandidates.length;
      status.lastResultCount = persistedCandidates.length;
      status.totalRuns += 1;
      await cleanupExpiredSnapshots();
      syncRefreshStatus();

      return {
        runId: run.id,
        generatedAt: status.lastCompletedAt,
        requestedHours: normalizedOptions.hours,
        minMcap: normalizedOptions.minMcap,
        minVol1h: normalizedOptions.minVol1h,
        minVol24h: normalizedOptions.minVol24h,
        candidateCount: allCandidates.length,
        resultCount: persistedCandidates.length,
      };
    } catch (err) {
      status.lastRunDurationMs = Date.now() - startedAtMs;
      status.lastRunId = run?.id || null;
      status.lastRunStatus = 'failed';
      status.totalErrors += 1;
      await cleanupExpiredSnapshots().catch(() => null);
      syncRefreshStatus();
      if (run?.id) {
        await tokenMarketBidZoneRun.failRun(run.id, err.message).catch(() => null);
      }
      throw err;
    } finally {
      status.inFlight = false;
      activeRunPromise = null;
    }
  })();

  return activeRunPromise;
}

async function runManualRefresh(options = {}) {
  const now = Date.now();
  syncRefreshStatus(now);
  if (manualRefreshCooldownUntil > now) {
    return {
      accepted: false,
      refreshAvailableAt: status.refreshAvailableAt,
      retryAfterSeconds: Math.max(1, Math.ceil((manualRefreshCooldownUntil - now) / 1000)),
    };
  }

  manualRefreshCooldownUntil = now + MANUAL_REFRESH_COOLDOWN_MS;
  status.lastManualTriggerAt = new Date(now).toISOString();
  syncRefreshStatus(now);

  const result = await runOnce(options, {
    triggeredBy: 'manual',
    ifRunning: 'join',
  });

  return {
    accepted: true,
    refreshAvailableAt: status.refreshAvailableAt,
    retryAfterSeconds: Math.max(1, Math.ceil((manualRefreshCooldownUntil - Date.now()) / 1000)),
    result,
  };
}

function start(options = {}) {
  if (running) return;
  const normalizedOptions = normalizeOptions({ ...DEFAULT_OPTIONS, ...options });
  scheduledOptions = normalizedOptions;
  running = true;
  status.running = true;
  syncRefreshStatus();
  status.lastStatementTimeoutMs = normalizedOptions.statementTimeoutMs;
  status.lastCandidateScanLimit = normalizedOptions.candidateScanLimit;
  if (options.runOnStart === true) {
    void runOnce(normalizedOptions, { triggeredBy: 'worker', ifRunning: 'join' }).catch((err) => {
      console.error('[BidZoneWorker] Initial run failed:', err.message);
    });
  }
  schedule();
  console.log('[BidZoneWorker] Started');
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
  syncRefreshStatus();
  return {
    ...status,
    manualRefreshCooldownMs: MANUAL_REFRESH_COOLDOWN_MS,
    snapshotRetentionMs: SNAPSHOT_RETENTION_MS,
  };
}

module.exports = {
  DEFAULT_OPTIONS,
  LOOP_INTERVAL_MS,
  MANUAL_REFRESH_COOLDOWN_MS,
  SNAPSHOT_RETENTION_MS,
  getStatus,
  runManualRefresh,
  runOnce,
  start,
  stop,
  __private: {
    cleanupExpiredSnapshots,
    computeRefreshAvailableAt,
    normalizeOptions,
  },
};
