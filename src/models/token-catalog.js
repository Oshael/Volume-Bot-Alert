const db = require('./db');
const adminBlockedToken = require('./admin-blocked-token');
const monitoredTokenExitEvent = require('./monitored-token-exit-event');
const { isValidAddress } = require('./user-token');
const { normalizeChain, normalizeText, sanitizeHttpUrl, sanitizeAssetUrl } = require('../utils/url-safety');
const { normalizeSocialLinkFields } = require('../utils/dex-social-links');
const { normalizeCumulativeVolumeWindows } = require('../services/volume-window-consistency');

const PUMPFUN_MIGRATION_GRACE_MS = 10 * 60 * 1000;
const METEORA_HIGH_TIER_MIN_VOL_24H = 100000;
const METEORA_NORMAL_TIER_MIN_VOL_24H = 15000;
const METEORA_PRIORITY_TIERS = ['high', 'normal', 'low'];
const DEX_CONFIRMED_ELIGIBILITY_STATES = ['dex-low', 'dex-normal', 'dex-high'];
const OLD_WEEK_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OLD_WEEK_MIN_AGE_MINUTES = Math.floor(OLD_WEEK_MIN_AGE_MS / (60 * 1000));
const OPEN_ENDED_AGE_MAX_MINUTES = 100 * 365 * 24 * 60;
const HISTORY_BUCKET_SORT_MODES = new Set(['vol', 'mcap', 'pchange', 'age']);
const DEFAULT_TOP_PERFORMERS_LIMIT = 15;
const DEFAULT_TOP_PERFORMERS_MIN_MCAP = 30000;
const DEFAULT_TOP_PERFORMERS_MIN_VOL_24H = 200000;
const DEFAULT_TOP_PERFORMERS_MAX_PCHANGE_24H = 300;
const DEFAULT_TOP_PERFORMERS_VOLUME_SLOT_LIMIT = 7;
const DEFAULT_TOP_PERFORMERS_STATEMENT_TIMEOUT_MS = 5000;
const EFFECTIVE_HISTORY_VOL_6H_SQL = 'GREATEST(COALESCE(tc.last_vol_6h, 0), COALESCE(tc.last_vol_1h, 0))';
const EFFECTIVE_HISTORY_VOL_24H_SQL = 'GREATEST(COALESCE(tc.last_vol_24h, 0), COALESCE(tc.last_vol_6h, 0), COALESCE(tc.last_vol_1h, 0))';

const HISTORY_BUCKET_SORT_COLUMNS = Object.freeze({
  vol: Object.freeze({
    '1h': 'tc.last_vol_1h',
    '6h': EFFECTIVE_HISTORY_VOL_6H_SQL,
    '24h': EFFECTIVE_HISTORY_VOL_24H_SQL,
  }),
  mcap: Object.freeze({
    highest: 'tc.last_mcap',
    lowest: 'tc.last_mcap',
  }),
  pchange: Object.freeze({
    '1h': 'tc.last_price_change_1h',
    '6h': 'tc.last_price_change_6h',
    '24h': 'tc.last_price_change_24h',
  }),
  age: Object.freeze({
    newest: 'tc.last_token_created_at_ms',
    oldest: 'tc.last_token_created_at_ms',
  }),
});

const MONITORED_SORT_COLUMNS = Object.freeze({
  vol: Object.freeze({
    '5m': 'tc.last_vol_5m',
    '1h': 'tc.last_vol_1h',
    '6h': 'tc.last_vol_6h',
    '24h': 'tc.last_vol_24h',
  }),
  mcap: Object.freeze({
    highest: 'tc.last_mcap',
    lowest: 'tc.last_mcap',
  }),
  age: Object.freeze({
    newest: 'tc.last_token_created_at_ms',
    oldest: 'tc.last_token_created_at_ms',
  }),
});

const DASHBOARD_MONITORED_SELECT_SQL = `SELECT
   tc.address,
   tc.symbol,
   tc.name,
   tc.eligible_for_monitoring,
   tc.last_mcap,
   tc.last_price,
   tc.last_vol_5m,
   tc.last_vol_1h,
   tc.last_vol_6h,
   tc.last_vol_24h,
   tc.last_liquidity_usd,
   tc.last_txns_1h_buys,
   tc.last_txns_1h_sells,
   tc.last_txns_24h_buys,
   tc.last_txns_24h_sells,
   tc.last_price_change_1h,
   tc.last_price_change_6h,
   tc.last_price_change_24h,
   tc.last_token_created_at_ms,
   tc.last_pair_address,
   tc.last_pair_url,
   tc.last_image_url,
   tc.last_twitter_url,
   tc.last_community_url,
   tc.monitor_priority,
   tc.first_seen_at,
   tc.last_seen_at,
   tc.last_evaluated_at,
   trr.label AS risk_review_label,
   trr.source AS risk_review_source,
   trr.notes AS risk_review_notes,
   trr.updated_at AS risk_review_updated_at,
   ab.label AS blocked_label,
   ab.created_by AS blocked_created_by,
   ab.created_at AS blocked_created_at,
   tre.last_attempted_at AS risk_enrichment_last_attempted_at,
   tre.last_enriched_at AS risk_enrichment_last_enriched_at,
   tre.last_error AS risk_enrichment_last_error,
   tre.holder_count AS risk_holder_count,
   tre.mint_authority_active AS risk_mint_authority_active,
   tre.freeze_authority_active AS risk_freeze_authority_active,
   tre.top_10_pct AS risk_top_10_pct,
   tre.top_20_pct AS risk_top_20_pct,
   tre.reason_codes AS risk_reason_codes`;

const DASHBOARD_MONITORED_LEAN_SELECT_SQL = `SELECT
   tc.address,
   tc.symbol,
   tc.name,
   tc.eligible_for_monitoring,
   tc.last_mcap,
   tc.last_price,
   tc.last_vol_5m,
   tc.last_vol_1h,
   tc.last_vol_6h,
   tc.last_vol_24h,
   tc.last_price_change_1h,
   tc.last_price_change_6h,
   tc.last_price_change_24h,
   tc.last_token_created_at_ms,
   tc.last_pair_address,
   tc.last_pair_url,
   tc.last_image_url,
   tc.last_twitter_url,
   tc.last_community_url,
   tc.monitor_priority,
   tc.first_seen_at,
   tc.last_seen_at,
   tc.last_evaluated_at`;

function normalizeSource(source) {
  const value = String(normalizeText(source, 64) || 'unknown').trim().toLowerCase();
  return value || 'unknown';
}

function toNullableText(value, maxLength = 256) {
  return normalizeText(value, maxLength);
}

function toNullableNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNullableInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.trunc(parsed) : null;
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
  const dexConfirmedStates = DEX_CONFIRMED_ELIGIBILITY_STATES.map((state) => `'${state}'`).join(', ');
  return `${tokenAlias}.is_active_monitor_candidate = TRUE
    AND (
      ${stateAlias}.has_pool = TRUE
      OR (
        COALESCE(${tokenAlias}.last_mcap, 0) >= 100000
        AND (
          COALESCE(${tokenAlias}.source, '') <> 'gmgn'
          OR ${tokenAlias}.eligibility_state IN (${dexConfirmedStates})
        )
      )
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

async function getMonitoredExitSnapshot(address) {
  const { rows } = await db.query(
    `SELECT
       address,
       source,
       is_active_monitor_candidate,
       eligibility_state,
       eligible_for_monitoring,
       suppressed_reason,
       monitor_priority,
       last_mcap,
       last_liquidity_usd,
       last_vol_5m,
       last_vol_1h,
       last_vol_6h,
       last_vol_24h,
       last_seen_at,
       last_evaluated_at,
       next_evaluation_at,
       evaluation_error_count,
       last_evaluation_error
     FROM token_catalog
     WHERE address = $1
     LIMIT 1`,
    [address]
  );
  return rows[0] || null;
}

async function recordMonitoredExit(previousRow, currentRow, context = {}) {
  try {
    await monitoredTokenExitEvent.recordIfExited(previousRow, currentRow, {
      pipeline: context.pipeline || 'token-catalog.applyEvaluationResult',
      evaluationSource: context.evaluationSource,
      exitSource: context.exitSource || context.evaluationSource,
    });
  } catch (err) {
    console.warn('[TokenCatalog] Failed to record monitored token exit:', err instanceof Error ? err.message : err);
  }
}

function normalizeRiskCandidateLimit(value, fallback = 250) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.trunc(parsed), 5000));
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
  const socialLinks = normalizeSocialLinkFields(token);
  const lastTwitterUrl = socialLinks.twitterUrl;
  const lastCommunityUrl = socialLinks.communityUrl;
  const isActiveMonitorCandidate = token.isActiveMonitorCandidate == null ? true : !!token.isActiveMonitorCandidate;
  const lastMcap = toNullableNumber(token.mcap);
  const lastPrice = toNullableNumber(token.price);
  const lastPriceChange1h = toNullableNumber(token.priceChange1h);
  const lastPriceChange6h = toNullableNumber(token.priceChange6h);
  const lastPriceChange24h = toNullableNumber(token.priceChange24h);
  const lastLiquidityUsd = toNullableNumber(token.liquidityUsd);
  const lastTxns1hBuys = toNullableInteger(token.txns1hBuys);
  const lastTxns1hSells = toNullableInteger(token.txns1hSells);
  const lastTxns24hBuys = toNullableInteger(token.txns24hBuys);
  const lastTxns24hSells = toNullableInteger(token.txns24hSells);
  const lastTokenCreatedAtMs = toNullableInteger(token.tokenCreatedAt);
  const isPumpfunMigrated = source === 'pumpfun-migrated';
  const migrationGraceUntil = isPumpfunMigrated
    ? toDateOrNull(token.migrationGraceUntil) || new Date(Date.now() + PUMPFUN_MIGRATION_GRACE_MS)
    : null;

  const { rows } = await db.query(
    `INSERT INTO token_catalog (
       address, chain, symbol, name, source,
       last_mcap, last_price, last_pair_address, last_pair_url,
       last_image_url, last_twitter_url, last_community_url,
       last_price_change_1h, last_price_change_6h, last_price_change_24h,
       last_liquidity_usd, last_txns_1h_buys, last_txns_1h_sells, last_txns_24h_buys, last_txns_24h_sells,
       last_token_created_at_ms, migration_grace_until,
       is_active_monitor_candidate
     )
     VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20,
       $21, $22,
       CASE
         WHEN EXISTS (SELECT 1 FROM admin_blocked_tokens ab WHERE ab.address = $24)
           THEN FALSE
         ELSE $23
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
       last_community_url = COALESCE(EXCLUDED.last_community_url, token_catalog.last_community_url),
       last_price_change_1h = COALESCE(EXCLUDED.last_price_change_1h, token_catalog.last_price_change_1h),
       last_price_change_6h = COALESCE(EXCLUDED.last_price_change_6h, token_catalog.last_price_change_6h),
       last_price_change_24h = COALESCE(EXCLUDED.last_price_change_24h, token_catalog.last_price_change_24h),
       last_liquidity_usd = COALESCE(EXCLUDED.last_liquidity_usd, token_catalog.last_liquidity_usd),
       last_txns_1h_buys = COALESCE(EXCLUDED.last_txns_1h_buys, token_catalog.last_txns_1h_buys),
       last_txns_1h_sells = COALESCE(EXCLUDED.last_txns_1h_sells, token_catalog.last_txns_1h_sells),
       last_txns_24h_buys = COALESCE(EXCLUDED.last_txns_24h_buys, token_catalog.last_txns_24h_buys),
       last_txns_24h_sells = COALESCE(EXCLUDED.last_txns_24h_sells, token_catalog.last_txns_24h_sells),
       last_token_created_at_ms = COALESCE(EXCLUDED.last_token_created_at_ms, token_catalog.last_token_created_at_ms),
       migration_grace_until = CASE
         WHEN EXCLUDED.source = 'pumpfun-migrated' AND $25 = TRUE THEN
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
         WHEN EXCLUDED.source = 'pumpfun-migrated' AND $25 = TRUE
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
      lastCommunityUrl,
      lastPriceChange1h,
      lastPriceChange6h,
      lastPriceChange24h,
      lastLiquidityUsd,
      lastTxns1hBuys,
      lastTxns1hSells,
      lastTxns24hBuys,
      lastTxns24hSells,
      lastTokenCreatedAtMs,
      migrationGraceUntil,
      isActiveMonitorCandidate,
      address,
      isPumpfunMigrated,
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
                WHEN source = 'user-manual'
                  OR EXISTS (
                    SELECT 1
                    FROM user_tokens ut
                    WHERE ut.address = token_catalog.address
                  ) THEN 0
                ELSE 1
              END ASC,
              CASE
                WHEN COALESCE(monitor_priority, 'dormant') = 'high'
                  AND COALESCE(last_mcap, 0) >= 100000
                  AND COALESCE(last_vol_6h, 0) >= 30000 THEN 0
                WHEN COALESCE(monitor_priority, 'dormant') = 'high'
                  AND COALESCE(last_mcap, 0) >= 100000
                  AND COALESCE(last_vol_6h, 0) >= 15000 THEN 1
                WHEN COALESCE(monitor_priority, 'dormant') = 'high'
                  AND COALESCE(last_mcap, 0) >= 100000 THEN 2
                WHEN source = 'pumpfun-migrated'
                  AND (
                    last_evaluated_at IS NULL
                    OR (migration_grace_until IS NOT NULL AND migration_grace_until > NOW() AND last_eligible_at IS NULL)
                  ) THEN 3
                WHEN COALESCE(monitor_priority, 'dormant') = 'normal' THEN 4
                WHEN COALESCE(monitor_priority, 'dormant') = 'low'
                  AND COALESCE(last_mcap, 0) >= 15000 THEN 5
                WHEN COALESCE(monitor_priority, 'dormant') = 'low' THEN 6
                ELSE 7
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
    `${DASHBOARD_MONITORED_LEAN_SELECT_SQL}
     FROM token_catalog tc
     WHERE tc.eligible_for_monitoring = TRUE
       AND COALESCE(tc.last_mcap, 0) >= $2
     ORDER BY tc.last_seen_at DESC, tc.last_evaluated_at DESC NULLS LAST
     LIMIT $1`,
    [safeLimit, safeMinMcap]
  );
  return rows;
}

