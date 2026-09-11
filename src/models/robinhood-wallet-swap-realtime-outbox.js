'use strict';

const db = require('./db');

const CHAIN = 'robinhood';
const NOTIFY_CHANNEL = 'robinhood_wallet_swap_realtime_outbox';
const DEFAULT_MAX_AUDIT_ATTEMPTS = 5;

function positiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(raw).toString();
}

function auditField(entry, camelName, snakeName) {
  if (!entry) return '';
  return entry[camelName] ?? entry[snakeName] ?? '';
}

function auditIdentity(entry, label) {
  const transactionHash = String(
    auditField(entry, 'transactionHash', 'transaction_hash')
  ).trim().toLowerCase();
  const blockHash = String(auditField(entry, 'blockHash', 'block_hash')).trim().toLowerCase();
  const eventKind = String(auditField(entry, 'eventKind', 'event_kind')).trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    throw new Error(`${label}.transactionHash is invalid`);
  }
  if (!/^0x[0-9a-f]{64}$/.test(blockHash)) throw new Error(`${label}.blockHash is invalid`);
  if (!['observed', 'finalized', 'invalidate'].includes(eventKind)) {
    throw new Error(`${label}.eventKind is invalid`);
  }
  return {
    transactionHash,
    logIndex: quantity(auditField(entry, 'logIndex', 'log_index'), `${label}.logIndex`),
    blockHash,
    eventKind,
  };
}

function auditOwner(value, label = 'trade audit') {
  const owner = String(value || '').trim();
  if (!owner || owner.length > 128) throw new Error(`${label} owner is required`);
  return owner;
}

function compareQuantity(left, right) {
  const difference = BigInt(left) - BigInt(right);
  return difference < 0n ? -1 : (difference > 0n ? 1 : 0);
}

function mapAuditRow(row) {
  return {
    ...auditIdentity(row, 'claimed'),
    blockNumber: String(row.block_number),
    transactionIndex: String(row.transaction_index),
    payload: row.payload,
    attemptCount: Number(row.audit_attempt_count),
  };
}

function mapPublicationRow(row) {
  return {
    ...auditIdentity(row, 'claimed'),
    blockNumber: String(row.block_number),
    transactionIndex: String(row.transaction_index),
    payload: row.payload,
    attemptCount: Number(row.attempt_count),
  };
}

