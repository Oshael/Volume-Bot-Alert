/**
 * Consumer-side repository for the durable derived live-emit outbox (Corte 5).
 *
 * robinhood-processing appends one row per changed live bucket inside its commit
 * transaction; the robinhood-derived worker leases a batch here, fans out each
 * payload through the shared market:bucket hub, then settles: delivered rows are
 * deleted (the queue self-prunes), failures reschedule with backoff, and a row
 * that exhausts its attempts is dead-lettered as `blocked`. Abandoned leases from
 * a crashed consumer are reclaimed. It owns no cursor and never touches capture
 * or processing state: a derived failure isolates its own row.
 */
const db = require('./db');

const CHAIN = 'robinhood';
const DEFAULT_MAX_ATTEMPTS = 5;
// Producer (processing commit) NOTIFYs here after appending rows; the derived
// worker LISTENs to wake immediately instead of waiting out its poll interval.
const OUTBOX_NOTIFY_CHANNEL = 'robinhood_derived_outbox';

function requireOwner(value) {
  const owner = String(value || '').trim();
  if (!owner || owner.length > 128) throw new Error('derived owner is required');
  return owner;
}

function requirePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function outboxIdOf(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw) || BigInt(raw) <= 0n) {
    throw new Error(`${label} must be a positive integer id`);
  }
  return raw;
}

function normalizeRetry(entry) {
  return {
    id: outboxIdOf(entry?.id, 'retry.id'),
    error: entry?.error == null ? null : String(entry.error).slice(0, 4000),
    backoffMs: requirePositiveInt(entry?.backoffMs ?? 1, 'retry.backoffMs'),
  };
}

function createRobinhoodDerivedOutboxRepository(options = {}) {
  const database = options.database || db;
  const defaultMaxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;

  // Leases a batch of pending, due outbox rows in append (id) order. FOR UPDATE
  // SKIP LOCKED lets concurrent consumers claim disjoint rows without blocking.
  async function claimOutbox(input = {}) {
    const owner = requireOwner(input.owner);
    const limit = requirePositiveInt(input.limit, 'limit');
    const leaseMs = requirePositiveInt(input.leaseMs, 'leaseMs');
    const result = await database.query(
      `WITH claimable AS (
         SELECT id
         FROM robinhood_derived_outbox
         WHERE status = 'pending'
           AND next_attempt_at <= NOW()
         ORDER BY next_attempt_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       UPDATE robinhood_derived_outbox outbox
       SET status = 'leased',
           lease_owner = $1,
           lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
           attempt_count = outbox.attempt_count + 1,
           updated_at = NOW()
       FROM claimable
       WHERE outbox.id = claimable.id
       RETURNING outbox.id, outbox.payload, outbox.attempt_count`,
      [owner, limit, leaseMs]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      payload: row.payload,
      attemptCount: Number(row.attempt_count),
    }));
  }

  // Deletes rows this owner still holds a live lease on. Delivered rows leave no
  // trace — the queue is a transient signal, not an audit log.
  async function deleteDelivered(client, owner, ids) {
    if (!ids.length) return 0;
    const normalized = ids.map((id) => outboxIdOf(id, 'delivered.id'));
    const result = await client.query(
      `DELETE FROM robinhood_derived_outbox
       WHERE chain = '${CHAIN}'
         AND id = ANY($1::bigint[])
         AND status = 'leased'
         AND lease_owner = $2
         AND lease_until > NOW()`,
      [normalized, owner]
    );
    return result.rowCount;
  }

  // Reschedules failed rows with backoff, or dead-letters them as `blocked` once
  // they have burned through their attempts.
  async function settleRetry(client, owner, entries, maxAttempts) {
    if (!entries.length) return { retried: 0, blocked: 0 };
    const rows = entries.map(normalizeRetry);
    const result = await client.query(
      `UPDATE robinhood_derived_outbox outbox
       SET status = CASE
             WHEN outbox.attempt_count >= $3 THEN 'blocked' ELSE 'pending' END,
           lease_owner = NULL,
           lease_until = NULL,
           next_attempt_at = CASE
             WHEN outbox.attempt_count >= $3 THEN outbox.next_attempt_at
             ELSE NOW() + (retry."backoffMs"::bigint * INTERVAL '1 millisecond') END,
           last_error = retry.error,
           updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS retry(
         id bigint, error text, "backoffMs" bigint
       )
       WHERE outbox.chain = '${CHAIN}'
         AND outbox.id = retry.id
         AND outbox.status = 'leased'
         AND outbox.lease_owner = $2
         AND outbox.lease_until > NOW()
       RETURNING outbox.status`,
      [JSON.stringify(rows), owner, maxAttempts]
    );
    const blocked = result.rows.filter((row) => row.status === 'blocked').length;
    return { retried: result.rowCount - blocked, blocked };
  }

  async function settleOutbox(input = {}) {
    const owner = requireOwner(input.owner);
    const maxAttempts = requirePositiveInt(input.maxAttempts ?? defaultMaxAttempts, 'maxAttempts');
    const delivered = Array.isArray(input.delivered) ? input.delivered : [];
    const retry = Array.isArray(input.retry) ? input.retry : [];
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const deliveredCount = await deleteDelivered(client, owner, delivered);
      const retryResult = await settleRetry(client, owner, retry, maxAttempts);
      await client.query('COMMIT');
      return {
        delivered: deliveredCount,
        retried: retryResult.retried,
        blocked: retryResult.blocked,
      };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  // Returns abandoned leases (crashed consumer) to the pending pool. The attempt
  // was already counted at claim time, so a stuck lease still burns an attempt.
  async function reclaimExpiredLeases() {
    const result = await database.query(
      `UPDATE robinhood_derived_outbox
       SET status = 'pending', lease_owner = NULL, lease_until = NULL, updated_at = NOW()
       WHERE chain = $1 AND status = 'leased' AND lease_until <= NOW()`,
      [CHAIN]
    );
    return result.rowCount;
  }

  // Dead-letter cleanup: a blocked row is kept for inspection, then pruned once it
  // is older than the retention window. Delivered rows self-prune on settle.
  async function pruneBlocked(input = {}) {
    const olderThanMs = requirePositiveInt(input.olderThanMs ?? 86_400_000, 'olderThanMs');
    const limit = requirePositiveInt(input.limit ?? 5000, 'limit');
    const result = await database.query(
      `DELETE FROM robinhood_derived_outbox
       WHERE id IN (
         SELECT id FROM robinhood_derived_outbox
         WHERE chain = $1
           AND status = 'blocked'
           AND updated_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond')
         ORDER BY updated_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )`,
      [CHAIN, olderThanMs, limit]
    );
    return result.rowCount;
  }

  return Object.freeze({
    claimOutbox,
    settleOutbox,
    reclaimExpiredLeases,
    pruneBlocked,
  });
}

module.exports = {
  createRobinhoodDerivedOutboxRepository,
  DEFAULT_MAX_ATTEMPTS,
  OUTBOX_NOTIFY_CHANNEL,
};
