const tokenCatalog = require('../models/token-catalog');
const db = require('../models/db');
const tokenMeteoraState = require('../models/token-meteora-state');
const tokenMeteoraSnapshot = require('../models/token-meteora-snapshot');
const meteora = require('./meteora');

const LOOP_INTERVAL_MS = 20 * 1000;
const MAX_TOKENS_PER_MINUTE = 800;
const MAX_BATCH_LIMIT = Math.ceil((MAX_TOKENS_PER_MINUTE * LOOP_INTERVAL_MS) / 60000);
const TARGET_REFRESH_MS_BY_TIER = {
  high: 30 * 1000,
  normal: 60 * 1000,
  low: 5 * 60 * 1000,
};
const PRIORITY_TIERS = ['high', 'normal', 'low'];

let timer = null;
let running = false;
let status = {
  running: false,
  lastRunAt: null,
  lastCompletedAt: null,
  lastRunDurationMs: 0,
  lastLoopOverrunMs: 0,
  lastScheduledDelayMs: LOOP_INTERVAL_MS,
  lastUniverseCount: 0,
  lastBatchLimit: 0,
  lastUniverseCountByTier: { high: 0, normal: 0, low: 0 },
  lastTargetChecksPerMinuteByTier: { high: 0, normal: 0, low: 0 },
  lastEffectiveChecksPerMinuteByTier: { high: 0, normal: 0, low: 0 },
  lastTargetChecksPerCycleByTier: { high: 0, normal: 0, low: 0 },
  lastSelectedCountByTier: { high: 0, normal: 0, low: 0 },
  lastBudgetDegraded: false,
  lastDegradedTiers: [],
  lastProcessed: 0,
  totalProcessed: 0,
  totalInserted: 0,
  totalErrors: 0,
};

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

function computeDynamicBatchLimit(universeCount) {
  const safeUniverseCount = Math.max(0, Math.trunc(Number(universeCount) || 0));
  if (safeUniverseCount <= 0) {
    return 0;
  }

  const cappedTokensPerMinute = Math.min(safeUniverseCount, MAX_TOKENS_PER_MINUTE);
  return Math.max(
    1,
    Math.min(
      MAX_BATCH_LIMIT,
      Math.ceil((cappedTokensPerMinute * LOOP_INTERVAL_MS) / 60000)
    )
  );
}

function emptyTierCounts() {
  return {
    high: 0,
    normal: 0,
    low: 0,
  };
}

function normalizeTierCounts(counts = {}) {
  const normalized = emptyTierCounts();

  for (const tier of PRIORITY_TIERS) {
    normalized[tier] = Math.max(0, Math.trunc(Number(counts?.[tier]) || 0));
  }

  return normalized;
}

function computeTargetChecksPerMinuteByTier(universeByTier = {}) {
  const normalizedUniverse = normalizeTierCounts(universeByTier);
  const targetChecksPerMinuteByTier = emptyTierCounts();

  for (const tier of PRIORITY_TIERS) {
    const targetRefreshMs = Number(TARGET_REFRESH_MS_BY_TIER[tier]) || 0;
    if (targetRefreshMs <= 0) {
      continue;
    }
    targetChecksPerMinuteByTier[tier] = normalizedUniverse[tier] * (60000 / targetRefreshMs);
  }

  return targetChecksPerMinuteByTier;
}