function normalizeDashboardMonitoredSorts(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return [{ mode: 'vol', window: '5m' }];
  }

  const next = [];
  const seen = new Set();
  for (const item of input) {
    const mode = String(item?.mode || '').trim();
    const window = String(item?.window || '').trim();
    const column = MONITORED_SORT_COLUMNS[mode]?.[window];
    if (!column) {
      continue;
    }

    const key = `${mode}:${window}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    next.push({ mode, window });
    if (next.length >= 8) {
      break;
    }
  }

  return next.length > 0 ? next : [{ mode: 'vol', window: '5m' }];
}

function getMonitoredSortDirection(mode, window) {
  if ((mode === 'mcap' && window === 'lowest') || (mode === 'age' && window === 'oldest')) {
    return 'ASC';
  }
  return 'DESC';
}

function buildDashboardMonitoredOrderSql(sorts) {
  const clauses = normalizeDashboardMonitoredSorts(sorts).map(({ mode, window }) => {
    const column = MONITORED_SORT_COLUMNS[mode][window];
    const direction = getMonitoredSortDirection(mode, window);
    return `COALESCE(${column}, 0) ${direction}`;
  });
  clauses.push('COALESCE(tc.last_token_created_at_ms, 0) DESC');
  clauses.push('COALESCE(tc.last_mcap, 0) DESC');
  clauses.push('tc.address ASC');
  return clauses.join(', ');
}

async function listDashboardMonitoredSlice(page = 0, perPage = 30, minMcap = 30000, sorts = []) {
  const safePage = Math.max(0, Number(page) || 0);
  const safePerPage = Math.max(1, Math.min(Number(perPage) || 30, 500));
  const safeMinMcap = Math.max(0, Number.isFinite(Number(minMcap)) ? Number(minMcap) : 30000);
  const offset = safePage * safePerPage;
  const orderSql = buildDashboardMonitoredOrderSql(sorts);
  const { rows } = await db.query(
    `${DASHBOARD_MONITORED_LEAN_SELECT_SQL},
       COUNT(*) OVER() AS total_count
     FROM token_catalog tc
     WHERE tc.eligible_for_monitoring = TRUE
       AND COALESCE(tc.last_mcap, 0) >= $3
     ORDER BY ${orderSql}
     LIMIT $1
     OFFSET $2`,
    [safePerPage, offset, safeMinMcap]
  );
  const total = Math.max(0, Number(rows[0]?.total_count) || 0);
  return {
    total,
    page: safePage,
    perPage: safePerPage,
    rows: rows.map(({ total_count: _totalCount, ...item }) => item),
  };
}

function normalizeTopPerformersOptions(options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_TOP_PERFORMERS_LIMIT, 50));
  const minMcap = Math.max(0, Number.isFinite(Number(options.minMcap)) ? Number(options.minMcap) : DEFAULT_TOP_PERFORMERS_MIN_MCAP);
  const minVol24h = Math.max(0, Number.isFinite(Number(options.minVol24h)) ? Number(options.minVol24h) : DEFAULT_TOP_PERFORMERS_MIN_VOL_24H);
  const maxPchange24h = Math.max(1, Number.isFinite(Number(options.maxPchange24h)) ? Number(options.maxPchange24h) : DEFAULT_TOP_PERFORMERS_MAX_PCHANGE_24H);
  const volumeSlotLimit = Math.min(DEFAULT_TOP_PERFORMERS_VOLUME_SLOT_LIMIT, limit);
  const statementTimeoutMs = Math.max(0, Math.trunc(Number(options.statementTimeoutMs) || DEFAULT_TOP_PERFORMERS_STATEMENT_TIMEOUT_MS));
  return {
    limit,
    minMcap,
    minVol24h,
    maxPchange24h,
    volumeSlotLimit,
    statementTimeoutMs,
  };
}

async function listDashboardTopPerformers(options = {}) {
  const normalized = normalizeTopPerformersOptions(options);
  const { rows } = await db.queryWithStatementTimeout(
    `WITH candidates AS (
       ${DASHBOARD_MONITORED_LEAN_SELECT_SQL},
       LEAST(GREATEST(COALESCE(tc.last_price_change_24h, 0), 0), $4::numeric) AS pchange_score_input,
       LN(1 + GREATEST(COALESCE(tc.last_vol_24h, 0), 0)) AS volume_score_input
       FROM token_catalog tc
       LEFT JOIN token_risk_reviews trr
         ON trr.token_address = tc.address
       WHERE tc.eligible_for_monitoring = TRUE
         AND tc.is_active_monitor_candidate = TRUE
         AND COALESCE(tc.last_mcap, 0) >= $2
         AND COALESCE(tc.last_vol_24h, 0) >= $3
         AND COALESCE(tc.last_price_change_24h, 0) > 0
         AND COALESCE(trr.label, '') NOT IN ('junk_probable', 'junk_permanent')
         AND NOT EXISTS (
           SELECT 1
           FROM admin_blocked_tokens ab
           WHERE ab.address = tc.address
         )
     ),
     ranked AS (
       SELECT
         candidates.*,
         CUME_DIST() OVER (ORDER BY volume_score_input) AS volume_rank_score,
         CUME_DIST() OVER (ORDER BY pchange_score_input) AS pchange_rank_score
       FROM candidates
     ),
     volume_picks AS (
       SELECT
         ranked.*,
         'volume_24h' AS performance_bucket,
         ((volume_rank_score * 0.82) + (pchange_rank_score * 0.18)) * 100 AS performance_score
       FROM ranked
       ORDER BY
         volume_score_input DESC,
         COALESCE(last_vol_24h, 0) DESC,
         pchange_score_input DESC,
         COALESCE(last_mcap, 0) DESC,
         last_seen_at DESC,
         address ASC
       LIMIT $5
     ),
     pchange_picks AS (
       SELECT
         ranked.*,
         'pchange_24h' AS performance_bucket,
         ((pchange_rank_score * 0.82) + (volume_rank_score * 0.18)) * 100 AS performance_score
       FROM ranked
       WHERE NOT EXISTS (
         SELECT 1
         FROM volume_picks vp
         WHERE vp.address = ranked.address
       )
       ORDER BY
         pchange_score_input DESC,
         pchange_rank_score DESC,
         volume_rank_score DESC,
         COALESCE(last_vol_24h, 0) DESC,
         COALESCE(last_mcap, 0) DESC,
         last_seen_at DESC,
         address ASC
       LIMIT GREATEST(0, $1 - (SELECT COUNT(*) FROM volume_picks))
     ),
     combined AS (
       SELECT * FROM volume_picks
       UNION ALL
       SELECT * FROM pchange_picks
     )
     SELECT *
     FROM combined
     ORDER BY
       performance_score DESC,
       volume_rank_score DESC,
       pchange_rank_score DESC,
       COALESCE(last_vol_24h, 0) DESC,
       COALESCE(last_price_change_24h, 0) DESC,
       COALESCE(last_mcap, 0) DESC,
       last_seen_at DESC,
       address ASC
     LIMIT $1`,
    [
      normalized.limit,
      normalized.minMcap,
      normalized.minVol24h,
      normalized.maxPchange24h,
      normalized.volumeSlotLimit,
    ],
    normalized.statementTimeoutMs
  );

  return rows;
}

function normalizeHistoryBucketName(bucket) {
  const normalized = String(bucket || '').trim();
  return normalized === 'oldWeek' ? 'oldWeek' : 'recent';
}

async function preserveGmgnPositiveVolumeWindows(address, result, volumes) {
  if (String(result.evaluationSource || '').trim().toLowerCase() !== 'gmgn') {
    return volumes;
  }

  const { rows } = await db.query(
    `SELECT last_vol_1h, last_vol_6h, last_vol_24h
     FROM token_catalog
     WHERE address = $1
     LIMIT 1`,
    [address]
  );
  const previous = rows[0] || {};
  const preserved = {
    ...volumes,
    lastVol1h: volumes.lastVol1h === 0 && toNullableNumber(previous.last_vol_1h) > 0
      ? toNullableNumber(previous.last_vol_1h)
      : volumes.lastVol1h,
    lastVol6h: volumes.lastVol6h === 0 && toNullableNumber(previous.last_vol_6h) > 0
      ? toNullableNumber(previous.last_vol_6h)
      : volumes.lastVol6h,
    lastVol24h: volumes.lastVol24h === 0 && toNullableNumber(previous.last_vol_24h) > 0
      ? toNullableNumber(previous.last_vol_24h)
      : volumes.lastVol24h,
  };

  const normalized = normalizeCumulativeVolumeWindows({
    vol1h: preserved.lastVol1h,
    vol6h: preserved.lastVol6h,
    vol24h: preserved.lastVol24h,
  }, {
    vol6h: toNullableNumber(previous.last_vol_6h),
    vol24h: toNullableNumber(previous.last_vol_24h),
  });

  return {
    ...preserved,
    lastVol6h: normalized.vol6h,
    lastVol24h: normalized.vol24h,
  };
}

function normalizeHistoryBucketSorts(input) {
  if (!Array.isArray(input) || input.length === 0) {
    return [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }];
  }

  const next = [];
  const seen = new Set();
  for (const item of input) {
    const mode = String(item?.mode || '').trim();
    const window = String(item?.window || '').trim();
    if (!HISTORY_BUCKET_SORT_MODES.has(mode)) {
      continue;
    }

    const column = HISTORY_BUCKET_SORT_COLUMNS[mode]?.[window];
    if (!column) {
      continue;
    }

    const key = `${mode}:${window}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    next.push({ mode, window });
    if (next.length >= 8) {
      break;
    }
  }

  return next.length > 0 ? next : [{ mode: 'vol', window: '1h' }, { mode: 'vol', window: '6h' }];
}

