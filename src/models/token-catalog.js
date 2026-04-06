const db = require('./db');
const adminBlockedToken = require('./admin-blocked-token');
const { isValidAddress } = require('./user-token');
const { normalizeChain, normalizeText, sanitizeHttpUrl, sanitizeAssetUrl } = require('../utils/url-safety');

const PUMPFUN_MIGRATION_MIN_MCAP = 30000;
const METEORA_HIGH_TIER_MIN_VOL_24H = 100000;
const METEORA_NORMAL_TIER_MIN_VOL_24H = 15000;
const METEORA_PRIORITY_TIERS = ['high', 'normal', 'low'];

function normalizeSource(source) {
  const value = String(normalizeText(source, 64) || 'unknown').trim().toLowerCase();
  return value || 'unknown';
}

function toNullableText(value, maxLength = 256) {
  return normalizeText(value, maxLength);
}

function toDateOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeMeteoraPriorityTier(value) {
  const tier = String(value || '').trim().toLowerCase();
  return METEORA_PRIORITY_TIERS.includes(tier) ? tier : null;
}

function buildMeteoraEligibilityWhereSql(tokenAlias = 'tc', stateAlias = 'ms') {
  return `${tokenAlias}.is_active_monitor_candidate = TRUE
    AND (
      COALESCE(${tokenAlias}.last_mcap, 0) >= 100000
      OR ${stateAlias}.has_pool = TRUE
    )`;
}

function buildMeteoraPriorityTierSql(tokenAlias = 'tc') {
  return `CASE
    WHEN COALESCE(${tokenAlias}.last_vol_24h, 0) >= ${METEORA_HIGH_TIER_MIN_VOL_24H} THEN 'high'
    WHEN COALESCE(${tokenAlias}.last_vol_24h, 0) >= ${METEORA_NORMAL_TIER_MIN_VOL_24H} THEN 'normal'
    ELSE 'low'
  END`;
}

function emptyMeteoraPriorityCounts() {
  return {
    high: 0,
    normal: 0,
    low: 0,
  };
}

