const db = require('./db');
const { isValidAddress } = require('./user-token');

const DEFAULT_LATERALIZATION_MIN_MCAP = 90_000;
const DEFAULT_LATERALIZATION_MIN_VOL_1H = 1_000;
const DEFAULT_LATERALIZATION_MIN_VOL_24H = 10_000;
const DEFAULT_LATERALIZATION_HOURS = 6;
const DEFAULT_LATERALIZATION_LIMIT = 50;
const DEFAULT_LATERALIZATION_SUB_1M_CANDIDATE_POOL_LIMIT = 120;
const DEFAULT_LATERALIZATION_1M_TO_4M_CANDIDATE_POOL_LIMIT = 50;
const DEFAULT_LATERALIZATION_5M_PLUS_CANDIDATE_POOL_LIMIT = 30;
const DEFAULT_LATERALIZATION_MIN_COVERAGE_RATIO = 0.7;
const DEFAULT_LATERALIZATION_MIN_BUCKETS = 20;
const DEFAULT_LATERALIZATION_MIN_POSITION_PCT = 15;
const DEFAULT_LATERALIZATION_MAX_POSITION_PCT = 85;
const DEFAULT_LATERALIZATION_SUB_1M_MIN_HOURS = 16;
const DEFAULT_LATERALIZATION_GTE_1M_MIN_HOURS = 32;
const DEFAULT_BID_ZONE_MIN_MCAP = 90_000;
const DEFAULT_BID_ZONE_MIN_VOL_1H = 1_000;
const DEFAULT_BID_ZONE_MIN_VOL_24H = 10_000;
const DEFAULT_BID_ZONE_HOURS = 48;
const DEFAULT_BID_ZONE_LIMIT = 50;
const DEFAULT_BID_ZONE_MIN_COVERAGE_RATIO = 0.75;
const DEFAULT_BID_ZONE_MIN_BUCKETS = 20;
const DEFAULT_BID_ZONE_MIN_SUPPORT_TOUCHES = 3;
const DEFAULT_BID_ZONE_MIN_SUPPORT_DISTANCE_PCT = -3;
const DEFAULT_BID_ZONE_MAX_SUPPORT_DISTANCE_PCT = 18;
const DEFAULT_BID_ZONE_MAX_RECENT_RANGE_PCT = 28;
const DEFAULT_BID_ZONE_MAX_CLOSE_DRIFT_PCT = 30;

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

function computeQuantile(values, quantile) {
  const nums = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  if (!nums.length) {
    return null;
  }

  if (nums.length === 1) {
    return nums[0];
  }

  const q = clamp01(Number(quantile));
  const position = (nums.length - 1) * q;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = nums[lowerIndex];
  const upper = nums[upperIndex];
  if (lowerIndex === upperIndex || !Number.isFinite(lower) || !Number.isFinite(upper)) {
    return Number.isFinite(lower) ? lower : upper;
  }

  const weight = position - lowerIndex;
  return lower + ((upper - lower) * weight);
}

function countTouchClusters(buckets, supportLevel, options = {}) {
  const items = Array.isArray(buckets) ? buckets : [];
  const support = Number(supportLevel);
  if (!Number.isFinite(support) || !(support > 0) || !items.length) {
    return 0;
  }

  const maxTouchBandPct = Math.max(0.01, Number(options.maxTouchBandPct) || 0.05);
  const maxBreakdownPct = Math.max(0.005, Number(options.maxBreakdownPct) || 0.04);
  let clusters = 0;
  let inCluster = false;

  for (const bucket of items) {
    const low = Number(bucket.lowMcap ?? bucket.closeMcap ?? bucket.openMcap);
    const close = Number(bucket.closeMcap ?? bucket.openMcap ?? bucket.lowMcap);
    const touched = Number.isFinite(low)
      && Number.isFinite(close)
      && low <= support * (1 + maxTouchBandPct)
      && close >= support * (1 - maxBreakdownPct);

    if (touched && !inCluster) {
      clusters += 1;
      inCluster = true;
      continue;
    }

    if (!touched) {
      inCluster = false;
    }
  }

  return clusters;
}

function getRangeLimitPct(mcap) {
  const value = Number(mcap);
  if (!Number.isFinite(value) || value < DEFAULT_LATERALIZATION_MIN_MCAP) {
    return null;
  }
  if (value < 1_000_000) return 50;
  if (value < 4_000_000) return 50;
  return 25;
}

function getDriftLimitPct(mcap) {
  const value = Number(mcap);
  if (!Number.isFinite(value) || value < DEFAULT_LATERALIZATION_MIN_MCAP) {
    return null;
  }
  if (value < 1_000_000) return 20;
  if (value < 4_000_000) return 16;
  return 14;
}

function getMinimumWindowHoursForMcap(mcap) {
  const value = Number(mcap);
  if (!Number.isFinite(value) || value < 1_000_000) {
    return DEFAULT_LATERALIZATION_SUB_1M_MIN_HOURS;
  }
  return DEFAULT_LATERALIZATION_GTE_1M_MIN_HOURS;
}

function getCandidatePoolBand(mcap) {
  const value = Number(mcap);
  if (!Number.isFinite(value) || value < 1_000_000) {
    return 'sub_1m';
  }
  if (value < 4_000_000) {
    return 'm1_to_4m';
  }
  return 'm4_plus';
}

