'use strict';

const crypto = require('node:crypto');
const db = require('./db');

const MIN_WINDOW_MS = 10 * 60 * 1000;
const MAX_WINDOW_MS = 20 * 60 * 1000;
const MIN_SOURCE_COUNT = 4;
const DEFAULT_SOURCE_LIMIT = 5_000;
const MAX_SOURCE_LIMIT = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 5_000;

const SOURCES_SQL = `SELECT archived.dedupe_key, archived.platform,
       archived.platform_event_id, archived.platform_user_id,
       archived.occurred_at, archived.captured_at,
       archived.asset_chain_key, archived.asset_address_normalized,
       archived.thesis, archived.thesis_sha256, archived.source_metadata,
       profile.username, profile.x_username, profile.display_name,
       profile.profile_picture_url
FROM callout_thesis_archive archived
LEFT JOIN callout_profiles profile
  ON profile.platform = archived.platform
 AND profile.platform_user_id = archived.platform_user_id
WHERE COALESCE(archived.occurred_at, archived.captured_at) >= $1::timestamptz
  AND COALESCE(archived.occurred_at, archived.captured_at) < $2::timestamptz
  AND archived.asset_chain_key IS NOT NULL
  AND archived.asset_address_normalized IS NOT NULL
  AND NULLIF(BTRIM(archived.thesis), '') IS NOT NULL
ORDER BY archived.asset_chain_key, archived.asset_address_normalized,
         COALESCE(archived.occurred_at, archived.captured_at), archived.dedupe_key
LIMIT $3::int`;

function taggedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw taggedError('INVALID_CALLOUT_SUMMARY_WINDOW', `${label} must be a valid timestamp`);
  }
  return parsed;
}

function normalizeSourceLimit(value) {
  if (value == null || value === '') return DEFAULT_SOURCE_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < MIN_SOURCE_COUNT || parsed > MAX_SOURCE_LIMIT) {
    throw taggedError('INVALID_CALLOUT_SUMMARY_SOURCE_LIMIT',
      `sourceLimit must be between ${MIN_SOURCE_COUNT} and ${MAX_SOURCE_LIMIT}`);
  }
  return parsed;
}

function normalizeWindow(input = {}) {
  const from = instant(input.from, 'from');
  const to = instant(input.to, 'to');
  const durationMs = to.getTime() - from.getTime();
  if (durationMs < MIN_WINDOW_MS || durationMs > MAX_WINDOW_MS) {
    throw taggedError('INVALID_CALLOUT_SUMMARY_WINDOW',
      'summary window must be between 10 and 20 minutes');
  }
  return Object.freeze({
    from: from.toISOString(), to: to.toISOString(), durationMs,
    sourceLimit: normalizeSourceLimit(input.sourceLimit),
  });
}

function safeLinks(metadata) {
  const values = Array.isArray(metadata?.sourceLinks) ? metadata.sourceLinks : [];
  return Object.freeze(values.slice(0, 32).flatMap((item) => {
    if (!item || typeof item.link !== 'string' || item.link.length > 2048) return [];
    try {
      const url = new URL(item.link);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
      return [Object.freeze({
        link: url.toString(),
        text: typeof item.text === 'string' ? item.text.slice(0, 500) : null,
        provider: typeof item.provider === 'string' ? item.provider.slice(0, 100) : null,
      })];
    } catch { return []; }
  }));
}

function sourceFromRow(row) {
  return Object.freeze({
    id: row.dedupe_key,
    platform: row.platform,
    platformEventId: row.platform_event_id || null,
    occurredAt: new Date(row.occurred_at || row.captured_at).toISOString(),
    profile: Object.freeze({
      platformUserId: row.platform_user_id || null,
      username: row.username || null,
      xUsername: row.x_username || null,
      displayName: row.display_name || null,
      profilePictureUrl: row.profile_picture_url || null,
    }),
    thesis: String(row.thesis).trim(),
    thesisSha256: row.thesis_sha256,
    links: safeLinks(row.source_metadata),
  });
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function candidateFromGroup(window, rows) {
  const first = rows[0];
  const sources = Object.freeze(rows.map(sourceFromRow));
  const asset = Object.freeze({
    chainKey: first.asset_chain_key,
    address: first.asset_address_normalized,
  });
  const clusterKey = digest(JSON.stringify([
    asset.chainKey, asset.address, window.from, window.to,
  ]));
  const sourceFingerprint = digest(JSON.stringify(sources.map((source) => [
    source.id, source.thesisSha256,
  ])));
  return Object.freeze({
    clusterKey, sourceFingerprint, asset,
    window: Object.freeze({ from: window.from, to: window.to }),
    sourceCount: sources.length,
    platforms: Object.freeze([...new Set(sources.map(({ platform }) => platform))].sort()),
    sources,
  });
}

function groupCandidates(window, rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.asset_chain_key}\0${row.asset_address_normalized}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return Object.freeze([...groups.values()]
    .filter((group) => group.length >= MIN_SOURCE_COUNT)
    .map((group) => candidateFromGroup(window, group)));
}

function createCalloutSummaryCandidateRead(options = {}) {
  const database = options.database || db;
  const statementTimeoutMs = options.statementTimeoutMs || DEFAULT_STATEMENT_TIMEOUT_MS;

  async function listCandidates(input = {}) {
    const window = normalizeWindow(input);
    const params = [window.from, window.to, window.sourceLimit + 1];
    const result = database.queryWithStatementTimeout
      ? await database.queryWithStatementTimeout(SOURCES_SQL, params, statementTimeoutMs)
      : await database.query(SOURCES_SQL, params);
    if (result.rows.length > window.sourceLimit) {
      throw taggedError('CALLOUT_SUMMARY_SOURCE_LIMIT',
        'summary candidate window exceeded its source limit');
    }
    return Object.freeze({
      window: Object.freeze({ from: window.from, to: window.to }),
      candidates: groupCandidates(window, result.rows),
    });
  }

  return Object.freeze({ listCandidates });
}

module.exports = {
  createCalloutSummaryCandidateRead,
  __private: {
    DEFAULT_SOURCE_LIMIT, DEFAULT_STATEMENT_TIMEOUT_MS, MAX_SOURCE_LIMIT,
    MAX_WINDOW_MS, MIN_SOURCE_COUNT, MIN_WINDOW_MS, SOURCES_SQL,
    candidateFromGroup, groupCandidates, normalizeSourceLimit, normalizeWindow,
    safeLinks, sourceFromRow,
  },
};
