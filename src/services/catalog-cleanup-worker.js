const tokenCatalog = require('../models/token-catalog');
const adminBlockedToken = require('../models/admin-blocked-token');
const tokenMarketBucket1m = require('../models/token-market-bucket-1m');
const tokenMarketVolumeBucket1m = require('../models/token-market-volume-bucket-1m');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');
const workerRuntimeState = require('../models/worker-runtime-state');

function readIntEnv(name, fallback, min, max) {
  const parsed = Math.trunc(Number(process.env[name]));
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(parsed, max));
}

const QUARANTINE_LOOP_INTERVAL_MS = 15 * 60 * 1000;
const ARCHIVE_LOOP_INTERVAL_MS = 48 * 60 * 60 * 1000;
const BLOCKED_ARTIFACT_LOOP_INTERVAL_MS = readIntEnv(
  'CATALOG_CLEANUP_BLOCKED_ARTIFACT_INTERVAL_MS',
  15 * 60 * 1000,
  10 * 1000,
  60 * 60 * 1000
);
const BLOCKED_ARTIFACT_IDLE_INTERVAL_MS = readIntEnv(
  'CATALOG_CLEANUP_BLOCKED_ARTIFACT_IDLE_INTERVAL_MS',
  60 * 60 * 1000,
  60 * 1000,
  24 * 60 * 60 * 1000
);
const ARCHIVE_LIMIT = 400;
const BLOCKED_ARTIFACT_ADDRESS_LIMIT = readIntEnv('CATALOG_CLEANUP_BLOCKED_ARTIFACT_ADDRESS_LIMIT', 1, 1, 25);
const BLOCKED_ARTIFACT_CHUNK_LIMIT = readIntEnv('CATALOG_CLEANUP_BLOCKED_ARTIFACT_CHUNK_LIMIT', 250, 25, 1000);
const BLOCKED_ARTIFACT_STATEMENT_TIMEOUT_MS = readIntEnv(
  'CATALOG_CLEANUP_BLOCKED_ARTIFACT_STATEMENT_TIMEOUT_MS',
  2000,
  250,
  30 * 1000
);
const BLOCKED_ARTIFACT_MIN_BLOCKED_AGE_MS = 24 * 60 * 60 * 1000;
const QUARANTINE_RECHECK_MS = 6 * 60 * 60 * 1000;
const SOFT_ARCHIVE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const ARCHIVE_STATE_KEY = 'catalog_cleanup_soft_archive_last_run_at';

let quarantineTimer = null;
let archiveTimer = null;
let blockedArtifactTimer = null;
let running = false;
let status = {
  running: false,
  lastQuarantineRunAt: null,
  lastArchiveRunAt: null,
  lastBlockedArtifactRunAt: null,
  persistedArchiveAnchorAt: null,
  nextArchiveRunAt: null,
  nextBlockedArtifactRunAt: null,
  archived: 0,
  quarantined: 0,
  blockedArtifactTokens: 0,
  lastQuarantineSummary: null,
  lastArchiveSummary: null,
  lastBlockedArtifactSummary: null,
  totalArchived: 0,
  totalQuarantined: 0,
  totalDeletedMarketBuckets1m: 0,
  totalDeletedMarketVolumeBuckets1m: 0,
  totalDeletedMeteoraSnapshots: 0,
  totalBlockedArtifactTokens: 0,
  totalDeletedBlockedMarketBuckets1m: 0,
  totalDeletedBlockedMarketBucketsAgg: 0,
  totalDeletedBlockedMarketVolumeBuckets1m: 0,
  totalDeletedBlockedMeteoraSnapshots: 0,
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

function computeBlockedArtifactDelayMs(summary = null) {
  return summary?.blockedArtifactTokens > 0
    ? BLOCKED_ARTIFACT_LOOP_INTERVAL_MS
    : BLOCKED_ARTIFACT_IDLE_INTERVAL_MS;
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
    let deletedMarketVolumeBuckets1m = 0;
    let deletedMeteoraSnapshots = 0;

    if (archivedAddresses.length > 0) {
      [deletedMarketBuckets1m, deletedMarketVolumeBuckets1m, deletedMeteoraSnapshots] = await Promise.all([
        tokenMarketBucket1m.deleteByAddresses(archivedAddresses),
        tokenMarketVolumeBucket1m.deleteByAddresses(archivedAddresses, 'solana'),
        tokenMeteoraSnapshot.deleteByAddresses(archivedAddresses),
      ]);
    }

    summary.deletedMarketBuckets1m = deletedMarketBuckets1m;
    summary.deletedMarketVolumeBuckets1m = deletedMarketVolumeBuckets1m;
    summary.deletedMeteoraSnapshots = deletedMeteoraSnapshots;

    status.archived = summary.archived;
    status.totalArchived += summary.archived;
    status.totalDeletedMarketBuckets1m += deletedMarketBuckets1m;
    status.totalDeletedMarketVolumeBuckets1m += deletedMarketVolumeBuckets1m;
    status.totalDeletedMeteoraSnapshots += deletedMeteoraSnapshots;
    status.lastArchiveSummary = summary;

    const persisted = await workerRuntimeState.setLastRunAt(ARCHIVE_STATE_KEY, startedAt);
    status.persistedArchiveAnchorAt = toIsoStringOrNull(persisted?.last_run_at) || startedAt.toISOString();
    status.nextArchiveRunAt = new Date(startedAt.getTime() + ARCHIVE_LOOP_INTERVAL_MS).toISOString();

    console.log(
      `[CatalogCleanupWorker] Archived=${summary.archived} deletedMarketBuckets1m=${deletedMarketBuckets1m} deletedMarketVolumeBuckets1m=${deletedMarketVolumeBuckets1m} deletedMeteoraSnapshots=${deletedMeteoraSnapshots} archiveLimit=${summary.archiveLimit} loop=archive intervalMs=${ARCHIVE_LOOP_INTERVAL_MS}`
    );
  } catch (err) {
    status.totalErrors += 1;
    console.error('[CatalogCleanupWorker] Soft archive cleanup failed:', err.message);
  }
}