function getHistoryBucketOrderDirection(mode, window) {
  if ((mode === 'mcap' && window === 'lowest') || (mode === 'age' && window === 'oldest')) {
    return 'ASC';
  }
  return 'DESC';
}

function getHistoryBucketScoreDirection(mode, window) {
  return getHistoryBucketOrderDirection(mode, window) === 'DESC' ? 'ASC' : 'DESC';
}

function buildHistoryBucketSortClauses(sorts) {
  return normalizeHistoryBucketSorts(sorts).map(({ mode, window }) => {
    const column = HISTORY_BUCKET_SORT_COLUMNS[mode][window];
    const direction = getHistoryBucketOrderDirection(mode, window);
    return `COALESCE(${column}, 0) ${direction}`;
  });
}

function buildHistoryBucketScoreSql(sorts) {
  const normalized = normalizeHistoryBucketSorts(sorts);
  const scoreClauses = normalized.map(({ mode, window }) => {
    const column = HISTORY_BUCKET_SORT_COLUMNS[mode][window];
    const direction = getHistoryBucketScoreDirection(mode, window);
    return `CUME_DIST() OVER (ORDER BY COALESCE(${column}, 0) ${direction})`;
  });

  return `(${scoreClauses.join(' + ')}) / ${scoreClauses.length}`;
}

function buildHistoryBucketOrderSql(sorts) {
  const clauses = ['history_sort_score DESC', ...buildHistoryBucketSortClauses(sorts)];
  clauses.push('COALESCE(tc.last_token_created_at_ms, 0) DESC');
  clauses.push('COALESCE(tc.last_mcap, 0) DESC');
  clauses.push('tc.address ASC');
  return clauses.join(', ');
}

function buildHistoryBucketAgeWhereSql(bucket, ageParams = []) {
  if (normalizeHistoryBucketName(bucket) === 'oldWeek' && ageParams.length < 2) {
    return 'tc.last_token_created_at_ms <= $1';
  }

  return 'tc.last_token_created_at_ms >= $1 AND tc.last_token_created_at_ms <= $2';
}

function normalizeRecentAgeMinutes(value, fallbackMinutes) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallbackMinutes;
  }

  return Math.max(0, Math.min(OLD_WEEK_MIN_AGE_MINUTES, Math.round(parsed)));
}

function normalizeOldWeekAgeMinMinutes(value, fallbackMinutes) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallbackMinutes;
  }

  return Math.max(OLD_WEEK_MIN_AGE_MINUTES, Math.min(OPEN_ENDED_AGE_MAX_MINUTES, Math.round(parsed)));
}

function normalizeOldWeekAgeMaxMinutes(value, fallbackMinutes) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallbackMinutes;
  }
  if (parsed <= 0) {
    return 0;
  }

  return Math.max(OLD_WEEK_MIN_AGE_MINUTES, Math.min(OPEN_ENDED_AGE_MAX_MINUTES, Math.round(parsed)));
}

