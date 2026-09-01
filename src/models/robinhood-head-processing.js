/**
 * Consumer-side repository for the durable head-capture queue (Corte 4b).
 *
 * This is the claim/settle boundary the `robinhood-processing` worker uses. It
 * leases pending captures with a short lease, settles them as processed/rejected
 * (terminal + retention) or reschedules them with backoff, dead-letters a
 * capture that exhausts its attempts, and reclaims leases abandoned by a crashed
 * consumer. It never touches the capture cursor: processing failures isolate the
 * claim and never revert head capture (evidence contract §7, plan §5.2).
 */
const db = require('./db');

const CHAIN = 'robinhood';
const STREAMS = new Set(['discovery', 'market']);
const DEFAULT_MAX_ATTEMPTS = 5;
const PROCESSING_LEASE_KEY = 'robinhood-processing-worker';
const BLOCKED_RECOVERY_ERROR = 'V4 liquidity range update conflicted or became negative';
const BLOCKED_RECOVERY_LOCK_KEY = 'robinhood-processing-blocked-recovery';

const MARKET_CLAIM_SQL = `WITH first_v4_by_pool AS MATERIALIZED (
  SELECT DISTINCT ON (market_key)
         market_key, transaction_hash, log_index
  FROM robinhood_head_captures
  WHERE chain = '${CHAIN}'
    AND stream = 'market'
    AND protocol = 'uniswap-v4'
    AND processing_status IN ('pending', 'leased', 'blocked')
  ORDER BY market_key, block_number, transaction_index, log_index
), v4_claimable AS MATERIALIZED (
  SELECT capture.chain, capture.transaction_hash, capture.log_index,
         capture.block_number, capture.transaction_index
  FROM first_v4_by_pool first_v4
  INNER JOIN robinhood_head_captures capture
    ON capture.chain = '${CHAIN}'
   AND capture.transaction_hash = first_v4.transaction_hash
   AND capture.log_index = first_v4.log_index
  WHERE capture.processing_status = 'pending'
    AND capture.next_attempt_at <= NOW()
  ORDER BY capture.block_number, capture.transaction_index, capture.log_index
  LIMIT $2
  FOR UPDATE OF capture SKIP LOCKED
), independent_claimable AS MATERIALIZED (
  SELECT capture.chain, capture.transaction_hash, capture.log_index,
         capture.block_number, capture.transaction_index
  FROM robinhood_head_captures capture
  WHERE capture.chain = '${CHAIN}'
    AND capture.stream = 'market'
    AND capture.protocol IS DISTINCT FROM 'uniswap-v4'
    AND capture.processing_status = 'pending'
    AND capture.next_attempt_at <= NOW()
  ORDER BY capture.block_number, capture.transaction_index, capture.log_index
  LIMIT $2
  FOR UPDATE OF capture SKIP LOCKED
), claimable AS (
  SELECT candidate.chain, candidate.transaction_hash, candidate.log_index
  FROM (
    SELECT * FROM v4_claimable
    UNION ALL
    SELECT * FROM independent_claimable
  ) candidate
  ORDER BY candidate.block_number, candidate.transaction_index, candidate.log_index
  LIMIT $2
)
UPDATE robinhood_head_captures capture
SET processing_status = 'leased',
    lease_owner = $1,
    lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
    attempt_count = capture.attempt_count + 1,
    updated_at = NOW()
FROM claimable
WHERE capture.chain = claimable.chain
  AND capture.transaction_hash = claimable.transaction_hash
  AND capture.log_index = claimable.log_index
RETURNING capture.*`;

function requireOwner(value) {
  const owner = String(value || '').trim();
  if (!owner || owner.length > 128) throw new Error('processing owner is required');
  return owner;
}

function requirePositiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function optionalStream(value) {
  if (value == null) return null;
  const stream = String(value).trim().toLowerCase();
  if (!STREAMS.has(stream)) throw new Error('stream must be discovery or market');
  return stream;
}