function computeTierBudgetPlan(universeByTier = {}, maxTokensPerMinute = MAX_TOKENS_PER_MINUTE) {
  const normalizedUniverse = normalizeTierCounts(universeByTier);
  const targetChecksPerMinuteByTier = computeTargetChecksPerMinuteByTier(normalizedUniverse);
  const effectiveChecksPerMinuteByTier = emptyTierCounts();
  const targetChecksPerCycleByTier = emptyTierCounts();
  const degradedTiers = [];
  let remainingBudget = Math.max(0, Number(maxTokensPerMinute) || 0);

  for (const tier of PRIORITY_TIERS) {
    const targetChecksPerMinute = Math.max(0, Number(targetChecksPerMinuteByTier[tier]) || 0);
    const effectiveChecksPerMinute = Math.min(remainingBudget, targetChecksPerMinute);
    effectiveChecksPerMinuteByTier[tier] = effectiveChecksPerMinute;
    targetChecksPerCycleByTier[tier] = effectiveChecksPerMinute <= 0
      ? 0
      : Math.max(1, Math.ceil((effectiveChecksPerMinute * LOOP_INTERVAL_MS) / 60000));

    if (effectiveChecksPerMinute + 1e-9 < targetChecksPerMinute) {
      degradedTiers.push(tier);
    }

    remainingBudget = Math.max(0, remainingBudget - effectiveChecksPerMinute);
  }

  const totalTargetChecksPerMinute = PRIORITY_TIERS.reduce(
    (sum, tier) => sum + (Number(targetChecksPerMinuteByTier[tier]) || 0),
    0
  );
  const totalEffectiveChecksPerMinute = PRIORITY_TIERS.reduce(
    (sum, tier) => sum + (Number(effectiveChecksPerMinuteByTier[tier]) || 0),
    0
  );
  const totalTargetChecksPerCycle = PRIORITY_TIERS.reduce(
    (sum, tier) => sum + (Number(targetChecksPerCycleByTier[tier]) || 0),
    0
  );

  return {
    universeByTier: normalizedUniverse,
    targetChecksPerMinuteByTier,
    effectiveChecksPerMinuteByTier,
    targetChecksPerCycleByTier,
    totalTargetChecksPerMinute,
    totalEffectiveChecksPerMinute,
    totalTargetChecksPerCycle,
    degraded: degradedTiers.length > 0,
    degradedTiers,
    remainingBudget,
  };
}

function buildTierDueCutoff(checkedAt, tier) {
  const checkedDate = checkedAt instanceof Date ? checkedAt : new Date(checkedAt);
  if (!Number.isFinite(checkedDate.getTime())) {
    return null;
  }

  const refreshMs = Number(TARGET_REFRESH_MS_BY_TIER[tier]) || 0;
  if (refreshMs <= 0) {
    return null;
  }

  return new Date(checkedDate.getTime() - refreshMs);
}

async function selectCycleTokens(batchLimit, targetChecksPerCycleByTier, checkedAt) {
  const selectedTokens = [];
  const selectedCountByTier = emptyTierCounts();
  const normalizedTargets = normalizeTierCounts(targetChecksPerCycleByTier);
  let remainingCapacity = Math.max(0, Math.trunc(Number(batchLimit) || 0));
  let carryoverSlots = 0;

  for (const tier of PRIORITY_TIERS) {
    if (remainingCapacity <= 0) {
      break;
    }

    const tierTarget = normalizedTargets[tier];
    const requestedSlots = Math.min(remainingCapacity, tierTarget + carryoverSlots);
    if (requestedSlots <= 0) {
      carryoverSlots = 0;
      continue;
    }

    const tokens = await tokenCatalog.listDueForMeteoraSnapshots(
      requestedSlots,
      tier,
      buildTierDueCutoff(checkedAt, tier)
    );

    selectedTokens.push(...tokens);
    selectedCountByTier[tier] = tokens.length;
    remainingCapacity -= tokens.length;
    carryoverSlots = Math.max(0, requestedSlots - tokens.length);
  }

  return {
    tokens: selectedTokens,
    selectedCountByTier,
    remainingCapacity,
    carryoverSlots,
  };
}

function normalizeBatch(batch) {
  const results = batch?.results && typeof batch.results === 'object' ? batch.results : {};
  const checkedAddresses = Array.isArray(batch?.checkedAddresses)
    ? [...new Set(batch.checkedAddresses.map((address) => String(address || '').trim()).filter(Boolean))]
    : [];
  const errorsByAddress = batch?.errorsByAddress && typeof batch.errorsByAddress === 'object'
    ? batch.errorsByAddress
    : {};

  return {
    results,
    checkedAddresses,
    errorsByAddress,
  };
}