function buildHistoryBucketQueryParams(bucket, options = {}) {
  const normalizedBucket = normalizeHistoryBucketName(bucket);
  const safePage = Math.max(0, Math.floor(Number(options.page) || 0));
  const safePerPage = Math.max(10, Math.min(Math.floor(Number(options.perPage) || 30), 500));
  const safeMinMcap = Math.max(0, Number.isFinite(Number(options.mcapMin)) ? Number(options.mcapMin) : 0);
  const safeMaxMcap = Number.isFinite(Number(options.mcapMax)) ? Number(options.mcapMax) : 0;
  const searchQuery = String(options.searchQuery || '').trim().toLowerCase();
  const searchPattern = searchQuery ? `%${searchQuery}%` : null;
  const dismissedAddresses = Array.from(new Set(
    (Array.isArray(options.dismissedAddresses) ? options.dismissedAddresses : [])
      .map((item) => String(item || '').trim())
      .filter((item) => isValidAddress(item))
  ));
  const starredAddresses = Array.from(new Set(
    (Array.isArray(options.starredAddresses) ? options.starredAddresses : [])
      .map((item) => String(item || '').trim())
      .filter((item) => isValidAddress(item))
  ));

  if (Boolean(options.starredOnly) && starredAddresses.length === 0) {
    return {
      ok: false,
      empty: true,
      params: {
        page: safePage,
        perPage: safePerPage,
      },
    };
  }

  const now = Date.now();
  const ageParams = normalizedBucket === 'oldWeek'
    ? (() => {
        const oldWeekAgeMinMinutes = normalizeOldWeekAgeMinMinutes(options.ageMinMinutes, OLD_WEEK_MIN_AGE_MINUTES);
        const oldWeekAgeMaxMinutes = normalizeOldWeekAgeMaxMinutes(options.ageMaxMinutes, 0);
        if (oldWeekAgeMaxMinutes > 0) {
          return [
            now - (Math.max(oldWeekAgeMinMinutes, oldWeekAgeMaxMinutes) * 60 * 1000),
            now - (oldWeekAgeMinMinutes * 60 * 1000),
          ];
        }

        return [now - (oldWeekAgeMinMinutes * 60 * 1000)];
      })()
    : (() => {
        const recentAgeMinMinutes = normalizeRecentAgeMinutes(options.ageMinMinutes, 0);
        const recentAgeMaxMinutes = Math.max(
          recentAgeMinMinutes,
          normalizeRecentAgeMinutes(options.ageMaxMinutes, OLD_WEEK_MIN_AGE_MINUTES)
        );

        return [
          now - (recentAgeMaxMinutes * 60 * 1000),
          now - (recentAgeMinMinutes * 60 * 1000),
        ];
      })();

  return {
    ok: true,
    params: {
      bucket: normalizedBucket,
      page: safePage,
      perPage: safePerPage,
      offset: safePage * safePerPage,
      minMcap: safeMinMcap,
      maxMcap: safeMaxMcap,
      searchPattern,
      dismissedAddresses,
      starredAddresses,
      starredOnly: Boolean(options.starredOnly),
      scoreSql: buildHistoryBucketScoreSql(options.sorts),
      orderSql: buildHistoryBucketOrderSql(options.sorts),
      ageParams,
    },
  };
}

function buildHistoryBucketWhereSql(params) {
  return [
    'tc.eligible_for_monitoring = TRUE',
    'tc.last_token_created_at_ms IS NOT NULL',
    'tc.last_token_created_at_ms > 0',
    buildHistoryBucketAgeWhereSql(params.bucket, params.ageParams),
    `COALESCE(tc.last_mcap, 0) >= $${params.ageParams.length + 1}`,
    `($${params.ageParams.length + 2} <= 0 OR COALESCE(tc.last_mcap, 0) <= $${params.ageParams.length + 2})`,
    `($${params.ageParams.length + 3}::text IS NULL OR (
      LOWER(COALESCE(tc.symbol, '')) LIKE $${params.ageParams.length + 3}
      OR LOWER(COALESCE(tc.name, '')) LIKE $${params.ageParams.length + 3}
      OR LOWER(tc.address) LIKE $${params.ageParams.length + 3}
    ))`,
    `($${params.ageParams.length + 4}::varchar[] = '{}'::varchar[] OR tc.address <> ALL($${params.ageParams.length + 4}::varchar[]))`,
    `($${params.ageParams.length + 5}::boolean = FALSE OR tc.address = ANY($${params.ageParams.length + 6}::varchar[]))`,
  ];
}

function buildHistoryBucketWhereParams(params) {
  return [
    ...params.ageParams,
    params.minMcap,
    params.maxMcap,
    params.searchPattern,
    params.dismissedAddresses,
    params.starredOnly,
    params.starredAddresses,
  ];
}

function buildHistoryBucketQueryParamsWithLimit(params) {
  return [
    ...buildHistoryBucketWhereParams(params),
    params.perPage,
    params.offset,
  ];
}

function shiftSqlPlaceholders(sql, offset) {
  return sql.replace(/\$(\d+)/g, (_match, value) => `$${Number(value) + offset}`);
}

function getHistoryBucketProbeAgeDiagnosis(row, params) {
  const createdAtMs = Number(row.last_token_created_at_ms);
  if (params.bucket === 'oldWeek' && params.ageParams.length < 2) {
    if (createdAtMs > params.ageParams[0]) return 'age_too_young';
    return null;
  } else {
    if (createdAtMs < params.ageParams[0]) return 'age_too_old';
    if (createdAtMs > params.ageParams[1]) return 'age_too_young';
  }
  return null;
}

function matchesHistoryBucketSearch(row, searchPattern) {
  if (!searchPattern) {
    return true;
  }

  const searchNeedle = searchPattern.replace(/%/g, '').toLowerCase();
  const haystack = `${row.symbol || ''} ${row.name || ''} ${row.address || ''}`.toLowerCase();
  return haystack.includes(searchNeedle);
}

function diagnoseHistoryBucketProbe(row, params) {
  if (!row.catalog_present) return 'catalog_missing';
  if (row.included_rank) return 'included_by_filters';
  if (!row.eligible_for_monitoring) {
    return `eligible_for_monitoring=false:${row.suppressed_reason || row.eligibility_state || 'unknown'}`;
  }
  if (!row.last_token_created_at_ms || Number(row.last_token_created_at_ms) <= 0) {
    return 'missing_token_created_at';
  }

  const ageDiagnosis = getHistoryBucketProbeAgeDiagnosis(row, params);
  if (ageDiagnosis) return ageDiagnosis;

  const mcap = Number(row.last_mcap) || 0;
  if (mcap < params.minMcap) return 'mcap_below_min';
  if (params.maxMcap > 0 && mcap > params.maxMcap) return 'mcap_above_max';
  if (!matchesHistoryBucketSearch(row, params.searchPattern)) return 'search_mismatch';
  if (params.dismissedAddresses.includes(row.address)) return 'dismissed';
  if (params.starredOnly && !params.starredAddresses.includes(row.address)) return 'starred_only_mismatch';
  return 'excluded_unknown';
}

