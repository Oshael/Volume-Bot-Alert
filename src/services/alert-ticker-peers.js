const db = require('../models/db');
const tokenCatalog = require('../models/token-catalog');
const { createTokenIdentity, normalizeTokenChain } = require('../utils/token-identity');

const SUBTICKER_MIN_LENGTH = 3;
const DEFAULT_LIMIT = 8;
// Lists embedded in polled responses stay at DEFAULT_LIMIT; the on-demand panel
// lookup asks for this ceiling. The OG and the market-cap leader are pinned on
// top of it, so a low-cap or inactive OG never falls off the list.
const MAX_LIMIT = 20;
// Catalog valuations are never cleared when a token dies, so a rugged peer can
// keep its last peak forever. Only a peer whose market data was refreshed inside
// this window can hold #1; stale peers stay listed but flagged. Solana compares
// market cap, while Robinhood compares its canonical FDV.
const MCAP_FRESHNESS_SECONDS = 24 * 60 * 60;
const SOURCE_PEER_ROLE_OG = 'og';
const SOURCE_PEER_ROLE_MCAP_LEADER = 'mcap_leader';
const SOURCE_PEER_ROLE_WARNING = 'peer_warning';

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
  return Math.max(2, Math.min(parsed, MAX_LIMIT));
}

function mapPeerRow(row) {
  return {
    address: row.address || '',
    symbol: row.symbol || null,
    name: row.name || null,
    imageUrl: row.image_url || null,
    mcap: toNumberOrNull(row.last_mcap),
    mcapStale: row.has_fresh_mcap !== true,
    mcapAgeMs: toNumberOrNull(row.mcap_age_ms),
    tokenCreatedAt: toNumberOrNull(row.last_token_created_at_ms),
    ageMsAtAlert: toNumberOrNull(row.age_ms_at_alert),
    matchType: row.match_type === 'subticker' ? 'subticker' : 'exact',
  };
}

function normalizeContextText(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getContextWords(...values) {
  const words = new Set();
  for (const value of values) {
    for (const word of normalizeContextText(value).split(' ')) {
      if (word.length >= 3) {
        words.add(word);
      }
    }
  }
  return words;
}

function splitCompactText(value) {
  const text = normalizeSymbolKey(value);
  return text.match(/[A-Z]+|[0-9]+/g) || [];
}

function hasSharedMeaningfulWord(leftWords, rightWords) {
  for (const word of leftWords) {
    if (rightWords.has(word)) {
      return true;
    }
  }
  return false;
}

function compactContainsContext(compactValue, contextWords) {
  const compact = normalizeSymbolKey(compactValue);
  if (!compact) {
    return false;
  }

  for (const word of contextWords) {
    if (compact.includes(word)) {
      return true;
    }
  }
  return false;
}

function resolveSubtickerSuffix(sourceSymbol, peerSymbol) {
  const source = normalizeSymbolKey(sourceSymbol);
  const peer = normalizeSymbolKey(peerSymbol);
  if (!source || !peer || source === peer) {
    return null;
  }
  if (peer.startsWith(source)) {
    return peer.slice(source.length);
  }
  if (source.startsWith(peer)) {
    return source.slice(peer.length);
  }
  return null;
}

function isContextualSubtickerPeer(source = {}, peer = {}) {
  const suffix = resolveSubtickerSuffix(source.symbol, peer.symbol);
  if (!suffix) {
    return false;
  }

  const sourceWords = getContextWords(source.symbol, source.name);
  const peerWords = getContextWords(peer.symbol, peer.name);
  const suffixWords = getContextWords(...splitCompactText(suffix));
  if (!sourceWords.size || !peerWords.size) {
    return true;
  }

  if (hasSharedMeaningfulWord(sourceWords, suffixWords)) {
    return true;
  }
  if (compactContainsContext(suffix, sourceWords)) {
    return true;
  }
  return false;
}

function filterContextualTickerPeerRows(rows, source) {
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (row?.match_type !== 'subticker') {
      return true;
    }
    return isContextualSubtickerPeer(source, {
      symbol: row.symbol,
      name: row.name,
    });
  });
}