async function upsertToken(token) {
  await adminBlockedToken.ensureTable();
  const address = String(token.address || '').trim();
  if (!isValidAddress(address)) {
    throw new Error('Invalid token address format');
  }

  const chain = normalizeChain(token.chain);
  const source = normalizeSource(token.source);
  const symbol = normalizeText(token.symbol, 64);
  const name = normalizeText(token.name, 160);
  const lastPairAddress = isValidAddress(String(token.pairAddress || '').trim()) ? String(token.pairAddress).trim() : null;
  const lastPairUrl = sanitizeHttpUrl(token.pairUrl);
  const lastImageUrl = sanitizeAssetUrl(token.imageUrl);
  const lastTwitterUrl = sanitizeHttpUrl(token.twitterUrl);
  const isActiveMonitorCandidate = token.isActiveMonitorCandidate == null ? true : !!token.isActiveMonitorCandidate;
  const lastMcap = Number.isFinite(Number(token.mcap)) ? Number(token.mcap) : null;
  const lastPrice = Number.isFinite(Number(token.price)) ? Number(token.price) : null;
  const lastPriceChange1h = Number.isFinite(Number(token.priceChange1h)) ? Number(token.priceChange1h) : null;
  const lastPriceChange6h = Number.isFinite(Number(token.priceChange6h)) ? Number(token.priceChange6h) : null;
  const lastPriceChange24h = Number.isFinite(Number(token.priceChange24h)) ? Number(token.priceChange24h) : null;
  const lastTokenCreatedAtMs = Number.isFinite(Number(token.tokenCreatedAt)) ? Math.trunc(Number(token.tokenCreatedAt)) : null;
  const qualifiesPumpMigrationBoost = source === 'pumpfun-migrated' && lastMcap != null && lastMcap >= PUMPFUN_MIGRATION_MIN_MCAP;
  const migrationGraceUntil = qualifiesPumpMigrationBoost
    ? toDateOrNull(token.migrationGraceUntil) || new Date(Date.now() + (10 * 60 * 1000))
    : null;

  const { rows } = await db.query(
    `INSERT INTO token_catalog (
       address, chain, symbol, name, source,
       last_mcap, last_price, last_pair_address, last_pair_url,
       last_image_url, last_twitter_url,
       last_price_change_1h, last_price_change_6h, last_price_change_24h,
       last_token_created_at_ms, migration_grace_until,
       is_active_monitor_candidate
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       CASE
         WHEN EXISTS (SELECT 1 FROM admin_blocked_tokens ab WHERE ab.address = $18)
           THEN FALSE
         ELSE $17
       END
     )
     ON CONFLICT (address) DO UPDATE SET
       chain = EXCLUDED.chain,
       symbol = COALESCE(EXCLUDED.symbol, token_catalog.symbol),
       name = COALESCE(EXCLUDED.name, token_catalog.name),
       source = EXCLUDED.source,
       last_seen_at = NOW(),
       last_mcap = COALESCE(EXCLUDED.last_mcap, token_catalog.last_mcap),
       last_price = COALESCE(EXCLUDED.last_price, token_catalog.last_price),
       last_pair_address = COALESCE(EXCLUDED.last_pair_address, token_catalog.last_pair_address),
       last_pair_url = COALESCE(EXCLUDED.last_pair_url, token_catalog.last_pair_url),
       last_image_url = COALESCE(EXCLUDED.last_image_url, token_catalog.last_image_url),
       last_twitter_url = COALESCE(EXCLUDED.last_twitter_url, token_catalog.last_twitter_url),
       last_price_change_1h = COALESCE(EXCLUDED.last_price_change_1h, token_catalog.last_price_change_1h),
       last_price_change_6h = COALESCE(EXCLUDED.last_price_change_6h, token_catalog.last_price_change_6h),
       last_price_change_24h = COALESCE(EXCLUDED.last_price_change_24h, token_catalog.last_price_change_24h),
       last_token_created_at_ms = COALESCE(EXCLUDED.last_token_created_at_ms, token_catalog.last_token_created_at_ms),
       migration_grace_until = CASE
         WHEN EXCLUDED.source = 'pumpfun-migrated' AND $19 = TRUE THEN
           CASE
             WHEN token_catalog.migration_grace_until IS NULL OR token_catalog.migration_grace_until < NOW()
               THEN EXCLUDED.migration_grace_until
             ELSE token_catalog.migration_grace_until
           END
         ELSE token_catalog.migration_grace_until
       END,
       is_active_monitor_candidate = CASE
         WHEN EXISTS (SELECT 1 FROM admin_blocked_tokens ab WHERE ab.address = token_catalog.address)
           THEN FALSE
         ELSE EXCLUDED.is_active_monitor_candidate
       END,
       next_evaluation_at = CASE
         WHEN EXCLUDED.source = 'pumpfun-migrated' AND $19 = TRUE
           THEN LEAST(token_catalog.next_evaluation_at, NOW())
         ELSE token_catalog.next_evaluation_at
       END,
       metadata_updated_at = NOW()
     RETURNING *`,
    [
      address,
      chain,
      symbol,
      name,
      source,
      lastMcap,
      lastPrice,
      lastPairAddress,
      lastPairUrl,
      lastImageUrl,
      lastTwitterUrl,
      lastPriceChange1h,
      lastPriceChange6h,
      lastPriceChange24h,
      lastTokenCreatedAtMs,
      migrationGraceUntil,
      isActiveMonitorCandidate,
      address,
      qualifiesPumpMigrationBoost,
    ]
  );

  return rows[0];
}

async function getByAddress(address) {
  const addr = String(address || '').trim();
  const { rows } = await db.query(
    'SELECT * FROM token_catalog WHERE address = $1 LIMIT 1',
    [addr]
  );
  return rows[0] || null;
}