async function listDashboardHistoryBucketDebugProbe(bucket, options = {}, addresses = []) {
  const unique = Array.from(new Set(
    (Array.isArray(addresses) ? addresses : [])
      .map((item) => String(item || '').trim())
      .filter((item) => isValidAddress(item))
  )).slice(0, 50);

  if (!unique.length) {
    return [];
  }

  const normalized = buildHistoryBucketQueryParams(bucket, options);
  if (!normalized.ok) {
    return unique.map((address) => ({
      address,
      included: false,
      diagnosis: 'starred_only_empty',
    }));
  }

  const { params } = normalized;
  const whereSql = buildHistoryBucketWhereSql(params).map((clause) => shiftSqlPlaceholders(clause, 1));
  const whereParams = buildHistoryBucketWhereParams(params);
  const rankedOrderSql = params.orderSql.replace(/\btc\./g, 'scored.');

  const { rows } = await db.query(
    `WITH requested AS (
       SELECT address, ordinality AS input_order
       FROM unnest($1::varchar[]) WITH ORDINALITY AS probe(address, ordinality)
     ),
     scored AS (
       SELECT
         tc.address,
         tc.last_mcap,
         tc.last_vol_1h,
         tc.last_vol_6h,
         tc.last_vol_24h,
         tc.last_price_change_1h,
         tc.last_price_change_6h,
         tc.last_price_change_24h,
         tc.last_token_created_at_ms,
         ${params.scoreSql} AS history_sort_score
       FROM token_catalog tc
       LEFT JOIN token_risk_reviews trr
         ON trr.token_address = tc.address
       LEFT JOIN admin_blocked_tokens ab
         ON ab.address = tc.address
       LEFT JOIN token_risk_enrichment tre
         ON tre.token_address = tc.address
       WHERE ${whereSql.join('\n         AND ')}
     ),
     ranked AS (
       SELECT
         scored.address,
         scored.history_sort_score,
         ROW_NUMBER() OVER (ORDER BY ${rankedOrderSql}) AS included_rank
       FROM scored
     )
     SELECT
       requested.address,
       requested.input_order,
       tc.address IS NOT NULL AS catalog_present,
       tc.symbol,
       tc.name,
       tc.eligible_for_monitoring,
       tc.eligibility_state,
       tc.suppressed_reason,
       tc.monitor_priority,
       tc.last_mcap,
       tc.last_vol_1h,
       tc.last_vol_6h,
       tc.last_vol_24h,
       tc.last_price_change_1h,
       tc.last_price_change_6h,
       tc.last_price_change_24h,
       tc.last_token_created_at_ms,
       tc.last_seen_at,
       tc.last_evaluated_at,
       ranked.included_rank,
       ranked.history_sort_score
     FROM requested
     LEFT JOIN token_catalog tc
       ON tc.address = requested.address
     LEFT JOIN ranked
       ON ranked.address = requested.address
     ORDER BY requested.input_order ASC`,
    [unique, ...whereParams]
  );

  return rows.map((row) => ({
    address: row.address,
    symbol: row.symbol || null,
    included: Boolean(row.included_rank),
    diagnosis: diagnoseHistoryBucketProbe(row, params),
    rank: row.included_rank ? Number(row.included_rank) : null,
    historySortScore: row.history_sort_score != null ? Number(row.history_sort_score) : null,
    eligibleForMonitoring: row.eligible_for_monitoring,
    eligibilityState: row.eligibility_state || null,
    suppressedReason: row.suppressed_reason || null,
    monitorPriority: row.monitor_priority || null,
    mcap: row.last_mcap != null ? Number(row.last_mcap) : null,
    volume1h: row.last_vol_1h != null ? Number(row.last_vol_1h) : null,
    volume6h: row.last_vol_6h != null ? Number(row.last_vol_6h) : null,
    volume24h: row.last_vol_24h != null ? Number(row.last_vol_24h) : null,
    priceChange1h: row.last_price_change_1h != null ? Number(row.last_price_change_1h) : null,
    priceChange6h: row.last_price_change_6h != null ? Number(row.last_price_change_6h) : null,
    priceChange24h: row.last_price_change_24h != null ? Number(row.last_price_change_24h) : null,
    tokenCreatedAt: row.last_token_created_at_ms != null ? Number(row.last_token_created_at_ms) : null,
    lastSeenAt: row.last_seen_at || null,
    lastEvaluatedAt: row.last_evaluated_at || null,
  }));
}

async function listDashboardHistoryBucket(bucket, options = {}) {
  const normalized = buildHistoryBucketQueryParams(bucket, options);
  if (!normalized.ok) {
    return {
      total: 0,
      rows: [],
      page: normalized.params.page,
      perPage: normalized.params.perPage,
    };
  }

  const { params } = normalized;
  const whereSql = buildHistoryBucketWhereSql(params);
  const queryParams = buildHistoryBucketQueryParamsWithLimit(params);

  const { rows } = await db.query(
    `${DASHBOARD_MONITORED_SELECT_SQL},
       ${params.scoreSql} AS history_sort_score,
       COUNT(*) OVER() AS total_count
     FROM token_catalog tc
     LEFT JOIN token_risk_reviews trr
       ON trr.token_address = tc.address
     LEFT JOIN admin_blocked_tokens ab
       ON ab.address = tc.address
     LEFT JOIN token_risk_enrichment tre
       ON tre.token_address = tc.address
     WHERE ${whereSql.join('\n       AND ')}
     ORDER BY ${params.orderSql}
     LIMIT $${params.ageParams.length + 7}
     OFFSET $${params.ageParams.length + 8}`,
    queryParams
  );

  return {
    total: Number(rows[0]?.total_count) || 0,
    rows,
    page: params.page,
    perPage: params.perPage,
  };
}

