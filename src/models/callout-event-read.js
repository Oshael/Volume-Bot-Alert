'use strict';

const db = require('./db');
const { normalizeTokenAddress, normalizeTokenChain } = require('../utils/token-identity');

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const MAX_RANGE_MS = 72 * 60 * 60 * 1000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;
const CURSOR_VERSION = 1;

const CALLOUT_EVENTS_SQL = `SELECT event.dedupe_key, event.platform,
       event.platform_event_id, event.occurred_at, event.captured_at,
       event.asset_chain_key, event.asset_address_normalized,
       event.thesis, event.market_cap, event.source_metadata,
       profile.platform_user_id, profile.username, profile.x_username,
       profile.display_name, profile.profile_picture_url
FROM callout_events event
LEFT JOIN callout_profiles profile
  ON profile.platform = event.platform
 AND profile.platform_user_id = event.platform_user_id
WHERE event.asset_chain_key = $1
  AND event.asset_address_normalized = $2
  AND event.occurred_at >= $3::timestamptz
  AND event.occurred_at < $4::timestamptz
  AND event.expires_at > NOW()
  AND (
    $5::timestamptz IS NULL
    OR (event.occurred_at, event.dedupe_key) < ($5::timestamptz, $6::text)
  )
ORDER BY event.occurred_at DESC, event.dedupe_key DESC
LIMIT $7::int`;

function taggedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw taggedError('INVALID_CALLOUT_RANGE', `${label} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeLimit(value) {
  if (value == null || value === '') return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw taggedError('INVALID_CALLOUT_LIMIT', `limit must be between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
}

function encodeCursor(query, row) {
  return Buffer.from(JSON.stringify({
    v: CURSOR_VERSION, chain: query.chainKey, token: query.tokenAddress,
    from: query.from, to: query.to,
    occurredAt: new Date(row.occurred_at).toISOString(), key: row.dedupe_key,
  })).toString('base64url');
}

function decodeCursor(value, query) {
  if (value == null || value === '') return null;
  try {
    const cursor = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    const occurredAt = new Date(cursor.occurredAt);
    if (cursor.v !== CURSOR_VERSION || cursor.chain !== query.chainKey
        || cursor.token !== query.tokenAddress || cursor.from !== query.from
        || cursor.to !== query.to || !Number.isFinite(occurredAt.getTime())
        || typeof cursor.key !== 'string' || !cursor.key) {
      throw new Error('mismatch');
    }
    return Object.freeze({ occurredAt: occurredAt.toISOString(), key: cursor.key });
  } catch (_) {
    throw taggedError('INVALID_CALLOUT_CURSOR', 'cursor is invalid for this callout query');
  }
}

function normalizeQuery(input = {}, now = Date.now) {
  const chainKey = normalizeTokenChain(input.chainKey);
  const tokenAddress = normalizeTokenAddress(chainKey, input.tokenAddress);
  const to = input.to == null || input.to === '' ? new Date(now()) : instant(input.to, 'to');
  const from = input.from == null || input.from === ''
    ? new Date(to.getTime() - MAX_RANGE_MS) : instant(input.from, 'from');
  const duration = to.getTime() - from.getTime();
  if (duration <= 0 || duration > MAX_RANGE_MS) {
    throw taggedError('INVALID_CALLOUT_RANGE', 'range must be greater than zero and at most 72 hours');
  }
  const query = {
    chainKey, tokenAddress, from: from.toISOString(), to: to.toISOString(),
    limit: normalizeLimit(input.limit),
  };
  query.cursor = decodeCursor(input.cursor, query);
  return Object.freeze(query);
}

function numericOrNull(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSourceLink(item) {
  if (!item || typeof item.link !== 'string' || item.link.length > 2048) return null;
  try {
    const url = new URL(item.link);
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
      return null;
    }
    return Object.freeze({
      link: url.toString(),
      text: typeof item.text === 'string' ? item.text.slice(0, 500) : null,
      provider: typeof item.provider === 'string' ? item.provider.slice(0, 100) : null,
    });
  } catch (_) {
    return null;
  }
}

function sourceLinks(metadata) {
  const candidates = Array.isArray(metadata?.sourceLinks) ? metadata.sourceLinks : [];
  return Object.freeze(candidates.slice(0, 32).map(normalizeSourceLink).filter(Boolean));
}

function normalizeCallout(row) {
  return Object.freeze({
    id: row.dedupe_key,
    eventType: 'callout',
    platform: row.platform,
    platformEventId: row.platform_event_id || null,
    occurredAt: new Date(row.occurred_at).toISOString(),
    capturedAt: new Date(row.captured_at).toISOString(),
    profile: Object.freeze({
      platformUserId: row.platform_user_id || null,
      username: row.username || null,
      xUsername: row.x_username || null,
      displayName: row.display_name || null,
      profilePictureUrl: row.profile_picture_url || null,
    }),
    asset: Object.freeze({
      chainKey: row.asset_chain_key,
      address: row.asset_address_normalized,
    }),
    thesis: row.thesis || null,
    marketCap: numericOrNull(row.market_cap),
    source: Object.freeze({
      platform: row.platform,
      platformEventId: row.platform_event_id || null,
      links: sourceLinks(row.source_metadata),
    }),
  });
}

function createCalloutEventRead(options = {}) {
  const database = options.database || db;
  const now = options.now || Date.now;
  const statementTimeoutMs = options.statementTimeoutMs || DEFAULT_STATEMENT_TIMEOUT_MS;

  async function listEvents(input = {}) {
    const query = normalizeQuery(input, now);
    const params = [
      query.chainKey, query.tokenAddress, query.from, query.to,
      query.cursor?.occurredAt || null, query.cursor?.key || null, query.limit + 1,
    ];
    const result = database.queryWithStatementTimeout
      ? await database.queryWithStatementTimeout(CALLOUT_EVENTS_SQL, params, statementTimeoutMs)
      : await database.query(CALLOUT_EVENTS_SQL, params);
    const selectedRows = result.rows.slice(0, query.limit);
    const hasMore = result.rows.length > query.limit;
    return Object.freeze({
      chainKey: query.chainKey, tokenAddress: query.tokenAddress,
      from: query.from, to: query.to,
      events: Object.freeze(selectedRows.map(normalizeCallout)),
      hasMore,
      nextCursor: hasMore && selectedRows.length
        ? encodeCursor(query, selectedRows[selectedRows.length - 1]) : null,
    });
  }

  return Object.freeze({ listEvents });
}

module.exports = {
  createCalloutEventRead,
  __private: {
    CALLOUT_EVENTS_SQL, CURSOR_VERSION, DEFAULT_LIMIT, DEFAULT_STATEMENT_TIMEOUT_MS,
    MAX_LIMIT, MAX_RANGE_MS, decodeCursor, encodeCursor, normalizeCallout,
    normalizeLimit, normalizeQuery,
  },
};