function getCandidatePoolBandLimit(band) {
  switch (String(band || '').trim().toLowerCase()) {
    case 'm1_to_4m':
      return DEFAULT_LATERALIZATION_1M_TO_4M_CANDIDATE_POOL_LIMIT;
    case 'm4_plus':
      return DEFAULT_LATERALIZATION_5M_PLUS_CANDIDATE_POOL_LIMIT;
    case 'sub_1m':
    default:
      return DEFAULT_LATERALIZATION_SUB_1M_CANDIDATE_POOL_LIMIT;
  }
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
  if (value <= 4_000_000) return 8;
  return 5;
}

function getHighCapQualityBonus(currentMcap, rangePct, driftPct, vol1h, vol24h) {
  const value = Number(currentMcap);
  if (!Number.isFinite(value) || value < 1_000_000) {
    return 0;
  }

  let bonus = 0;
  const range = Number(rangePct);
  const drift = Number(driftPct);
  const vol1 = Number(vol1h);
  const vol24 = Number(vol24h);

  if (Number.isFinite(range)) {
    if (value < 4_000_000 && range <= 20) bonus += 4;
    else if (value >= 4_000_000 && range <= 12) bonus += 5;
  }

  if (Number.isFinite(drift)) {
    if (value < 4_000_000 && drift <= 6) bonus += 2;
    else if (value >= 4_000_000 && drift <= 4) bonus += 3;
  }

  if (Number.isFinite(vol1) && Number.isFinite(vol24)) {
    if (vol1 >= 5000) bonus += 2;
    if (vol24 >= 100000) bonus += 2;
  }

  return bonus;
}

function getLiquidityRankingAdjustment(vol1h, vol6h, options = {}) {
  const value1h = Number(vol1h);
  const value6h = Number(vol6h);
  const ageHours = Number(options.ageHours);
  const neutralThreshold = Math.max(250, Number(options.neutralThreshold) || DEFAULT_LATERALIZATION_MIN_VOL_1H);

  let penalty = 0;
  if (!Number.isFinite(value1h) || value1h < 200) {
    penalty = -12;
  } else if (value1h < 500) {
    penalty = -7;
  } else if (value1h < neutralThreshold) {
    penalty = -4;
  }

  if (penalty < 0 && Number.isFinite(ageHours)) {
    if (ageHours >= (24 * 30) && value1h < 500) {
      penalty -= 4;
    } else if (ageHours >= (24 * 14) && value1h < 500) {
      penalty -= 2;
    }
  }

  if (penalty < 0 && Number.isFinite(value6h)) {
    if (penalty <= -12 && value1h < 200) {
      return penalty;
    }
    if (value6h >= 10_000) {
      penalty += 6;
    } else if (value6h >= 3_000) {
      penalty += 3;
    }
  }

  return Math.min(0, penalty);
}

