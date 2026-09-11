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

function blockLag(head, frontier) {
  if (head == null || frontier == null) return null;
  const lag = BigInt(head) - BigInt(frontier);
  return (lag > 0n ? lag : 0n).toString();
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
    const fromBlock = input.fromBlock == null
      ? null : quantity(input.fromBlock, 'fromBlock');
    const result = await database.query(
      `WITH claimable AS MATERIALIZED (
         SELECT outbox.chain, outbox.transaction_hash, outbox.log_index,
                outbox.block_hash, outbox.event_kind
           FROM robinhood_wallet_swap_realtime_outbox outbox
          WHERE outbox.chain='${CHAIN}' AND outbox.audit_status='pending'
            AND outbox.audit_next_attempt_at<=NOW()
            AND ($4::bigint IS NULL OR outbox.block_number >= $4::bigint)
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
      [owner, limit, leaseMs, fromBlock]
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
    const activationBlock = input.activationBlock == null
      ? null : quantity(input.activationBlock, 'activationBlock');
    if (input.observedEnabled === true && activationBlock == null) {
      throw new Error('trade publication activationBlock is required for observed events');
    }
    // Before the first canary there cannot be a terminal event that is safe to
    // publish. Avoid searching the historical audited backlog on every tick.
    if (activationBlock == null) return [];
    const result = await database.query(
      `WITH claimable AS MATERIALIZED (
         SELECT outbox.chain, outbox.transaction_hash, outbox.log_index,
                outbox.block_hash, outbox.event_kind
           FROM robinhood_wallet_swap_realtime_outbox outbox
          WHERE outbox.chain='${CHAIN}' AND outbox.status='pending'
            AND outbox.audit_status='complete' AND outbox.next_attempt_at<=NOW()
            AND ((outbox.event_kind='observed' AND $4::boolean
                  AND outbox.block_number >= $5::bigint) OR
              (outbox.event_kind<>'observed'
               AND outbox.block_number >= $5::bigint AND EXISTS (
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
      [owner, limit, leaseMs, input.observedEnabled === true, activationBlock]
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

  async function pruneTerminalCycles(input = {}) {
    const retentionMs = positiveInt(input.retentionMs, 'retentionMs');
    const limit = positiveInt(input.limit, 'limit');
    const result = await database.query(
      `WITH candidate_cycles AS MATERIALIZED (
         SELECT terminal.chain, terminal.transaction_hash, terminal.log_index,
                terminal.block_hash, MIN(terminal.created_at) AS terminal_created_at
           FROM robinhood_wallet_swap_realtime_outbox terminal
          WHERE terminal.chain=$1 AND terminal.event_kind IN ('finalized', 'invalidate')
            AND terminal.audit_status='complete'
            AND terminal.status IN ('pending', 'complete')
            AND terminal.created_at<=NOW()-($2::bigint*INTERVAL '1 millisecond')
          GROUP BY terminal.chain, terminal.transaction_hash, terminal.log_index,
                   terminal.block_hash
          ORDER BY MIN(terminal.created_at)
          LIMIT $3
       ), cycle_counts AS MATERIALIZED (
         SELECT cycle.chain, cycle.transaction_hash, cycle.log_index, cycle.block_hash,
                COUNT(*)::int AS row_count
           FROM candidate_cycles cycle
           INNER JOIN robinhood_wallet_swap_realtime_outbox outbox
             USING (chain, transaction_hash, log_index, block_hash)
          GROUP BY cycle.chain, cycle.transaction_hash, cycle.log_index, cycle.block_hash
       ), locked_rows AS MATERIALIZED (
         SELECT outbox.ctid, outbox.chain, outbox.transaction_hash, outbox.log_index,
                outbox.block_hash, outbox.status, outbox.audit_status,
                outbox.audited_at, outbox.published_at, counts.row_count
           FROM cycle_counts counts
           INNER JOIN robinhood_wallet_swap_realtime_outbox outbox
             USING (chain, transaction_hash, log_index, block_hash)
          ORDER BY outbox.created_at, outbox.event_kind
          FOR UPDATE OF outbox SKIP LOCKED
       ), eligible_cycles AS MATERIALIZED (
         SELECT chain, transaction_hash, log_index, block_hash
           FROM locked_rows
          GROUP BY chain, transaction_hash, log_index, block_hash, row_count
         HAVING COUNT(*)=row_count
            AND BOOL_AND(audit_status='complete')
            AND (BOOL_AND(status='pending') OR BOOL_AND(status='complete'))
            AND BOOL_AND(COALESCE(
              GREATEST(audited_at, COALESCE(published_at, audited_at)), 'infinity'
            )<=NOW()-($2::bigint*INTERVAL '1 millisecond'))
       ), deleted AS (
         DELETE FROM robinhood_wallet_swap_realtime_outbox outbox
          USING eligible_cycles cycle
          WHERE outbox.chain=cycle.chain
            AND outbox.transaction_hash=cycle.transaction_hash
            AND outbox.log_index=cycle.log_index
            AND outbox.block_hash=cycle.block_hash
          RETURNING 1
       )
       SELECT (SELECT COUNT(*)::int FROM eligible_cycles) AS cycles,
              COUNT(*)::int AS rows FROM deleted`,
      [CHAIN, retentionMs, limit]
    );
    return {
      cycles: Number(result.rows[0]?.cycles || 0),
      rows: Number(result.rows[0]?.rows || 0),
    };
  }

  async function loadTelemetry() {
    const result = await database.query(
      `WITH capture AS MATERIALIZED (
         SELECT node_head, finalized_head FROM robinhood_chain_capture_cursor WHERE chain=$1
       ), frontiers AS MATERIALIZED (
         SELECT
           (SELECT block_number FROM robinhood_wallet_swap_realtime_outbox
             WHERE chain=$1 AND event_kind='observed' AND status='complete'
             ORDER BY block_number DESC LIMIT 1) AS observed_block,
           (SELECT block_number FROM robinhood_wallet_swap_realtime_outbox
             WHERE chain=$1 AND event_kind='finalized' AND status='complete'
             ORDER BY block_number DESC LIMIT 1) AS finalized_block,
           (SELECT published_at FROM robinhood_wallet_swap_realtime_outbox
             WHERE chain=$1 AND event_kind='invalidate' AND status='complete'
             ORDER BY block_number DESC LIMIT 1) AS last_invalidation_at
       ), grouped AS MATERIALIZED (
         SELECT event_kind, COUNT(*)::int AS rows,
                COUNT(*) FILTER (WHERE status='pending')::int AS pending,
                COUNT(*) FILTER (WHERE status='leased')::int AS leased,
                COUNT(*) FILTER (
                  WHERE status='blocked' OR audit_status='blocked'
                )::int AS blocked,
                COALESCE(SUM(GREATEST(attempt_count-1, 0)
                  + GREATEST(audit_attempt_count-1, 0)), 0)::text AS retries,
                EXTRACT(EPOCH FROM NOW()-MIN(created_at)) AS oldest_age_seconds
           FROM robinhood_wallet_swap_realtime_outbox
          WHERE chain=$1 AND (status<>'complete' OR audit_status<>'complete')
          GROUP BY event_kind
       ), backlog AS (
         SELECT COALESCE(jsonb_object_agg(event_kind, jsonb_build_object(
                  'rows', rows, 'pending', pending, 'leased', leased,
                  'blocked', blocked, 'retries', retries,
                  'oldestAgeSeconds', oldest_age_seconds
                )), '{}'::jsonb) AS by_kind,
                COALESCE(SUM(rows), 0)::int AS rows,
                COALESCE(SUM(blocked), 0)::int AS blocked,
                COALESCE(SUM(retries::numeric), 0)::text AS retries,
                MAX(oldest_age_seconds) AS oldest_age_seconds
           FROM grouped
       )
       SELECT capture.node_head::text, capture.finalized_head::text,
              frontiers.observed_block::text, frontiers.finalized_block::text,
              frontiers.last_invalidation_at, backlog.*
         FROM capture CROSS JOIN frontiers CROSS JOIN backlog`,
      [CHAIN]
    );
    const row = result.rows[0] || {};
    return {
      backlogByEventKind: row.by_kind || {},
      backlogRows: Number(row.rows || 0),
      blockedRows: Number(row.blocked || 0),
      retryAttempts: Number(row.retries || 0),
      oldestBacklogAgeSeconds: row.oldest_age_seconds == null
        ? null : Number(row.oldest_age_seconds),
      observedFrontierBlock: row.observed_block || null,
      finalizedFrontierBlock: row.finalized_block || null,
      observedLagBlocks: blockLag(row.node_head, row.observed_block),
      finalizedLagBlocks: blockLag(row.finalized_head, row.finalized_block),
      lastInvalidationAt: row.last_invalidation_at || null,
    };
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
         RETURNING chain, transaction_hash, log_index, block_hash, block_number
       ), terminalized AS (
         UPDATE robinhood_wallet_swap_realtime_outbox observed
            SET terminalized_at=COALESCE(observed.terminalized_at, clock_timestamp()),
                updated_at=NOW()
           FROM invalidated
          WHERE observed.chain=invalidated.chain
            AND observed.transaction_hash=invalidated.transaction_hash
            AND observed.log_index=invalidated.log_index
            AND observed.block_hash=invalidated.block_hash
            AND observed.event_kind='observed'
         RETURNING 1
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
                observed.transaction_index, observed.payload,
                terminal.event_kind AS existing_terminal_kind
           FROM robinhood_wallet_swap_realtime_outbox observed
           LEFT JOIN robinhood_chain_blocks block
             ON block.chain=observed.chain
            AND block.block_number=observed.block_number
            AND block.block_hash=observed.block_hash
            AND block.canonical
           LEFT JOIN LATERAL (
             SELECT candidate.event_kind
               FROM robinhood_wallet_swap_realtime_outbox candidate
              WHERE candidate.chain=observed.chain
                AND candidate.transaction_hash=observed.transaction_hash
                AND candidate.log_index=observed.log_index
                AND candidate.block_hash=observed.block_hash
                AND candidate.event_kind IN ('finalized', 'invalidate')
              LIMIT 1
           ) terminal ON TRUE
          WHERE observed.chain='${CHAIN}' AND observed.event_kind='observed'
            AND observed.terminalized_at IS NULL
            AND (terminal.event_kind IS NOT NULL OR (
              block.block_hash IS NOT NULL AND observed.block_number <= $1::bigint
            ))
          ORDER BY observed.block_number, observed.transaction_index, observed.log_index
          LIMIT $2
          FOR UPDATE OF observed SKIP LOCKED
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
          WHERE existing_terminal_kind IS NULL
         ON CONFLICT (
           chain, transaction_hash, log_index, block_hash, event_kind
         ) DO NOTHING
         RETURNING block_number
       ), terminalized AS (
         UPDATE robinhood_wallet_swap_realtime_outbox observed
            SET terminalized_at=clock_timestamp(), updated_at=NOW()
           FROM promotable
          WHERE observed.chain=promotable.chain
            AND observed.transaction_hash=promotable.transaction_hash
            AND observed.log_index=promotable.log_index
            AND observed.block_hash=promotable.block_hash
            AND observed.event_kind='observed'
            AND observed.terminalized_at IS NULL
         RETURNING 1
       ), notified AS (
         SELECT pg_notify($3, MAX(block_number)::text) AS sent
           FROM inserted HAVING COUNT(*) > 0
       )
       SELECT (SELECT COUNT(*)::int FROM terminalized) AS promoted,
              (SELECT COUNT(*)::int FROM notified) AS notifications
      `,
      [throughBlock, limit, NOTIFY_CHANNEL]
    );
    return Number(result.rows[0]?.promoted || 0);
  }

  return Object.freeze({
    appendOrphanInvalidations,
    claimAudit,
    claimPublication,
    loadTelemetry,
    pruneTerminalCycles,
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
