'use strict';

/** Inactive state-only claim/reclaim repository prepared for Corte 3B.3. */
const db = require('./db');

const CHAIN = 'robinhood';
const STREAMS = new Set(['discovery', 'market']);
const DEFAULT_MAX_ATTEMPTS = 5;
const MIN_CAPTURE_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const PROCESSING_LEASE_KEY = 'robinhood-processing-worker';
const BLOCKED_RECOVERY_ERROR = 'V4 liquidity range update conflicted or became negative';
const BLOCKED_RECOVERY_LOCK_KEY = 'robinhood-processing-blocked-recovery';

const RETURN_CLAIMED_SQL = `
SELECT payload.*, claimed.stream, claimed.protocol, claimed.market_key,
       claimed.block_number, claimed.transaction_index,
       claimed.processing_status, claimed.lease_owner, claimed.lease_until,
       claimed.attempt_count, claimed.next_attempt_at, claimed.last_error,
       claimed.terminal_at, claimed.retention_eligible_at, claimed.updated_at
  FROM claimed
  JOIN robinhood_head_captures payload
    USING (chain, transaction_hash, log_index)
 ORDER BY claimed.block_number, claimed.transaction_index, claimed.log_index`;

const MARKET_CLAIM_SQL = `WITH RECURSIVE first_v4_by_pool AS (
  (SELECT state.market_key, state.transaction_hash, state.log_index,
          state.block_number, state.transaction_index
     FROM robinhood_head_capture_states state
    WHERE state.chain='${CHAIN}' AND state.stream='market'
      AND state.protocol='uniswap-v4' AND state.market_key IS NOT NULL
      AND state.processing_status IN ('pending', 'leased', 'blocked')
    ORDER BY state.market_key, state.block_number, state.transaction_index, state.log_index
    LIMIT 1)
  UNION ALL
  SELECT next_pool.market_key, next_pool.transaction_hash, next_pool.log_index,
         next_pool.block_number, next_pool.transaction_index
    FROM first_v4_by_pool current_pool
    CROSS JOIN LATERAL (
      SELECT state.market_key, state.transaction_hash, state.log_index,
             state.block_number, state.transaction_index
        FROM robinhood_head_capture_states state
       WHERE state.chain='${CHAIN}' AND state.stream='market'
         AND state.protocol='uniswap-v4'
         AND state.processing_status IN ('pending', 'leased', 'blocked')
         AND state.market_key > current_pool.market_key
       ORDER BY state.market_key, state.block_number, state.transaction_index, state.log_index
       LIMIT 1
    ) next_pool
), v4_claimable AS MATERIALIZED (
  SELECT state.chain, state.transaction_hash, state.log_index,
         state.block_number, state.transaction_index
    FROM first_v4_by_pool first_v4
    JOIN robinhood_head_capture_states state
      ON state.chain='${CHAIN}'
     AND state.transaction_hash=first_v4.transaction_hash
     AND state.log_index=first_v4.log_index
   WHERE state.processing_status='pending' AND state.next_attempt_at <= NOW()
   ORDER BY state.block_number, state.transaction_index, state.log_index
   LIMIT $2 FOR UPDATE OF state SKIP LOCKED
), independent_claimable AS MATERIALIZED (
  SELECT state.chain, state.transaction_hash, state.log_index,
         state.block_number, state.transaction_index
    FROM robinhood_head_capture_states state
   WHERE state.chain='${CHAIN}' AND state.stream='market'
     AND state.protocol IS DISTINCT FROM 'uniswap-v4'
     AND state.processing_status='pending' AND state.next_attempt_at <= NOW()
   ORDER BY state.block_number, state.transaction_index, state.log_index
   LIMIT $2 FOR UPDATE OF state SKIP LOCKED
), claimable AS (
  SELECT candidate.chain, candidate.transaction_hash, candidate.log_index
    FROM (SELECT * FROM v4_claimable UNION ALL SELECT * FROM independent_claimable) candidate
   ORDER BY candidate.block_number, candidate.transaction_index, candidate.log_index
   LIMIT $2
), claimed AS (
  UPDATE robinhood_head_capture_states state
     SET processing_status='leased', lease_owner=$1,
         lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),
         attempt_count=state.attempt_count+1, updated_at=NOW()
    FROM claimable
   WHERE state.chain=claimable.chain
     AND state.transaction_hash=claimable.transaction_hash
     AND state.log_index=claimable.log_index
     AND state.processing_status='pending'
  RETURNING state.*
)${RETURN_CLAIMED_SQL}`;

