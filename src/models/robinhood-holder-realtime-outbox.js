'use strict';

const db = require('./db');

const NOTIFY_CHANNEL = 'robinhood_holder_realtime_outbox';
const TABLE = 'robinhood_holder_realtime_outbox';
const DEFAULT_MAX_ATTEMPTS = 5;

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function ownerOf(value) {
  const owner = String(value || '').trim();
  if (!owner || owner.length > 128) throw new Error('holder realtime owner is required');
  return owner;
}

function idOf(value, label) {
  const id = String(value ?? '').trim();
  if (!/^\d+$/.test(id) || BigInt(id) <= 0n) throw new Error(`${label} must be a positive id`);
  return id;
}

async function enqueuePublications(client, publications = []) {
  if (!publications.length) return 0;
  const rows = publications.map((publication) => ({
    token_address: publication.tokenAddress,
    ledger_version: publication.ledgerVersion,
    event_kind: publication.invalidated === true ? 'invalidate' : 'observed',
    holder_count: publication.invalidated === true ? null : publication.holderCount,
    observed_at: publication.observedAt,
    live_through_block: publication.liveThroughBlock,
    live_through_hash: publication.liveThroughHash,
    latency: publication.latency || {},
  }));
  const result = await client.query(
    `WITH inserted AS (
       INSERT INTO ${TABLE} (
         chain, token_address, ledger_version, event_kind, holder_count,
         observed_at, live_through_block, live_through_hash, latency
       ) SELECT 'robinhood', item.token_address, item.ledger_version::bigint,
                item.event_kind, item.holder_count::bigint, item.observed_at::timestamptz,
                item.live_through_block::bigint, item.live_through_hash, item.latency
           FROM jsonb_to_recordset($1::jsonb) AS item(
             token_address text, ledger_version text, event_kind text,
             holder_count text, observed_at text, live_through_block text,
             live_through_hash text, latency jsonb
           )
       ON CONFLICT (chain, token_address, ledger_version, event_kind) DO NOTHING
       RETURNING id
     ), notified AS (
       SELECT pg_notify($2, '') FROM inserted LIMIT 1
     ) SELECT COUNT(*)::int AS inserted,
              (SELECT COUNT(*) FROM notified) AS notifications FROM inserted`,
    [JSON.stringify(rows), NOTIFY_CHANNEL]
  );
  return Number(result.rows[0]?.inserted) || 0;
}

function createRobinhoodHolderRealtimeOutboxRepository(options = {}) {
  const database = options.database || db;
  const defaultMaxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;

  async function claimOutbox(input = {}) {
    const owner = ownerOf(input.owner);
    const limit = positiveInt(input.limit, 'limit');
    const leaseMs = positiveInt(input.leaseMs, 'leaseMs');
    const result = await database.query(
      `WITH claimable AS (
         SELECT id FROM ${TABLE}
          WHERE status='pending' AND next_attempt_at<=NOW()
          ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
       ), leased AS (
         UPDATE ${TABLE} outbox SET status='leased', lease_owner=$1,
           lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),
           attempt_count=outbox.attempt_count+1, updated_at=NOW()
         FROM claimable WHERE outbox.id=claimable.id
         RETURNING outbox.*
       ) SELECT id, attempt_count, jsonb_strip_nulls(jsonb_build_object(
           'type', CASE WHEN event_kind='invalidate' THEN 'holder:invalidate'
             ELSE 'holder:count' END,
           'chain', chain, 'address', token_address, 'source', 'ledger_live',
           'holderCount', holder_count, 'observedAt', observed_at,
           'ledgerVersion', ledger_version, 'liveThroughBlock', live_through_block,
           'liveThroughHash', live_through_hash, 'latency', latency
         )) AS payload FROM leased ORDER BY id`,
      [owner, limit, leaseMs]
    );
    return result.rows.map((row) => ({
      id: String(row.id), payload: row.payload, attemptCount: Number(row.attempt_count),
    }));
  }

  async function settleOutbox(input = {}) {
    const owner = ownerOf(input.owner);
    const maxAttempts = positiveInt(input.maxAttempts ?? defaultMaxAttempts, 'maxAttempts');
    const items = (input.delivered || []).map((id) => ({ id: idOf(id, 'delivered.id') }));
    for (const [index, entry] of (input.retry || []).entries()) items.push({
      id: idOf(entry?.id, `retry[${index}].id`),
      error: String(entry?.error || '').slice(0, 4000),
      backoffMs: positiveInt(entry?.backoffMs ?? 1, `retry[${index}].backoffMs`),
    });
    if (!items.length) return { delivered: 0, retried: 0, blocked: 0 };
    const result = await database.query(
      `UPDATE ${TABLE} outbox SET
         status=CASE WHEN item.error IS NULL THEN 'complete'
           WHEN outbox.attempt_count >= $3 THEN 'blocked' ELSE 'pending' END,
         lease_owner=NULL, lease_until=NULL,
         next_attempt_at=CASE WHEN item.error IS NOT NULL AND outbox.attempt_count < $3
           THEN NOW()+(item."backoffMs"*INTERVAL '1 millisecond') ELSE next_attempt_at END,
         published_at=CASE WHEN item.error IS NULL THEN NOW() ELSE published_at END,
         last_error=item.error, updated_at=NOW()
       FROM jsonb_to_recordset($1::jsonb) AS item(id bigint, error text, "backoffMs" bigint)
       WHERE outbox.id=item.id AND outbox.status='leased'
         AND outbox.lease_owner=$2 AND outbox.lease_until>NOW()
       RETURNING outbox.status`,
      [JSON.stringify(items), owner, maxAttempts]
    );
    const count = (status) => result.rows.filter((row) => row.status === status).length;
    return { delivered: count('complete'), retried: count('pending'), blocked: count('blocked') };
  }

  async function reclaimExpiredLeases() {
    const result = await database.query(
      `UPDATE ${TABLE} SET status='pending', lease_owner=NULL, lease_until=NULL, updated_at=NOW()
        WHERE status='leased' AND lease_until<=NOW()`
    );
    return result.rowCount;
  }

  async function readBacklog() {
    const result = await database.query(
      `SELECT COUNT(*) FILTER (WHERE status='pending')::int AS pending,
              COUNT(*) FILTER (WHERE status='pending' AND next_attempt_at<=NOW())::int AS due,
              COUNT(*) FILTER (WHERE status='leased')::int AS leased,
              COUNT(*) FILTER (WHERE status='leased' AND lease_until<=NOW())::int AS expired_leases,
              COUNT(*) FILTER (WHERE status='blocked')::int AS blocked,
              COALESCE(MAX(attempt_count),0)::int AS max_attempts,
              EXTRACT(EPOCH FROM NOW()-MIN(created_at)
                FILTER (WHERE status IN ('pending','leased')))::float AS oldest_age_seconds
         FROM ${TABLE} WHERE status IN ('pending','leased','blocked')`
    );
    const row = result.rows[0] || {};
    return {
      pending: Number(row.pending || 0), due: Number(row.due || 0),
      leased: Number(row.leased || 0), expiredLeases: Number(row.expired_leases || 0),
      blocked: Number(row.blocked || 0), maxAttempts: Number(row.max_attempts || 0),
      oldestAgeSeconds: row.oldest_age_seconds == null ? null : Number(row.oldest_age_seconds),
    };
  }

  return Object.freeze({ claimOutbox, settleOutbox, reclaimExpiredLeases, readBacklog });
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS, NOTIFY_CHANNEL, TABLE,
  createRobinhoodHolderRealtimeOutboxRepository, enqueuePublications,
};
