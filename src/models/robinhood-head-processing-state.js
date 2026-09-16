'use strict';

/** Inactive state-only claim/reclaim repository prepared for Corte 3B.3. */
const db = require('./db');

const CHAIN = 'robinhood';
const STREAMS = new Set(['discovery', 'market']);

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

function createRobinhoodHeadProcessingStateRepository(options = {}) {
  const database = options.database || db;

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

  return Object.freeze({ claimCaptures, claimV4Continuations, reclaimExpiredLeases });
}

module.exports = {
  DISCOVERY_CLAIM_SQL, MARKET_CLAIM_SQL, V4_CONTINUATION_CLAIM_SQL,
  createRobinhoodHeadProcessingStateRepository,
};