const DISCOVERY_CLAIM_SQL = `WITH claimable AS MATERIALIZED (
  SELECT state.chain, state.transaction_hash, state.log_index
    FROM robinhood_head_capture_states state
   WHERE state.chain='${CHAIN}' AND state.stream='discovery'
     AND state.processing_status='pending' AND state.next_attempt_at <= NOW()
   ORDER BY state.block_number, state.transaction_index, state.log_index
   LIMIT $2 FOR UPDATE OF state SKIP LOCKED
), claimed AS (
  UPDATE robinhood_head_capture_states state
     SET processing_status='leased', lease_owner=$1,
         lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),
         attempt_count=state.attempt_count+1, updated_at=NOW()
    FROM claimable
   WHERE state.chain=claimable.chain
     AND state.transaction_hash=claimable.transaction_hash
     AND state.log_index=claimable.log_index
     AND state.processing_status='pending'
  RETURNING state.*
)${RETURN_CLAIMED_SQL}`;

const V4_CONTINUATION_CLAIM_SQL = `WITH requested AS MATERIALIZED (
  SELECT DISTINCT requested.market_key FROM unnest($4::text[]) requested(market_key)
), first_by_pool AS MATERIALIZED (
  SELECT first_state.* FROM requested
  CROSS JOIN LATERAL (
    SELECT state.transaction_hash, state.log_index
      FROM robinhood_head_capture_states state
     WHERE state.chain='${CHAIN}' AND state.stream='market'
       AND state.protocol='uniswap-v4' AND state.market_key=requested.market_key
       AND state.processing_status IN ('pending', 'leased', 'blocked')
     ORDER BY state.block_number, state.transaction_index, state.log_index LIMIT 1
  ) first_state
), locked_pools AS MATERIALIZED (
  SELECT state.market_key FROM first_by_pool first_state
  JOIN robinhood_head_capture_states state
    ON state.chain='${CHAIN}'
   AND state.transaction_hash=first_state.transaction_hash
   AND state.log_index=first_state.log_index
 WHERE state.processing_status='pending' AND state.next_attempt_at <= NOW()
 FOR UPDATE OF state SKIP LOCKED
), bounded_by_pool AS MATERIALIZED (
  SELECT next_state.* FROM locked_pools
  CROSS JOIN LATERAL (
    SELECT state.market_key, state.transaction_hash, state.log_index,
           state.block_number, state.transaction_index,
           state.processing_status, state.next_attempt_at
      FROM robinhood_head_capture_states state
     WHERE state.chain='${CHAIN}' AND state.stream='market'
       AND state.protocol='uniswap-v4' AND state.market_key=locked_pools.market_key
       AND state.processing_status IN ('pending', 'leased', 'blocked')
     ORDER BY state.block_number, state.transaction_index, state.log_index
     LIMIT LEAST($5::int,
       GREATEST(1, CEIL($2::numeric/(SELECT COUNT(*) FROM requested))::int))
  ) next_state
), marked_prefix AS MATERIALIZED (
  SELECT bounded.*,
         BOOL_OR(bounded.processing_status<>'pending' OR bounded.next_attempt_at>NOW())
           OVER pool_prefix AS blocked_prefix
    FROM bounded_by_pool bounded
  WINDOW pool_prefix AS (PARTITION BY bounded.market_key
    ORDER BY bounded.block_number, bounded.transaction_index, bounded.log_index
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
), claimable AS MATERIALIZED (
  SELECT state.chain, state.transaction_hash, state.log_index
    FROM marked_prefix prefix
    JOIN robinhood_head_capture_states state
      ON state.chain='${CHAIN}'
     AND state.transaction_hash=prefix.transaction_hash AND state.log_index=prefix.log_index
   WHERE NOT prefix.blocked_prefix AND state.processing_status='pending'
     AND state.next_attempt_at <= NOW()
   ORDER BY state.block_number, state.transaction_index, state.log_index
   LIMIT $2 FOR UPDATE OF state SKIP LOCKED
), claimed AS (
  UPDATE robinhood_head_capture_states state
     SET processing_status='leased', lease_owner=$1,
         lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),
         attempt_count=state.attempt_count+1, updated_at=NOW()
    FROM claimable
   WHERE state.chain=claimable.chain
     AND state.transaction_hash=claimable.transaction_hash
     AND state.log_index=claimable.log_index
     AND state.processing_status='pending'
  RETURNING state.*
)${RETURN_CLAIMED_SQL}`;