function createRobinhoodWalletSwapRealtimeOutboxRepository(options = {}) {
  const database = options.database || db;
  const defaultMaxAuditAttempts = options.maxAuditAttempts || DEFAULT_MAX_AUDIT_ATTEMPTS;

  async function claimAudit(input = {}) {
    const owner = auditOwner(input.owner);
    const limit = positiveInt(input.limit, 'limit');
    const leaseMs = positiveInt(input.leaseMs, 'leaseMs');
    const result = await database.query(
      `WITH claimable AS MATERIALIZED (
         SELECT outbox.chain, outbox.transaction_hash, outbox.log_index,
                outbox.block_hash, outbox.event_kind
           FROM robinhood_wallet_swap_realtime_outbox outbox
          WHERE outbox.chain='${CHAIN}' AND outbox.audit_status='pending'
            AND outbox.audit_next_attempt_at<=NOW()
            AND (outbox.event_kind='observed' OR EXISTS (
              SELECT 1 FROM robinhood_wallet_swap_realtime_outbox observed
               WHERE observed.chain=outbox.chain
                 AND observed.transaction_hash=outbox.transaction_hash
                 AND observed.log_index=outbox.log_index
                 AND observed.block_hash=outbox.block_hash
                 AND observed.event_kind='observed'
                 AND observed.audit_status='complete'
            ))
          ORDER BY outbox.block_number, outbox.transaction_index, outbox.log_index,
                   CASE outbox.event_kind WHEN 'observed' THEN 0 ELSE 1 END
          LIMIT $2 FOR UPDATE OF outbox SKIP LOCKED
       )
       UPDATE robinhood_wallet_swap_realtime_outbox outbox
          SET audit_status='leased', audit_lease_owner=$1,
              audit_lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),
              audit_attempt_count=outbox.audit_attempt_count+1, updated_at=NOW()
         FROM claimable
        WHERE outbox.chain=claimable.chain
          AND outbox.transaction_hash=claimable.transaction_hash
          AND outbox.log_index=claimable.log_index
          AND outbox.block_hash=claimable.block_hash
          AND outbox.event_kind=claimable.event_kind
       RETURNING outbox.*`,
      [owner, limit, leaseMs]
    );
    return result.rows.map(mapAuditRow);
  }

  async function settleAudit(input = {}) {
    const owner = auditOwner(input.owner);
    const audited = (input.audited || []).map((row, index) => (
      auditIdentity(row, `audited[${index}]`)
    ));
    const retry = (input.retry || []).map((row, index) => ({
      ...auditIdentity(row, `retry[${index}]`),
      error: String(row?.error ?? '').slice(0, 4000),
      backoffMs: positiveInt(row?.backoffMs ?? 1, `retry[${index}].backoffMs`),
    }));
    const maxAttempts = positiveInt(
      input.maxAttempts ?? defaultMaxAuditAttempts, 'maxAttempts'
    );
    const client = await database.getClient();
    const recordset = `jsonb_to_recordset($1::jsonb) AS item(
      "transactionHash" text, "logIndex" bigint, "blockHash" text,
      "eventKind" text, error text, "backoffMs" bigint
    )`;
    try {
      await client.query('BEGIN');
      let auditedCount = 0;
      if (audited.length) {
        const result = await client.query(
          `UPDATE robinhood_wallet_swap_realtime_outbox outbox
              SET audit_status='complete', audit_lease_owner=NULL,
                  audit_lease_until=NULL, audited_at=NOW(),
                  audit_last_error=NULL, updated_at=NOW()
             FROM ${recordset}
            WHERE outbox.chain='${CHAIN}' AND outbox.audit_status='leased'
              AND outbox.audit_lease_owner=$2 AND outbox.audit_lease_until>NOW()
              AND outbox.transaction_hash=item."transactionHash"
              AND outbox.log_index=item."logIndex"
              AND outbox.block_hash=item."blockHash"
              AND outbox.event_kind=item."eventKind"`,
          [JSON.stringify(audited), owner]
        );
        auditedCount = result.rowCount;
      }
      let retried = 0;
      let blocked = 0;
      if (retry.length) {
        const result = await client.query(
          `UPDATE robinhood_wallet_swap_realtime_outbox outbox
              SET audit_status=CASE WHEN outbox.audit_attempt_count >= $3
                    THEN 'blocked' ELSE 'pending' END,
                  audit_lease_owner=NULL, audit_lease_until=NULL,
                  audit_next_attempt_at=CASE WHEN outbox.audit_attempt_count >= $3
                    THEN outbox.audit_next_attempt_at
                    ELSE NOW()+(item."backoffMs"*INTERVAL '1 millisecond') END,
                  audit_last_error=item.error, updated_at=NOW()
             FROM ${recordset}
            WHERE outbox.chain='${CHAIN}' AND outbox.audit_status='leased'
              AND outbox.audit_lease_owner=$2 AND outbox.audit_lease_until>NOW()
              AND outbox.transaction_hash=item."transactionHash"
              AND outbox.log_index=item."logIndex"
              AND outbox.block_hash=item."blockHash"
              AND outbox.event_kind=item."eventKind"
          RETURNING outbox.audit_status`,
          [JSON.stringify(retry), owner, maxAttempts]
        );
        blocked = result.rows.filter((row) => row.audit_status === 'blocked').length;
        retried = result.rowCount - blocked;
      }
      await client.query('COMMIT');
      return { audited: auditedCount, retried, blocked };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function reclaimExpiredAuditLeases() {
    const result = await database.query(
      `UPDATE robinhood_wallet_swap_realtime_outbox
          SET audit_status='pending', audit_lease_owner=NULL,
              audit_lease_until=NULL, updated_at=NOW()
        WHERE chain=$1 AND audit_status='leased' AND audit_lease_until<=NOW()`,
      [CHAIN]
    );
    return result.rowCount;
  }

  async function claimPublication(input = {}) {
    const owner = auditOwner(input.owner, 'trade publication');
    const limit = positiveInt(input.limit, 'limit');
    const leaseMs = positiveInt(input.leaseMs, 'leaseMs');
    const result = await database.query(
      `WITH claimable AS MATERIALIZED (
         SELECT outbox.chain, outbox.transaction_hash, outbox.log_index,
                outbox.block_hash, outbox.event_kind
           FROM robinhood_wallet_swap_realtime_outbox outbox
          WHERE outbox.chain='${CHAIN}' AND outbox.status='pending'
            AND outbox.audit_status='complete' AND outbox.next_attempt_at<=NOW()
            AND ((outbox.event_kind='observed' AND $4::boolean) OR
              (outbox.event_kind<>'observed' AND EXISTS (
                SELECT 1 FROM robinhood_wallet_swap_realtime_outbox observed
                 WHERE observed.chain=outbox.chain
                   AND observed.transaction_hash=outbox.transaction_hash
                   AND observed.log_index=outbox.log_index
                   AND observed.block_hash=outbox.block_hash
                   AND observed.event_kind='observed' AND observed.status='complete'
              )))
          ORDER BY outbox.block_number, outbox.transaction_index, outbox.log_index,
                   CASE outbox.event_kind
                     WHEN 'observed' THEN 0 WHEN 'finalized' THEN 1 ELSE 2 END
          LIMIT $2 FOR UPDATE OF outbox SKIP LOCKED
       )
       UPDATE robinhood_wallet_swap_realtime_outbox outbox
          SET status='leased', lease_owner=$1,
              lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),
              attempt_count=outbox.attempt_count+1, updated_at=NOW()
         FROM claimable
        WHERE outbox.chain=claimable.chain
          AND outbox.transaction_hash=claimable.transaction_hash
          AND outbox.log_index=claimable.log_index
          AND outbox.block_hash=claimable.block_hash
          AND outbox.event_kind=claimable.event_kind
       RETURNING outbox.*`,
      [owner, limit, leaseMs, input.observedEnabled === true]
    );
    const rank = { observed: 0, finalized: 1, invalidate: 2 };
    return result.rows.map(mapPublicationRow).sort((left, right) => (
      compareQuantity(left.blockNumber, right.blockNumber)
      || compareQuantity(left.transactionIndex, right.transactionIndex)
      || compareQuantity(left.logIndex, right.logIndex)
      || rank[left.eventKind] - rank[right.eventKind]
    ));
  }

  async function settlePublication(input = {}) {
    const owner = auditOwner(input.owner, 'trade publication');
    const delivered = (input.delivered || []).map((row, index) => (
      auditIdentity(row, `delivered[${index}]`)
    ));
    const retry = (input.retry || []).map((row, index) => ({
      ...auditIdentity(row, `retry[${index}]`),
      error: String(row?.error ?? '').slice(0, 4000),
      backoffMs: positiveInt(row?.backoffMs ?? 1, `retry[${index}].backoffMs`),
    }));
    const maxAttempts = positiveInt(input.maxAttempts ?? 5, 'maxAttempts');
    const client = await database.getClient();
    const recordset = `jsonb_to_recordset($1::jsonb) AS item(
      "transactionHash" text, "logIndex" bigint, "blockHash" text,
      "eventKind" text, error text, "backoffMs" bigint
    )`;
    try {
      await client.query('BEGIN');
      let deliveredCount = 0;
      if (delivered.length) {
        const result = await client.query(
          `UPDATE robinhood_wallet_swap_realtime_outbox outbox
              SET status='complete', lease_owner=NULL, lease_until=NULL,
                  published_at=NOW(), last_error=NULL, updated_at=NOW()
             FROM ${recordset}
            WHERE outbox.chain='${CHAIN}' AND outbox.status='leased'
              AND outbox.lease_owner=$2 AND outbox.lease_until>NOW()
              AND outbox.transaction_hash=item."transactionHash"
              AND outbox.log_index=item."logIndex" AND outbox.block_hash=item."blockHash"
              AND outbox.event_kind=item."eventKind"`,
          [JSON.stringify(delivered), owner]
        );
        deliveredCount = result.rowCount;
      }
      let retried = 0;
      let blocked = 0;
      if (retry.length) {
        const result = await client.query(
          `UPDATE robinhood_wallet_swap_realtime_outbox outbox
              SET status=CASE WHEN outbox.attempt_count >= $3 THEN 'blocked' ELSE 'pending' END,
                  lease_owner=NULL, lease_until=NULL,
                  next_attempt_at=CASE WHEN outbox.attempt_count >= $3 THEN outbox.next_attempt_at
                    ELSE NOW()+(item."backoffMs"*INTERVAL '1 millisecond') END,
                  last_error=item.error, updated_at=NOW()
             FROM ${recordset}
            WHERE outbox.chain='${CHAIN}' AND outbox.status='leased'
              AND outbox.lease_owner=$2 AND outbox.lease_until>NOW()
              AND outbox.transaction_hash=item."transactionHash"
              AND outbox.log_index=item."logIndex" AND outbox.block_hash=item."blockHash"
              AND outbox.event_kind=item."eventKind" RETURNING outbox.status`,
          [JSON.stringify(retry), owner, maxAttempts]
        );
        blocked = result.rows.filter((row) => row.status === 'blocked').length;
        retried = result.rowCount - blocked;
      }
      await client.query('COMMIT');
      return { delivered: deliveredCount, retried, blocked };
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function reclaimExpiredPublicationLeases() {
    const result = await database.query(
      `UPDATE robinhood_wallet_swap_realtime_outbox
          SET status='pending', lease_owner=NULL, lease_until=NULL, updated_at=NOW()
        WHERE chain=$1 AND status='leased' AND lease_until<=NOW()`, [CHAIN]
    );
    return result.rowCount;
  }

  async function appendOrphanInvalidations(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('trade invalidation requires a transaction client');
    }
    const recoveryGeneration = quantity(input.generation, 'generation');
    const fromBlock = quantity(input.fromBlock, 'fromBlock');
    const throughBlock = quantity(input.throughBlock, 'throughBlock');
    if (BigInt(fromBlock) > BigInt(throughBlock)) {
      throw new Error('trade invalidation range is inverted');
    }
    const result = await client.query(
      `WITH orphaned AS MATERIALIZED (
         SELECT observed.chain, observed.transaction_hash, observed.log_index,
                observed.block_number, observed.block_hash,
                observed.transaction_index, observed.payload
           FROM robinhood_wallet_swap_realtime_outbox observed
           INNER JOIN robinhood_chain_blocks block
             ON block.chain=observed.chain
            AND block.block_number=observed.block_number
            AND block.block_hash=observed.block_hash
            AND block.canonical
          WHERE observed.chain=$1 AND observed.event_kind='observed'
            AND observed.block_number BETWEEN $2::bigint AND $3::bigint
       ), invalidated AS (
         INSERT INTO robinhood_wallet_swap_realtime_outbox(
           chain, transaction_hash, log_index, event_kind, block_number,
           block_hash, transaction_index, payload
         )
         SELECT chain, transaction_hash, log_index, 'invalidate', block_number,
                block_hash, transaction_index,
                payload || jsonb_build_object(
                  'type', 'market:trade:invalidate',
                  'finality', 'invalidated',
                  'reason', 'reorg',
                  'recoveryGeneration', $4::text,
                  'invalidatedAt', clock_timestamp()
                )
           FROM orphaned
         ON CONFLICT (
           chain, transaction_hash, log_index, block_hash, event_kind
         ) DO UPDATE
           SET updated_at=robinhood_wallet_swap_realtime_outbox.updated_at
         WHERE robinhood_wallet_swap_realtime_outbox.payload->>'recoveryGeneration'=$4::text
         RETURNING block_number
       ), notified AS (
         SELECT pg_notify($5, MAX(block_number)::text) AS sent
           FROM invalidated HAVING COUNT(*) > 0
       )
       SELECT (SELECT COUNT(*)::int FROM orphaned) AS observed,
              (SELECT COUNT(*)::int FROM invalidated) AS invalidated,
              (SELECT COUNT(*)::int FROM notified) AS notifications`,
      [CHAIN, fromBlock, throughBlock, recoveryGeneration, NOTIFY_CHANNEL]
    );
    const observed = Number(result.rows[0]?.observed || 0);
    const invalidated = Number(result.rows[0]?.invalidated || 0);
    if (invalidated !== observed) {
      const error = new Error('orphan trade lifecycle conflicts with an earlier invalidation');
      error.code = 'trade_invalidation_conflict';
      throw error;
    }
    return { observed, invalidated };
  }

  async function promoteFinalized(input = {}) {
    const throughBlock = quantity(input.throughBlock, 'throughBlock');
    const limit = positiveInt(input.limit, 'limit');
    const result = await database.query(
      `WITH promotable AS MATERIALIZED (
         SELECT observed.chain, observed.transaction_hash, observed.log_index,
                observed.block_number, observed.block_hash,
                observed.transaction_index, observed.payload
           FROM robinhood_wallet_swap_realtime_outbox observed
           INNER JOIN robinhood_chain_blocks block
             ON block.chain=observed.chain
            AND block.block_number=observed.block_number
            AND block.block_hash=observed.block_hash
            AND block.canonical
           LEFT JOIN robinhood_wallet_swap_realtime_outbox finalized
             ON finalized.chain=observed.chain
            AND finalized.transaction_hash=observed.transaction_hash
            AND finalized.log_index=observed.log_index
            AND finalized.block_hash=observed.block_hash
            AND finalized.event_kind='finalized'
          WHERE observed.chain='${CHAIN}' AND observed.event_kind='observed'
            AND observed.block_number <= $1::bigint
            AND finalized.transaction_hash IS NULL
          ORDER BY observed.block_number, observed.transaction_index, observed.log_index
          LIMIT $2
       ), inserted AS (
         INSERT INTO robinhood_wallet_swap_realtime_outbox(
           chain, transaction_hash, log_index, event_kind, block_number,
           block_hash, transaction_index, payload
         )
         SELECT chain, transaction_hash, log_index, 'finalized', block_number,
                block_hash, transaction_index,
                payload || jsonb_build_object(
                  'type', 'market:trade:finalized',
                  'finality', 'finalized',
                  'finalizedAt', clock_timestamp()
                )
           FROM promotable
         ON CONFLICT (
           chain, transaction_hash, log_index, block_hash, event_kind
         ) DO NOTHING
         RETURNING block_number
       ), notified AS (
         SELECT pg_notify($3, MAX(block_number)::text) AS sent
           FROM inserted HAVING COUNT(*) > 0
       )
       SELECT COUNT(*)::int AS promoted,
              (SELECT COUNT(*)::int FROM notified) AS notifications
         FROM inserted`,
      [throughBlock, limit, NOTIFY_CHANNEL]
    );
    return Number(result.rows[0]?.promoted || 0);
  }

  return Object.freeze({
    appendOrphanInvalidations,
    claimAudit,
    claimPublication,
    promoteFinalized,
    reclaimExpiredAuditLeases,
    reclaimExpiredPublicationLeases,
    settleAudit,
    settlePublication,
  });
}

module.exports = {
  DEFAULT_MAX_AUDIT_ATTEMPTS,
  NOTIFY_CHANNEL,
  createRobinhoodWalletSwapRealtimeOutboxRepository,
};