function passesDeadLiquidityFilter(vol1h, vol6h) {
  const value1h = Number(vol1h);
  const value6h = Number(vol6h);
  return !(value1h < 100 && value6h < 1_500);
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

function getStaleLowCapPenalty(ageHours, currentMcap) {
  const age = Number(ageHours);
  const mcap = Number(currentMcap);
  if (!Number.isFinite(age) || !Number.isFinite(mcap)) return 0;
  if (age >= (24 * 30) && mcap < 150_000) return -10;
  return 0;
}

function getActiveLiquidityBonus(vol1h, vol6h) {
  const value1h = Number(vol1h);
  const value6h = Number(vol6h);
  if (!Number.isFinite(value1h) || !Number.isFinite(value6h)) return 0;
  if (value1h >= 1_000 && value6h >= 20_000) return 6;
  return 0;
}

function getEarlyBidZoneBonus(ageHours, currentMcap) {
  const age = Number(ageHours);
  const mcap = Number(currentMcap);
  if (!Number.isFinite(age) || !Number.isFinite(mcap)) return 0;
  if (age <= (24 * 14) && mcap >= 90_000 && mcap <= 180_000) return 5;
  return 0;
}

function scoreBidZoneCandidate(row, options = {}) {
  const nowMs = Number(options.nowMs) || Date.now();
  const windowHours = Math.max(1, Math.min(Number(options.hours) || DEFAULT_BID_ZONE_HOURS, 48));
  const currentMcap = Number(row.last_mcap_window ?? row.last_mcap);
  const supportLevelMcap = Number(row.support_level_mcap);
  const resistanceLevelMcap = Number(row.resistance_level_mcap);
  const medianCloseMcap = Number(row.median_close_mcap);
  const firstCloseMcap = Number(row.first_close_mcap);
  const lastCloseMcap = Number(row.last_mcap_window);
  const recentMedianCloseMcap = Number(row.recent_median_close_mcap);
  const recentRangePct = Number(row.recent_range_pct);
  const vol1h = Number(row.last_vol_1h);
  const vol6h = Number(row.last_vol_6h);
  const vol24h = Number(row.last_vol_24h);
  const bucketCount = Number(row.bucket_count) || 0;
  const sampleCount = Number(row.sample_count) || 0;
  const supportTouchClusters = Math.max(0, Number(row.support_touch_clusters) || 0);
  const minMcap = Math.max(DEFAULT_BID_ZONE_MIN_MCAP, Number(options.minMcap) || DEFAULT_BID_ZONE_MIN_MCAP);
  const minVol1h = Math.max(250, Number(options.minVol1h) || DEFAULT_BID_ZONE_MIN_VOL_1H);
  const minVol24h = Math.max(0, Number(options.minVol24h) || DEFAULT_BID_ZONE_MIN_VOL_24H);
  const minCoverageRatio = Number(options.minCoverageRatio) || DEFAULT_BID_ZONE_MIN_COVERAGE_RATIO;
  const minBuckets = Math.max(3, Number(options.minBuckets) || DEFAULT_BID_ZONE_MIN_BUCKETS);
  const minSupportTouches = Math.max(1, Number(options.minSupportTouches) || DEFAULT_BID_ZONE_MIN_SUPPORT_TOUCHES);
  const minSupportDistancePct = Number.isFinite(Number(options.minSupportDistancePct))
    ? Number(options.minSupportDistancePct)
    : DEFAULT_BID_ZONE_MIN_SUPPORT_DISTANCE_PCT;
  const maxSupportDistancePct = Number.isFinite(Number(options.maxSupportDistancePct))
    ? Number(options.maxSupportDistancePct)
    : DEFAULT_BID_ZONE_MAX_SUPPORT_DISTANCE_PCT;
  const maxRecentRangePct = Number(options.maxRecentRangePct) || DEFAULT_BID_ZONE_MAX_RECENT_RANGE_PCT;
  const maxCloseDriftPct = Number(options.maxCloseDriftPct) || DEFAULT_BID_ZONE_MAX_CLOSE_DRIFT_PCT;

  const ageHours = computeAgeHours(row.last_token_created_at_ms, nowMs);
  const expectedBucketCount = computeExpectedBucketCount(windowHours, row.last_token_created_at_ms, nowMs);
  const coverageRatio = expectedBucketCount > 0 ? bucketCount / expectedBucketCount : 0;
  const robustRangePct = Number.isFinite(resistanceLevelMcap) && Number.isFinite(supportLevelMcap) && medianCloseMcap > 0
    ? ((resistanceLevelMcap - supportLevelMcap) / medianCloseMcap) * 100
    : null;
  const closeDriftPct = Number.isFinite(firstCloseMcap) && firstCloseMcap > 0 && Number.isFinite(lastCloseMcap)
    ? (Math.abs(lastCloseMcap - firstCloseMcap) / firstCloseMcap) * 100
    : null;
  const supportDistancePct = Number.isFinite(supportLevelMcap) && supportLevelMcap > 0 && Number.isFinite(currentMcap)
    ? ((currentMcap - supportLevelMcap) / supportLevelMcap) * 100
    : null;
  const resistanceDistancePct = Number.isFinite(resistanceLevelMcap) && resistanceLevelMcap > 0 && Number.isFinite(currentMcap)
    ? ((resistanceLevelMcap - currentMcap) / resistanceLevelMcap) * 100
    : null;
  const passesRecentLiquidity = passesDeadLiquidityFilter(vol1h, vol6h);
  const liquidityPenalty = getLiquidityRankingAdjustment(vol1h, vol6h, {
    neutralThreshold: minVol1h,
    ageHours,
  });
  const supportDistanceScore = supportDistancePct == null
    ? 0
    : clamp01(1 - (Math.max(0, supportDistancePct) / maxSupportDistancePct)) * 28;
  const supportTouchScore = clamp01((supportTouchClusters - minSupportTouches + 1) / 4) * 20;
  const compressionScore = Number.isFinite(recentRangePct)
    ? clamp01(1 - (recentRangePct / maxRecentRangePct)) * 18
    : 0;
  const driftScore = Number.isFinite(closeDriftPct)
    ? clamp01(1 - (closeDriftPct / maxCloseDriftPct)) * 14
    : 0;
  const coverageScore = clamp01(coverageRatio) * 12;
  const supportBandBonus = supportDistancePct != null && supportDistancePct >= 0 && supportDistancePct <= 10 ? 6 : 0;

  const score = supportDistanceScore
    + supportTouchScore
    + compressionScore
    + driftScore
    + coverageScore
    + supportBandBonus
    + getMcapRankingBonus(currentMcap)
    + getActiveLiquidityBonus(vol1h, vol6h)
    + getEarlyBidZoneBonus(ageHours, currentMcap)
    + getStaleLowCapPenalty(ageHours, currentMcap)
    + liquidityPenalty
    + getAgeRankingBonus(ageHours);

  const passesSupportDistance = supportDistancePct != null
    && supportDistancePct >= minSupportDistancePct
    && supportDistancePct <= maxSupportDistancePct;
  const passesTouchCount = supportTouchClusters >= minSupportTouches;
  const passesRecentCompression = recentRangePct != null && recentRangePct <= maxRecentRangePct;
  const passesCloseDrift = closeDriftPct != null && closeDriftPct <= maxCloseDriftPct;
  const passesLiquidity = vol24h >= minVol24h && vol1h >= minVol1h;
  const passesCoverage = coverageRatio >= minCoverageRatio;
  const passesMcap = Number.isFinite(currentMcap) && currentMcap >= minMcap;

  const passes = passesMcap
    && passesCoverage
    && bucketCount >= minBuckets
    && passesRecentLiquidity
    && passesLiquidity
    && passesTouchCount
    && passesSupportDistance
    && passesRecentCompression
    && passesCloseDrift;

  return {
    passes,
    score: roundMetric(score, 2),
    supportLevelMcap: roundMetric(supportLevelMcap, 2),
    resistanceLevelMcap: roundMetric(resistanceLevelMcap, 2),
    robustRangePct: roundMetric(robustRangePct, 2),
    recentRangePct: roundMetric(recentRangePct, 2),
    closeDriftPct: roundMetric(closeDriftPct, 2),
    supportDistancePct: roundMetric(supportDistancePct, 2),
    resistanceDistancePct: roundMetric(resistanceDistancePct, 2),
    supportTouchClusters,
    ageHours: roundMetric(ageHours, 2),
    expectedBucketCount,
    coverageRatio: roundMetric(coverageRatio, 4),
    bucketCount,
    sampleCount,
    passesRecentLiquidity,
    liquidityPenalty,
    volume1hPenalty: liquidityPenalty,
    recentMedianCloseMcap: roundMetric(recentMedianCloseMcap, 2),
  };
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
  const vol6h = Number(row.last_vol_6h);
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
  const minVol1h = Math.max(250, Number(options.minVol1h) || DEFAULT_LATERALIZATION_MIN_VOL_1H);
  const minVol24h = Math.max(0, Number(options.minVol24h) || DEFAULT_LATERALIZATION_MIN_VOL_24H);
  const minPositionPct = Number(options.minPositionPct) || DEFAULT_LATERALIZATION_MIN_POSITION_PCT;
  const maxPositionPct = Number(options.maxPositionPct) || DEFAULT_LATERALIZATION_MAX_POSITION_PCT;
  const liquidityPenalty = getLiquidityRankingAdjustment(vol1h, vol6h, {
    neutralThreshold: minVol1h,
    ageHours,
  });
  const passesRecentLiquidity = passesDeadLiquidityFilter(vol1h, vol6h);

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
    + getHighCapQualityBonus(currentMcap, rangePct, driftPct, vol1h, vol24h)
    + getActiveLiquidityBonus(vol1h, vol6h)
    + getEarlyBidZoneBonus(ageHours, currentMcap)
    + getStaleLowCapPenalty(ageHours, currentMcap)
    + liquidityPenalty
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
    && passesRecentLiquidity
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
    passesRecentLiquidity,
    liquidityPenalty,
    volume1hPenalty: liquidityPenalty,
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

async function computeLateralizedCandidates(options = {}) {
  const requestedHours = Math.max(1, Math.min(Number(options.hours) || DEFAULT_LATERALIZATION_HOURS, 48));
  const minMcap = Math.max(DEFAULT_LATERALIZATION_MIN_MCAP, Number(options.minMcap) || DEFAULT_LATERALIZATION_MIN_MCAP);
  const minVol1h = Math.max(250, Number(options.minVol1h) || DEFAULT_LATERALIZATION_MIN_VOL_1H);
  const minVol24h = Math.max(0, Number(options.minVol24h) || DEFAULT_LATERALIZATION_MIN_VOL_24H);
  const maxLookbackHours = Math.max(
    requestedHours,
    DEFAULT_LATERALIZATION_SUB_1M_MIN_HOURS,
    DEFAULT_LATERALIZATION_GTE_1M_MIN_HOURS
  );
  const nowMs = Number(options.nowMs) || Date.now();

  const { rows } = await db.query(
    `WITH ranked_candidates AS (
       SELECT
         address,
         symbol,
         name,
         last_mcap,
         last_vol_1h,
         last_vol_6h,
         last_vol_24h,
         last_token_created_at_ms,
         monitor_priority,
         CASE
           WHEN COALESCE(last_mcap, 0) < 1000000 THEN 'sub_1m'
           WHEN COALESCE(last_mcap, 0) < 4000000 THEN 'm1_to_4m'
           ELSE 'm4_plus'
         END AS mcap_band,
         ROW_NUMBER() OVER (
           PARTITION BY CASE
             WHEN COALESCE(last_mcap, 0) < 1000000 THEN 'sub_1m'
             WHEN COALESCE(last_mcap, 0) < 4000000 THEN 'm1_to_4m'
             ELSE 'm4_plus'
           END
           ORDER BY
             COALESCE(last_vol_24h, 0) DESC,
             COALESCE(last_vol_1h, 0) DESC,
             COALESCE(last_mcap, 0) DESC,
             last_seen_at DESC
         ) AS band_rank
       FROM token_catalog
       WHERE eligible_for_monitoring = TRUE
         AND is_active_monitor_candidate = TRUE
         AND COALESCE(last_mcap, 0) >= $1
         AND COALESCE(last_vol_24h, 0) >= $2
     ),
     catalog_candidates AS (
       SELECT
         ranked.address,
         ranked.symbol,
         ranked.name,
         ranked.last_mcap,
         ranked.last_vol_1h,
         ranked.last_vol_6h,
         ranked.last_vol_24h,
         ranked.last_token_created_at_ms,
         ranked.monitor_priority
       FROM ranked_candidates ranked
       WHERE ranked.band_rank <= CASE ranked.mcap_band
         WHEN 'sub_1m' THEN $3::bigint
         WHEN 'm1_to_4m' THEN $4::bigint
         ELSE $5::bigint
       END
     )
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
     WHERE b.bucket_ts >= NOW() - ($6::int * INTERVAL '1 hour')
     ORDER BY c.address ASC, b.bucket_ts ASC`,
    [
      minMcap,
      minVol24h,
      getCandidatePoolBandLimit('sub_1m'),
      getCandidatePoolBandLimit('m1_to_4m'),
      getCandidatePoolBandLimit('m4_plus'),
      maxLookbackHours,
    ]
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
        last_vol_6h: candidate.volume6h,
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
        liquidityPenalty: metrics.liquidityPenalty,
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
        volume1hPenalty: metrics.volume1hPenalty,
        requestedHours,
        minimumWindowHours,
        windowHoursUsed: effectiveWindowHours,
        reasons: {
          passesMcap: latestWindowMcap != null && Number(latestWindowMcap) >= minMcap,
          passesRange: metrics.rangePct != null && metrics.rangeLimitPct != null && metrics.rangePct <= metrics.rangeLimitPct,
          passesDrift: metrics.driftPct != null && metrics.driftLimitPct != null && metrics.driftPct <= metrics.driftLimitPct,
          passesCoverage: metrics.coverageRatio != null && metrics.coverageRatio >= (Number(options.minCoverageRatio) || DEFAULT_LATERALIZATION_MIN_COVERAGE_RATIO),
          passesRecentLiquidity: metrics.passesRecentLiquidity,
          liquidityPenalty: metrics.liquidityPenalty,
          volume1hPenalty: metrics.volume1hPenalty,
          passesLiquidity: candidate.volume24h != null && Number(candidate.volume24h) >= minVol24h,
          passesPosition: metrics.passesPosition,
        },
      };
    })
    .filter(Boolean)
    .filter((item) => item.reasons.passesMcap && item.reasons.passesRange && item.reasons.passesDrift && item.reasons.passesCoverage && item.reasons.passesRecentLiquidity && item.reasons.passesLiquidity && item.reasons.passesPosition && item.bucketCount >= (Math.max(3, Number(options.minBuckets) || DEFAULT_LATERALIZATION_MIN_BUCKETS)))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if ((a.rangePct ?? Number.POSITIVE_INFINITY) !== (b.rangePct ?? Number.POSITIVE_INFINITY)) {
        return (a.rangePct ?? Number.POSITIVE_INFINITY) - (b.rangePct ?? Number.POSITIVE_INFINITY);
      }
      return (b.coverageRatio ?? 0) - (a.coverageRatio ?? 0);
    });
}