function normalizeAddressKey(value) {
  return String(value || '').trim();
}

function normalizePeerChain(value) {
  return normalizeTokenChain(value || 'solana');
}

function normalizePeerIdentity(address, chainValue) {
  try {
    return createTokenIdentity(normalizePeerChain(chainValue), address);
  } catch (_) {
    return null;
  }
}

function sameAddress(left, right) {
  return normalizeAddressKey(left) !== '' && normalizeAddressKey(left) === normalizeAddressKey(right);
}

function mapPeerStatsRow(row) {
  const exactCount = Number.parseInt(String(row?.exact_count || '0'), 10);
  const subtickerCount = Number.parseInt(String(row?.subticker_count || '0'), 10);
  return {
    exactCount: Number.isInteger(exactCount) ? exactCount : 0,
    subtickerCount: Number.isInteger(subtickerCount) ? subtickerCount : 0,
    oldestExactAddress: normalizeAddressKey(row?.oldest_exact_address) || null,
    highestMcapExactAddress: normalizeAddressKey(row?.highest_mcap_exact_address) || null,
  };
}

// The badge on the row and the OG/#1 marks inside the peers panel must agree, so
// both read the same two addresses. Any extra gate here would show a token marked
// #1 in the panel while the row above it still warns with `!`.
function resolveSourcePeerRole(address, stats) {
  if (!stats || stats.exactCount <= 1) {
    return SOURCE_PEER_ROLE_WARNING;
  }

  if (sameAddress(address, stats.oldestExactAddress)) {
    return SOURCE_PEER_ROLE_OG;
  }
  if (sameAddress(address, stats.highestMcapExactAddress)) {
    return SOURCE_PEER_ROLE_MCAP_LEADER;
  }
  return SOURCE_PEER_ROLE_WARNING;
}

function buildTickerPeerSummary(input = {}, stats = null, items = []) {
  const identity = normalizePeerIdentity(input.address, input.chain);
  const address = identity?.address || '';
  const symbol = String(input.symbol || '').trim();
  const normalizedSymbol = normalizeSymbolKey(symbol);
  if (!identity || normalizedSymbol.length < 2 || !stats || stats.exactCount <= 1) {
    return null;
  }

  return {
    chain: identity.chain,
    sourceSymbol: symbol || null,
    normalizedSymbol,
    count: stats.exactCount,
    exactCount: stats.exactCount,
    subtickerCount: stats.subtickerCount,
    hasSubtickerMatch: stats.subtickerCount > 0,
    sourcePeerRole: resolveSourcePeerRole(address, stats),
    oldestExactAddress: stats.oldestExactAddress,
    highestMcapExactAddress: stats.highestMcapExactAddress,
    items,
  };
}