async function deleteBlockedArtifactsForAddresses(addresses) {
  const blockedAddresses = Array.isArray(addresses) ? addresses : [];
  if (!blockedAddresses.length) {
    return {
      blockedArtifactTokens: 0,
      deletedMarketBucketsAgg: 0,
      deletedMarketBuckets1m: 0,
      deletedMarketVolumeBuckets1m: 0,
      deletedMeteoraSnapshots: 0,
    };
  }

  let deletedMarketBucketsAgg = 0;
  let deletedMarketBuckets1m = 0;
  let deletedMarketVolumeBuckets1m = 0;
  let deletedMeteoraSnapshots = 0;
  const options = {
    chain: 'solana',
    limit: BLOCKED_ARTIFACT_CHUNK_LIMIT,
    statementTimeoutMs: BLOCKED_ARTIFACT_STATEMENT_TIMEOUT_MS,
  };

  for (const address of blockedAddresses) {
    const marketSummary = await tokenMarketBucket1m.deleteChunkByAddress(address, options);
    deletedMarketBucketsAgg += marketSummary.deletedMarketBucketsAgg || 0;
    deletedMarketBuckets1m += marketSummary.deletedMarketBuckets1m || 0;
    deletedMarketVolumeBuckets1m += await tokenMarketVolumeBucket1m.deleteChunkByAddress(address, options);
    deletedMeteoraSnapshots += await tokenMeteoraSnapshot.deleteChunkByAddress(address, options);
  }

  return {
    blockedArtifactTokens: blockedAddresses.length,
    deletedMarketBucketsAgg,
    deletedMarketBuckets1m,
    deletedMarketVolumeBuckets1m,
    deletedMeteoraSnapshots,
  };
}

async function runBlockedArtifactCleanupOnce() {
  if (!running) return;

  status.lastBlockedArtifactRunAt = new Date().toISOString();

  try {
    const blockedAddresses = await adminBlockedToken.listAddressesWithCleanupArtifacts(BLOCKED_ARTIFACT_ADDRESS_LIMIT, {
      minBlockedAgeMs: BLOCKED_ARTIFACT_MIN_BLOCKED_AGE_MS,
    });
    const summary = await deleteBlockedArtifactsForAddresses(blockedAddresses);

    status.blockedArtifactTokens = summary.blockedArtifactTokens;
    status.totalBlockedArtifactTokens += summary.blockedArtifactTokens;
    status.totalDeletedBlockedMarketBuckets1m += summary.deletedMarketBuckets1m;
    status.totalDeletedBlockedMarketBucketsAgg += summary.deletedMarketBucketsAgg;
    status.totalDeletedBlockedMarketVolumeBuckets1m += summary.deletedMarketVolumeBuckets1m;
    status.totalDeletedBlockedMeteoraSnapshots += summary.deletedMeteoraSnapshots;
    status.lastBlockedArtifactSummary = summary;

    if (summary.blockedArtifactTokens > 0) {
      console.log(
        `[CatalogCleanupWorker] BlockedArtifactTokens=${summary.blockedArtifactTokens} deletedMarketBucketsAgg=${summary.deletedMarketBucketsAgg} deletedMarketBuckets1m=${summary.deletedMarketBuckets1m} deletedMarketVolumeBuckets1m=${summary.deletedMarketVolumeBuckets1m} deletedMeteoraSnapshots=${summary.deletedMeteoraSnapshots} addressLimit=${BLOCKED_ARTIFACT_ADDRESS_LIMIT} chunkLimit=${BLOCKED_ARTIFACT_CHUNK_LIMIT} statementTimeoutMs=${BLOCKED_ARTIFACT_STATEMENT_TIMEOUT_MS} loop=blocked-artifacts intervalMs=${BLOCKED_ARTIFACT_LOOP_INTERVAL_MS}`
      );
    }
  } catch (err) {
    status.totalErrors += 1;
    console.error('[CatalogCleanupWorker] Blocked token artifact cleanup failed:', err.message);
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

function scheduleBlockedArtifactCleanup() {
  if (!running) return;
  const delayMs = computeBlockedArtifactDelayMs(status.lastBlockedArtifactSummary);
  status.nextBlockedArtifactRunAt = new Date(Date.now() + delayMs).toISOString();
  blockedArtifactTimer = setTimeout(async () => {
    try {
      await runBlockedArtifactCleanupOnce();
    } finally {
      scheduleBlockedArtifactCleanup();
    }
  }, delayMs);
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
  void runBlockedArtifactCleanupOnce();
  scheduleQuarantine();
  scheduleBlockedArtifactCleanup();
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
  if (blockedArtifactTimer) {
    clearTimeout(blockedArtifactTimer);
    blockedArtifactTimer = null;
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
  runBlockedArtifactCleanupOnce,
  __private: {
    computeArchiveDelayMs,
    computeBlockedArtifactDelayMs,
    deleteBlockedArtifactsForAddresses,
    toIsoStringOrNull,
  },
};