async function listRecent(limit = 100) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
  const { rows } = await db.query(
    `SELECT *
     FROM token_catalog
     ORDER BY last_seen_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return rows;
}

async function listDueForEvaluation(limit = 25) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 5000));
  const { rows } = await db.query(
    `SELECT *
     FROM token_catalog
     WHERE is_active_monitor_candidate = TRUE
       AND next_evaluation_at <= NOW()
     ORDER BY CASE
                WHEN COALESCE(monitor_priority, 'dormant') = 'high'
                  AND COALESCE(last_mcap, 0) >= 100000
                  AND COALESCE(last_vol_6h, 0) >= 30000 THEN 0
                WHEN COALESCE(monitor_priority, 'dormant') = 'high'
                  AND COALESCE(last_mcap, 0) >= 100000
                  AND COALESCE(last_vol_6h, 0) >= 15000 THEN 1
                WHEN COALESCE(monitor_priority, 'dormant') = 'high'
                  AND COALESCE(last_mcap, 0) >= 100000 THEN 2
                WHEN COALESCE(monitor_priority, 'dormant') = 'normal' THEN 3
                WHEN COALESCE(monitor_priority, 'dormant') = 'low'
                  AND COALESCE(last_mcap, 0) >= 15000 THEN 4
                WHEN COALESCE(monitor_priority, 'dormant') = 'low' THEN 5
                ELSE 6
              END ASC,
              next_evaluation_at ASC,
              COALESCE(last_mcap, 0) DESC,
              COALESCE(last_vol_24h, last_vol_6h, last_vol_1h, last_vol_5m, 0) DESC,
              last_seen_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return rows;
}

async function countDueForEvaluationSummary() {
  const { rows } = await db.query(
    `SELECT
       COALESCE(monitor_priority, 'dormant') AS priority,
       COUNT(*)::int AS count,
       COALESCE(MAX((EXTRACT(EPOCH FROM (NOW() - next_evaluation_at)) * 1000)::bigint), 0)::bigint AS max_overdue_ms
     FROM token_catalog
     WHERE is_active_monitor_candidate = TRUE
       AND next_evaluation_at <= NOW()
     GROUP BY COALESCE(monitor_priority, 'dormant')`
  );

  const byPriority = {
    high: 0,
    normal: 0,
    low: 0,
    dormant: 0,
    other: 0,
  };
  const maxOverdueMsByPriority = {
    high: 0,
    normal: 0,
    low: 0,
    dormant: 0,
    other: 0,
  };

  let total = 0;
  let maxOverdueMs = 0;

  for (const row of rows) {
    const rawPriority = String(row.priority || '').trim().toLowerCase();
    const priority = Object.prototype.hasOwnProperty.call(byPriority, rawPriority)
      ? rawPriority
      : 'other';
    const count = Number(row.count) || 0;
    const overdueMs = Number(row.max_overdue_ms) || 0;

    byPriority[priority] += count;
    maxOverdueMsByPriority[priority] = Math.max(maxOverdueMsByPriority[priority], overdueMs);
    total += count;
    maxOverdueMs = Math.max(maxOverdueMs, overdueMs);
  }

  return {
    total,
    byPriority,
    maxOverdueMs,
    maxOverdueMsByPriority,
  };
}

async function listDueForMeteoraSnapshots(limit = 25, tier = null, checkedBefore = null) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 1000));
  const normalizedTier = normalizeMeteoraPriorityTier(tier);
  const params = [safeLimit];
  let tierFilterSql = '';
  let checkedBeforeSql = '';

  if (normalizedTier) {
    params.push(normalizedTier);
    tierFilterSql = `AND ${buildMeteoraPriorityTierSql('tc')} = $${params.length}`;
  }

  const checkedBeforeDate = toDateOrNull(checkedBefore);
  if (checkedBeforeDate) {
    params.push(checkedBeforeDate);
    checkedBeforeSql = `AND (tc.last_meteora_checked_at IS NULL OR tc.last_meteora_checked_at <= $${params.length})`;
  }

  const { rows } = await db.query(
    `SELECT
       tc.*,
       ${buildMeteoraPriorityTierSql('tc')} AS meteora_priority_tier
     FROM token_catalog tc
     LEFT JOIN token_meteora_state ms
       ON ms.token_address = tc.address
     WHERE ${buildMeteoraEligibilityWhereSql('tc', 'ms')}
       ${tierFilterSql}
       ${checkedBeforeSql}
     ORDER BY tc.last_meteora_checked_at ASC NULLS FIRST,
              tc.last_seen_at DESC,
              tc.address ASC
     LIMIT $1`,
    params
  );
  return rows;
}

