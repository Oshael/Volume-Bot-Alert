const db = require('../models/db');
const tokenCatalog = require('../models/token-catalog');
const { isValidAddress } = require('../models/user-token');

const SUBTICKER_MIN_LENGTH = 4;
const DEFAULT_LIMIT = 8;

function normalizeSymbolKey(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function toNumberOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeLimit(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isInteger(parsed)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(2, Math.min(parsed, 20));
}

function mapPeerRow(row) {
  return {
    address: row.address || '',
    symbol: row.symbol || null,
    name: row.name || null,
    imageUrl: row.image_url || null,
    mcap: toNumberOrNull(row.last_mcap),
    tokenCreatedAt: toNumberOrNull(row.last_token_created_at_ms),
    ageMsAtAlert: toNumberOrNull(row.age_ms_at_alert),
    matchType: row.match_type === 'subticker' ? 'subticker' : 'exact',
  };
}

async function listTickerPeersBySymbol(symbol, options = {}, runner = db) {
  const normalizedSymbol = normalizeSymbolKey(symbol);
  if (normalizedSymbol.length < 2) {
    return [];
  }

  const limit = normalizeLimit(options.limit);
  const snapshotTsMs = toNumberOrNull(options.snapshotTsMs) ?? Date.now();
  const { rows } = await runner.query(
    `WITH catalog AS (
       SELECT
         address,
         symbol,
         name,
         last_image_url AS image_url,
         last_mcap,
         last_token_created_at_ms,
         CASE
           WHEN last_token_created_at_ms IS NOT NULL
            THEN GREATEST(0, $4::bigint - last_token_created_at_ms)
           ELSE NULL
         END AS age_ms_at_alert,
         regexp_replace(upper(COALESCE(symbol, '')), '[^A-Z0-9]', '', 'g') AS normalized_symbol
       FROM token_catalog
       WHERE symbol IS NOT NULL
         AND btrim(symbol) <> ''
     )
     SELECT
       address,
       symbol,
       name,
       image_url,
       last_mcap,
       last_token_created_at_ms,
       age_ms_at_alert,
       CASE
         WHEN normalized_symbol = $1 THEN 'exact'
         ELSE 'subticker'
       END AS match_type
     FROM catalog
     WHERE normalized_symbol <> ''
       AND (
         normalized_symbol = $1
         OR (
           char_length($1) >= $2
           AND char_length(normalized_symbol) >= $2
           AND (
             normalized_symbol LIKE $1 || '%'
             OR $1 LIKE normalized_symbol || '%'
           )
         )
       )
     ORDER BY
       CASE WHEN normalized_symbol = $1 THEN 0 ELSE 1 END ASC,
       COALESCE(last_mcap, 0) DESC,
       COALESCE(last_token_created_at_ms, 0) DESC,
       address ASC
     LIMIT $3`,
    [normalizedSymbol, SUBTICKER_MIN_LENGTH, limit, snapshotTsMs]
  );

  return rows.map(mapPeerRow);
}

async function buildTickerPeerSnapshotForAlert(input = {}, options = {}, runner = db) {
  const address = String(input.address || '').trim();
  const limit = normalizeLimit(options.limit);
  if (!isValidAddress(address)) {
    return null;
  }

  let symbol = String(input.symbol || '').trim();
  if (!symbol) {
    const tokenRow = await tokenCatalog.getByAddress(address);
    symbol = String(tokenRow?.symbol || '').trim();
  }

  const normalizedSymbol = normalizeSymbolKey(symbol);
  if (normalizedSymbol.length < 2) {
    return null;
  }

  const snapshotTsMs = toNumberOrNull(options.snapshotTsMs) ?? Date.now();
  const items = await listTickerPeersBySymbol(symbol, { limit, snapshotTsMs }, runner);
  if (items.length <= 1) {
    return null;
  }

  return {
    sourceSymbol: symbol,
    normalizedSymbol,
    count: items.length,
    hasSubtickerMatch: items.some((item) => item.matchType === 'subticker'),
    items,
  };
}

module.exports = {
  buildTickerPeerSnapshotForAlert,
  listTickerPeersBySymbol,
  __private: {
    normalizeLimit,
    normalizeSymbolKey,
  },
};