function mapRowsByTokenAddress(rows = []) {
  return new Map(rows.map((row) => [String(row.token_address || '').trim(), row]));
}

function valueWhenHasPool(hasPool, value, fallback = null) {
  return hasPool ? (value ?? fallback) : fallback;
}

function buildStatePayload(address, result, checkedAt, snapshot, baseline) {
  const hasPool = Boolean(result && Number(result.tvl) > 0);
  return {
    tokenAddress: address,
    lastCheckedAt: checkedAt,
    hasPool,
    currentTvl: valueWhenHasPool(hasPool, result?.tvl),
    bestPoolAddress: valueWhenHasPool(hasPool, result?.poolAddress),
    poolCount: valueWhenHasPool(hasPool, result?.poolCount, 0),
    lastError: null,
    source: 'meteora',
    lastSnapshotAt: valueWhenHasPool(hasPool, snapshot?.ts || checkedAt),
    baselineTvl1h: valueWhenHasPool(hasPool, baseline?.baseline_tvl_1h),
    baselineTvl4h: valueWhenHasPool(hasPool, baseline?.baseline_tvl_4h),
    baselineTvl6h: valueWhenHasPool(hasPool, baseline?.baseline_tvl_6h),
    baselineTvl24h: valueWhenHasPool(hasPool, baseline?.baseline_tvl_24h),
    volume1h: valueWhenHasPool(hasPool, result?.volume1h),
    volume4h: valueWhenHasPool(hasPool, result?.volume4h),
    volume24h: valueWhenHasPool(hasPool, result?.volume24h),
  };
}

