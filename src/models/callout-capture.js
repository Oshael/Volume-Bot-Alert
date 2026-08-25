'use strict';

const db = require('./db');
const { walletObservationKey } = require('../services/profile-wallet-domain');

function iso(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function optionalIso(value, label) {
  return value == null ? null : iso(value, label);
}

function profileRows(profileEnvelopes, calloutEnvelopes) {
  const profiles = new Map();
  function merge(payload, observedAt, source) {
    if (!payload?.platform || !payload.platformUserId) return;
    const key = `${payload.platform}:${payload.platformUserId}`;
    const timestamp = iso(observedAt, 'profile observedAt');
    const current = profiles.get(key);
    const metadata = {
      platform: payload.platform, platformUserId: payload.platformUserId,
      username: payload.username || null, xUsername: payload.xUsername || null,
      displayName: payload.displayName || null, profilePictureUrl: payload.profilePictureUrl || null,
      latestSource: source || null, firstObservedAt: timestamp, lastObservedAt: timestamp,
    };
    if (!current) return profiles.set(key, metadata);
    current.firstObservedAt = current.firstObservedAt < timestamp ? current.firstObservedAt : timestamp;
    if (timestamp >= current.lastObservedAt) {
      for (const field of ['username', 'xUsername', 'displayName', 'profilePictureUrl']) {
        current[field] = metadata[field] || current[field];
      }
      current.latestSource = metadata.latestSource || current.latestSource;
      current.lastObservedAt = timestamp;
    }
  }
  for (const envelope of profileEnvelopes) {
    merge(envelope?.payload, envelope?.payload?.observedAt || envelope?.capturedAt, envelope?.payload?.source);
  }
  for (const envelope of calloutEnvelopes) {
    const payload = envelope?.payload;
    merge({ platform: payload?.platform, ...payload?.profile }, payload?.occurredAt || envelope?.capturedAt, 'callout');
  }
  return [...profiles.values()];
}

function walletRows(profileEnvelopes) {
  const rows = new Map();
  for (const envelope of profileEnvelopes) {
    const profile = envelope?.payload;
    const observedAt = iso(profile?.observedAt || envelope?.capturedAt, 'wallet observedAt');
    for (const wallet of profile?.wallets || []) {
      const observationKey = walletObservationKey(profile, wallet);
      const row = {
        observationKey, platform: profile.platform, platformUserId: profile.platformUserId,
        addressOriginal: wallet.addressOriginal, addressNormalized: wallet.address,
        rawChainId: wallet.rawChainId, chainKey: wallet.chainKey, chainFamily: wallet.chainFamily,
        resolutionStatus: wallet.resolutionStatus, relationType: wallet.relationType,
        sourceType: wallet.sourceType, sourceField: wallet.sourceField,
        sourceRecordId: wallet.sourceRecordId, confidence: wallet.confidence,
        evidenceAt: optionalIso(wallet.evidenceAt, 'wallet evidenceAt'),
        firstObservedAt: observedAt, lastObservedAt: observedAt,
      };
      const current = rows.get(observationKey);
      if (!current) rows.set(observationKey, row);
      else {
        current.firstObservedAt = current.firstObservedAt < observedAt ? current.firstObservedAt : observedAt;
        current.lastObservedAt = current.lastObservedAt > observedAt ? current.lastObservedAt : observedAt;
      }
    }
  }
  return [...rows.values()];
}

function calloutRow(envelope) {
  const payload = envelope?.payload;
  if (!envelope?.dedupeKey || !payload?.platform || payload.eventKind !== 'callout') {
    throw new TypeError('Valid callout envelope is required');
  }
  const capturedAt = iso(envelope.capturedAt, 'callout capturedAt');
  return {
    dedupeKey: envelope.dedupeKey, platform: payload.platform,
    platformEventId: payload.platformEventId, platformUserId: payload.profile?.platformUserId,
    occurredAt: optionalIso(payload.occurredAt, 'callout occurredAt'), capturedAt,
    assetAddressOriginal: payload.asset?.addressOriginal,
    assetAddressNormalized: payload.asset?.address,
    assetRawChainId: payload.asset?.rawChainId, assetChainKey: payload.asset?.chainKey,
    assetChainFamily: payload.asset?.chainFamily,
    assetResolutionStatus: payload.asset?.resolutionStatus || 'unknown_chain',
    thesis: payload.thesis, marketCap: payload.marketCap,
    sourceMetadata: payload.sourceMetadata || {},
    expiresAt: new Date(Date.parse(capturedAt) + 72 * 60 * 60 * 1000).toISOString(),
  };
}

function stableCallout(row) {
  return JSON.stringify({ ...row, capturedAt: null, expiresAt: null });
}

function calloutRows(envelopes) {
  const rows = new Map();
  for (const envelope of envelopes) {
    const row = calloutRow(envelope);
    const current = rows.get(row.dedupeKey);
    if (current && stableCallout(current) !== stableCallout(row)) {
      throw new Error('Callout batch contains conflicting duplicate event');
    }
    if (!current) rows.set(row.dedupeKey, row);
  }
  return [...rows.values()];
}

const PROFILE_UPSERT = `INSERT INTO callout_profiles AS current (
  platform, platform_user_id, username, x_username, display_name, profile_picture_url,
  latest_source, first_observed_at, last_observed_at
) SELECT platform, "platformUserId", username, "xUsername", "displayName", "profilePictureUrl",
         "latestSource", "firstObservedAt", "lastObservedAt"
  FROM jsonb_to_recordset($1::jsonb) AS row(
    platform text, "platformUserId" text, username text, "xUsername" text,
    "displayName" text, "profilePictureUrl" text, "latestSource" text,
    "firstObservedAt" timestamptz, "lastObservedAt" timestamptz)
ON CONFLICT (platform, platform_user_id) DO UPDATE SET
  username = CASE WHEN EXCLUDED.last_observed_at >= current.last_observed_at THEN COALESCE(EXCLUDED.username, current.username) ELSE current.username END,
  x_username = CASE WHEN EXCLUDED.last_observed_at >= current.last_observed_at THEN COALESCE(EXCLUDED.x_username, current.x_username) ELSE current.x_username END,
  display_name = CASE WHEN EXCLUDED.last_observed_at >= current.last_observed_at THEN COALESCE(EXCLUDED.display_name, current.display_name) ELSE current.display_name END,
  profile_picture_url = CASE WHEN EXCLUDED.last_observed_at >= current.last_observed_at THEN COALESCE(EXCLUDED.profile_picture_url, current.profile_picture_url) ELSE current.profile_picture_url END,
  latest_source = CASE WHEN EXCLUDED.last_observed_at >= current.last_observed_at THEN COALESCE(EXCLUDED.latest_source, current.latest_source) ELSE current.latest_source END,
  first_observed_at = LEAST(current.first_observed_at, EXCLUDED.first_observed_at),
  last_observed_at = GREATEST(current.last_observed_at, EXCLUDED.last_observed_at), updated_at = NOW()`;

const WALLET_UPSERT = `INSERT INTO callout_wallet_observations (
  observation_key, platform, platform_user_id, address_original, address_normalized,
  raw_chain_id, chain_key, chain_family, resolution_status, relation_type, source_type,
  source_field, source_record_id, confidence, evidence_at, first_observed_at, last_observed_at
) SELECT "observationKey", platform, "platformUserId", "addressOriginal", "addressNormalized",
  "rawChainId", "chainKey", "chainFamily", "resolutionStatus", "relationType", "sourceType",
  "sourceField", "sourceRecordId", confidence, "evidenceAt", "firstObservedAt", "lastObservedAt"
  FROM jsonb_to_recordset($1::jsonb) AS row(
    "observationKey" text, platform text, "platformUserId" text, "addressOriginal" text,
    "addressNormalized" text, "rawChainId" text, "chainKey" text, "chainFamily" text,
    "resolutionStatus" text, "relationType" text, "sourceType" text, "sourceField" text,
    "sourceRecordId" text, confidence text, "evidenceAt" timestamptz,
    "firstObservedAt" timestamptz, "lastObservedAt" timestamptz)
ON CONFLICT (observation_key) DO UPDATE SET
  first_observed_at = LEAST(callout_wallet_observations.first_observed_at, EXCLUDED.first_observed_at),
  last_observed_at = GREATEST(callout_wallet_observations.last_observed_at, EXCLUDED.last_observed_at),
  updated_at = NOW()`;

const CALLOUT_UPSERT = `INSERT INTO callout_events (
  dedupe_key, platform, platform_event_id, platform_user_id, occurred_at, captured_at,
  asset_address_original, asset_address_normalized, asset_raw_chain_id, asset_chain_key,
  asset_chain_family, asset_resolution_status, thesis, market_cap, source_metadata, expires_at
) SELECT "dedupeKey", platform, "platformEventId", "platformUserId", "occurredAt", "capturedAt",
  "assetAddressOriginal", "assetAddressNormalized", "assetRawChainId", "assetChainKey",
  "assetChainFamily", "assetResolutionStatus", thesis, "marketCap", "sourceMetadata", "expiresAt"
  FROM jsonb_to_recordset($1::jsonb) AS row(
    "dedupeKey" text, platform text, "platformEventId" text, "platformUserId" text,
    "occurredAt" timestamptz, "capturedAt" timestamptz, "assetAddressOriginal" text,
    "assetAddressNormalized" text, "assetRawChainId" text, "assetChainKey" text,
    "assetChainFamily" text, "assetResolutionStatus" text, thesis text, "marketCap" numeric,
    "sourceMetadata" jsonb, "expiresAt" timestamptz)
ON CONFLICT (dedupe_key) DO UPDATE SET
  source_metadata = CASE
    WHEN callout_events.source_metadata <@ EXCLUDED.source_metadata
      THEN callout_events.source_metadata || EXCLUDED.source_metadata
    ELSE callout_events.source_metadata
  END
  WHERE callout_events.platform = EXCLUDED.platform
    AND callout_events.platform_event_id IS NOT DISTINCT FROM EXCLUDED.platform_event_id
    AND callout_events.platform_user_id IS NOT DISTINCT FROM EXCLUDED.platform_user_id
    AND callout_events.occurred_at IS NOT DISTINCT FROM EXCLUDED.occurred_at
    AND callout_events.asset_address_original IS NOT DISTINCT FROM EXCLUDED.asset_address_original
    AND callout_events.thesis IS NOT DISTINCT FROM EXCLUDED.thesis
    AND (
      callout_events.source_metadata = EXCLUDED.source_metadata
      OR callout_events.source_metadata <@ EXCLUDED.source_metadata
      OR EXCLUDED.source_metadata <@ callout_events.source_metadata
    )
RETURNING dedupe_key`;

const CHECKPOINT_UPSERT = `INSERT INTO callout_collector_checkpoints (
  collector_key, state, last_committed_at
) VALUES ($1, $2::jsonb, $3)
ON CONFLICT (collector_key) DO UPDATE SET state = EXCLUDED.state,
  last_committed_at = EXCLUDED.last_committed_at, updated_at = NOW()
  WHERE callout_collector_checkpoints.last_committed_at IS NULL
     OR EXCLUDED.last_committed_at >= callout_collector_checkpoints.last_committed_at
RETURNING collector_key`;

const PRUNE_EXPIRED_CALLOUTS = `WITH expired AS MATERIALIZED (
  SELECT dedupe_key
  FROM callout_events
  WHERE expires_at <= NOW()
  ORDER BY expires_at, dedupe_key
  LIMIT $1::int
  FOR UPDATE SKIP LOCKED
)
DELETE FROM callout_events AS event
USING expired
WHERE event.dedupe_key = expired.dedupe_key
RETURNING event.dedupe_key`;

function createCalloutCaptureRepository(options = {}) {
  const database = options.database || db;
  async function loadCheckpoint(checkpointKey) {
    const key = String(checkpointKey || '').trim();
    if (!key) throw new TypeError('Capture checkpoint key is required');
    const result = await database.query(
      `SELECT state, last_committed_at FROM callout_collector_checkpoints
       WHERE collector_key = $1`, [key]
    );
    const row = result.rows[0];
    return row ? {
      state: row.state || {},
      lastCommittedAt: row.last_committed_at ? new Date(row.last_committed_at).toISOString() : null,
    } : null;
  }

  async function commitCapture(input = {}) {
    const profiles = profileRows(input.profileEnvelopes || [], input.calloutEnvelopes || []);
    const wallets = walletRows(input.profileEnvelopes || []);
    const callouts = calloutRows(input.calloutEnvelopes || []);
    const checkpointKey = String(input.checkpointKey || '').trim();
    if (!checkpointKey || !input.checkpointState || typeof input.checkpointState !== 'object'
      || Array.isArray(input.checkpointState)) {
      throw new TypeError('Capture checkpoint key and object state are required');
    }
    const committedAt = iso(input.committedAt || new Date(), 'committedAt');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      if (profiles.length) await client.query(PROFILE_UPSERT, [JSON.stringify(profiles)]);
      if (wallets.length) await client.query(WALLET_UPSERT, [JSON.stringify(wallets)]);
      if (callouts.length) {
        const persisted = await client.query(CALLOUT_UPSERT, [JSON.stringify(callouts)]);
        if (persisted.rowCount !== callouts.length) throw new Error('Callout replay conflicts with persisted event');
      }
      const checkpoint = await client.query(CHECKPOINT_UPSERT,
        [checkpointKey, JSON.stringify(input.checkpointState), committedAt]);
      if (checkpoint.rowCount !== 1) throw new Error('Capture checkpoint is newer than this batch');
      await client.query('COMMIT');
      return { profiles: profiles.length, wallets: wallets.length, callouts: callouts.length, committedAt };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally { client.release(); }
  }

  async function pruneExpiredCallouts(input = {}) {
    const batchLimit = Number(input.batchLimit);
    if (!Number.isSafeInteger(batchLimit) || batchLimit < 1 || batchLimit > 10_000) {
      throw new TypeError('Callout retention batchLimit must be between 1 and 10000');
    }
    const result = await database.query(PRUNE_EXPIRED_CALLOUTS, [batchLimit]);
    return Object.freeze({
      deletedCallouts: result.rowCount,
      hasMore: result.rowCount === batchLimit,
    });
  }

  return Object.freeze({ commitCapture, loadCheckpoint, pruneExpiredCallouts });
}

module.exports = {
  createCalloutCaptureRepository,
  __private: {
    CALLOUT_UPSERT, CHECKPOINT_UPSERT, PROFILE_UPSERT, PRUNE_EXPIRED_CALLOUTS,
    WALLET_UPSERT,
    calloutRows, profileRows, walletRows,
  },
};
