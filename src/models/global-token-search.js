'use strict';

const db = require('./db');

const SEARCH_TIMEOUT_MS = 1500;
const SEARCH_SQL = `SELECT address, symbol, name, last_image_url,
       CASE WHEN LOWER(symbol) = $1 THEN 'exact_ticker'
            WHEN LOWER(symbol) LIKE $2 ESCAPE '\\'
              OR LOWER(name) LIKE $2 ESCAPE '\\' THEN 'prefix'
            ELSE 'text' END AS match
  FROM token_catalog
 WHERE chain = 'robinhood'
   AND (LOWER(symbol) = $1
     OR LOWER(symbol) LIKE $2 ESCAPE '\\'
     OR LOWER(name) LIKE $2 ESCAPE '\\'
     OR to_tsvector('simple', COALESCE(symbol, '') || ' ' || COALESCE(name, ''))
        @@ plainto_tsquery('simple', $1))
 ORDER BY CASE WHEN LOWER(symbol) = $1 THEN 0
               WHEN LOWER(symbol) LIKE $2 ESCAPE '\\'
                 OR LOWER(name) LIKE $2 ESCAPE '\\' THEN 1 ELSE 2 END,
          LOWER(COALESCE(symbol, name, '')), address
 LIMIT $3`;

function escapeLikePrefix(value) {
  return `${value.replace(/[\\%_]/g, '\\$&')}%`;
}

async function searchRobinhoodTokens(query, limit, options = {}) {
  const database = options.database || db;
  const normalized = String(query || '').trim().toLowerCase();
  const safeLimit = Math.max(1, Math.min(Math.trunc(Number(limit) || 10), 20));
  if (normalized.length < 2 || normalized.length > 120) throw new RangeError('invalid global search text length');
  if (options.signal?.aborted) throw new Error('global search aborted');
  const params = [normalized, escapeLikePrefix(normalized), safeLimit];
  const result = typeof database.queryWithStatementTimeout === 'function'
    ? await database.queryWithStatementTimeout(SEARCH_SQL, params, SEARCH_TIMEOUT_MS)
    : await database.query(SEARCH_SQL, params);
  if (options.signal?.aborted) throw new Error('global search aborted');
  return result.rows;
}

module.exports = { SEARCH_SQL, SEARCH_TIMEOUT_MS, searchRobinhoodTokens };