async function listAutoRiskReviewCandidates(limit = 250, offset = 0, minMcap = 30000) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 250, 5000));
  const safeOffset = Math.max(0, Math.trunc(Number(offset) || 0));
  const safeMinMcap = Math.max(0, Number.isFinite(Number(minMcap)) ? Number(minMcap) : 30000);
  const { rows } = await db.query(
    `SELECT
       tc.address,
       tc.source,
       tc.symbol,
       tc.name,
       tc.eligible_for_monitoring,
       tc.suppressed_reason,
       tc.last_mcap,
       tc.last_price,
       tc.last_vol_5m,
       tc.last_vol_1h,
       tc.last_vol_6h,
       tc.last_vol_24h,
       tc.last_liquidity_usd,
       tc.last_txns_1h_buys,
       tc.last_txns_1h_sells,
       tc.last_txns_24h_buys,
       tc.last_txns_24h_sells,
       tc.last_price_change_1h,
       tc.last_price_change_6h,
       tc.last_price_change_24h,
       tc.last_token_created_at_ms,
       tc.last_pair_address,
       tc.last_pair_url,
       tc.last_image_url,
       tc.last_twitter_url,
       tc.last_community_url,
       tc.monitor_priority,
       tc.last_seen_at,
       tc.last_evaluated_at,
       trr.label AS risk_review_label,
       trr.source AS risk_review_source,
       trr.notes AS risk_review_notes,
       trr.updated_at AS risk_review_updated_at,
       ab.label AS blocked_label,
       ab.created_by AS blocked_created_by,
       ab.created_at AS blocked_created_at,
       tre.last_attempted_at AS risk_enrichment_last_attempted_at,
       tre.last_enriched_at AS risk_enrichment_last_enriched_at,
       tre.last_error AS risk_enrichment_last_error,
       tre.holder_count AS risk_holder_count,
       tre.mint_authority_active AS risk_mint_authority_active,
       tre.freeze_authority_active AS risk_freeze_authority_active,
       tre.top_10_pct AS risk_top_10_pct,
       tre.top_20_pct AS risk_top_20_pct,
       tre.reason_codes AS risk_reason_codes
     FROM token_catalog tc
     LEFT JOIN token_risk_reviews trr
       ON trr.token_address = tc.address
     LEFT JOIN admin_blocked_tokens ab
       ON ab.address = tc.address
     LEFT JOIN token_risk_enrichment tre
       ON tre.token_address = tc.address
     WHERE (tc.eligible_for_monitoring = TRUE OR tc.suppressed_reason = 'gmgn_needs_risk_enrichment')
       AND COALESCE(tc.last_mcap, 0) >= $3
       AND COALESCE(trr.label, '') <> 'valid'
     ORDER BY CASE
                WHEN trr.source = 'auto'
                 AND tc.last_evaluated_at IS NOT NULL
                 AND (trr.updated_at IS NULL OR trr.updated_at < tc.last_evaluated_at)
                  THEN 0
                WHEN trr.token_address IS NULL THEN 1
                ELSE 2
              END ASC,
              COALESCE(tc.last_evaluated_at, tc.last_seen_at) DESC,
              tc.last_seen_at DESC,
              tc.address ASC
     LIMIT $1
     OFFSET $2`,
    [safeLimit, safeOffset, safeMinMcap]
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
       tc.address,
       tc.symbol,
       tc.name,
       tc.last_pair_address,
       tc.last_pair_url,
       tc.last_image_url,
       tc.last_twitter_url,
       tc.last_community_url,
       tc.last_mcap,
       tc.last_vol_5m,
       tc.last_vol_1h,
       tc.last_vol_6h,
       tc.last_vol_24h,
       tc.last_liquidity_usd,
       tc.last_txns_1h_buys,
       tc.last_txns_1h_sells,
       tc.last_txns_24h_buys,
       tc.last_txns_24h_sells,
       tc.last_price_change_1h,
       tc.last_price_change_6h,
       tc.last_price_change_24h,
       tc.monitor_priority,
       tc.last_token_created_at_ms,
       trr.label AS risk_review_label,
       trr.source AS risk_review_source,
       trr.notes AS risk_review_notes,
       trr.updated_at AS risk_review_updated_at,
       tre.last_attempted_at AS risk_enrichment_last_attempted_at,
       tre.last_enriched_at AS risk_enrichment_last_enriched_at,
       tre.last_error AS risk_enrichment_last_error,
       tre.holder_count AS risk_holder_count,
       tre.mint_authority_active AS risk_mint_authority_active,
       tre.freeze_authority_active AS risk_freeze_authority_active,
       tre.top_10_pct AS risk_top_10_pct,
       tre.top_20_pct AS risk_top_20_pct,
       tre.reason_codes AS risk_reason_codes
     FROM token_catalog tc
     LEFT JOIN token_risk_reviews trr
       ON trr.token_address = tc.address
     LEFT JOIN admin_blocked_tokens ab
       ON ab.address = tc.address
     LEFT JOIN token_risk_enrichment tre
       ON tre.token_address = tc.address
     WHERE tc.address = ANY($1::varchar[])`,
    [unique]
  );

  return rows;
}

async function listRiskEnrichmentCandidates(limit = 250, runner = db) {
  const safeLimit = normalizeRiskCandidateLimit(limit);
  const { rows } = await runner.query(
    `SELECT
       tc.address,
       tc.symbol,
       tc.name,
       tc.source,
       tc.eligibility_state,
       tc.eligible_for_monitoring,
       tc.suppressed_reason,
       tc.monitor_priority,
       tc.last_mcap,
       tc.last_vol_1h,
       tc.last_vol_6h,
       tc.last_vol_24h,
       tc.last_liquidity_usd,
       tc.last_txns_1h_buys,
       tc.last_txns_1h_sells,
       tc.last_txns_24h_buys,
       tc.last_txns_24h_sells,
       tc.last_price_change_1h,
       tc.last_price_change_6h,
       tc.last_price_change_24h,
       tc.last_token_created_at_ms,
       tc.last_seen_at,
       tc.last_evaluated_at,
       trr.label AS risk_review_label,
       trr.source AS risk_review_source,
       tre.last_attempted_at,
       tre.last_enriched_at,
       tre.last_error,
       tre.holder_count,
       tre.mint_authority_active,
       tre.freeze_authority_active,
       tre.top_10_pct,
       tre.top_20_pct
     FROM token_catalog tc
     LEFT JOIN token_risk_reviews trr
       ON trr.token_address = tc.address
     LEFT JOIN token_risk_enrichment tre
       ON tre.token_address = tc.address
     WHERE tc.is_active_monitor_candidate = TRUE
       AND NOT EXISTS (
         SELECT 1
         FROM admin_blocked_tokens ab
         WHERE ab.address = tc.address
       )
     ORDER BY CASE
                WHEN COALESCE(tc.monitor_priority, 'dormant') = 'high' THEN 0
                WHEN COALESCE(tc.monitor_priority, 'dormant') = 'normal' THEN 1
                WHEN COALESCE(tc.monitor_priority, 'dormant') = 'low' THEN 2
                ELSE 3
              END ASC,
              COALESCE(tre.last_enriched_at, tre.last_attempted_at, to_timestamp(0)) ASC,
              tc.last_seen_at DESC,
              tc.address ASC
     LIMIT $1`,
    [safeLimit]
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

async function reactivateAdminBlockedToken(address) {
  await adminBlockedToken.ensureTable();
  const addr = String(address || '').trim();
  if (!isValidAddress(addr)) {
    throw new Error('Invalid token address format');
  }

  const { rows } = await db.query(
    `UPDATE token_catalog
     SET source = CASE
           WHEN EXISTS (SELECT 1 FROM user_tokens ut WHERE ut.address = $1) THEN 'user-manual'
           WHEN source = 'admin-blocked' THEN 'dexscreener-discovery'
           ELSE source
         END,
         is_active_monitor_candidate = TRUE,
         eligible_for_monitoring = FALSE,
         eligibility_state = 'pending',
         suppressed_reason = NULL,
         monitor_priority = 'dormant',
         next_evaluation_at = NOW(),
         last_evaluation_error = NULL,
         evaluation_error_count = 0,
         metadata_updated_at = NOW()
     WHERE address = $1
       AND NOT EXISTS (
         SELECT 1
         FROM admin_blocked_tokens ab
         WHERE ab.address = token_catalog.address
       )
     RETURNING *`,
    [addr]
  );

  return rows[0] || null;
}

async function applyEvaluationResult(address, result) {
  await adminBlockedToken.ensureTable();
  const addr = String(address || '').trim();
  const previousMonitoringRow = await getMonitoredExitSnapshot(addr);
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
  const socialLinks = normalizeSocialLinkFields(result);
  const twitterUrl = socialLinks.twitterUrl;
  const communityUrl = socialLinks.communityUrl;
  const lastMcap = toNullableNumber(result.mcap);
  const lastPrice = toNullableNumber(result.price);
  const monitorPriority = toNullableText(result.monitorPriority, 32) || 'dormant';
  const lastVol5m = toNullableNumber(result.vol5m);
  const volumeValues = await preserveGmgnPositiveVolumeWindows(addr, result, {
    lastVol1h: toNullableNumber(result.vol1h),
    lastVol6h: toNullableNumber(result.vol6h),
    lastVol24h: toNullableNumber(result.vol24h),
  });
  const { lastVol1h, lastVol6h, lastVol24h } = volumeValues;
  const lastPriceChange1h = toNullableNumber(result.priceChange1h);
  const lastPriceChange6h = toNullableNumber(result.priceChange6h);
  const lastPriceChange24h = toNullableNumber(result.priceChange24h);
  const lastLiquidityUsd = toNullableNumber(result.liquidityUsd);
  const lastTxns1hBuys = toNullableInteger(result.txns1hBuys);
  const lastTxns1hSells = toNullableInteger(result.txns1hSells);
  const lastTxns24hBuys = toNullableInteger(result.txns24hBuys);
  const lastTxns24hSells = toNullableInteger(result.txns24hSells);
  const lastTokenCreatedAtMs = toNullableInteger(result.tokenCreatedAt);

  const updateResult = await db.query(
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
         last_community_url = COALESCE($14, last_community_url),
         last_mcap = COALESCE($15, last_mcap),
         last_price = COALESCE($16, last_price),
         monitor_priority = $17,
         last_vol_5m = COALESCE($18, last_vol_5m),
         last_vol_1h = COALESCE($19, last_vol_1h),
         last_vol_6h = COALESCE($20, last_vol_6h),
         last_vol_24h = COALESCE($21, last_vol_24h),
         last_price_change_1h = COALESCE($22, last_price_change_1h),
         last_price_change_6h = COALESCE($23, last_price_change_6h),
         last_price_change_24h = COALESCE($24, last_price_change_24h),
         last_liquidity_usd = COALESCE($25, last_liquidity_usd),
         last_txns_1h_buys = COALESCE($26, last_txns_1h_buys),
         last_txns_1h_sells = COALESCE($27, last_txns_1h_sells),
         last_txns_24h_buys = COALESCE($28, last_txns_24h_buys),
         last_txns_24h_sells = COALESCE($29, last_txns_24h_sells),
         last_token_created_at_ms = COALESCE($30, last_token_created_at_ms),
         metadata_updated_at = CASE
           WHEN $8 IS NOT NULL OR $9 IS NOT NULL OR $10 IS NOT NULL OR $11 IS NOT NULL OR $12 IS NOT NULL OR $13 IS NOT NULL OR $14 IS NOT NULL OR $15 IS NOT NULL OR $16 IS NOT NULL OR $18 IS NOT NULL OR $19 IS NOT NULL OR $20 IS NOT NULL OR $21 IS NOT NULL OR $22 IS NOT NULL OR $23 IS NOT NULL OR $24 IS NOT NULL OR $25 IS NOT NULL OR $26 IS NOT NULL OR $27 IS NOT NULL OR $28 IS NOT NULL OR $29 IS NOT NULL OR $30 IS NOT NULL
           THEN NOW()
           ELSE metadata_updated_at
         END
     WHERE address = $1
       AND COALESCE(source, '') <> 'admin-blocked'
       AND NOT EXISTS (
         SELECT 1
         FROM admin_blocked_tokens ab
         WHERE ab.address = token_catalog.address
       )
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
      communityUrl,
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
      lastLiquidityUsd,
      lastTxns1hBuys,
      lastTxns1hSells,
      lastTxns24hBuys,
      lastTxns24hSells,
      lastTokenCreatedAtMs,
    ]
  );

  if (updateResult.rows[0]) {
    await recordMonitoredExit(previousMonitoringRow, updateResult.rows[0], {
      evaluationSource: result.evaluationSource || result.source,
    });
    return updateResult.rows[0];
  }

  const blockedNextEvaluationAt = new Date(Date.now() + (10 * 365 * 24 * 60 * 60 * 1000));
  const blockedResult = await db.query(
    `UPDATE token_catalog
     SET source = 'admin-blocked',
         is_active_monitor_candidate = FALSE,
         eligible_for_monitoring = FALSE,
         eligibility_state = 'admin-blocked',
         suppressed_reason = 'admin_blocked',
         monitor_priority = 'dormant',
         last_evaluated_at = NOW(),
         next_evaluation_at = $2,
         last_evaluation_error = NULL,
         evaluation_error_count = 0,
         metadata_updated_at = NOW()
     WHERE address = $1
       AND (
         source = 'admin-blocked'
         OR EXISTS (
           SELECT 1
           FROM admin_blocked_tokens ab
           WHERE ab.address = token_catalog.address
         )
       )
     RETURNING *`,
    [addr, blockedNextEvaluationAt]
  );

  if (blockedResult.rows[0]) {
    await recordMonitoredExit(previousMonitoringRow, blockedResult.rows[0], {
      evaluationSource: 'admin-blocked',
    });
  }

  return blockedResult.rows[0] || null;
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

async function hasUserManualAddress(address) {
  const addr = String(address || '').trim();
  if (!isValidAddress(addr)) {
    return false;
  }

  const { rows } = await db.query(
    `SELECT 1
     FROM user_tokens
     WHERE address = $1
     LIMIT 1`,
    [addr]
  );
  return rows.length > 0;
}

async function demoteFormerManualAddress(address) {
  const addr = String(address || '').trim();
  if (!isValidAddress(addr)) {
    return null;
  }

  const { rows } = await db.query(
    `UPDATE token_catalog tc
     SET source = 'dexscreener-discovery',
         metadata_updated_at = NOW()
     WHERE tc.address = $1
       AND tc.source = 'user-manual'
       AND NOT EXISTS (
         SELECT 1
         FROM user_tokens ut
         WHERE ut.address = tc.address
       )
     RETURNING *`,
    [addr]
  );
  return rows[0] || null;
}

module.exports = {
  upsertToken,
  getByAddress,
  hasUserManualAddress,
  demoteFormerManualAddress,
  listRecent,
  listDueForEvaluation,
  countDueForEvaluationSummary,
  countDueForMeteoraSnapshots,
  countDueForMeteoraSnapshotsByTier,
  listDueForMeteoraSnapshots,
  listEligibleVisible,
  listDashboardMonitored,
  listDashboardMonitoredSlice,
  listDashboardTopPerformers,
  listDashboardHistoryBucket,
  listDashboardHistoryBucketDebugProbe,
  listAutoRiskReviewCandidates,
  listDashboardMetadataByAddresses,
  listRiskEnrichmentCandidates,
  markMeteoraChecked,
  scheduleImmediateEvaluation,
  reactivateSoftArchivedToken,
  reactivateAdminBlockedToken,
  applyEvaluationResult,
  applyQuarantineCleanup,
  applySoftArchiveCleanup,
  applyAutomatedCleanup,
};
