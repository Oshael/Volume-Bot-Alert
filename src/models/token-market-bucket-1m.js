const db = require('./db');
const { isValidAddress } = require('./user-token');

const DEFAULT_LATERALIZATION_MIN_MCAP = 90_000;
const DEFAULT_LATERALIZATION_MIN_VOL_1H = 1_000;
const DEFAULT_LATERALIZATION_MIN_VOL_24H = 10_000;
const DEFAULT_LATERALIZATION_HOURS = 6;
const DEFAULT_LATERALIZATION_LIMIT = 50;
const DEFAULT_LATERALIZATION_MIN_COVERAGE_RATIO = 0.7;
const DEFAULT_LATERALIZATION_MIN_BUCKETS = 20;
const DEFAULT_LATERALIZATION_MIN_POSITION_PCT = 15;
const DEFAULT_LATERALIZATION_MAX_POSITION_PCT = 85;
const DEFAULT_LATERALIZATION_SUB_1M_MIN_HOURS = 16;
const DEFAULT_LATERALIZATION_GTE_1M_MIN_HOURS = 32;

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function getBucketDate(value = new Date()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('Invalid bucket timestamp');
  }

  date.setUTCSeconds(0, 0);
  return date;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundMetric(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function computeSampleStddev(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));

  if (nums.length < 2) {
    return null;
  }

  const mean = nums.reduce((sum, value) => sum + value, 0) / nums.length;
  const variance = nums.reduce((sum, value) => {
    const delta = value - mean;
    return sum + (delta * delta);
  }, 0) / (nums.length - 1);

  return Math.sqrt(variance);
}

function getRangeLimitPct(mcap) {
  const value = Number(mcap);
  if (!Number.isFinite(value) || value < DEFAULT_LATERALIZATION_MIN_MCAP) {
    return null;
  }
  if (value < 1_000_000) return 50;
  if (value < 5_000_000) return 35;
  return 20;
}

function getDriftLimitPct(mcap) {
  const value = Number(mcap);
  if (!Number.isFinite(value) || value < DEFAULT_LATERALIZATION_MIN_MCAP) {
    return null;
  }
  if (value < 1_000_000) return 20;
  if (value < 5_000_000) return 12;
  return 8;
}

function getMinimumWindowHoursForMcap(mcap) {
  const value = Number(mcap);
  if (!Number.isFinite(value) || value < 1_000_000) {
    return DEFAULT_LATERALIZATION_SUB_1M_MIN_HOURS;
  }
  return DEFAULT_LATERALIZATION_GTE_1M_MIN_HOURS;
}

function computeExpectedBucketCount(windowHours, createdAtMs, nowMs = Date.now()) {
  const safeWindowHours = Math.max(1, Number(windowHours) || DEFAULT_LATERALIZATION_HOURS);
  const requestedMinutes = Math.max(1, Math.round(safeWindowHours * 60));
  const createdMs = Number(createdAtMs);

  if (!Number.isFinite(createdMs) || createdMs <= 0) {
    return requestedMinutes;
  }

  const ageMinutes = Math.max(1, Math.floor((nowMs - createdMs) / 60000));
  return Math.max(1, Math.min(requestedMinutes, ageMinutes));
}

function computeAgeHours(createdAtMs, nowMs = Date.now()) {
  const createdMs = Number(createdAtMs);
  if (!Number.isFinite(createdMs) || createdMs <= 0) {
    return null;
  }

  const ageHours = (nowMs - createdMs) / (60 * 60 * 1000);
  return Number.isFinite(ageHours) && ageHours >= 0 ? ageHours : null;
}

function getMcapRankingBonus(mcap) {
  const value = Number(mcap);
  if (!Number.isFinite(value) || value < DEFAULT_LATERALIZATION_MIN_MCAP) return 0;
  if (value >= 150_000 && value <= 500_000) return 18;
  if (value < 150_000) return 12;
  if (value <= 1_000_000) return 10;
  if (value <= 5_000_000) return 4;
  return 0;
}

