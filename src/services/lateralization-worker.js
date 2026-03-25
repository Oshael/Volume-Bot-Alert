const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketLateralizationRun = require('../models/token-market-lateralization-run');

const LOOP_INTERVAL_MS = 20 * 60 * 1000;
const DEFAULT_OPTIONS = Object.freeze({
  hours: 6,
  minMcap: 90_000,
  minVol24h: 10_000,
  limit: 50,
});

let timer = null;
let running = false;
let activeRunPromise = null;
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
  lastMinVol24h: DEFAULT_OPTIONS.minVol24h,
  lastLimit: DEFAULT_OPTIONS.limit,
  lastCandidateCount: 0,
  lastResultCount: 0,
  totalRuns: 0,
  totalErrors: 0,
};

function normalizeOptions(input = {}) {
  return {
    hours: Math.max(1, Math.min(Number(input.hours) || DEFAULT_OPTIONS.hours, 48)),
    minMcap: Math.max(DEFAULT_OPTIONS.minMcap, Number(input.minMcap) || DEFAULT_OPTIONS.minMcap),
    minVol24h: Math.max(0, Number(input.minVol24h) || DEFAULT_OPTIONS.minVol24h),
    limit: Math.max(1, Math.min(Number(input.limit) || DEFAULT_OPTIONS.limit, 200)),
  };
}

function schedule() {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      await runOnce(DEFAULT_OPTIONS, { triggeredBy: 'worker', ifRunning: 'join' });
    } catch (err) {
      console.error('[LateralizationWorker] Scheduled run failed:', err.message);
    } finally {
      schedule();
    }
  }, LOOP_INTERVAL_MS);
}

async function runOnce(options = {}, meta = {}) {
  const normalizedOptions = normalizeOptions(options);
  const ifRunning = String(meta.ifRunning || 'reject').trim().toLowerCase();
  if (activeRunPromise) {
    if (ifRunning === 'join') {
      return activeRunPromise;
    }
    throw new Error('Lateralization worker already has an active run');
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
    status.lastMinVol24h = normalizedOptions.minVol24h;
    status.lastLimit = normalizedOptions.limit;

    try {
      run = await tokenMarketLateralizationRun.startRun({
        requestedHours: normalizedOptions.hours,
        minMcap: normalizedOptions.minMcap,
        minVol24h: normalizedOptions.minVol24h,
        notes,
        triggeredBy,
      });
      const allCandidates = await tokenMarketBucket1m.computeLateralizedCandidates(normalizedOptions);
      const persistedCandidates = allCandidates.slice(0, normalizedOptions.limit);
      const completedRun = await tokenMarketLateralizationRun.completeRun(run.id, {
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

      return {
        runId: run.id,
        generatedAt: status.lastCompletedAt,
        requestedHours: normalizedOptions.hours,
        minMcap: normalizedOptions.minMcap,
        minVol24h: normalizedOptions.minVol24h,
        candidateCount: allCandidates.length,
        resultCount: persistedCandidates.length,
      };
    } catch (err) {
      status.lastRunDurationMs = Date.now() - startedAtMs;
      status.lastRunId = run?.id || null;
      status.lastRunStatus = 'failed';
      status.totalErrors += 1;
      if (run?.id) {
        await tokenMarketLateralizationRun.failRun(run.id, err.message).catch(() => null);
      }
      throw err;
    } finally {
      status.inFlight = false;
      activeRunPromise = null;
    }
  })();

  return activeRunPromise;
}

function start() {
  if (running) return;
  running = true;
  status.running = true;
  void runOnce(DEFAULT_OPTIONS, { triggeredBy: 'worker', ifRunning: 'join' }).catch((err) => {
    console.error('[LateralizationWorker] Initial run failed:', err.message);
  });
  schedule();
  console.log('[LateralizationWorker] Started');
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
  runOnce,
  start,
  stop,
  __private: {
    normalizeOptions,
  },
};