async function listTickerPeerSummariesForTokens(tokens = [], options = {}, runner = db) {
  const chain = normalizePeerChain(options.chain || tokens.find((item) => item?.chain)?.chain || 'solana');
  const inputs = Array.from(new Map(
    (Array.isArray(tokens) ? tokens : [])
      .map((item) => {
        const identity = normalizePeerIdentity(item?.address, item?.chain || chain);
        return identity?.chain === chain ? {
          chain,
          address: identity.address,
          symbol: String(item?.symbol || '').trim(),
        } : null;
      })
      .filter((item) => item && normalizeSymbolKey(item.symbol).length >= 2)
      .map((item) => [item.address, item])
  ).values());

  const normalizedSymbols = [...new Set(inputs.map((item) => normalizeSymbolKey(item.symbol)))];
  if (!normalizedSymbols.length) {
    return new Map();
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
         CASE WHEN chain = 'robinhood' THEN last_fdv ELSE last_mcap END AS last_mcap,
         last_vol_24h,
         CASE
           WHEN last_token_created_at_ms IS NOT NULL AND last_token_created_at_ms > 0
             THEN last_token_created_at_ms
           WHEN chain = 'robinhood' AND first_seen_at IS NOT NULL
             THEN ROUND(EXTRACT(EPOCH FROM first_seen_at) * 1000)
           ELSE NULL
         END AS last_token_created_at_ms,
         CASE
           WHEN last_token_created_at_ms IS NOT NULL AND last_token_created_at_ms > 0
            THEN GREATEST(0, $3::bigint - last_token_created_at_ms)
           WHEN chain = 'robinhood' AND first_seen_at IS NOT NULL
            THEN GREATEST(0, $3::bigint - ROUND(EXTRACT(EPOCH FROM first_seen_at) * 1000))
           ELSE NULL
         END AS age_ms_at_alert,
         (CASE WHEN chain = 'robinhood' THEN last_seen_at ELSE metadata_updated_at END)
           > NOW() - make_interval(secs => $5) AS has_fresh_mcap,
         CASE
           WHEN (CASE WHEN chain = 'robinhood' THEN last_seen_at ELSE metadata_updated_at END) IS NOT NULL
            THEN ROUND(EXTRACT(EPOCH FROM (
              NOW() - (CASE WHEN chain = 'robinhood' THEN last_seen_at ELSE metadata_updated_at END)
            )) * 1000)
           ELSE NULL
         END AS mcap_age_ms,
         regexp_replace(upper(COALESCE(symbol, '')), '[^A-Z0-9]', '', 'g') AS normalized_symbol
       FROM token_catalog
       WHERE chain = $4
         AND symbol IS NOT NULL
         AND btrim(symbol) <> ''
     ),
     exact_matches AS (
       SELECT
         *,
         'exact' AS match_type
       FROM catalog
       WHERE normalized_symbol = ANY($1::text[])
     ),
     stats AS (
       SELECT
         normalized_symbol,
         COUNT(*) AS exact_count,
         0 AS subticker_count,
         (
           ARRAY_AGG(address ORDER BY last_token_created_at_ms ASC, address ASC)
           FILTER (WHERE last_token_created_at_ms IS NOT NULL AND last_token_created_at_ms > 0)
         )[1] AS oldest_exact_address,
         (
           ARRAY_AGG(address ORDER BY last_mcap DESC, COALESCE(last_token_created_at_ms, 9223372036854775807) ASC, address ASC)
           FILTER (WHERE last_mcap IS NOT NULL AND last_mcap > 0 AND has_fresh_mcap)
         )[1] AS highest_mcap_exact_address
       FROM exact_matches
       GROUP BY normalized_symbol
     ),
     ranked AS (
       SELECT
         exact_matches.*,
         stats.exact_count,
         stats.subticker_count,
         stats.oldest_exact_address,
         stats.highest_mcap_exact_address,
         ROW_NUMBER() OVER (
           PARTITION BY exact_matches.normalized_symbol
           ORDER BY COALESCE(exact_matches.last_mcap, 0) DESC,
                    COALESCE(exact_matches.last_vol_24h, 0) DESC,
                    COALESCE(exact_matches.last_token_created_at_ms, 9223372036854775807) ASC,
                    exact_matches.address ASC
         ) AS peer_rank
       FROM exact_matches
       JOIN stats ON stats.normalized_symbol = exact_matches.normalized_symbol
     )
     SELECT
       *
     FROM ranked
     WHERE peer_rank <= $2
        OR address = oldest_exact_address
        OR address = highest_mcap_exact_address
     ORDER BY normalized_symbol ASC, peer_rank ASC`,
    [normalizedSymbols, limit, snapshotTsMs, chain, MCAP_FRESHNESS_SECONDS]
  );

  const statsBySymbol = new Map();
  const itemsBySymbol = new Map();
  for (const row of rows) {
    const normalizedSymbol = normalizeSymbolKey(row.normalized_symbol);
    if (!statsBySymbol.has(normalizedSymbol)) {
      statsBySymbol.set(normalizedSymbol, mapPeerStatsRow(row));
    }
    const items = itemsBySymbol.get(normalizedSymbol) || [];
    items.push(mapPeerRow(row));
    itemsBySymbol.set(normalizedSymbol, items);
  }
  return new Map(inputs
    .map((item) => {
      const normalizedSymbol = normalizeSymbolKey(item.symbol);
      return [
        item.address,
        buildTickerPeerSummary(
          item,
          statsBySymbol.get(normalizedSymbol) || null,
          itemsBySymbol.get(normalizedSymbol) || []
        ),
      ];
    })
    .filter(([, summary]) => Boolean(summary)));
}

async function queryTickerPeerRowsBySymbol(symbol, options = {}, runner = db) {
  const normalizedSymbol = normalizeSymbolKey(symbol);
  if (normalizedSymbol.length < 2) {
    return [];
  }

  const limit = normalizeLimit(options.limit);
  const snapshotTsMs = toNumberOrNull(options.snapshotTsMs) ?? Date.now();
  const chain = normalizePeerChain(options.chain || 'solana');
  const { rows } = await runner.query(
    `WITH catalog AS (
       SELECT
         address,
         symbol,
         name,
         last_image_url AS image_url,
         CASE WHEN chain = 'robinhood' THEN last_fdv ELSE last_mcap END AS last_mcap,
         last_vol_24h,
         CASE
           WHEN last_token_created_at_ms IS NOT NULL AND last_token_created_at_ms > 0
             THEN last_token_created_at_ms
           WHEN chain = 'robinhood' AND first_seen_at IS NOT NULL
             THEN ROUND(EXTRACT(EPOCH FROM first_seen_at) * 1000)
           ELSE NULL
         END AS last_token_created_at_ms,
         CASE
           WHEN last_token_created_at_ms IS NOT NULL AND last_token_created_at_ms > 0
            THEN GREATEST(0, $4::bigint - last_token_created_at_ms)
           WHEN chain = 'robinhood' AND first_seen_at IS NOT NULL
            THEN GREATEST(0, $4::bigint - ROUND(EXTRACT(EPOCH FROM first_seen_at) * 1000))
           ELSE NULL
         END AS age_ms_at_alert,
         (CASE WHEN chain = 'robinhood' THEN last_seen_at ELSE metadata_updated_at END)
           > NOW() - make_interval(secs => $6) AS has_fresh_mcap,
         CASE
           WHEN (CASE WHEN chain = 'robinhood' THEN last_seen_at ELSE metadata_updated_at END) IS NOT NULL
            THEN ROUND(EXTRACT(EPOCH FROM (
              NOW() - (CASE WHEN chain = 'robinhood' THEN last_seen_at ELSE metadata_updated_at END)
            )) * 1000)
           ELSE NULL
         END AS mcap_age_ms,
         regexp_replace(upper(COALESCE(symbol, '')), '[^A-Z0-9]', '', 'g') AS normalized_symbol
       FROM token_catalog
       WHERE chain = $5
         AND symbol IS NOT NULL
         AND btrim(symbol) <> ''
     ),
     matches AS (
       SELECT
         address,
         symbol,
         name,
         image_url,
         last_mcap,
         last_vol_24h,
         has_fresh_mcap,
         mcap_age_ms,
         last_token_created_at_ms,
         age_ms_at_alert,
         normalized_symbol,
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
     ),
     stats AS (
       SELECT
         COUNT(*) FILTER (WHERE normalized_symbol = $1) AS exact_count,
         COUNT(*) FILTER (WHERE normalized_symbol <> $1) AS subticker_count,
         (
           ARRAY_AGG(address ORDER BY last_token_created_at_ms ASC, address ASC)
           FILTER (
             WHERE normalized_symbol = $1
               AND last_token_created_at_ms IS NOT NULL
               AND last_token_created_at_ms > 0
           )
         )[1] AS oldest_exact_address,
         (
           ARRAY_AGG(address ORDER BY last_mcap DESC, COALESCE(last_token_created_at_ms, 9223372036854775807) ASC, address ASC)
           FILTER (
             WHERE normalized_symbol = $1
               AND last_mcap IS NOT NULL
               AND last_mcap > 0
               AND has_fresh_mcap
           )
         )[1] AS highest_mcap_exact_address
       FROM matches
     ),
     ranked AS (
       SELECT
         matches.*,
         stats.exact_count,
         stats.subticker_count,
         stats.oldest_exact_address,
         stats.highest_mcap_exact_address,
         ROW_NUMBER() OVER (
           ORDER BY
             CASE WHEN matches.match_type = 'exact' THEN 0 ELSE 1 END ASC,
             COALESCE(matches.last_mcap, 0) DESC,
             COALESCE(matches.last_vol_24h, 0) DESC,
             COALESCE(matches.last_token_created_at_ms, 9223372036854775807) ASC,
             matches.address ASC
         ) AS peer_rank
       FROM matches
       CROSS JOIN stats
     )
     SELECT
       *
     FROM ranked
     WHERE peer_rank <= $3
        OR address = oldest_exact_address
        OR address = highest_mcap_exact_address
     ORDER BY peer_rank ASC`,
    [normalizedSymbol, SUBTICKER_MIN_LENGTH, limit, snapshotTsMs, chain, MCAP_FRESHNESS_SECONDS]
  );

  return rows;
}

async function listTickerPeersBySymbol(symbol, options = {}, runner = db) {
  const rows = await queryTickerPeerRowsBySymbol(symbol, options, runner);
  return rows.map(mapPeerRow);
}

function resolveTickerPeerSnapshotIdentity(input, options) {
  return normalizePeerIdentity(input.address, input.chain || options.chain || 'solana');
}

async function buildTickerPeerSnapshotForAlert(input = {}, options = {}, runner = db) {
  const identity = resolveTickerPeerSnapshotIdentity(input, options);
  if (!identity) {
    return null;
  }
  const address = identity.address;
  const limit = normalizeLimit(options.limit);

  let symbol = String(input.symbol || '').trim();
  let name = String(input.name || '').trim();
  if (!symbol) {
    const tokenRow = await tokenCatalog.getByAddress(address, identity.chain);
    symbol = String(tokenRow?.symbol || '').trim();
    if (!name) {
      name = String(tokenRow?.name || '').trim();
    }
  }

  const normalizedSymbol = normalizeSymbolKey(symbol);
  if (normalizedSymbol.length < 2) {
    return null;
  }

  const snapshotTsMs = toNumberOrNull(options.snapshotTsMs) ?? Date.now();
  const rows = await queryTickerPeerRowsBySymbol(symbol, {
    chain: identity.chain,
    limit,
    snapshotTsMs,
  }, runner);
  const contextualRows = filterContextualTickerPeerRows(rows, { symbol, name });
  const items = contextualRows.map(mapPeerRow);
  if (items.length <= 1) {
    return null;
  }

  const stats = mapPeerStatsRow(rows[0]);
  const subtickerCount = contextualRows.filter((row) => row?.match_type === 'subticker').length;
  return {
    chain: identity.chain,
    sourceSymbol: symbol,
    normalizedSymbol,
    count: items.length,
    exactCount: stats.exactCount,
    subtickerCount,
    hasSubtickerMatch: items.some((item) => item.matchType === 'subticker'),
    sourcePeerRole: resolveSourcePeerRole(address, stats),
    oldestExactAddress: stats.oldestExactAddress,
    highestMcapExactAddress: stats.highestMcapExactAddress,
    items,
  };
}

module.exports = {
  MAX_PEER_LIST_LIMIT: MAX_LIMIT,
  buildTickerPeerSnapshotForAlert,
  listTickerPeerSummariesForTokens,
  listTickerPeersBySymbol,
  __private: {
    buildTickerPeerSummary,
    mapPeerRow,
    mapPeerStatsRow,
    filterContextualTickerPeerRows,
    isContextualSubtickerPeer,
    normalizeLimit,
    normalizeSymbolKey,
    queryTickerPeerRowsBySymbol,
    resolveSourcePeerRole,
  },
};