function getAgeRankingBonus(ageHours) {
  const value = Number(ageHours);
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value < 2) return -10;
  if (value < 12) return 10;
  if (value <= (24 * 5)) return 16;
  if (value <= (24 * 14)) return 8;
  if (value <= (24 * 30)) return 0;
  return -8;
}

function scoreLateralizedCandidate(row, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const windowHours = Math.max(1, Number(options.hours) || DEFAULT_LATERALIZATION_HOURS);
  const currentMcap = Number(row.last_mcap_window ?? row.last_mcap);
  const maxHighMcap = Number(row.max_high_mcap);
  const minLowMcap = Number(row.min_low_mcap);
  const avgCloseMcap = Number(row.avg_close_mcap);
  const firstMcap = Number(row.first_mcap);
  const lastMcapWindow = Number(row.last_mcap_window);
  const stddevMcap = Number(row.close_mcap_stddev);
  const vol1h = Number(row.last_vol_1h);
  const vol24h = Number(row.last_vol_24h);
  const bucketCount = Number(row.bucket_count) || 0;
  const sampleCount = Number(row.sample_count) || 0;
  const minMcap = Math.max(DEFAULT_LATERALIZATION_MIN_MCAP, Number(options.minMcap) || DEFAULT_LATERALIZATION_MIN_MCAP);

  const rangeLimitPct = getRangeLimitPct(currentMcap);
  const driftLimitPct = getDriftLimitPct(currentMcap);
  const rangePct = Number.isFinite(maxHighMcap) && Number.isFinite(minLowMcap) && avgCloseMcap > 0
    ? ((maxHighMcap - minLowMcap) / avgCloseMcap) * 100
    : null;
  const driftPct = Number.isFinite(firstMcap) && firstMcap > 0 && Number.isFinite(lastMcapWindow)
    ? (Math.abs(lastMcapWindow - firstMcap) / firstMcap) * 100
    : null;
  const volatilityPct = Number.isFinite(stddevMcap) && avgCloseMcap > 0
    ? (stddevMcap / avgCloseMcap) * 100
    : null;
  const turnoverPct = Number.isFinite(vol24h) && currentMcap > 0
    ? (vol24h / currentMcap) * 100
    : null;

  const ageHours = computeAgeHours(row.last_token_created_at_ms, nowMs);
  const expectedBucketCount = computeExpectedBucketCount(windowHours, row.last_token_created_at_ms, nowMs);
  const coverageRatio = expectedBucketCount > 0 ? bucketCount / expectedBucketCount : 0;
  const minCoverageRatio = Number(options.minCoverageRatio) || DEFAULT_LATERALIZATION_MIN_COVERAGE_RATIO;
  const minBuckets = Math.max(3, Number(options.minBuckets) || DEFAULT_LATERALIZATION_MIN_BUCKETS);
  const minVol1h = Math.max(0, Number(options.minVol1h) || DEFAULT_LATERALIZATION_MIN_VOL_1H);
  const minVol24h = Math.max(0, Number(options.minVol24h) || DEFAULT_LATERALIZATION_MIN_VOL_24H);
  const minPositionPct = Number(options.minPositionPct) || DEFAULT_LATERALIZATION_MIN_POSITION_PCT;
  const maxPositionPct = Number(options.maxPositionPct) || DEFAULT_LATERALIZATION_MAX_POSITION_PCT;

  const rangeSpan = Number.isFinite(maxHighMcap) && Number.isFinite(minLowMcap)
    ? (maxHighMcap - minLowMcap)
    : null;
  const centerPosition = Number.isFinite(rangeSpan) && rangeSpan > 0 && Number.isFinite(lastMcapWindow)
    ? (lastMcapWindow - minLowMcap) / rangeSpan
    : 0.5;
  const centerBonus = (1 - clamp01(Math.abs(centerPosition - 0.5) / 0.5)) * 8;
  const rangeScore = rangeLimitPct != null && rangePct != null
    ? clamp01(1 - (rangePct / rangeLimitPct)) * 40
    : 0;
  const driftScore = driftLimitPct != null && driftPct != null
    ? clamp01(1 - (driftPct / driftLimitPct)) * 25
    : 0;
  const coverageScore = clamp01(coverageRatio) * 15;
  const volatilityCeilingPct = rangeLimitPct != null ? Math.max(8, rangeLimitPct / 2) : 12;
  const volatilityScore = volatilityPct != null
    ? clamp01(1 - (volatilityPct / volatilityCeilingPct)) * 8
    : 0;
  const turnoverScore = turnoverPct != null
    ? clamp01(turnoverPct / 40) * 10
    : 0;

  const score = rangeScore
    + driftScore
    + coverageScore
    + volatilityScore
    + turnoverScore
    + centerBonus
    + getMcapRankingBonus(currentMcap)
    + getAgeRankingBonus(ageHours);

  const currentPositionPct = centerPosition * 100;
  const passesPosition = Number.isFinite(currentPositionPct)
    && currentPositionPct >= minPositionPct
    && currentPositionPct <= maxPositionPct;

  const passes = (
    Number.isFinite(currentMcap)
    && currentMcap >= minMcap
    && rangeLimitPct != null
    && driftLimitPct != null
    && rangePct != null
    && driftPct != null
    && rangePct <= rangeLimitPct
    && driftPct <= driftLimitPct
    && coverageRatio >= minCoverageRatio
    && bucketCount >= minBuckets
    && vol1h >= minVol1h
    && vol24h >= minVol24h
    && passesPosition
  );

  return {
    passes,
    score: roundMetric(score, 2),
    rangeLimitPct,
    driftLimitPct,
    rangePct: roundMetric(rangePct, 2),
    driftPct: roundMetric(driftPct, 2),
    volatilityPct: roundMetric(volatilityPct, 2),
    turnoverPct: roundMetric(turnoverPct, 2),
    ageHours: roundMetric(ageHours, 2),
    expectedBucketCount,
    coverageRatio: roundMetric(coverageRatio, 4),
    currentPositionPct: roundMetric(currentPositionPct, 2),
    bucketCount,
    sampleCount,
    passesPosition,
  };
}