async function persistBatch(checkedAddresses, results, errorsByAddress, checkedAt) {
  const client = await db.getClient();

  try {
    await client.query('BEGIN');

    const positiveSnapshotsByAddress = new Map();
    for (const address of checkedAddresses) {
      const result = results[address];
      const hasPool = Boolean(result && Number(result.tvl) > 0);

      if (hasPool) {
        const snapshot = await tokenMeteoraSnapshot.insertSnapshot({
          tokenAddress: address,
          ts: checkedAt,
          totalTvl: result.tvl,
          bestPoolAddress: result.poolAddress,
          poolCount: result.poolCount,
          source: 'meteora',
        }, client);
        positiveSnapshotsByAddress.set(address, snapshot || { ts: checkedAt });
        status.totalInserted += 1;
      }
    }

    const positiveAddresses = [...positiveSnapshotsByAddress.keys()];
    const baselineRows = await tokenMeteoraSnapshot.listBaselineTvlsByAddresses(
      positiveAddresses,
      checkedAt,
      client
    );
    const baselinesByAddress = mapRowsByTokenAddress(baselineRows);

    for (const address of checkedAddresses) {
      await tokenMeteoraState.upsertState(
        buildStatePayload(
          address,
          results[address],
          checkedAt,
          positiveSnapshotsByAddress.get(address) || null,
          baselinesByAddress.get(address) || null
        ),
        client
      );
    }

    for (const [address, error] of Object.entries(errorsByAddress)) {
      await tokenMeteoraState.recordError(address, error, client);
    }

    await tokenCatalog.markMeteoraChecked(checkedAddresses, checkedAt, client);
    await client.query('COMMIT');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

async function runOnce() {
  if (!running) return LOOP_INTERVAL_MS;

  const cycleStartedAt = Date.now();
  const checkedAt = new Date(cycleStartedAt);
  status.lastRunAt = checkedAt.toISOString();

  try {
    const [universeCount, tierSummary] = await Promise.all([
      tokenCatalog.countDueForMeteoraSnapshots(),
      tokenCatalog.countDueForMeteoraSnapshotsByTier(),
    ]);
    const tierBudgetPlan = computeTierBudgetPlan(tierSummary?.byTier || {});
    const batchLimit = computeDynamicBatchLimit(universeCount);
    status.lastUniverseCount = universeCount;
    status.lastBatchLimit = batchLimit;
    status.lastUniverseCountByTier = tierBudgetPlan.universeByTier;
    status.lastTargetChecksPerMinuteByTier = tierBudgetPlan.targetChecksPerMinuteByTier;
    status.lastEffectiveChecksPerMinuteByTier = tierBudgetPlan.effectiveChecksPerMinuteByTier;
    status.lastTargetChecksPerCycleByTier = tierBudgetPlan.targetChecksPerCycleByTier;
    status.lastBudgetDegraded = tierBudgetPlan.degraded;
    status.lastDegradedTiers = [...tierBudgetPlan.degradedTiers];

    if (batchLimit === 0) {
      status.lastProcessed = 0;
      return computeNextDelayMs(0);
    }

    const selection = await selectCycleTokens(
      batchLimit,
      tierBudgetPlan.targetChecksPerCycleByTier,
      checkedAt
    );
    const tokens = selection.tokens;
    const addresses = tokens.map((token) => token.address);
    status.lastSelectedCountByTier = selection.selectedCountByTier;
    status.lastProcessed = addresses.length;
    status.totalProcessed += addresses.length;

    if (addresses.length === 0) {
      return computeNextDelayMs(0);
    }

    const batch = normalizeBatch(await meteora.fetchMeteoraBulk(addresses));
    const { results, checkedAddresses, errorsByAddress } = batch;

    if (Object.keys(errorsByAddress).length > 0) {
      status.totalErrors += 1;
      console.warn('[MeteoraSnapshotWorker] Meteora returned partial batch failures:', Object.keys(errorsByAddress).length);
    }

    if (checkedAddresses.length === 0 && Object.keys(errorsByAddress).length === 0) {
      status.totalErrors += 1;
      console.warn('[MeteoraSnapshotWorker] Meteora returned an empty batch without checked addresses or errors');
      return;
    }

    await persistBatch(checkedAddresses, results, errorsByAddress, checkedAt);
  } catch (err) {
    status.totalErrors += 1;
    console.error('[MeteoraSnapshotWorker] Failed to snapshot batch:', err.message);
  } finally {
    const cycleFinishedAt = Date.now();
    status.lastCompletedAt = new Date(cycleFinishedAt).toISOString();
    status.lastRunDurationMs = cycleFinishedAt - cycleStartedAt;
    status.lastLoopOverrunMs = Math.max(0, status.lastRunDurationMs - LOOP_INTERVAL_MS);
  }

  return computeNextDelayMs(status.lastRunDurationMs);
}

function schedule(delayMs = LOOP_INTERVAL_MS) {
  if (!running) return;
  const appliedDelayMs = normalizeDelayMs(delayMs);
  status.lastScheduledDelayMs = appliedDelayMs;
  timer = setTimeout(async () => {
    let nextDelayMs = LOOP_INTERVAL_MS;
    try {
      nextDelayMs = await runOnce();
    } finally {
      schedule(nextDelayMs);
    }
  }, appliedDelayMs);
}

function start() {
  if (running) return;
  running = true;
  status.running = true;
  schedule();
  console.log('[MeteoraSnapshotWorker] Started');
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
  __private: {
    LOOP_INTERVAL_MS,
    MAX_TOKENS_PER_MINUTE,
    MAX_BATCH_LIMIT,
    PRIORITY_TIERS,
    TARGET_REFRESH_MS_BY_TIER,
    buildTierDueCutoff,
    computeDynamicBatchLimit,
    computeTargetChecksPerMinuteByTier,
    computeTierBudgetPlan,
    computeNextDelayMs,
    emptyTierCounts,
    normalizeBatch,
    normalizeDelayMs,
    normalizeTierCounts,
    buildStatePayload,
    mapRowsByTokenAddress,
    persistBatch,
    selectCycleTokens,
  },
};