function compareCaptureOrder(left, right) {
  for (const field of ['block_number', 'transaction_index', 'log_index']) {
    const leftValue = BigInt(left[field]);
    const rightValue = BigInt(right[field]);
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function optionalBlock(value, label = 'throughBlock') {
  if (value == null || value === '') return null;
  const block = String(value).trim();
  if (!/^\d+$/.test(block)) throw new Error(`${label} must be a non-negative integer`);
  return block;
}

function recoverySummary(rows, limit, workerActive = false) {
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

function hexWord(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} must be 32 bytes`);
  return normalized;
}

function logIndexOf(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  return raw;
}

function normalizeIdentity(entry, label) {
  return {
    transactionHash: hexWord(entry?.transactionHash, `${label}.transactionHash`),
    logIndex: logIndexOf(entry?.logIndex, `${label}.logIndex`),
  };
}

function normalizeRetry(entry) {
  return {
    ...normalizeIdentity(entry, 'retry'),
    error: entry?.error == null ? null : String(entry.error).slice(0, 4000),
    backoffMs: requirePositiveInt(entry?.backoffMs ?? 1, 'retry.backoffMs'),
  };
}

function normalizeRejected(entry) {
  return {
    ...normalizeIdentity(entry, 'rejected'),
    reason: entry?.reason == null ? null : String(entry.reason).slice(0, 4000),
  };
}

function createRobinhoodHeadProcessingRepository(options = {}) {
  const database = options.database || db;
  const defaultMaxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;

  // Leases a batch of pending, due captures in on-chain order. FOR UPDATE SKIP
  // LOCKED lets concurrent consumers claim disjoint rows without blocking.
  async function claimCaptures(input = {}) {
    const owner = requireOwner(input.owner);
    const limit = requirePositiveInt(input.limit, 'limit');
    const leaseMs = requirePositiveInt(input.leaseMs, 'leaseMs');
    const stream = optionalStream(input.stream);
    const result = stream === 'market'
      ? await database.query(MARKET_CLAIM_SQL, [owner, limit, leaseMs])
      : await database.query(
        `WITH first_v4_by_pool AS MATERIALIZED (
         SELECT DISTINCT ON (market_key)
                chain, market_key, transaction_hash, log_index
         FROM robinhood_head_captures
         WHERE chain = '${CHAIN}'
           AND stream = 'market'
           AND protocol = 'uniswap-v4'
           AND processing_status IN ('pending', 'leased', 'blocked')
           AND ($4::text IS NULL OR $4 = 'market')
         ORDER BY market_key, block_number, transaction_index, log_index
       ), claimable AS (
         SELECT capture.chain, capture.transaction_hash, capture.log_index
         FROM robinhood_head_captures capture
         LEFT JOIN first_v4_by_pool first_v4
           ON first_v4.chain = capture.chain
          AND first_v4.market_key = capture.market_key
         WHERE capture.processing_status = 'pending'
           AND capture.next_attempt_at <= NOW()
           AND ($4::text IS NULL OR capture.stream = $4)
           AND (
             capture.stream <> 'market'
             OR capture.protocol IS DISTINCT FROM 'uniswap-v4'
             OR (
               first_v4.transaction_hash = capture.transaction_hash
               AND first_v4.log_index = capture.log_index
             )
           )
         ORDER BY capture.block_number, capture.transaction_index, capture.log_index
         LIMIT $2
         FOR UPDATE OF capture SKIP LOCKED
       )
       UPDATE robinhood_head_captures capture
       SET processing_status = 'leased',
           lease_owner = $1,
           lease_until = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
           attempt_count = capture.attempt_count + 1,
           updated_at = NOW()
       FROM claimable
       WHERE capture.chain = claimable.chain
         AND capture.transaction_hash = claimable.transaction_hash
         AND capture.log_index = claimable.log_index
       RETURNING capture.*`,
        [owner, limit, leaseMs, stream]
      );
    return result.rows.sort(compareCaptureOrder);
  }

  // Reschedules failed captures with backoff, or dead-letters them as `blocked`
  // once they have burned through their attempts.
  async function settleRetry(client, owner, entries, maxAttempts) {
    if (!entries.length) return { retried: 0, blocked: 0 };
    const rows = entries.map(normalizeRetry);
    const result = await client.query(
      `UPDATE robinhood_head_captures capture
       SET processing_status = CASE
             WHEN capture.attempt_count >= $3 THEN 'blocked' ELSE 'pending' END,
           lease_owner = NULL,
           lease_until = NULL,
           next_attempt_at = CASE
             WHEN capture.attempt_count >= $3 THEN capture.next_attempt_at
             ELSE NOW() + (retry."backoffMs"::bigint * INTERVAL '1 millisecond') END,
           last_error = retry.error,
           updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS retry(
         "transactionHash" text, "logIndex" bigint, error text, "backoffMs" bigint
       )
       WHERE capture.chain = '${CHAIN}'
         AND capture.transaction_hash = retry."transactionHash"
         AND capture.log_index = retry."logIndex"
         AND capture.processing_status = 'leased'
         AND capture.lease_owner = $2
         AND capture.lease_until > NOW()
       RETURNING capture.processing_status`,
      [JSON.stringify(rows), owner, maxAttempts]
    );
    const blocked = result.rows.filter((row) => row.processing_status === 'blocked').length;
    return { retried: result.rowCount - blocked, blocked };
  }

  async function settleClaims(input = {}) {
    const owner = requireOwner(input.owner);
    const retentionMs = requirePositiveInt(input.retentionMs, 'retentionMs');
    const maxAttempts = requirePositiveInt(input.maxAttempts ?? defaultMaxAttempts, 'maxAttempts');
    const processed = Array.isArray(input.processed) ? input.processed : [];
    const rejected = Array.isArray(input.rejected) ? input.rejected : [];
    const retry = Array.isArray(input.retry) ? input.retry : [];
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const processedCount = await settleTerminalStatus(client, owner, processed, 'processed', retentionMs);
      const rejectedCount = await settleTerminalStatus(client, owner, rejected, 'rejected', retentionMs);
      const retryResult = await settleRetry(client, owner, retry, maxAttempts);
      await client.query('COMMIT');
      return {
        processed: processedCount,
        rejected: rejectedCount,
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

  async function settleTerminalStatus(client, owner, entries, status, retentionMs) {
    if (!entries.length) return 0;
    const rows = entries.map((entry) => ({ ...normalizeRejected(entry), status }));
    const result = await client.query(
      `UPDATE robinhood_head_captures capture
       SET processing_status = terminal.status,
           lease_owner = NULL,
           lease_until = NULL,
           terminal_at = NOW(),
           retention_eligible_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
           last_error = terminal.reason,
           updated_at = NOW()
       FROM jsonb_to_recordset($1::jsonb) AS terminal(
         "transactionHash" text, "logIndex" bigint, reason text, status text
       )
       WHERE capture.chain = '${CHAIN}'
         AND capture.transaction_hash = terminal."transactionHash"
         AND capture.log_index = terminal."logIndex"
         AND capture.processing_status = 'leased'
         AND capture.lease_owner = $2
         AND capture.lease_until > NOW()
       RETURNING capture.transaction_hash`,
      [JSON.stringify(rows), owner, retentionMs]
    );
    return result.rowCount;
  }

  // Returns abandoned leases (crashed consumer) to the pending pool. The attempt
  // was already counted at claim time, so a stuck lease still burns an attempt.
  async function reclaimExpiredLeases() {
    const result = await database.query(
      `UPDATE robinhood_head_captures
       SET processing_status = 'pending',
           lease_owner = NULL,
           lease_until = NULL,
           updated_at = NOW()
       WHERE chain = $1
         AND processing_status = 'leased'
         AND lease_until <= NOW()
       RETURNING transaction_hash`,
      [CHAIN]
    );
    return result.rowCount;
  }

  // Lowest not-yet-terminal block is the effective processing watermark; the
  // status counts expose queue depth and dead-letter backlog for observability.
  async function getProcessingWatermark(streamValue) {
    const stream = optionalStream(streamValue);
    const result = await database.query(
      `SELECT MIN(block_number) FILTER (
                WHERE processing_status IN ('pending', 'leased', 'blocked')
              ) AS pending_block,
              COUNT(*) FILTER (WHERE processing_status = 'pending') AS pending,
              COUNT(*) FILTER (WHERE processing_status = 'leased') AS leased,
              COUNT(*) FILTER (WHERE processing_status = 'blocked') AS blocked
       FROM robinhood_head_captures
       WHERE chain = $1 AND ($2::text IS NULL OR stream = $2)`,
      [CHAIN, stream]
    );
    const row = result.rows[0] || {};
    return {
      pendingBlock: row.pending_block == null ? null : String(row.pending_block),
      pending: Number(row.pending || 0),
      leased: Number(row.leased || 0),
      blocked: Number(row.blocked || 0),
    };
  }

  // Oldest in-flight market evidence, anchoring the processing/derived coverage
  // frontier. Only non-terminal work (pending, leased) counts: a `blocked`
  // dead-letter is never processed into an observation, so pinning coverage to
  // it would freeze the frontier in the past forever. Its evidence is retained
  // and recoverable on replay, and dead-letter depth stays visible via
  // getProcessingWatermark. Terminal history is never scanned by this hot read.
  async function getOldestActiveCapture(streamValue) {
    const stream = optionalStream(streamValue);
    const result = await database.query(
      `WITH leased AS MATERIALIZED (
         SELECT block_number, evidence->>'timestampMs' AS timestamp_ms,
                transaction_index, log_index
         FROM robinhood_head_captures
         WHERE chain = $1 AND stream = $2 AND processing_status = 'leased'
       ), active AS (
         (SELECT block_number, evidence->>'timestampMs' AS timestamp_ms,
                 transaction_index, log_index
          FROM robinhood_head_captures
          WHERE chain = $1 AND stream = $2 AND processing_status = 'pending'
          ORDER BY block_number, transaction_index, log_index
          LIMIT 1)
         UNION ALL
         (SELECT block_number, timestamp_ms, transaction_index, log_index
          FROM leased
          ORDER BY block_number, transaction_index, log_index
          LIMIT 1)
       )
       SELECT block_number, timestamp_ms
       FROM active
       ORDER BY block_number, transaction_index, log_index
       LIMIT 1`,
      [CHAIN, stream]
    );
    const row = result.rows[0];
    if (!row) return null;
    const rawTimestamp = String(row.timestamp_ms || '');
    const timestamp = /^\d+$/.test(rawTimestamp) ? Number(rawTimestamp) : NaN;
    return {
      blockNumber: String(row.block_number),
      observedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
    };
  }

  // Prunes captures whose retention window has elapsed (Q3: 1 day after
  // terminal). The queue is a passage corridor; permanent observations/buckets
  // live in their own tables, so a processed/rejected capture is disposable.
  async function pruneExpiredCaptures(input = {}) {
    const limit = requirePositiveInt(input.limit ?? 5000, 'limit');
    const result = await database.query(
      `DELETE FROM robinhood_head_captures
       WHERE (chain, transaction_hash, log_index) IN (
         SELECT chain, transaction_hash, log_index
         FROM robinhood_head_captures
         WHERE chain = $1
           AND processing_status IN ('processed', 'rejected')
           AND retention_eligible_at IS NOT NULL
           AND retention_eligible_at <= NOW()
         ORDER BY retention_eligible_at
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING transaction_hash`,
      [CHAIN, limit]
    );
    return result.rowCount;
  }

  async function previewBlockedRecovery(input = {}) {
    const limit = requirePositiveInt(input.limit, 'limit');
    const throughBlock = optionalBlock(input.throughBlock);
    const [lease, candidates] = await Promise.all([
      database.query(
        `SELECT EXISTS (
           SELECT 1 FROM worker_leases
           WHERE lease_key = $1 AND lease_until > NOW()
         ) AS active`,
        [PROCESSING_LEASE_KEY]
      ),
      database.query(
        `SELECT block_number
         FROM robinhood_head_captures
         WHERE chain = $1
           AND stream = 'market'
           AND processing_status = 'blocked'
           AND last_error = $2
           AND ($3::bigint IS NULL OR block_number <= $3::bigint)
         ORDER BY block_number, transaction_index, log_index
         LIMIT ($4::int + 1)`,
        [CHAIN, BLOCKED_RECOVERY_ERROR, throughBlock, limit]
      ),
    ]);
    return recoverySummary(candidates.rows, limit, lease.rows[0]?.active === true);
  }

  async function requeueBlockedRecoveryBatch(input = {}) {
    const limit = requirePositiveInt(input.limit, 'limit');
    const throughBlock = optionalBlock(input.throughBlock);
    if (throughBlock == null) throw new Error('throughBlock is required for blocked recovery');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [BLOCKED_RECOVERY_LOCK_KEY]);
      const lease = await client.query(
        `SELECT lease_until > NOW() AS active
         FROM worker_leases WHERE lease_key = $1 FOR UPDATE`,
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
           FROM robinhood_head_captures
           WHERE chain = $1
             AND stream = 'market'
             AND processing_status = 'blocked'
             AND last_error = $2
             AND block_number <= $3::bigint
           ORDER BY block_number, transaction_index, log_index
           LIMIT $4::int
           FOR UPDATE SKIP LOCKED
         ), requeued AS (
           UPDATE robinhood_head_captures capture
           SET processing_status = 'pending',
               attempt_count = 0,
               next_attempt_at = NOW(),
               updated_at = NOW()
           FROM targets
           WHERE capture.chain = targets.chain
             AND capture.transaction_hash = targets.transaction_hash
             AND capture.log_index = targets.log_index
           RETURNING capture.block_number
         )
         SELECT COUNT(*)::int AS requeued,
                MIN(block_number) AS oldest_block,
                MAX(block_number) AS newest_block
         FROM requeued`,
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
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    claimCaptures,
    settleClaims,
    reclaimExpiredLeases,
    getOldestActiveCapture,
    getProcessingWatermark,
    pruneExpiredCaptures,
    previewBlockedRecovery,
    requeueBlockedRecoveryBatch,
  });
}

module.exports = {
  BLOCKED_RECOVERY_ERROR,
  createRobinhoodHeadProcessingRepository,
  DEFAULT_MAX_ATTEMPTS,
};
