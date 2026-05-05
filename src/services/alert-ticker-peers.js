const db = require('../models/db');
const tokenCatalog = require('../models/token-catalog');
const { isValidAddress } = require('../models/user-token');

const SUBTICKER_MIN_LENGTH = 3;
const DEFAULT_LIMIT = 8;
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

function sameAddress(left, right) {
  return normalizeAddressKey(left) !== '' && normalizeAddressKey(left) === normalizeAddressKey(right);
}

function mapPeerStatsRow(row) {
  const exactCount = Number.parseInt(String(row?.exact_count || '0'), 10);
  const subtickerCount = Number.parseInt(String(row?.subticker_count || '0'), 10);
  const exactMissingCreatedAtCount = Number.parseInt(String(row?.exact_missing_created_at_count || '0'), 10);
  const exactMissingMcapCount = Number.parseInt(String(row?.exact_missing_mcap_count || '0'), 10);
  return {
    exactCount: Number.isInteger(exactCount) ? exactCount : 0,
    subtickerCount: Number.isInteger(subtickerCount) ? subtickerCount : 0,
    exactMissingCreatedAtCount: Number.isInteger(exactMissingCreatedAtCount) ? exactMissingCreatedAtCount : 0,
    exactMissingMcapCount: Number.isInteger(exactMissingMcapCount) ? exactMissingMcapCount : 0,
    oldestExactAddress: normalizeAddressKey(row?.oldest_exact_address) || null,
    highestMcapExactAddress: normalizeAddressKey(row?.highest_mcap_exact_address) || null,
  };
}

function resolveSourcePeerRole(address, stats) {
  if (!stats || stats.exactCount <= 1) {
    return SOURCE_PEER_ROLE_WARNING;
  }

  const isOldestExact = sameAddress(address, stats.oldestExactAddress);
  const isHighestMcapExact = sameAddress(address, stats.highestMcapExactAddress);
  const hasCompleteExactMcapData = (Number(stats.exactMissingMcapCount) || 0) === 0;
  if (isOldestExact && isHighestMcapExact && hasCompleteExactMcapData) {
    return SOURCE_PEER_ROLE_OG;
  }
  if (isHighestMcapExact && hasCompleteExactMcapData) {
    return SOURCE_PEER_ROLE_MCAP_LEADER;
  }
  return SOURCE_PEER_ROLE_WARNING;
}

async function queryTickerPeerRowsBySymbol(symbol, options = {}, runner = db) {
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
     ),
     matches AS (
       SELECT
         address,
         symbol,
         name,
         image_url,
         last_mcap,
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
         COUNT(*) FILTER (WHERE normalized_symbol = $1 AND last_token_created_at_ms IS NULL) AS exact_missing_created_at_count,
         COUNT(*) FILTER (WHERE normalized_symbol = $1 AND (last_mcap IS NULL OR last_mcap <= 0)) AS exact_missing_mcap_count,
         (
           ARRAY_AGG(address ORDER BY last_token_created_at_ms ASC, address ASC)
           FILTER (WHERE normalized_symbol = $1 AND last_token_created_at_ms IS NOT NULL)
         )[1] AS oldest_exact_address,
         (
           ARRAY_AGG(address ORDER BY last_mcap DESC, COALESCE(last_token_created_at_ms, 9223372036854775807) ASC, address ASC)
           FILTER (WHERE normalized_symbol = $1 AND last_mcap IS NOT NULL AND last_mcap > 0)
         )[1] AS highest_mcap_exact_address
       FROM matches
     )
     SELECT
       matches.*,
       stats.exact_count,
       stats.subticker_count,
       stats.exact_missing_created_at_count,
       stats.exact_missing_mcap_count,
       stats.oldest_exact_address,
       stats.highest_mcap_exact_address
     FROM matches
     CROSS JOIN stats
     ORDER BY
       CASE WHEN match_type = 'exact' THEN 0 ELSE 1 END ASC,
       COALESCE(last_mcap, 0) DESC,
       COALESCE(last_token_created_at_ms, 0) DESC,
       address ASC
     LIMIT $3`,
    [normalizedSymbol, SUBTICKER_MIN_LENGTH, limit, snapshotTsMs]
  );

  return rows;
}

async function listTickerPeersBySymbol(symbol, options = {}, runner = db) {
  const rows = await queryTickerPeerRowsBySymbol(symbol, options, runner);
  return rows.map(mapPeerRow);
}

async function buildTickerPeerSnapshotForAlert(input = {}, options = {}, runner = db) {
  const address = String(input.address || '').trim();
  const limit = normalizeLimit(options.limit);
  if (!isValidAddress(address)) {
    return null;
  }

  let symbol = String(input.symbol || '').trim();
  let name = String(input.name || '').trim();
  if (!symbol) {
    const tokenRow = await tokenCatalog.getByAddress(address);
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
  const rows = await queryTickerPeerRowsBySymbol(symbol, { limit, snapshotTsMs }, runner);
  const contextualRows = filterContextualTickerPeerRows(rows, { symbol, name });
  const items = contextualRows.map(mapPeerRow);
  if (items.length <= 1) {
    return null;
  }

  const stats = mapPeerStatsRow(rows[0]);
  const subtickerCount = contextualRows.filter((row) => row?.match_type === 'subticker').length;
  return {
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
  buildTickerPeerSnapshotForAlert,
  listTickerPeersBySymbol,
  __private: {
    mapPeerStatsRow,
    filterContextualTickerPeerRows,
    isContextualSubtickerPeer,
    normalizeLimit,
    normalizeSymbolKey,
    queryTickerPeerRowsBySymbol,
    resolveSourcePeerRole,
  },
};
