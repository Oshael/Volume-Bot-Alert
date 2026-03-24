const tokenCatalog = require('../models/token-catalog');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketSnapshot = require('../models/token-market-snapshot');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');

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
  totalDeletedMarketBuckets1m: 0,
  totalDeletedMarketSnapshots: 0,
  totalDeletedMeteoraSnapshots: 0,
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
    const archivedAddresses = Array.isArray(summary.archivedAddresses) ? summary.archivedAddresses : [];
    let deletedMarketBuckets1m = 0;
    let deletedMarketSnapshots = 0;
    let deletedMeteoraSnapshots = 0;

    if (archivedAddresses.length > 0) {
      [deletedMarketBuckets1m, deletedMarketSnapshots, deletedMeteoraSnapshots] = await Promise.all([
        tokenMarketBucket1m.deleteByAddresses(archivedAddresses),
        tokenMarketSnapshot.deleteByAddresses(archivedAddresses),
        tokenMeteoraSnapshot.deleteByAddresses(archivedAddresses),
      ]);
    }

    summary.deletedMarketBuckets1m = deletedMarketBuckets1m;
    summary.deletedMarketSnapshots = deletedMarketSnapshots;
    summary.deletedMeteoraSnapshots = deletedMeteoraSnapshots;

    status.archived = summary.archived;
    status.quarantined = summary.quarantined;
    status.totalArchived += summary.archived;
    status.totalQuarantined += summary.quarantined;
    status.totalDeletedMarketBuckets1m += deletedMarketBuckets1m;
    status.totalDeletedMarketSnapshots += deletedMarketSnapshots;
    status.totalDeletedMeteoraSnapshots += deletedMeteoraSnapshots;
    status.lastSummary = summary;

    console.log(
      `[CatalogCleanupWorker] Archived=${summary.archived} Quarantined=${summary.quarantined} deletedMarketBuckets1m=${deletedMarketBuckets1m} deletedMarketSnapshots=${deletedMarketSnapshots} deletedMeteoraSnapshots=${deletedMeteoraSnapshots} staleDays=${summary.staleDays}`
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