async function computeBidZoneCandidates(options = {}) {
  const requestedHours = Math.max(1, Math.min(Number(options.hours) || DEFAULT_BID_ZONE_HOURS, 48));
  const minMcap = Math.max(DEFAULT_BID_ZONE_MIN_MCAP, Number(options.minMcap) || DEFAULT_BID_ZONE_MIN_MCAP);
  const minVol1h = Math.max(250, Number(options.minVol1h) || DEFAULT_BID_ZONE_MIN_VOL_1H);
  const minVol24h = Math.max(0, Number(options.minVol24h) || DEFAULT_BID_ZONE_MIN_VOL_24H);
  const maxLookbackHours = Math.max(requestedHours, DEFAULT_LATERALIZATION_SUB_1M_MIN_HOURS, DEFAULT_LATERALIZATION_GTE_1M_MIN_HOURS);
  const nowMs = Number(options.nowMs) || Date.now();

  const { rows } = await db.query(
    `WITH ranked_candidates AS (
       SELECT
         address,
         symbol,
         name,
         last_mcap,
         last_vol_1h,
         last_vol_6h,
         last_vol_24h,
         last_token_created_at_ms,
         monitor_priority,
         CASE
           WHEN COALESCE(last_mcap, 0) < 1000000 THEN 'sub_1m'
           WHEN COALESCE(last_mcap, 0) < 4000000 THEN 'm1_to_4m'
           ELSE 'm4_plus'
         END AS mcap_band,
         ROW_NUMBER() OVER (
           PARTITION BY CASE
             WHEN COALESCE(last_mcap, 0) < 1000000 THEN 'sub_1m'
             WHEN COALESCE(last_mcap, 0) < 4000000 THEN 'm1_to_4m'
             ELSE 'm4_plus'
           END
           ORDER BY
             COALESCE(last_vol_24h, 0) DESC,
             COALESCE(last_vol_1h, 0) DESC,
             COALESCE(last_mcap, 0) DESC,
             last_seen_at DESC
         ) AS band_rank
       FROM token_catalog
       WHERE eligible_for_monitoring = TRUE
         AND is_active_monitor_candidate = TRUE
         AND COALESCE(last_mcap, 0) >= $1
         AND COALESCE(last_vol_24h, 0) >= $2
     ),
     catalog_candidates AS (
       SELECT
         ranked.address,
         ranked.symbol,
         ranked.name,
         ranked.last_mcap,
         ranked.last_vol_1h,
         ranked.last_vol_6h,
         ranked.last_vol_24h,
         ranked.last_token_created_at_ms,
         ranked.monitor_priority
       FROM ranked_candidates ranked
       WHERE ranked.band_rank <= CASE ranked.mcap_band
         WHEN 'sub_1m' THEN $3::bigint
         WHEN 'm1_to_4m' THEN $4::bigint
         ELSE $5::bigint
       END
     )
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
     WHERE b.bucket_ts >= NOW() - ($6::int * INTERVAL '1 hour')
     ORDER BY c.address ASC, b.bucket_ts ASC`,
    [
      minMcap,
      minVol24h,
      getCandidatePoolBandLimit('sub_1m'),
      getCandidatePoolBandLimit('m1_to_4m'),
      getCandidatePoolBandLimit('m4_plus'),
      maxLookbackHours,
    ]
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

      const closeValues = scopedBuckets
        .map((bucket) => bucket.closeMcap)
        .filter((value) => Number.isFinite(value));
      if (closeValues.length < 6) {
        return null;
      }

      const firstBucket = scopedBuckets.find((bucket) => bucket.openMcap != null || bucket.closeMcap != null) || null;
      const recentWindowHours = Math.max(6, Math.min(12, Math.round(effectiveWindowHours / 2)));
      const recentCutoffMs = nowMs - (recentWindowHours * 60 * 60 * 1000);
      const recentBuckets = scopedBuckets.filter((bucket) => bucket.bucketTsMs >= recentCutoffMs);
      const recentCloseValues = recentBuckets
        .map((bucket) => bucket.closeMcap)
        .filter((value) => Number.isFinite(value));
      const supportLevelMcap = computeQuantile(closeValues, 0.15);
      const resistanceLevelMcap = computeQuantile(closeValues, 0.85);
      const medianCloseMcap = computeQuantile(closeValues, 0.5);
      const recentLowerBand = computeQuantile(recentCloseValues, 0.15);
      const recentUpperBand = computeQuantile(recentCloseValues, 0.85);
      const recentMedianCloseMcap = computeQuantile(recentCloseValues, 0.5);
      const recentRangePct = Number.isFinite(recentLowerBand) && Number.isFinite(recentUpperBand) && Number(recentMedianCloseMcap) > 0
        ? ((recentUpperBand - recentLowerBand) / recentMedianCloseMcap) * 100
        : null;
      const supportTouchClusters = countTouchClusters(scopedBuckets, supportLevelMcap, {
        maxTouchBandPct: 0.05,
        maxBreakdownPct: 0.03,
      });

      const row = {
        last_mcap: candidate.catalogMcap,
        last_mcap_window: latestWindowMcap,
        support_level_mcap: supportLevelMcap,
        resistance_level_mcap: resistanceLevelMcap,
        median_close_mcap: medianCloseMcap,
        first_close_mcap: firstBucket ? (firstBucket.closeMcap == null ? firstBucket.openMcap : firstBucket.closeMcap) : null,
        recent_median_close_mcap: recentMedianCloseMcap,
        recent_range_pct: recentRangePct,
        support_touch_clusters: supportTouchClusters,
        last_vol_1h: candidate.volume1h,
        last_vol_6h: candidate.volume6h,
        last_vol_24h: candidate.volume24h,
        bucket_count: scopedBuckets.length,
        sample_count: scopedBuckets.reduce((sum, bucket) => sum + bucket.sampleCount, 0),
        last_token_created_at_ms: candidate.lastTokenCreatedAtMs,
      };

      const metrics = scoreBidZoneCandidate(row, {
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
        liquidityPenalty: metrics.liquidityPenalty,
        supportLevelMcap: metrics.supportLevelMcap,
        resistanceLevelMcap: metrics.resistanceLevelMcap,
        robustRangePct: metrics.robustRangePct,
        recentRangePct: metrics.recentRangePct,
        closeDriftPct: metrics.closeDriftPct,
        supportDistancePct: metrics.supportDistancePct,
        resistanceDistancePct: metrics.resistanceDistancePct,
        supportTouchClusters: metrics.supportTouchClusters,
        coverageRatio: metrics.coverageRatio,
        bucketCount: metrics.bucketCount,
        sampleCount: metrics.sampleCount,
        expectedBucketCount: metrics.expectedBucketCount,
        ageHours: metrics.ageHours,
        requestedHours,
        minimumWindowHours,
        windowHoursUsed: effectiveWindowHours,
        volume1hPenalty: metrics.volume1hPenalty,
        reasons: {
          passesMcap: latestWindowMcap != null && Number(latestWindowMcap) >= minMcap,
          passesCoverage: metrics.coverageRatio != null && metrics.coverageRatio >= (Number(options.minCoverageRatio) || DEFAULT_BID_ZONE_MIN_COVERAGE_RATIO),
          passesRecentLiquidity: metrics.passesRecentLiquidity,
          liquidityPenalty: metrics.liquidityPenalty,
          volume1hPenalty: metrics.volume1hPenalty,
          passesLiquidity: candidate.volume24h != null && Number(candidate.volume24h) >= minVol24h && candidate.volume1h != null && Number(candidate.volume1h) >= minVol1h,
          passesSupportDistance: metrics.supportDistancePct != null
            && metrics.supportDistancePct >= (Number.isFinite(Number(options.minSupportDistancePct)) ? Number(options.minSupportDistancePct) : DEFAULT_BID_ZONE_MIN_SUPPORT_DISTANCE_PCT)
            && metrics.supportDistancePct <= (Number(options.maxSupportDistancePct) || DEFAULT_BID_ZONE_MAX_SUPPORT_DISTANCE_PCT),
          passesTouches: metrics.supportTouchClusters >= (Math.max(1, Number(options.minSupportTouches) || DEFAULT_BID_ZONE_MIN_SUPPORT_TOUCHES)),
          passesRecentCompression: metrics.recentRangePct != null && metrics.recentRangePct <= (Number(options.maxRecentRangePct) || DEFAULT_BID_ZONE_MAX_RECENT_RANGE_PCT),
          passesCloseDrift: metrics.closeDriftPct != null && metrics.closeDriftPct <= (Number(options.maxCloseDriftPct) || DEFAULT_BID_ZONE_MAX_CLOSE_DRIFT_PCT),
        },
      };
    })
    .filter(Boolean)
    .filter((item) => item.reasons.passesMcap
      && item.reasons.passesCoverage
      && item.reasons.passesRecentLiquidity
      && item.reasons.passesLiquidity
      && item.reasons.passesSupportDistance
      && item.reasons.passesTouches
      && item.reasons.passesRecentCompression
      && item.reasons.passesCloseDrift
      && item.bucketCount >= (Math.max(3, Number(options.minBuckets) || DEFAULT_BID_ZONE_MIN_BUCKETS)))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if ((a.supportDistancePct ?? Number.POSITIVE_INFINITY) !== (b.supportDistancePct ?? Number.POSITIVE_INFINITY)) {
        return (a.supportDistancePct ?? Number.POSITIVE_INFINITY) - (b.supportDistancePct ?? Number.POSITIVE_INFINITY);
      }
      return (b.supportTouchClusters ?? 0) - (a.supportTouchClusters ?? 0);
    });
}