async function upsertSnapshotBucket(snapshot) {
  const address = String(snapshot.tokenAddress || snapshot.address || '').trim();
  if (!isValidAddress(address)) {
    throw new Error('Invalid token address format');
  }

  const bucketTs = getBucketDate(snapshot.ts || new Date());
  const mcap = toNumberOrNull(snapshot.mcap);
  const price = toNumberOrNull(snapshot.price);
  const source = String(snapshot.source || 'dexscreener').trim().toLowerCase() || 'dexscreener';

  const { rows } = await db.query(
    `INSERT INTO token_market_buckets_1m (
       token_address,
       bucket_ts,
       open_mcap,
       high_mcap,
       low_mcap,
       close_mcap,
       open_price,
       high_price,
       low_price,
       close_price,
       sample_count,
       source
     )
     VALUES (
       $1, $2,
       $3, $3, $3, $3,
       $4, $4, $4, $4,
       1,
       $5
     )
     ON CONFLICT (token_address, bucket_ts) DO UPDATE SET
       high_mcap = CASE
         WHEN EXCLUDED.high_mcap IS NULL THEN token_market_buckets_1m.high_mcap
         WHEN token_market_buckets_1m.high_mcap IS NULL THEN EXCLUDED.high_mcap
         ELSE GREATEST(token_market_buckets_1m.high_mcap, EXCLUDED.high_mcap)
       END,
       low_mcap = CASE
         WHEN EXCLUDED.low_mcap IS NULL THEN token_market_buckets_1m.low_mcap
         WHEN token_market_buckets_1m.low_mcap IS NULL THEN EXCLUDED.low_mcap
         ELSE LEAST(token_market_buckets_1m.low_mcap, EXCLUDED.low_mcap)
       END,
       close_mcap = COALESCE(EXCLUDED.close_mcap, token_market_buckets_1m.close_mcap),
       high_price = CASE
         WHEN EXCLUDED.high_price IS NULL THEN token_market_buckets_1m.high_price
         WHEN token_market_buckets_1m.high_price IS NULL THEN EXCLUDED.high_price
         ELSE GREATEST(token_market_buckets_1m.high_price, EXCLUDED.high_price)
       END,
       low_price = CASE
         WHEN EXCLUDED.low_price IS NULL THEN token_market_buckets_1m.low_price
         WHEN token_market_buckets_1m.low_price IS NULL THEN EXCLUDED.low_price
         ELSE LEAST(token_market_buckets_1m.low_price, EXCLUDED.low_price)
       END,
       close_price = COALESCE(EXCLUDED.close_price, token_market_buckets_1m.close_price),
       sample_count = token_market_buckets_1m.sample_count + 1,
       source = COALESCE(EXCLUDED.source, token_market_buckets_1m.source)
     RETURNING *`,
    [address, bucketTs, mcap, price, source]
  );

  return rows[0];
}

