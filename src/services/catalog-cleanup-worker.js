const tokenCatalog = require('../models/token-catalog');

const LOOP_INTERVAL_MS = 60 * 60 * 1000;
const STALE_DAYS = 5;
const QUARANTINE_RECHECK_MS = 6 * 60 * 60 * 1000;
const SOFT_ARCHIVE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

let timer = null;
let running = false;
let status = {
  running: false,
  lastRunAt: null,
  archived: 0,
  quarantined: 0,
  lastSummary: null,
  totalArchived: 0,
  totalQuarantined: 0,
  totalErrors: 0,
};

async function runOnce() {
  if (!running) return;

  status.lastRunAt = new Date().toISOString();

  try {
    const summary = await tokenCatalog.applyAutomatedCleanup({
      staleDays: STALE_DAYS,
      quarantineRecheckMs: QUARANTINE_RECHECK_MS,
      softArchiveRecheckMs: SOFT_ARCHIVE_RECHECK_MS,
    });

    status.archived = summary.archived;
    status.quarantined = summary.quarantined;
    status.totalArchived += summary.archived;
    status.totalQuarantined += summary.quarantined;
    status.lastSummary = summary;

    console.log(
      `[CatalogCleanupWorker] Archived=${summary.archived} Quarantined=${summary.quarantined} staleDays=${summary.staleDays}`
    );
  } catch (err) {
    status.totalErrors += 1;
    console.error('[CatalogCleanupWorker] Cleanup failed:', err.message);
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
  }, LOOP_INTERVAL_MS);
}

function start() {
  if (running) return;
  running = true;
  status.running = true;
  void runOnce();
  schedule();
  console.log('[CatalogCleanupWorker] Started');
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
  start,
  stop,
  getStatus,
  runOnce,
};