async function debugLateralizedCandidateByAddress(address, options = {}) {
  const addr = String(address || '').trim();
  if (!isValidAddress(addr)) {
    throw new Error('Invalid token address format');
  }

  const requestedHours = Math.max(1, Math.min(Number(options.hours) || DEFAULT_LATERALIZATION_HOURS, 48));
  const minMcap = Math.max(DEFAULT_LATERALIZATION_MIN_MCAP, Number(options.minMcap) || DEFAULT_LATERALIZATION_MIN_MCAP);
  const minVol1h = Math.max(250, Number(options.minVol1h) || DEFAULT_LATERALIZATION_MIN_VOL_1H);
  const minVol24h = Math.max(0, Number(options.minVol24h) || DEFAULT_LATERALIZATION_MIN_VOL_24H);
  const nowMs = Number(options.nowMs) || Date.now();

  const { rows } = await db.query(
    `WITH ranked_candidates AS (
       SELECT
         tc.*,
         CASE
           WHEN COALESCE(tc.last_mcap, 0) < 1000000 THEN 'sub_1m'
           WHEN COALESCE(tc.last_mcap, 0) < 4000000 THEN 'm1_to_4m'
           ELSE 'm4_plus'
         END AS mcap_band,
         ROW_NUMBER() OVER (
           PARTITION BY CASE
             WHEN COALESCE(tc.last_mcap, 0) < 1000000 THEN 'sub_1m'
             WHEN COALESCE(tc.last_mcap, 0) < 4000000 THEN 'm1_to_4m'
             ELSE 'm4_plus'
           END
           ORDER BY
             COALESCE(tc.last_vol_24h, 0) DESC,
             COALESCE(tc.last_vol_1h, 0) DESC,
             COALESCE(tc.last_mcap, 0) DESC,
             tc.last_seen_at DESC
         ) AS band_rank
       FROM token_catalog tc
       WHERE tc.eligible_for_monitoring = TRUE
         AND tc.is_active_monitor_candidate = TRUE
         AND COALESCE(tc.last_mcap, 0) >= $2
         AND COALESCE(tc.last_vol_24h, 0) >= $3
     )
     SELECT
       tc.address,
       tc.symbol,
       tc.name,
       tc.monitor_priority,
       tc.eligible_for_monitoring,
       tc.is_active_monitor_candidate,
       tc.last_mcap,
       tc.last_vol_1h,
       tc.last_vol_6h,
       tc.last_vol_24h,
       tc.last_token_created_at_ms,
       tc.last_seen_at,
       ranked.mcap_band,
       ranked.band_rank
     FROM token_catalog tc
     LEFT JOIN ranked_candidates ranked
       ON ranked.address = tc.address
     WHERE tc.address = $1
     LIMIT 1`,
    [addr, minMcap, minVol24h]
  );

  const token = rows[0] || null;
  if (!token) {
    return {
      address: addr,
      found: false,
      error: 'Token not found in token_catalog',
    };
  }

  const catalogMcap = toNumberOrNull(token.last_mcap);
  const band = token.mcap_band || getCandidatePoolBand(catalogMcap);
  const bandLimit = getCandidatePoolBandLimit(band);
  const minimumWindowHours = getMinimumWindowHoursForMcap(catalogMcap);
  const effectiveWindowHours = Math.max(requestedHours, minimumWindowHours);
  const maxLookbackHours = Math.max(
    requestedHours,
    DEFAULT_LATERALIZATION_SUB_1M_MIN_HOURS,
    DEFAULT_LATERALIZATION_GTE_1M_MIN_HOURS
  );
  const history = await listHistoryByAddress(addr, {
    hours: maxLookbackHours,
    limit: maxLookbackHours * 60,
  });
  const cutoffMs = nowMs - (effectiveWindowHours * 60 * 60 * 1000);
  const scopedBuckets = history.filter((bucket) => new Date(bucket.ts).getTime() >= cutoffMs);
  const latestBucket = scopedBuckets[scopedBuckets.length - 1] || null;
  const latestWindowMcap = latestBucket
    ? (latestBucket.closeMcap == null ? latestBucket.openMcap : latestBucket.closeMcap)
    : null;
  const firstBucket = scopedBuckets.find((bucket) => bucket.openMcap != null || bucket.closeMcap != null) || null;
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
    last_mcap: catalogMcap,
    last_mcap_window: latestWindowMcap,
    max_high_mcap: maxHighMcap,
    min_low_mcap: minLowMcap,
    avg_close_mcap: avgCloseMcap,
    first_mcap: firstBucket ? (firstBucket.openMcap == null ? firstBucket.closeMcap : firstBucket.openMcap) : null,
    close_mcap_stddev: computeSampleStddev(closeValues),
    last_vol_1h: toNumberOrNull(token.last_vol_1h),
    last_vol_6h: toNumberOrNull(token.last_vol_6h),
    last_vol_24h: toNumberOrNull(token.last_vol_24h),
    bucket_count: scopedBuckets.length,
    sample_count: scopedBuckets.reduce((sum, bucket) => sum + bucket.sampleCount, 0),
    last_token_created_at_ms: token.last_token_created_at_ms == null ? null : Number(token.last_token_created_at_ms),
  };

  const metrics = scoreLateralizedCandidate(row, {
    ...options,
    hours: effectiveWindowHours,
    nowMs,
    minMcap,
    minVol1h,
    minVol24h,
  });

  const reasons = {
    passesMcap: latestWindowMcap != null && Number(latestWindowMcap) >= minMcap,
    passesRange: metrics.rangePct != null && metrics.rangeLimitPct != null && metrics.rangePct <= metrics.rangeLimitPct,
    passesDrift: metrics.driftPct != null && metrics.driftLimitPct != null && metrics.driftPct <= metrics.driftLimitPct,
    passesCoverage: metrics.coverageRatio != null && metrics.coverageRatio >= (Number(options.minCoverageRatio) || DEFAULT_LATERALIZATION_MIN_COVERAGE_RATIO),
    passesRecentLiquidity: metrics.passesRecentLiquidity,
    liquidityPenalty: metrics.liquidityPenalty,
    volume1hPenalty: metrics.volume1hPenalty,
    passesLiquidity: row.last_vol_24h != null && Number(row.last_vol_24h) >= minVol24h,
    passesPosition: metrics.passesPosition,
  };

  const passesAllFilters = reasons.passesMcap
    && reasons.passesRange
    && reasons.passesDrift
    && reasons.passesCoverage
    && reasons.passesRecentLiquidity
    && reasons.passesLiquidity
    && reasons.passesPosition
    && metrics.bucketCount >= (Math.max(3, Number(options.minBuckets) || DEFAULT_LATERALIZATION_MIN_BUCKETS));

  return {
    address: addr,
    found: true,
    token: {
      symbol: token.symbol || null,
      name: token.name || null,
      monitorPriority: token.monitor_priority || 'dormant',
      eligibleForMonitoring: Boolean(token.eligible_for_monitoring),
      isActiveMonitorCandidate: Boolean(token.is_active_monitor_candidate),
      mcap: catalogMcap,
      volume1h: toNumberOrNull(token.last_vol_1h),
      volume6h: toNumberOrNull(token.last_vol_6h),
      volume24h: toNumberOrNull(token.last_vol_24h),
      lastTokenCreatedAtMs: token.last_token_created_at_ms == null ? null : Number(token.last_token_created_at_ms),
      lastSeenAt: token.last_seen_at || null,
    },
    pool: {
      mcapBand: band,
      bandRank: Number.isFinite(Number(token.band_rank)) ? Number(token.band_rank) : null,
      bandLimit,
      passesCandidatePool: Number.isFinite(Number(token.band_rank)) ? Number(token.band_rank) <= bandLimit : false,
    },
    window: {
      requestedHours,
      minimumWindowHours,
      effectiveWindowHours,
      maxLookbackHours,
      scopedBucketCount: scopedBuckets.length,
      expectedBucketCount: metrics.expectedBucketCount,
      firstBucketAt: scopedBuckets[0]?.ts || null,
      lastBucketAt: scopedBuckets[scopedBuckets.length - 1]?.ts || null,
    },
    metrics: {
      score: metrics.score,
      rangePct: metrics.rangePct,
      rangeLimitPct: metrics.rangeLimitPct,
      driftPct: metrics.driftPct,
      driftLimitPct: metrics.driftLimitPct,
      coverageRatio: metrics.coverageRatio,
      currentPositionPct: metrics.currentPositionPct,
      ageHours: metrics.ageHours,
      bucketCount: metrics.bucketCount,
      sampleCount: metrics.sampleCount,
      liquidityPenalty: metrics.liquidityPenalty,
      volume1hPenalty: metrics.volume1hPenalty,
      latestWindowMcap,
      catalogMcap,
    },
    reasons,
    passesAllFilters,
  };
}