function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function ownerOf(value) {
  const owner = String(value || '').trim();
  if (!owner || owner.length > 128) throw new Error('processing owner is required');
  return owner;
}

function streamOf(value) {
  const stream = String(value || '').trim().toLowerCase();
  if (!STREAMS.has(stream)) throw new Error('stream must be discovery or market');
  return stream;
}

function marketKeysOf(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

function optionalBlock(value) {
  if (value == null || value === '') return null;
  const block = String(value).trim();
  if (!/^\d+$/.test(block)) throw new Error('throughBlock must be a non-negative integer');
  return block;
}

function identityOf(entry, label) {
  const transactionHash = String(entry?.transactionHash || '').trim().toLowerCase();
  const logIndex = String(entry?.logIndex ?? '').trim();
  if (!/^0x[0-9a-f]{64}$/.test(transactionHash)) {
    throw new Error(`${label}.transactionHash must be 32 bytes`);
  }
  if (!/^\d+$/.test(logIndex)) throw new Error(`${label}.logIndex must be a non-negative integer`);
  return { transactionHash, logIndex };
}

function retryOf(entry) {
  return {
    ...identityOf(entry, 'retry'),
    error: entry?.error == null ? null : String(entry.error).slice(0, 4000),
    backoffMs: positiveInt(entry?.backoffMs ?? 1, 'retry.backoffMs'),
  };
}

function terminalOf(entry, status) {
  return {
    ...identityOf(entry, status), status,
    reason: entry?.reason == null ? null : String(entry.reason).slice(0, 4000),
  };
}

function recoverySummary(rows, limit, workerActive) {
  const selected = rows.slice(0, limit);
  return {
    workerActive,
    candidates: selected.length,
    oldestBlock: selected[0]?.block_number == null ? null : String(selected[0].block_number),
    newestBlock: selected.at(-1)?.block_number == null
      ? null : String(selected.at(-1).block_number),
    hasMore: rows.length > limit,
  };
}

function createRobinhoodHeadProcessingStateRepository(options = {}) {
  const database = options.database || db;
  const defaultMaxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;

  async function claimCaptures(input = {}) {
    const owner = ownerOf(input.owner);
    const limit = positiveInt(input.limit, 'limit');
    const leaseMs = positiveInt(input.leaseMs, 'leaseMs');
    const stream = streamOf(input.stream);
    const sql = stream === 'market' ? MARKET_CLAIM_SQL : DISCOVERY_CLAIM_SQL;
    const result = await database.query(sql, [owner, limit, leaseMs]);
    return result.rows;
  }

  async function claimV4Continuations(input = {}) {
    const owner = ownerOf(input.owner);
    const limit = positiveInt(input.limit, 'limit');
    const leaseMs = positiveInt(input.leaseMs, 'leaseMs');
    const perPoolLimit = positiveInt(input.perPoolLimit ?? limit, 'perPoolLimit');
    const marketKeys = marketKeysOf(input.marketKeys);
    if (!marketKeys.length) return [];
    const result = await database.query(
      V4_CONTINUATION_CLAIM_SQL, [owner, limit, leaseMs, marketKeys, perPoolLimit]
    );
    return result.rows;
  }

  async function reclaimExpiredLeases() {
    const result = await database.query(
      `UPDATE robinhood_head_capture_states
          SET processing_status='pending', lease_owner=NULL, lease_until=NULL, updated_at=NOW()
        WHERE chain=$1 AND processing_status='leased' AND lease_until <= NOW()
        RETURNING transaction_hash`,
      [CHAIN]
    );
    return result.rowCount;
  }

  async function settleTerminal(client, owner, entries, status, retentionMs) {
    if (!entries.length) return 0;
    const rows = entries.map((entry) => terminalOf(entry, status));
    const result = await client.query(
      `UPDATE robinhood_head_capture_states state
          SET processing_status=terminal.status, lease_owner=NULL, lease_until=NULL,
              terminal_at=NOW(),
              retention_eligible_at=NOW()+($3::bigint*INTERVAL '1 millisecond'),
              last_error=terminal.reason, updated_at=NOW()
         FROM jsonb_to_recordset($1::jsonb) AS terminal(
           "transactionHash" text, "logIndex" bigint, reason text, status text
         )
        WHERE state.chain='${CHAIN}'
          AND state.transaction_hash=terminal."transactionHash"
          AND state.log_index=terminal."logIndex"
          AND state.processing_status='leased' AND state.lease_owner=$2
          AND state.lease_until>NOW()
        RETURNING state.transaction_hash`,
      [JSON.stringify(rows), owner, retentionMs]
    );
    return result.rowCount;
  }

  async function settleRetry(client, owner, entries, maxAttempts) {
    if (!entries.length) return { retried: 0, blocked: 0 };
    const rows = entries.map(retryOf);
    const result = await client.query(
      `UPDATE robinhood_head_capture_states state
          SET processing_status=CASE
                WHEN state.attempt_count >= $3 THEN 'blocked' ELSE 'pending' END,
              lease_owner=NULL, lease_until=NULL,
              next_attempt_at=CASE WHEN state.attempt_count >= $3
                THEN state.next_attempt_at
                ELSE NOW()+(retry."backoffMs"::bigint*INTERVAL '1 millisecond') END,
              last_error=retry.error, updated_at=NOW()
         FROM jsonb_to_recordset($1::jsonb) AS retry(
           "transactionHash" text, "logIndex" bigint, error text, "backoffMs" bigint
         )
        WHERE state.chain='${CHAIN}'
          AND state.transaction_hash=retry."transactionHash"
          AND state.log_index=retry."logIndex"
          AND state.processing_status='leased' AND state.lease_owner=$2
          AND state.lease_until>NOW()
        RETURNING state.processing_status`,
      [JSON.stringify(rows), owner, maxAttempts]
    );
    const blocked = result.rows.filter((row) => row.processing_status === 'blocked').length;
    return { retried: result.rowCount - blocked, blocked };
  }

  async function settleClaims(input = {}) {
    const owner = ownerOf(input.owner);
    const retentionMs = Math.max(
      MIN_CAPTURE_RETENTION_MS, positiveInt(input.retentionMs, 'retentionMs')
    );
    const maxAttempts = positiveInt(input.maxAttempts ?? defaultMaxAttempts, 'maxAttempts');
    const processed = Array.isArray(input.processed) ? input.processed : [];
    const rejected = Array.isArray(input.rejected) ? input.rejected : [];
    const retry = Array.isArray(input.retry) ? input.retry : [];
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const processedCount = await settleTerminal(
        client, owner, processed, 'processed', retentionMs
      );
      const rejectedCount = await settleTerminal(
        client, owner, rejected, 'rejected', retentionMs
      );
      const retryResult = await settleRetry(client, owner, retry, maxAttempts);
      await client.query('COMMIT');
      return {
        processed: processedCount, rejected: rejectedCount,
        retried: retryResult.retried, blocked: retryResult.blocked,
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function previewBlockedRecovery(input = {}) {
    const limit = positiveInt(input.limit, 'limit');
    const throughBlock = optionalBlock(input.throughBlock);
    const [lease, candidates] = await Promise.all([
      database.query(
        `SELECT EXISTS (SELECT 1 FROM worker_leases
          WHERE lease_key=$1 AND lease_until>NOW()) AS active`,
        [PROCESSING_LEASE_KEY]
      ),
      database.query(
        `SELECT block_number FROM robinhood_head_capture_states
          WHERE chain=$1 AND stream='market' AND processing_status='blocked'
            AND last_error=$2 AND ($3::bigint IS NULL OR block_number <= $3::bigint)
          ORDER BY block_number, transaction_index, log_index LIMIT ($4::int+1)`,
        [CHAIN, BLOCKED_RECOVERY_ERROR, throughBlock, limit]
      ),
    ]);
    return recoverySummary(candidates.rows, limit, lease.rows[0]?.active === true);
  }

  async function requeueBlockedRecoveryBatch(input = {}) {
    const limit = positiveInt(input.limit, 'limit');
    const throughBlock = optionalBlock(input.throughBlock);
    if (throughBlock == null) throw new Error('throughBlock is required for blocked recovery');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        BLOCKED_RECOVERY_LOCK_KEY,
      ]);
      const lease = await client.query(
        `SELECT lease_until>NOW() AS active FROM worker_leases
          WHERE lease_key=$1 FOR UPDATE`,
        [PROCESSING_LEASE_KEY]
      );
      if (lease.rows[0]?.active === true) {
        const error = new Error('Robinhood processing worker must be stopped');
        error.code = 'robinhood_processing_worker_active';
        throw error;
      }
      const result = await client.query(
        `WITH targets AS MATERIALIZED (
           SELECT chain, transaction_hash, log_index
             FROM robinhood_head_capture_states
            WHERE chain=$1 AND stream='market' AND processing_status='blocked'
              AND last_error=$2 AND block_number <= $3::bigint
            ORDER BY block_number, transaction_index, log_index
            LIMIT $4::int FOR UPDATE SKIP LOCKED
         ), requeued AS (
           UPDATE robinhood_head_capture_states state
              SET processing_status='pending', attempt_count=0,
                  next_attempt_at=NOW(), updated_at=NOW()
             FROM targets
            WHERE state.chain=targets.chain
              AND state.transaction_hash=targets.transaction_hash
              AND state.log_index=targets.log_index
           RETURNING state.block_number
         )
         SELECT COUNT(*)::int AS requeued, MIN(block_number) AS oldest_block,
                MAX(block_number) AS newest_block FROM requeued`,
        [CHAIN, BLOCKED_RECOVERY_ERROR, throughBlock, limit]
      );
      await client.query('COMMIT');
      const row = result.rows[0] || {};
      return {
        requeued: Number(row.requeued || 0),
        oldestBlock: row.oldest_block == null ? null : String(row.oldest_block),
        newestBlock: row.newest_block == null ? null : String(row.newest_block),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    claimCaptures, claimV4Continuations, reclaimExpiredLeases, settleClaims,
    previewBlockedRecovery, requeueBlockedRecoveryBatch,
  });
}

module.exports = {
  BLOCKED_RECOVERY_ERROR, DISCOVERY_CLAIM_SQL, MARKET_CLAIM_SQL,
  V4_CONTINUATION_CLAIM_SQL,
  createRobinhoodHeadProcessingStateRepository,
};
