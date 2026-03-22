const db = require('./db');
const adminBlockedToken = require('./admin-blocked-token');
const { isValidAddress } = require('./user-token');

function normalizeChain(chain) {
  const value = String(chain || 'solana').trim().toLowerCase();
  if (!value) return 'solana';
  return value;
}

function normalizeSource(source) {
  const value = String(source || 'unknown').trim().toLowerCase();
  return value || 'unknown';
}

function toNullableText(value) {
  return value == null ? null : String(value).trim() || null;
}

async function upsertToken(token) {
  await adminBlockedToken.ensureTable();
  const address = String(token.address || '').trim();
  if (!isValidAddress(address)) {
    throw new Error('Invalid token address format');
  }

  const chain = normalizeChain(token.chain);
  const source = normalizeSource(token.source);
  const symbol = toNullableText(token.symbol);
  const name = toNullableText(token.name);
  const lastPairAddress = toNullableText(token.pairAddress);
  const lastPairUrl = toNullableText(token.pairUrl);
  const lastImageUrl = toNullableText(token.imageUrl);
  const lastTwitterUrl = toNullableText(token.twitterUrl);
  const isActiveMonitorCandidate = token.isActiveMonitorCandidate == null ? true : !!token.isActiveMonitorCandidate;
  const lastMcap = Number.isFinite(Number(token.mcap)) ? Number(token.mcap) : null;
  const lastPrice = Number.isFinite(Number(token.price)) ? Number(token.price) : null;
  const lastPriceChange1h = Number.isFinite(Number(token.priceChange1h)) ? Number(token.priceChange1h) : null;
  const lastPriceChange6h = Number.isFinite(Number(token.priceChange6h)) ? Number(token.priceChange6h) : null;
  const lastPriceChange24h = Number.isFinite(Number(token.priceChange24h)) ? Number(token.priceChange24h) : null;
  const lastTokenCreatedAtMs = Number.isFinite(Number(token.tokenCreatedAt)) ? Math.trunc(Number(token.tokenCreatedAt)) : null;

  const { rows } = await db.query(
    `INSERT INTO token_catalog (
       address, chain, symbol, name, source,
       last_mcap, last_price, last_pair_address, last_pair_url,
       last_image_url, last_twitter_url,
       last_price_change_1h, last_price_change_6h, last_price_change_24h,
       last_token_created_at_ms,
       is_active_monitor_candidate
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       CASE
         WHEN EXISTS (SELECT 1 FROM admin_blocked_tokens ab WHERE ab.address = $17)
           THEN FALSE
         ELSE $16
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
       is_active_monitor_candidate = CASE
         WHEN EXISTS (SELECT 1 FROM admin_blocked_tokens ab WHERE ab.address = token_catalog.address)
           THEN FALSE
         ELSE EXCLUDED.is_active_monitor_candidate
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
      isActiveMonitorCandidate,
      address,
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

async function listEligibleForSnapshots(limit = 25) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 25, 200));
  const { rows } = await db.query(
    `SELECT *
     FROM token_catalog
     WHERE eligible_for_monitoring = TRUE
     ORDER BY last_evaluated_at DESC NULLS LAST, last_seen_at DESC
     LIMIT $1`,
    [safeLimit]
  );
  return rows;
}

async function listEligibleVisible(limit = 500, minMcap = 30000) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 500, 5000));
  const safeMinMcap = Number.isFinite(Number(minMcap)) ? Number(minMcap) : 30000;
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
  const safeMinMcap = Number.isFinite(Number(minMcap)) ? Number(minMcap) : 30000;
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

async function applyEvaluationResult(address, result) {
  const addr = String(address || '').trim();
  const eligibilityState = toNullableText(result.eligibilityState) || 'unknown';
  const eligibleForMonitoring = !!result.eligibleForMonitoring;
  const suppressedReason = toNullableText(result.suppressedReason);
  const nextEvaluationAt = result.nextEvaluationAt || new Date(Date.now() + 10 * 60 * 1000);
  const lastEvaluationError = toNullableText(result.lastEvaluationError);
  const errorCount = Number.isInteger(result.evaluationErrorCount) ? result.evaluationErrorCount : 0;
  const symbol = toNullableText(result.symbol);
  const name = toNullableText(result.name);
  const pairAddress = toNullableText(result.pairAddress);
  const pairUrl = toNullableText(result.pairUrl);
  const imageUrl = toNullableText(result.imageUrl);
  const twitterUrl = toNullableText(result.twitterUrl);
  const lastMcap = Number.isFinite(Number(result.mcap)) ? Number(result.mcap) : null;
  const lastPrice = Number.isFinite(Number(result.price)) ? Number(result.price) : null;
  const monitorPriority = toNullableText(result.monitorPriority) || 'dormant';
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

async function applyAutomatedCleanup(options = {}) {
  const staleDays = Math.max(1, Number(options.staleDays) || 5);
  const quarantineRecheckMs = Math.max(60 * 1000, Number(options.quarantineRecheckMs) || (6 * 60 * 60 * 1000));
  const softArchiveRecheckMs = Math.max(60 * 1000, Number(options.softArchiveRecheckMs) || (30 * 24 * 60 * 60 * 1000));
  const staleInterval = `${staleDays} days`;

  const archiveQuery = `
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
    SET is_active_monitor_candidate = FALSE,
        eligible_for_monitoring = FALSE,
        monitor_priority = 'dormant',
        suppressed_reason = 'cleanup_soft_archive',
        next_evaluation_at = NOW() + ($1 * INTERVAL '1 millisecond')
    WHERE COALESCE(tc.last_mcap, 0) < 15000
      AND tc.source <> 'dexscreener-discovery'
      AND NOT EXISTS (
        SELECT 1
        FROM protected_addresses pa
        WHERE pa.address = tc.address
      )
      AND (
        tc.eligible_for_monitoring = FALSE
        OR tc.last_vol_24h IS NULL
        OR tc.last_vol_24h < 1000
        OR tc.last_seen_at < NOW() - $2::interval
        OR tc.eligibility_state IN ('dex-missing', 'dex-known-no-mcap')
        OR (tc.eligibility_state = 'evaluation-error' AND COALESCE(tc.evaluation_error_count, 0) >= 3)
      )
      AND (
        tc.last_seen_at < NOW() - $2::interval
        OR tc.eligibility_state IN ('dex-missing', 'dex-known-no-mcap')
        OR (tc.eligibility_state = 'evaluation-error' AND COALESCE(tc.evaluation_error_count, 0) >= 3)
      )
    RETURNING tc.address, tc.source
  `;

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

  const [archiveResult, quarantineResult] = await Promise.all([
    db.query(archiveQuery, [softArchiveRecheckMs, staleInterval]),
    db.query(quarantineQuery, [quarantineRecheckMs]),
  ]);

  const archivedBySource = archiveResult.rows.reduce((acc, row) => {
    acc[row.source] = (acc[row.source] || 0) + 1;
    return acc;
  }, {});

  const quarantinedBySource = quarantineResult.rows.reduce((acc, row) => {
    acc[row.source] = (acc[row.source] || 0) + 1;
    return acc;
  }, {});

  return {
    archived: archiveResult.rowCount,
    quarantined: quarantineResult.rowCount,
    archivedBySource,
    quarantinedBySource,
    staleDays,
  };
}

module.exports = {
  upsertToken,
  getByAddress,
  listRecent,
  listDueForEvaluation,
  listEligibleForSnapshots,
  listEligibleVisible,
  listDashboardMonitored,
  scheduleImmediateEvaluation,
  applyEvaluationResult,
  applyAutomatedCleanup,
};
