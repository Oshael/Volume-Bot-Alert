const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { normalizeText, sanitizeAssetUrl, sanitizeHttpUrl } = require('../utils/url-safety');

const CHAIN = 'robinhood';
const PROTOCOL = 'uniswap-v2';
const DASHBOARD_PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const WINDOW_MS = 5 * 60 * 1000;

function decimal(value, label, options = {}) {
  if (value == null && options.nullable) return null;
  const raw = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(raw)) throw new Error(`${label} must be a non-negative decimal`);
  return raw;
}

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid timestamp`);
  return parsed;
}

function signedDecimal(value, label, options = {}) {
  if (value == null && options.nullable) return null;
  const raw = String(value ?? '').trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) throw new Error(`${label} must be a decimal`);
  return raw;
}

function primaryAddress(protocol, marketKey) {
  if (protocol === 'uniswap-v4') return null;
  return normalizeTokenAddress(CHAIN, marketKey.slice(`${CHAIN}:${protocol}:`.length));
}

function normalizeDashboardSnapshot(input = {}) {
  const protocol = String(input.protocol || '').trim().toLowerCase();
  if (!DASHBOARD_PROTOCOLS.has(protocol)) {
    throw new Error('Robinhood dashboard projection protocol is unsupported');
  }
  const marketKey = String(input.marketKey || '').trim().toLowerCase();
  if (!marketKey.startsWith(`${CHAIN}:${protocol}:`)) {
    throw new Error('Robinhood dashboard projection marketKey is invalid');
  }
  return Object.freeze({
    tokenAddress: normalizeTokenAddress(CHAIN, input.tokenAddress),
    protocol,
    pairAddress: primaryAddress(protocol, marketKey),
    firstSeenAt: timestamp(input.discoveredAt, 'discoveredAt'),
    lastSeenAt: timestamp(input.lastObservedAt, 'lastObservedAt'),
    priceUsd: decimal(input.lastPriceUsd, 'lastPriceUsd'),
    fdvUsd: decimal(input.lastFdvUsd, 'lastFdvUsd', { nullable: true }),
    volume5mUsd: decimal(input.volume5mUsd, 'volume5mUsd', { nullable: true }),
    volume1hUsd: decimal(input.volume1hUsd, 'volume1hUsd', { nullable: true }),
    volume6hUsd: decimal(input.volume6hUsd, 'volume6hUsd', { nullable: true }),
    volume24hUsd: decimal(input.volume24hUsd, 'volume24hUsd', { nullable: true }),
    liquidityUsd: decimal(input.liquidityUsd, 'liquidityUsd', { nullable: true }),
    priceChange1hPct: signedDecimal(input.priceChange1hPct, 'priceChange1hPct', { nullable: true }),
    priceChange6hPct: signedDecimal(input.priceChange6hPct, 'priceChange6hPct', { nullable: true }),
    priceChange24hPct: signedDecimal(input.priceChange24hPct, 'priceChange24hPct', { nullable: true }),
  });
}

function normalizeStagedSnapshot(input = {}) {
  const protocol = String(input.protocol || '').trim().toLowerCase();
  if (protocol !== PROTOCOL) throw new Error('Robinhood catalog staging currently supports uniswap-v2 only');
  if (Number(input.windowMs) !== WINDOW_MS) throw new Error('Robinhood catalog staging requires a 5 minute window');

  const marketKey = String(input.marketKey || '').trim().toLowerCase();
  const prefix = `${CHAIN}:${PROTOCOL}:`;
  if (!marketKey.startsWith(prefix)) throw new Error('Robinhood catalog marketKey is invalid');

  return Object.freeze({
    chain: CHAIN,
    protocol,
    marketKey,
    tokenAddress: normalizeTokenAddress(CHAIN, input.tokenAddress),
    pairAddress: normalizeTokenAddress(CHAIN, marketKey.slice(prefix.length)),
    firstSeenAt: timestamp(input.discoveredAt, 'discoveredAt'),
    lastSeenAt: timestamp(input.lastObservedAt, 'lastObservedAt'),
    priceUsd: decimal(input.lastPriceUsd, 'lastPriceUsd'),
    volume5mUsd: decimal(input.volumeUsd, 'volumeUsd'),
    liquidityUsd: decimal(input.liquidityUsd, 'liquidityUsd', { nullable: true }),
    fdvUsd: decimal(input.lastFdvUsd, 'lastFdvUsd', { nullable: true }),
  });
}

async function stageSnapshot(input, runner = db) {
  const snapshot = normalizeStagedSnapshot(input);
  const { rows } = await runner.query(
    `INSERT INTO token_catalog (
       chain, address, source, first_seen_at, last_seen_at,
       last_price, last_fdv, last_vol_5m, last_liquidity_usd,
       last_pair_address, last_dex_id,
       is_active_monitor_candidate, eligible_for_monitoring,
       eligibility_state, suppressed_reason
     ) VALUES (
       'robinhood', $1, 'robinhood-onchain', $2, $3,
       $4, $5, $6, $7,
       $8, 'uniswap-v2',
       FALSE, FALSE,
       'robinhood-staged', 'robinhood-alerts-disabled'
     )
     ON CONFLICT (chain, address) DO UPDATE SET
       source = EXCLUDED.source,
       first_seen_at = LEAST(token_catalog.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = GREATEST(token_catalog.last_seen_at, EXCLUDED.last_seen_at),
       last_price = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_price ELSE token_catalog.last_price END,
       last_fdv = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_fdv ELSE token_catalog.last_fdv END,
       last_vol_5m = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_vol_5m ELSE token_catalog.last_vol_5m END,
       last_liquidity_usd = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_liquidity_usd ELSE token_catalog.last_liquidity_usd END,
       last_pair_address = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_pair_address ELSE token_catalog.last_pair_address END,
       last_dex_id = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_dex_id ELSE token_catalog.last_dex_id END,
       metadata_updated_at = NOW()
     RETURNING *`,
    [
      snapshot.tokenAddress,
      snapshot.firstSeenAt,
      snapshot.lastSeenAt,
      snapshot.priceUsd,
      snapshot.fdvUsd,
      snapshot.volume5mUsd,
      snapshot.liquidityUsd,
      snapshot.pairAddress,
    ]
  );
  return rows[0] || null;
}

async function projectDashboardSnapshot(input, runner = db) {
  const snapshot = normalizeDashboardSnapshot(input);
  const { rows } = await runner.query(
    `INSERT INTO token_catalog (
       chain, address, source, first_seen_at, last_seen_at,
       last_price, last_fdv, last_vol_5m, last_vol_1h, last_vol_6h,
       last_vol_24h, last_liquidity_usd, last_pair_address, last_dex_id,
       last_price_change_1h, last_price_change_6h, last_price_change_24h,
       last_token_created_at_ms, is_active_monitor_candidate,
       eligible_for_monitoring, eligibility_state, suppressed_reason,
       monitor_priority
     ) VALUES (
       'robinhood', $1, 'robinhood-onchain', $2, $3,
       $4, $5, $6, $7, $8,
       $9, $10, $11, $12,
       $13, $14, $15,
       $16, FALSE,
       FALSE, 'robinhood-dashboard-active', 'robinhood-workspace-read-only',
       'dormant'
     )
     ON CONFLICT (chain, address) DO UPDATE SET
       source = EXCLUDED.source,
       first_seen_at = LEAST(token_catalog.first_seen_at, EXCLUDED.first_seen_at),
       last_seen_at = GREATEST(token_catalog.last_seen_at, EXCLUDED.last_seen_at),
       last_price = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_price ELSE token_catalog.last_price END,
       last_fdv = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_fdv ELSE token_catalog.last_fdv END,
       last_vol_5m = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN COALESCE(EXCLUDED.last_vol_5m, token_catalog.last_vol_5m)
         ELSE token_catalog.last_vol_5m END,
       last_vol_1h = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN COALESCE(EXCLUDED.last_vol_1h, token_catalog.last_vol_1h)
         ELSE token_catalog.last_vol_1h END,
       last_vol_6h = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN COALESCE(EXCLUDED.last_vol_6h, token_catalog.last_vol_6h)
         ELSE token_catalog.last_vol_6h END,
       last_vol_24h = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN COALESCE(EXCLUDED.last_vol_24h, token_catalog.last_vol_24h)
         ELSE token_catalog.last_vol_24h END,
       last_liquidity_usd = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_liquidity_usd ELSE token_catalog.last_liquidity_usd END,
       last_pair_address = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_pair_address ELSE token_catalog.last_pair_address END,
       last_dex_id = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_dex_id ELSE token_catalog.last_dex_id END,
       last_price_change_1h = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_price_change_1h ELSE token_catalog.last_price_change_1h END,
       last_price_change_6h = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_price_change_6h ELSE token_catalog.last_price_change_6h END,
       last_price_change_24h = CASE WHEN EXCLUDED.last_seen_at >= token_catalog.last_seen_at
         THEN EXCLUDED.last_price_change_24h ELSE token_catalog.last_price_change_24h END,
       last_token_created_at_ms = LEAST(
         COALESCE(token_catalog.last_token_created_at_ms, EXCLUDED.last_token_created_at_ms),
         EXCLUDED.last_token_created_at_ms
       ),
       is_active_monitor_candidate = FALSE,
       eligible_for_monitoring = FALSE,
       eligibility_state = CASE
         WHEN token_catalog.eligibility_state = 'robinhood-staged'
           THEN token_catalog.eligibility_state
         ELSE 'robinhood-dashboard-active'
       END,
       suppressed_reason = CASE
         WHEN token_catalog.eligibility_state = 'robinhood-staged'
           THEN 'robinhood-alerts-disabled'
         ELSE 'robinhood-workspace-read-only'
       END,
       monitor_priority = 'dormant'
     RETURNING *`,
    [
      snapshot.tokenAddress,
      snapshot.firstSeenAt,
      snapshot.lastSeenAt,
      snapshot.priceUsd,
      snapshot.fdvUsd,
      snapshot.volume5mUsd,
      snapshot.volume1hUsd,
      snapshot.volume6hUsd,
      snapshot.volume24hUsd,
      snapshot.liquidityUsd,
      snapshot.pairAddress,
      snapshot.protocol,
      snapshot.priceChange1hPct,
      snapshot.priceChange6hPct,
      snapshot.priceChange24hPct,
      snapshot.firstSeenAt.getTime(),
    ]
  );
  return rows[0] || null;
}

async function listMetadata(addresses, runner = db) {
  const normalized = [...new Set((Array.isArray(addresses) ? addresses : [])
    .map((address) => normalizeTokenAddress(CHAIN, address)))].slice(0, 5000);
  if (!normalized.length) return [];
  const { rows } = await runner.query(
    `SELECT address, symbol, name, last_image_url, last_website_url,
       last_twitter_url, last_community_url, metadata_updated_at,
       robinhood_blockscout_checked_at, robinhood_dexscreener_checked_at
     FROM token_catalog
     WHERE chain = 'robinhood' AND address = ANY($1::varchar[])`,
    [normalized]
  );
  return rows;
}

async function recordBlockscoutMetadata(input = {}, runner = db) {
  const address = normalizeTokenAddress(CHAIN, input.address);
  const symbol = normalizeText(input.symbol, 64);
  const name = normalizeText(input.name, 128);
  const imageUrl = sanitizeAssetUrl(input.imageUrl);
  const { rows } = await runner.query(
    `UPDATE token_catalog
     SET symbol = COALESCE($2, symbol),
         name = COALESCE($3, name),
         last_image_url = COALESCE($4, last_image_url),
         robinhood_blockscout_checked_at = NOW(),
         metadata_updated_at = CASE WHEN $2 IS NOT NULL OR $3 IS NOT NULL OR $4 IS NOT NULL
           THEN NOW() ELSE metadata_updated_at END
     WHERE chain = 'robinhood' AND address = $1
     RETURNING *`,
    [address, symbol, name, imageUrl]
  );
  return rows[0] || null;
}

async function recordDexscreenerMetadata(input = {}, runner = db) {
  const address = normalizeTokenAddress(CHAIN, input.address);
  const imageUrl = sanitizeAssetUrl(input.imageUrl);
  const websiteUrl = sanitizeHttpUrl(input.websiteUrl);
  const twitterUrl = sanitizeHttpUrl(input.twitterUrl);
  const communityUrl = sanitizeHttpUrl(input.communityUrl || input.telegramUrl);
  const { rows } = await runner.query(
    `UPDATE token_catalog
     SET last_image_url = COALESCE($2, last_image_url),
         last_website_url = COALESCE($3, last_website_url),
         last_twitter_url = COALESCE($4, last_twitter_url),
         last_community_url = COALESCE($5, last_community_url),
         robinhood_dexscreener_checked_at = NOW(),
         metadata_updated_at = CASE
           WHEN $2 IS NOT NULL OR $3 IS NOT NULL OR $4 IS NOT NULL OR $5 IS NOT NULL
           THEN NOW() ELSE metadata_updated_at END
     WHERE chain = 'robinhood' AND address = $1
     RETURNING *`,
    [address, imageUrl, websiteUrl, twitterUrl, communityUrl]
  );
  return rows[0] || null;
}

async function applyMetadata(input = {}, runner = db) {
  const address = normalizeTokenAddress(CHAIN, input.address);
  const fields = {
    symbol: normalizeText(input.symbol, 64),
    name: normalizeText(input.name, 128),
    imageUrl: sanitizeAssetUrl(input.imageUrl),
    websiteUrl: sanitizeHttpUrl(input.websiteUrl),
    twitterUrl: sanitizeHttpUrl(input.twitterUrl),
    communityUrl: sanitizeHttpUrl(input.communityUrl || input.telegramUrl),
  };
  if (!Object.values(fields).some(Boolean)) return null;
  const { rows } = await runner.query(
    `UPDATE token_catalog
     SET symbol = COALESCE($2, symbol),
         name = COALESCE($3, name),
         last_image_url = COALESCE($4, last_image_url),
         last_website_url = COALESCE($5, last_website_url),
         last_twitter_url = COALESCE($6, last_twitter_url),
         last_community_url = COALESCE($7, last_community_url),
         metadata_updated_at = NOW()
     WHERE chain = 'robinhood' AND address = $1
     RETURNING *`,
    [
      address, fields.symbol, fields.name, fields.imageUrl,
      fields.websiteUrl, fields.twitterUrl, fields.communityUrl,
    ]
  );
  return rows[0] || null;
}

async function ensureManualToken(tokenAddress, runner = db) {
  const address = normalizeTokenAddress(CHAIN, tokenAddress);
  const { rows } = await runner.query(
    `INSERT INTO token_catalog (
       chain, address, source, is_active_monitor_candidate,
       eligible_for_monitoring, eligibility_state, suppressed_reason,
       monitor_priority
     ) VALUES (
       'robinhood', $1, 'user-manual', FALSE,
       FALSE, 'robinhood-manual', 'robinhood-manual-metadata-pending',
       'dormant'
     )
     ON CONFLICT (chain, address) DO UPDATE SET
       source = CASE WHEN token_catalog.source = 'robinhood-onchain'
         THEN token_catalog.source ELSE 'user-manual' END,
       eligibility_state = CASE WHEN token_catalog.source = 'robinhood-onchain'
         THEN token_catalog.eligibility_state ELSE 'robinhood-manual' END,
       suppressed_reason = CASE WHEN token_catalog.source = 'robinhood-onchain'
         THEN token_catalog.suppressed_reason ELSE 'robinhood-manual-metadata-pending' END,
       metadata_updated_at = NOW()
     RETURNING *`,
    [address]
  );
  return rows[0] || null;
}

async function listManualMetadataCandidates(input = {}, runner = db) {
  const limit = Math.max(1, Math.min(Number(input.limit) || 1000, 5000));
  const { rows } = await runner.query(
    `SELECT catalog.address AS "tokenAddress", 0::numeric AS "volumeUsd"
     FROM token_catalog catalog
     WHERE catalog.chain = 'robinhood'
       AND EXISTS (
         SELECT 1 FROM user_tokens manual
         WHERE manual.chain = catalog.chain AND manual.address = catalog.address
       )
     ORDER BY catalog.metadata_updated_at ASC, catalog.address ASC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = {
  applyMetadata,
  ensureManualToken,
  listMetadata,
  listManualMetadataCandidates,
  projectDashboardSnapshot,
  recordBlockscoutMetadata,
  recordDexscreenerMetadata,
  stageSnapshot,
  __private: { normalizeDashboardSnapshot, normalizeStagedSnapshot },
};