async function listHistoryByAddress(address, options = {}) {
  const addr = String(address || '').trim();
  if (!isValidAddress(addr)) {
    throw new Error('Invalid token address format');
  }

  const limit = Math.max(1, Math.min(Number(options.limit) || 168, 5000));
  const hours = options.hours == null ? null : Math.max(1, Math.min(Number(options.hours) || 0, 24 * 30));
  const days = options.days == null ? null : Math.max(1, Math.min(Number(options.days) || 0, 30));

  let lookbackHours = hours;
  if (lookbackHours == null && days != null) {
    lookbackHours = days * 24;
  }

  const params = [addr, limit];
  let whereExtra = '';
  if (lookbackHours != null) {
    params.push(lookbackHours);
    whereExtra = `AND bucket_ts >= NOW() - ($3::int * INTERVAL '1 hour')`;
  }

  const { rows } = await db.query(
    `SELECT
       token_address,
       bucket_ts,
       open_mcap,
       high_mcap,
       low_mcap,
       close_mcap,
       open_price,
       high_price,
       low_price,
       close_price,
       sample_count,
       source
     FROM token_market_buckets_1m
     WHERE token_address = $1
       ${whereExtra}
     ORDER BY bucket_ts DESC
     LIMIT $2`,
    params
  );

  return rows.reverse().map((row) => ({
    token_address: row.token_address,
    ts: row.bucket_ts,
    mcap: row.close_mcap == null ? null : Number(row.close_mcap),
    price: row.close_price == null ? null : Number(row.close_price),
    openMcap: row.open_mcap == null ? null : Number(row.open_mcap),
    highMcap: row.high_mcap == null ? null : Number(row.high_mcap),
    lowMcap: row.low_mcap == null ? null : Number(row.low_mcap),
    closeMcap: row.close_mcap == null ? null : Number(row.close_mcap),
    openPrice: row.open_price == null ? null : Number(row.open_price),
    highPrice: row.high_price == null ? null : Number(row.high_price),
    lowPrice: row.low_price == null ? null : Number(row.low_price),
    closePrice: row.close_price == null ? null : Number(row.close_price),
    sampleCount: Number(row.sample_count) || 0,
    source: row.source || 'dexscreener',
  }));
}

async function deleteByAddresses(addresses) {
  const unique = Array.from(
    new Set(
      (Array.isArray(addresses) ? addresses : [])
        .map((item) => String(item || '').trim())
        .filter((item) => isValidAddress(item))
    )
  );
  if (!unique.length) {
    return 0;
  }

  const result = await db.query(
    `DELETE FROM token_market_buckets_1m
     WHERE token_address = ANY($1::varchar[])`,
    [unique]
  );

  return result.rowCount || 0;
}

