const tokenCatalog = require('../models/token-catalog');
const tokenMeteoraState = require('../models/token-meteora-state');
const tokenRiskReview = require('../models/token-risk-review');
const { classifyTokenJunk } = require('./token-junk-metric');

const LOOP_INTERVAL_MS = 60 * 1000;
const DEFAULT_SCAN_LIMIT = 200;
const DEFAULT_MIN_MCAP = 30000;

let timer = null;
let running = false;
let activeRunPromise = null;
let nextOffset = 0;
let status = {
  running: false,
  inFlight: false,
  lastRunAt: null,
  lastCompletedAt: null,
  lastRunDurationMs: 0,
  lastScheduledDelayMs: LOOP_INTERVAL_MS,
  lastScanLimit: DEFAULT_SCAN_LIMIT,
  lastMinMcap: DEFAULT_MIN_MCAP,
  lastOffset: 0,
  nextOffset,
  lastCandidateCount: 0,
  lastProcessed: 0,
  lastSaved: 0,
  lastManualProtected: 0,
  totalProcessed: 0,
  totalSaved: 0,
  totalManualProtected: 0,
  totalErrors: 0,
  lastError: null,
};

function normalizeLimit(value, fallback, max = 5000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(parsed), max));
}

function normalizeOptions(options = {}) {
  return {
    scanLimit: normalizeLimit(options.scanLimit, DEFAULT_SCAN_LIMIT),
    minMcap: Math.max(0, Number(options.minMcap) || DEFAULT_MIN_MCAP),
  };
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

function buildMeteoraMetric(summaryRow) {
  const hasPool = summaryRow?.hasPool === true && (Number(summaryRow?.currentTvl) || 0) > 0;
  return {
    noPool: !hasPool,
    poolCount: hasPool ? (Number(summaryRow?.poolCount) || 0) : 0,
    tvl: hasPool ? (Number(summaryRow?.currentTvl) || 0) : null,
  };
}

function normalizeAutoLabel(assessment) {
  const label = String(assessment?.label || '').trim().toLowerCase();
  if (!label) {
    return null;
  }
  return label === 'junk_permanent' ? 'junk_probable' : label;
}

function hasStructuralCoverage(row) {
  return Boolean(
    row?.risk_enrichment_last_enriched_at
    || row?.risk_holder_count != null
    || row?.risk_top_10_pct != null
    || row?.risk_top_20_pct != null
    || row?.risk_mint_authority_active
    || row?.risk_freeze_authority_active
  );
}

function normalizePersistedAutoLabel(row, assessment) {
  const label = normalizeAutoLabel(assessment);
  if (!label) {
    return null;
  }

  if (label === 'valid' && !hasStructuralCoverage(row)) {
    return 'valid_but_weak';
  }

  return label;
}

function buildAutoNotes(assessment) {
  const mode = String(assessment?.mode || 'auto').trim() || 'auto';
  const reasonCodes = Array.isArray(assessment?.reasonCodes)
    ? assessment.reasonCodes.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  if (!reasonCodes.length) {
    return `auto/${mode}`;
  }

  return `auto/${mode}: ${reasonCodes.join(', ')}`;
}

async function listCandidates(offset, options, deps = {}) {
  const catalogModel = deps.tokenCatalogModel || tokenCatalog;
  const rows = await catalogModel.listAutoRiskReviewCandidates(options.scanLimit, offset, options.minMcap);
  if (rows.length === 0 && offset > 0) {
    nextOffset = 0;
    return catalogModel.listAutoRiskReviewCandidates(options.scanLimit, 0, options.minMcap);
  }
  return rows;
}

async function processRows(rows = [], deps = {}) {
  const meteoraModel = deps.tokenMeteoraStateModel || tokenMeteoraState;
  const reviewModel = deps.tokenRiskReviewModel || tokenRiskReview;
  const addresses = rows.map((row) => row.address).filter(Boolean);
  const meteoraRows = await meteoraModel.listSummaryByAddresses(addresses);
  const meteoraByAddress = new Map(meteoraRows.map((row) => [String(row.tokenAddress || row.token_address), row]));

  let saved = 0;
  let manualProtected = 0;

  for (const row of rows) {
    const assessment = classifyTokenJunk({
      ...row,
      meteora: buildMeteoraMetric(meteoraByAddress.get(row.address) || null),
    });

    const label = normalizePersistedAutoLabel(row, assessment);
    if (!label) {
      continue;
    }

    const review = await reviewModel.upsertAutoReview({
      tokenAddress: row.address,
      label,
      notes: buildAutoNotes(assessment),
    });

    if (review?.source === 'manual') {
      manualProtected += 1;
      continue;
    }

    saved += 1;
  }

  return { saved, manualProtected };
}

function schedule(options = {}) {
  if (!running) return;
  timer = setTimeout(async () => {
    try {
      await runOnce(options, { ifRunning: 'join' });
    } catch (err) {
      console.error('[TokenRiskReviewSyncWorker] Scheduled run failed:', err.message);
    } finally {
      schedule(options);
    }
  }, LOOP_INTERVAL_MS);
}

async function runOnce(options = {}, meta = {}, deps = {}) {
  const normalizedOptions = normalizeOptions(options);
  const ifRunning = String(meta.ifRunning || 'reject').trim().toLowerCase();

  if (activeRunPromise) {
    if (ifRunning === 'join') {
      return activeRunPromise;
    }
    throw new Error('Token risk review sync worker already has an active run');
  }

  activeRunPromise = (async () => {
    const startedAtMs = Date.now();
    const offset = nextOffset;

    status.inFlight = true;
    status.lastRunAt = new Date(startedAtMs).toISOString();
    status.lastScanLimit = normalizedOptions.scanLimit;
    status.lastMinMcap = normalizedOptions.minMcap;
    status.lastOffset = offset;
    status.lastProcessed = 0;
    status.lastSaved = 0;
    status.lastManualProtected = 0;
    status.lastError = null;

    try {
      const rows = await listCandidates(offset, normalizedOptions, deps);
      const result = await processRows(rows, deps);

      nextOffset = rows.length < normalizedOptions.scanLimit
        ? 0
        : offset + rows.length;

      status.nextOffset = nextOffset;
      status.lastCandidateCount = rows.length;
      status.lastProcessed = rows.length;
      status.lastSaved = result.saved;
      status.lastManualProtected = result.manualProtected;
      status.totalProcessed += rows.length;
      status.totalSaved += result.saved;
      status.totalManualProtected += result.manualProtected;
      status.lastCompletedAt = new Date().toISOString();
      status.lastRunDurationMs = Date.now() - startedAtMs;
      status.lastScheduledDelayMs = computeNextDelayMs(status.lastRunDurationMs);

      return {
        startedAt: status.lastRunAt,
        completedAt: status.lastCompletedAt,
        candidateCount: rows.length,
        processed: rows.length,
        saved: result.saved,
        manualProtected: result.manualProtected,
        nextOffset,
      };
    } catch (error) {
      status.totalErrors += 1;
      status.lastError = String(error?.message || error || 'Unknown worker error');
      throw error;
    } finally {
      status.inFlight = false;
      activeRunPromise = null;
    }
  })();

  return activeRunPromise;
}

function start(options = {}) {
  if (running) return;
  running = true;
  status.running = true;
  nextOffset = 0;
  status.nextOffset = nextOffset;
  schedule(options);
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
    nextOffset,
  };
}

module.exports = {
  LOOP_INTERVAL_MS,
  DEFAULT_SCAN_LIMIT,
  DEFAULT_MIN_MCAP,
  getStatus,
  runOnce,
  start,
  stop,
  __private: {
    buildAutoNotes,
    buildMeteoraMetric,
    hasStructuralCoverage,
    listCandidates,
    normalizeAutoLabel,
    normalizePersistedAutoLabel,
    normalizeOptions,
    processRows,
  },
};