async function listLateralizedCandidates(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_LATERALIZATION_LIMIT, 200));
  const candidates = await computeLateralizedCandidates(options);
  return candidates.slice(0, limit);
}

async function listBidZoneCandidates(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_BID_ZONE_LIMIT, 200));
  const candidates = await computeBidZoneCandidates(options);
  return candidates.slice(0, limit);
}

module.exports = {
  computeLateralizedCandidates,
  computeBidZoneCandidates,
  upsertSnapshotBucket,
  listHistoryByAddress,
  deleteByAddresses,
  listCurrentAndBaselineByAddresses,
  listLateralizedCandidates,
  listBidZoneCandidates,
  debugLateralizedCandidateByAddress,
  __private: {
    computeAgeHours,
    computeQuantile,
    countTouchClusters,
    computeExpectedBucketCount,
    getAgeRankingBonus,
    getBucketDate,
    getDriftLimitPct,
    getHighCapQualityBonus,
    getActiveLiquidityBonus,
    getCandidatePoolBand,
    getCandidatePoolBandLimit,
    getEarlyBidZoneBonus,
    getMcapRankingBonus,
    getMinimumWindowHoursForMcap,
    getRangeLimitPct,
    getStaleLowCapPenalty,
    getLiquidityRankingAdjustment,
    passesDeadLiquidityFilter,
    computeSampleStddev,
    scoreBidZoneCandidate,
    scoreLateralizedCandidate,
  },
};