async function listCurrentAndBaselineByAddresses(addresses, windowMinutes = 5) {
  const unique = Array.from(
    new Set(
      (Array.isArray(addresses) ? addresses : [])
        .map((item) => String(item || '').trim())
        .filter((item) => isValidAddress(item))
    )
  );
  if (!unique.length) {
    return [];
  }

  const safeWindowMinutes = Math.max(1, Math.min(Number(windowMinutes) || 5, 60));
  const { rows } = await db.query(
    `WITH requested AS (
       SELECT UNNEST($1::varchar[]) AS token_address
     )
     SELECT
       requested.token_address,
       current_row.current_ts,
       current_row.current_mcap,
       COALESCE(target.bucket_ts, fallback.bucket_ts) AS baseline_ts,
       COALESCE(target.close_mcap, fallback.close_mcap) AS baseline_mcap
     FROM requested
     LEFT JOIN LATERAL (
       SELECT
         bucket_ts AS current_ts,
         close_mcap AS current_mcap
       FROM token_market_buckets_1m
       WHERE token_address = requested.token_address
       ORDER BY bucket_ts DESC
       LIMIT 1
     ) AS current_row ON TRUE
     LEFT JOIN LATERAL (
       SELECT bucket_ts, close_mcap
       FROM token_market_buckets_1m
       WHERE token_address = requested.token_address
         AND close_mcap IS NOT NULL
         AND current_row.current_ts IS NOT NULL
         AND bucket_ts <= current_row.current_ts - ($2::int * INTERVAL '1 minute')
       ORDER BY bucket_ts DESC
       LIMIT 1
     ) AS target ON TRUE
     LEFT JOIN LATERAL (
       SELECT bucket_ts, close_mcap
       FROM token_market_buckets_1m
       WHERE token_address = requested.token_address
         AND close_mcap IS NOT NULL
         AND current_row.current_ts IS NOT NULL
         AND bucket_ts < current_row.current_ts
       ORDER BY bucket_ts ASC
       LIMIT 1
     ) AS fallback ON target.bucket_ts IS NULL
     ORDER BY requested.token_address ASC`,
    [unique, safeWindowMinutes]
  );

  return rows;
}