async function countDueForMeteoraSnapshots() {
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS count
     FROM token_catalog tc
     LEFT JOIN token_meteora_state ms
       ON ms.token_address = tc.address
     WHERE ${buildMeteoraEligibilityWhereSql('tc', 'ms')}`
  );

  return Number(rows[0]?.count) || 0;
}

async function countDueForMeteoraSnapshotsByTier() {
  const { rows } = await db.query(
    `SELECT
       ${buildMeteoraPriorityTierSql('tc')} AS meteora_priority_tier,
       COUNT(*)::int AS count
     FROM token_catalog tc
     LEFT JOIN token_meteora_state ms
       ON ms.token_address = tc.address
     WHERE ${buildMeteoraEligibilityWhereSql('tc', 'ms')}
     GROUP BY ${buildMeteoraPriorityTierSql('tc')}`
  );

  const byTier = emptyMeteoraPriorityCounts();
  let total = 0;

  for (const row of rows) {
    const tier = normalizeMeteoraPriorityTier(row.meteora_priority_tier);
    if (!tier) {
      continue;
    }
    const count = Number(row.count) || 0;
    byTier[tier] += count;
    total += count;
  }

  return {
    total,
    byTier,
  };
}

async function markMeteoraChecked(addresses, checkedAt = new Date(), runner = db) {
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

  const timestamp = toDateOrNull(checkedAt) || new Date();
  const result = await runner.query(
    `UPDATE token_catalog
     SET last_meteora_checked_at = $2
     WHERE address = ANY($1::varchar[])`,
    [unique, timestamp]
  );

  return result.rowCount || 0;
}

async function listEligibleVisible(limit = 500, minMcap = 30000) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 5000));
  const safeMinMcap = Math.max(0, Number.isFinite(Number(minMcap)) ? Number(minMcap) : 30000);
  const { rows } = await db.query(
    `SELECT
       address,
       symbol,
       name,
       eligible_for_monitoring,
       last_mcap,
       last_seen_at,
       last_evaluated_at
     FROM token_catalog
     WHERE eligible_for_monitoring = TRUE
       AND COALESCE(last_mcap, 0) >= $2
     ORDER BY last_seen_at DESC, last_evaluated_at DESC NULLS LAST
     LIMIT $1`,
    [safeLimit, safeMinMcap]
  );
  return rows;
}

async function listDashboardMonitored(limit = 500, minMcap = 30000) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 5000));
  const safeMinMcap = Math.max(0, Number.isFinite(Number(minMcap)) ? Number(minMcap) : 30000);
  const { rows } = await db.query(
    `SELECT
       address,
       symbol,
       name,
       eligible_for_monitoring,
       last_mcap,
       last_price,
       last_vol_5m,
       last_vol_1h,
       last_vol_6h,
       last_vol_24h,
       last_price_change_1h,
       last_price_change_6h,
       last_price_change_24h,
       last_token_created_at_ms,
       last_pair_address,
       last_pair_url,
       last_image_url,
       last_twitter_url,
       monitor_priority,
       last_seen_at,
       last_evaluated_at
     FROM token_catalog
     WHERE eligible_for_monitoring = TRUE
       AND COALESCE(last_mcap, 0) >= $2
     ORDER BY last_seen_at DESC, last_evaluated_at DESC NULLS LAST
     LIMIT $1`,
    [safeLimit, safeMinMcap]
  );
  return rows;
}

async function listDashboardMetadataByAddresses(addresses) {
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

  const { rows } = await db.query(
    `SELECT
       address,
       symbol,
       name,
       last_pair_address,
       last_pair_url,
       last_image_url,
       last_twitter_url,
       last_mcap,
       last_vol_1h,
       last_vol_6h,
       last_vol_24h,
       last_token_created_at_ms
     FROM token_catalog
     WHERE address = ANY($1::varchar[])`,
    [unique]
  );

  return rows;
}

async function scheduleImmediateEvaluation(address) {
  const addr = String(address || '').trim();
  if (!isValidAddress(addr)) {
    throw new Error('Invalid token address format');
  }

  const { rows } = await db.query(
    `UPDATE token_catalog
     SET next_evaluation_at = NOW()
     WHERE address = $1
     RETURNING *`,
    [addr]
  );

  return rows[0] || null;
}

async function reactivateSoftArchivedToken(address, options = {}) {
  await adminBlockedToken.ensureTable();
  const addr = String(address || '').trim();
  if (!isValidAddress(addr)) {
    throw new Error('Invalid token address format');
  }

  const source = normalizeSource(options.source || 'dexscreener-discovery');
  const { rows } = await db.query(
    `UPDATE token_catalog
     SET source = $2,
         is_active_monitor_candidate = TRUE,
         eligible_for_monitoring = FALSE,
         suppressed_reason = NULL,
         next_evaluation_at = NOW(),
         last_seen_at = NOW(),
         metadata_updated_at = NOW()
     WHERE address = $1
       AND suppressed_reason = 'cleanup_soft_archive'
       AND NOT EXISTS (
         SELECT 1
         FROM admin_blocked_tokens ab
         WHERE ab.address = token_catalog.address
       )
     RETURNING *`,
    [addr, source]
  );

  return rows[0] || null;
}

async function applyEvaluationResult(address, result) {
  const addr = String(address || '').trim();
  const eligibilityState = toNullableText(result.eligibilityState) || 'unknown';
  const eligibleForMonitoring = !!result.eligibleForMonitoring;
  const suppressedReason = toNullableText(result.suppressedReason);
  const nextEvaluationAt = result.nextEvaluationAt || new Date(Date.now() + 10 * 60 * 1000);
  const lastEvaluationError = toNullableText(result.lastEvaluationError);
  const errorCount = Number.isInteger(result.evaluationErrorCount) ? result.evaluationErrorCount : 0;
  const symbol = toNullableText(result.symbol, 64);
  const name = toNullableText(result.name, 160);
  const pairAddress = isValidAddress(String(result.pairAddress || '').trim()) ? String(result.pairAddress).trim() : null;
  const pairUrl = sanitizeHttpUrl(result.pairUrl);
  const imageUrl = sanitizeAssetUrl(result.imageUrl);
  const twitterUrl = sanitizeHttpUrl(result.twitterUrl);
  const lastMcap = Number.isFinite(Number(result.mcap)) ? Number(result.mcap) : null;
  const lastPrice = Number.isFinite(Number(result.price)) ? Number(result.price) : null;
  const monitorPriority = toNullableText(result.monitorPriority, 32) || 'dormant';
  const lastVol5m = Number.isFinite(Number(result.vol5m)) ? Number(result.vol5m) : null;
  const lastVol1h = Number.isFinite(Number(result.vol1h)) ? Number(result.vol1h) : null;
  const lastVol6h = Number.isFinite(Number(result.vol6h)) ? Number(result.vol6h) : null;
  const lastVol24h = Number.isFinite(Number(result.vol24h)) ? Number(result.vol24h) : null;
  const lastPriceChange1h = Number.isFinite(Number(result.priceChange1h)) ? Number(result.priceChange1h) : null;
  const lastPriceChange6h = Number.isFinite(Number(result.priceChange6h)) ? Number(result.priceChange6h) : null;
  const lastPriceChange24h = Number.isFinite(Number(result.priceChange24h)) ? Number(result.priceChange24h) : null;
  const lastTokenCreatedAtMs = Number.isFinite(Number(result.tokenCreatedAt)) ? Math.trunc(Number(result.tokenCreatedAt)) : null;

  const { rows } = await db.query(
    `UPDATE token_catalog
     SET eligibility_state = $2,
         eligible_for_monitoring = $3,
         suppressed_reason = $4,
         last_evaluated_at = NOW(),
         next_evaluation_at = $5,
         last_evaluation_error = $6,
         evaluation_error_count = $7,
         last_eligible_at = CASE WHEN $3 THEN NOW() ELSE last_eligible_at END,
         symbol = COALESCE($8, symbol),
         name = COALESCE($9, name),
         last_pair_address = COALESCE($10, last_pair_address),
         last_pair_url = COALESCE($11, last_pair_url),
         last_image_url = COALESCE($12, last_image_url),
         last_twitter_url = COALESCE($13, last_twitter_url),
         last_mcap = COALESCE($14, last_mcap),
         last_price = COALESCE($15, last_price),
         monitor_priority = $16,
         last_vol_5m = COALESCE($17, last_vol_5m),
         last_vol_1h = COALESCE($18, last_vol_1h),
         last_vol_6h = COALESCE($19, last_vol_6h),
         last_vol_24h = COALESCE($20, last_vol_24h),
         last_price_change_1h = COALESCE($21, last_price_change_1h),
         last_price_change_6h = COALESCE($22, last_price_change_6h),
         last_price_change_24h = COALESCE($23, last_price_change_24h),
         last_token_created_at_ms = COALESCE($24, last_token_created_at_ms),
         metadata_updated_at = CASE
           WHEN $8 IS NOT NULL OR $9 IS NOT NULL OR $10 IS NOT NULL OR $11 IS NOT NULL OR $12 IS NOT NULL OR $13 IS NOT NULL OR $14 IS NOT NULL OR $15 IS NOT NULL OR $17 IS NOT NULL OR $18 IS NOT NULL OR $19 IS NOT NULL OR $20 IS NOT NULL OR $21 IS NOT NULL OR $22 IS NOT NULL OR $23 IS NOT NULL OR $24 IS NOT NULL
           THEN NOW()
           ELSE metadata_updated_at
         END
     WHERE address = $1
     RETURNING *`,
    [
      addr,
      eligibilityState,
      eligibleForMonitoring,
      suppressedReason,
      nextEvaluationAt,
      lastEvaluationError,
      errorCount,
      symbol,
      name,
      pairAddress,
      pairUrl,
      imageUrl,
      twitterUrl,
      lastMcap,
      lastPrice,
      monitorPriority,
      lastVol5m,
      lastVol1h,
      lastVol6h,
      lastVol24h,
      lastPriceChange1h,
      lastPriceChange6h,
      lastPriceChange24h,
      lastTokenCreatedAtMs,
    ]
  );

  return rows[0] || null;
}

async function applyQuarantineCleanup(options = {}) {
  const quarantineRecheckMs = Math.max(60 * 1000, Number(options.quarantineRecheckMs) || (6 * 60 * 60 * 1000));

  const quarantineQuery = `
    WITH protected_addresses AS (
      SELECT DISTINCT address FROM user_tokens
      UNION
      SELECT DISTINCT address FROM user_starred_tokens
      UNION
      SELECT DISTINCT address FROM user_blocklist
      UNION
      SELECT DISTINCT address FROM token_catalog WHERE source = 'user-manual'
    )
    UPDATE token_catalog tc
    SET eligible_for_monitoring = FALSE,
        monitor_priority = 'dormant',
        suppressed_reason = 'cleanup_quarantine',
        next_evaluation_at = NOW() + ($1 * INTERVAL '1 millisecond')
    WHERE tc.source = 'dexscreener-discovery'
      AND tc.is_active_monitor_candidate = TRUE
      AND COALESCE(tc.last_mcap, 0) < 15000
      AND tc.eligible_for_monitoring = FALSE
      AND (tc.last_vol_24h IS NULL OR tc.last_vol_24h < 1000)
      AND NOT EXISTS (
        SELECT 1
        FROM protected_addresses pa
        WHERE pa.address = tc.address
      )
    RETURNING tc.address, tc.source
  `;

  const quarantineResult = await db.query(quarantineQuery, [quarantineRecheckMs]);

  const quarantinedBySource = quarantineResult.rows.reduce((acc, row) => {
    acc[row.source] = (acc[row.source] || 0) + 1;
    return acc;
  }, {});

  return {
    quarantined: quarantineResult.rowCount,
    quarantinedBySource,
  };
}

async function applySoftArchiveCleanup(options = {}) {
  const archiveLimit = Math.max(1, Math.min(Number(options.archiveLimit) || 400, 5000));
  const softArchiveRecheckMs = Math.max(60 * 1000, Number(options.softArchiveRecheckMs) || (30 * 24 * 60 * 60 * 1000));

  const archiveQuery = `
    WITH protected_addresses AS (
      SELECT DISTINCT address FROM user_tokens
      UNION
      SELECT DISTINCT address FROM user_starred_tokens
      UNION
      SELECT DISTINCT address FROM user_blocklist
      UNION
      SELECT DISTINCT address FROM token_catalog WHERE source = 'user-manual'
    ),
    candidate_addresses AS (
      SELECT tc.address
      FROM token_catalog tc
      WHERE COALESCE(tc.last_mcap, 0) > 0
        AND COALESCE(tc.last_mcap, 0) < 15000
        AND COALESCE(tc.suppressed_reason, '') NOT IN ('cleanup_soft_archive', 'cleanup_quarantine')
        AND NOT EXISTS (
          SELECT 1
          FROM protected_addresses pa
          WHERE pa.address = tc.address
        )
        AND (
          tc.eligible_for_monitoring = FALSE
          OR tc.last_vol_24h IS NULL
          OR tc.last_vol_24h < 1000
          OR tc.eligibility_state IN ('dex-missing', 'dex-known-no-mcap')
          OR (tc.eligibility_state = 'evaluation-error' AND COALESCE(tc.evaluation_error_count, 0) >= 3)
        )
      ORDER BY tc.first_seen_at ASC, tc.last_seen_at ASC, tc.address ASC
      LIMIT $2
    )
    UPDATE token_catalog tc
    SET is_active_monitor_candidate = FALSE,
        eligible_for_monitoring = FALSE,
        monitor_priority = 'dormant',
        suppressed_reason = 'cleanup_soft_archive',
        next_evaluation_at = NOW() + ($1 * INTERVAL '1 millisecond'),
        metadata_updated_at = NOW()
    FROM candidate_addresses ca
    WHERE tc.address = ca.address
    RETURNING tc.address, tc.source
  `;

  const archiveResult = await db.query(archiveQuery, [softArchiveRecheckMs, archiveLimit]);

  const archivedBySource = archiveResult.rows.reduce((acc, row) => {
    acc[row.source] = (acc[row.source] || 0) + 1;
    return acc;
  }, {});
  const archivedAddresses = archiveResult.rows.map((row) => row.address).filter(Boolean);

  return {
    archived: archiveResult.rowCount,
    archivedAddresses,
    archivedBySource,
    archiveLimit,
  };
}

async function applyAutomatedCleanup(options = {}) {
  const [quarantineSummary, archiveSummary] = await Promise.all([
    applyQuarantineCleanup(options),
    applySoftArchiveCleanup(options),
  ]);

  return {
    archived: archiveSummary.archived,
    quarantined: quarantineSummary.quarantined,
    archivedAddresses: archiveSummary.archivedAddresses,
    archivedBySource: archiveSummary.archivedBySource,
    quarantinedBySource: quarantineSummary.quarantinedBySource,
    archiveLimit: archiveSummary.archiveLimit,
  };
}

module.exports = {
  upsertToken,
  getByAddress,
  listRecent,
  listDueForEvaluation,
  countDueForEvaluationSummary,
  countDueForMeteoraSnapshots,
  countDueForMeteoraSnapshotsByTier,
  listDueForMeteoraSnapshots,
  listEligibleVisible,
  listDashboardMonitored,
  listDashboardMetadataByAddresses,
  markMeteoraChecked,
  scheduleImmediateEvaluation,
  reactivateSoftArchivedToken,
  applyEvaluationResult,
  applyQuarantineCleanup,
  applySoftArchiveCleanup,
  applyAutomatedCleanup,
};
