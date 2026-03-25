const tokenCatalog = require('../models/token-catalog');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketSnapshot = require('../models/token-market-snapshot');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');
const workerRuntimeState = require('../models/worker-runtime-state');

const QUARANTINE_LOOP_INTERVAL_MS = 15 * 60 * 1000;
const ARCHIVE_LOOP_INTERVAL_MS = 48 * 60 * 60 * 1000;
const ARCHIVE_LIMIT = 400;
const QUARANTINE_RECHECK_MS = 6 * 60 * 60 * 1000;
const SOFT_ARCHIVE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const ARCHIVE_STATE_KEY = 'catalog_cleanup_soft_archive_last_run_at';

let quarantineTimer = null;
let archiveTimer = null;
let running = false;
let status = {
  running: false,
  lastQuarantineRunAt: null,
  lastArchiveRunAt: null,
  persistedArchiveAnchorAt: null,
  nextArchiveRunAt: null,
  archived: 0,
  quarantined: 0,
  lastQuarantineSummary: null,
  lastArchiveSummary: null,
  totalArchived: 0,
  totalQuarantined: 0,
  totalDeletedMarketBuckets1m: 0,
  totalDeletedMarketSnapshots: 0,
  totalDeletedMeteoraSnapshots: 0,
  totalErrors: 0,
};

function toIsoStringOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function computeArchiveDelayMs(lastRunAt, nowMs = Date.now()) {
  if (!lastRunAt) {
    return ARCHIVE_LOOP_INTERVAL_MS;
  }

  const lastRunMs = lastRunAt instanceof Date ? lastRunAt.getTime() : new Date(lastRunAt).getTime();
  if (!Number.isFinite(lastRunMs)) {
    return ARCHIVE_LOOP_INTERVAL_MS;
  }

  return Math.max(0, ARCHIVE_LOOP_INTERVAL_MS - Math.max(0, nowMs - lastRunMs));
}

async function runQuarantineOnce() {
  if (!running) return;

  status.lastQuarantineRunAt = new Date().toISOString();

  try {
    const summary = await tokenCatalog.applyQuarantineCleanup({
      quarantineRecheckMs: QUARANTINE_RECHECK_MS,
    });
    status.quarantined = summary.quarantined;
    status.totalQuarantined += summary.quarantined;
    status.lastQuarantineSummary = summary;

    console.log(
      `[CatalogCleanupWorker] Quarantined=${summary.quarantined} loop=quarantine intervalMs=${QUARANTINE_LOOP_INTERVAL_MS}`
    );
  } catch (err) {
    status.totalErrors += 1;
    console.error('[CatalogCleanupWorker] Quarantine cleanup failed:', err.message);
  }
}

async function runArchiveOnce() {
  if (!running) return;

  const startedAt = new Date();
  status.lastArchiveRunAt = startedAt.toISOString();

  try {
    const summary = await tokenCatalog.applySoftArchiveCleanup({
      archiveLimit: ARCHIVE_LIMIT,
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
    status.totalArchived += summary.archived;
    status.totalDeletedMarketBuckets1m += deletedMarketBuckets1m;
    status.totalDeletedMarketSnapshots += deletedMarketSnapshots;
    status.totalDeletedMeteoraSnapshots += deletedMeteoraSnapshots;
    status.lastArchiveSummary = summary;

    const persisted = await workerRuntimeState.setLastRunAt(ARCHIVE_STATE_KEY, startedAt);
    status.persistedArchiveAnchorAt = toIsoStringOrNull(persisted?.last_run_at) || startedAt.toISOString();
    status.nextArchiveRunAt = new Date(startedAt.getTime() + ARCHIVE_LOOP_INTERVAL_MS).toISOString();

    console.log(
      `[CatalogCleanupWorker] Archived=${summary.archived} deletedMarketBuckets1m=${deletedMarketBuckets1m} deletedMarketSnapshots=${deletedMarketSnapshots} deletedMeteoraSnapshots=${deletedMeteoraSnapshots} archiveLimit=${summary.archiveLimit} loop=archive intervalMs=${ARCHIVE_LOOP_INTERVAL_MS}`
    );
  } catch (err) {
    status.totalErrors += 1;
    console.error('[CatalogCleanupWorker] Soft archive cleanup failed:', err.message);
  }
}

function scheduleQuarantine() {
  if (!running) return;
  quarantineTimer = setTimeout(async () => {
    try {
      await runQuarantineOnce();
    } finally {
      scheduleQuarantine();
    }
  }, QUARANTINE_LOOP_INTERVAL_MS);
}

function scheduleArchive() {
  if (!running) return;
  scheduleArchiveIn(ARCHIVE_LOOP_INTERVAL_MS);
}

function scheduleArchiveIn(delayMs) {
  if (!running) return;
  const safeDelayMs = Math.max(0, Number(delayMs) || 0);
  status.nextArchiveRunAt = new Date(Date.now() + safeDelayMs).toISOString();
  archiveTimer = setTimeout(async () => {
    try {
      await runArchiveOnce();
    } finally {
      scheduleArchive();
    }
  }, safeDelayMs);
}

async function initializeArchiveSchedule() {
  await workerRuntimeState.ensureTable();
  let persistedAnchor = await workerRuntimeState.getLastRunAt(ARCHIVE_STATE_KEY);

  if (!persistedAnchor) {
    const anchored = await workerRuntimeState.setLastRunAt(ARCHIVE_STATE_KEY, new Date());
    persistedAnchor = anchored?.last_run_at || null;
  }

  status.persistedArchiveAnchorAt = toIsoStringOrNull(persistedAnchor);
  const delayMs = computeArchiveDelayMs(persistedAnchor);
  scheduleArchiveIn(delayMs);
}

function start() {
  if (running) return;
  running = true;
  status.running = true;
  void runQuarantineOnce();
  scheduleQuarantine();
  void initializeArchiveSchedule().catch((err) => {
    status.totalErrors += 1;
    console.error('[CatalogCleanupWorker] Archive schedule initialization failed:', err.message);
    scheduleArchive();
  });
  console.log('[CatalogCleanupWorker] Started');
}

function stop() {
  running = false;
  status.running = false;
  if (quarantineTimer) {
    clearTimeout(quarantineTimer);
    quarantineTimer = null;
  }
  if (archiveTimer) {
    clearTimeout(archiveTimer);
    archiveTimer = null;
  }
}

function getStatus() {
  return { ...status };
}

module.exports = {
  start,
  stop,
  getStatus,
  runQuarantineOnce,
  runArchiveOnce,
  __private: {
    computeArchiveDelayMs,
    toIsoStringOrNull,
  },
};