async function listLateralizedCandidates(options = {}) {
  const requestedHours = Math.max(1, Math.min(Number(options.hours) || DEFAULT_LATERALIZATION_HOURS, 48));
  const minMcap = Math.max(DEFAULT_LATERALIZATION_MIN_MCAP, Number(options.minMcap) || DEFAULT_LATERALIZATION_MIN_MCAP);
  const minVol1h = Math.max(0, Number(options.minVol1h) || DEFAULT_LATERALIZATION_MIN_VOL_1H);
  const minVol24h = Math.max(0, Number(options.minVol24h) || DEFAULT_LATERALIZATION_MIN_VOL_24H);
  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_LATERALIZATION_LIMIT, 200));
  const maxLookbackHours = Math.max(
    requestedHours,
    DEFAULT_LATERALIZATION_SUB_1M_MIN_HOURS,
    DEFAULT_LATERALIZATION_GTE_1M_MIN_HOURS
  );
  const nowMs = Number(options.nowMs) || Date.now();

  const { rows } = await db.query(
    `WITH catalog_candidates AS (
       SELECT
         address,
         symbol,
         name,
         last_mcap,
         last_vol_1h,
         last_vol_6h,
         last_vol_24h,
         last_token_created_at_ms,
         monitor_priority
       FROM token_catalog
       WHERE eligible_for_monitoring = TRUE
         AND is_active_monitor_candidate = TRUE
         AND COALESCE(last_vol_1h, 0) >= $1
         AND COALESCE(last_vol_24h, 0) >= $2
     SELECT
       c.address AS token_address,
       c.symbol,
       c.name,
       c.last_mcap,
       c.last_vol_1h,
       c.last_vol_6h,
       c.last_vol_24h,
       c.last_token_created_at_ms,
       c.monitor_priority,
       b.bucket_ts,
       b.open_mcap,
       b.high_mcap,
       b.low_mcap,
       b.close_mcap,
       b.sample_count
     FROM catalog_candidates c
     INNER JOIN token_market_buckets_1m b
       ON b.token_address = c.address
     WHERE b.bucket_ts >= NOW() - ($3::int * INTERVAL '1 hour')
     ORDER BY c.address ASC, b.bucket_ts ASC`,
    [minVol1h, minVol24h, maxLookbackHours]
  );

  const grouped = new Map();
  for (const row of rows) {
    const address = row.token_address;
    if (!grouped.has(address)) {
      grouped.set(address, {
        address,
        symbol: row.symbol || null,
        name: row.name || null,
        monitorPriority: row.monitor_priority || 'dormant',
        catalogMcap: row.last_mcap == null ? null : Number(row.last_mcap),
        volume1h: row.last_vol_1h == null ? null : Number(row.last_vol_1h),
        volume6h: row.last_vol_6h == null ? null : Number(row.last_vol_6h),
        volume24h: row.last_vol_24h == null ? null : Number(row.last_vol_24h),
        lastTokenCreatedAtMs: row.last_token_created_at_ms == null ? null : Number(row.last_token_created_at_ms),
        buckets: [],
      });
    }

    grouped.get(address).buckets.push({
      bucketTsMs: new Date(row.bucket_ts).getTime(),
      bucketTs: row.bucket_ts,
      openMcap: row.open_mcap == null ? null : Number(row.open_mcap),
      highMcap: row.high_mcap == null ? null : Number(row.high_mcap),
      lowMcap: row.low_mcap == null ? null : Number(row.low_mcap),
      closeMcap: row.close_mcap == null ? null : Number(row.close_mcap),
      sampleCount: Number(row.sample_count) || 0,
    });
  }

  return Array.from(grouped.values())
    .map((candidate) => {
      const allBuckets = candidate.buckets;
      if (!allBuckets.length) {
        return null;
      }

      const latestBucket = allBuckets[allBuckets.length - 1];
      const latestWindowMcap = latestBucket.closeMcap == null ? latestBucket.openMcap : latestBucket.closeMcap;
      const minimumWindowHours = getMinimumWindowHoursForMcap(latestWindowMcap);
      const effectiveWindowHours = Math.max(requestedHours, minimumWindowHours);
      const cutoffMs = nowMs - (effectiveWindowHours * 60 * 60 * 1000);
      const scopedBuckets = allBuckets.filter((bucket) => bucket.bucketTsMs >= cutoffMs);
      if (!scopedBuckets.length) {
        return null;
      }

      const firstBucket = scopedBuckets.find((bucket) => bucket.openMcap != null || bucket.closeMcap != null) || null;
      const lastBucket = [...scopedBuckets].reverse().find((bucket) => bucket.closeMcap != null || bucket.openMcap != null) || null;
      const closeValues = scopedBuckets
        .map((bucket) => bucket.closeMcap)
        .filter((value) => Number.isFinite(value));
      const avgCloseMcap = closeValues.length
        ? closeValues.reduce((sum, value) => sum + value, 0) / closeValues.length
        : null;
      const maxHighMcap = scopedBuckets.reduce((max, bucket) => {
        return bucket.highMcap != null && (max == null || bucket.highMcap > max) ? bucket.highMcap : max;
      }, null);
      const minLowMcap = scopedBuckets.reduce((min, bucket) => {
        return bucket.lowMcap != null && (min == null || bucket.lowMcap < min) ? bucket.lowMcap : min;
      }, null);
      const row = {
        last_mcap: candidate.catalogMcap,
        last_mcap_window: latestWindowMcap,
        max_high_mcap: maxHighMcap,
        min_low_mcap: minLowMcap,
        avg_close_mcap: avgCloseMcap,
        first_mcap: firstBucket ? (firstBucket.openMcap == null ? firstBucket.closeMcap : firstBucket.openMcap) : null,
        close_mcap_stddev: computeSampleStddev(closeValues),
        last_vol_1h: candidate.volume1h,
        last_vol_24h: candidate.volume24h,
        bucket_count: scopedBuckets.length,
        sample_count: scopedBuckets.reduce((sum, bucket) => sum + bucket.sampleCount, 0),
        last_token_created_at_ms: candidate.lastTokenCreatedAtMs,
      };
      const metrics = scoreLateralizedCandidate(row, {
        ...options,
        hours: effectiveWindowHours,
        nowMs,
        minMcap,
        minVol1h,
        minVol24h,
      });

      return {
        address: candidate.address,
        symbol: candidate.symbol,
        name: candidate.name,
        monitorPriority: candidate.monitorPriority,
        mcap: latestWindowMcap == null ? null : Number(latestWindowMcap),
        catalogMcap: candidate.catalogMcap,
        windowMcap: latestWindowMcap == null ? null : Number(latestWindowMcap),
        volume1h: candidate.volume1h,
        volume6h: candidate.volume6h,
        volume24h: candidate.volume24h,
        firstBucketAt: scopedBuckets[0]?.bucketTs || null,
        lastBucketAt: scopedBuckets[scopedBuckets.length - 1]?.bucketTs || null,
        score: metrics.score,
        rangePct: metrics.rangePct,
        rangeLimitPct: metrics.rangeLimitPct,
        driftPct: metrics.driftPct,
        driftLimitPct: metrics.driftLimitPct,
        volatilityPct: metrics.volatilityPct,
        turnoverPct: metrics.turnoverPct,
        coverageRatio: metrics.coverageRatio,
        bucketCount: metrics.bucketCount,
        sampleCount: metrics.sampleCount,
        expectedBucketCount: metrics.expectedBucketCount,
        ageHours: metrics.ageHours,
        currentPositionPct: metrics.currentPositionPct,
        requestedHours,
        minimumWindowHours,
        windowHoursUsed: effectiveWindowHours,
        reasons: {
          passesMcap: latestWindowMcap != null && Number(latestWindowMcap) >= minMcap,
          passesRange: metrics.rangePct != null && metrics.rangeLimitPct != null && metrics.rangePct <= metrics.rangeLimitPct,
          passesDrift: metrics.driftPct != null && metrics.driftLimitPct != null && metrics.driftPct <= metrics.driftLimitPct,
          passesCoverage: metrics.coverageRatio != null && metrics.coverageRatio >= (Number(options.minCoverageRatio) || DEFAULT_LATERALIZATION_MIN_COVERAGE_RATIO),
          passesVolume1h: candidate.volume1h != null && Number(candidate.volume1h) >= minVol1h,
          passesLiquidity: candidate.volume24h != null && Number(candidate.volume24h) >= minVol24h,
          passesPosition: metrics.passesPosition,
        },
      };
    })
    .filter(Boolean)
    .filter((item) => item.reasons.passesMcap && item.reasons.passesRange && item.reasons.passesDrift && item.reasons.passesCoverage && item.reasons.passesVolume1h && item.reasons.passesLiquidity && item.reasons.passesPosition && item.bucketCount >= (Math.max(3, Number(options.minBuckets) || DEFAULT_LATERALIZATION_MIN_BUCKETS)))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if ((a.rangePct ?? Number.POSITIVE_INFINITY) !== (b.rangePct ?? Number.POSITIVE_INFINITY)) {
        return (a.rangePct ?? Number.POSITIVE_INFINITY) - (b.rangePct ?? Number.POSITIVE_INFINITY);
      }
      return (b.coverageRatio ?? 0) - (a.coverageRatio ?? 0);
    })
    .slice(0, limit);
}

module.exports = {
  upsertSnapshotBucket,
  listHistoryByAddress,
  deleteByAddresses,
  listCurrentAndBaselineByAddresses,
  listLateralizedCandidates,
  __private: {
    computeAgeHours,
    computeExpectedBucketCount,
    getAgeRankingBonus,
    getBucketDate,
    getDriftLimitPct,
    getMcapRankingBonus,
    getMinimumWindowHoursForMcap,
    getRangeLimitPct,
    computeSampleStddev,
    scoreLateralizedCandidate,
  },
};
