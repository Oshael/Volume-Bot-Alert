const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const TERMINAL_REASONS = new Set([
  'holder_missing',
  'holder_not_live',
  'holder_frontier_missing',
]);

// Resolve the expensive historical candidate without holding the global capture cursor.
// The earliest eligible first-buy is itself a swap, so it safely bounds the launch lookup.
const LOAD_CANDIDATE_SQL = `WITH target AS MATERIALIZED (
  SELECT requested.token_address, state.ledger_status, state.live_through_block,
         state.live_through_hash, frontier.block_number IS NOT NULL AS canonical_frontier,
         origin.discovery_block AS first_pool_block,
         origin.discovered_at AS first_pool_time,
         upper_buy.block_number AS upper_block,
         upper_buy.block_time AS upper_time
    FROM (VALUES ($2::varchar)) requested(token_address)
    LEFT JOIN robinhood_holder_token_states state
      ON state.chain = $1 AND state.token_address = requested.token_address
    LEFT JOIN robinhood_chain_blocks frontier
      ON frontier.chain = state.chain AND frontier.canonical
     AND frontier.block_number = state.live_through_block
     AND frontier.block_hash = state.live_through_hash
    LEFT JOIN LATERAL (
      SELECT registry.discovery_block, registry.discovered_at
        FROM robinhood_pool_registry registry
       WHERE registry.chain = state.chain AND registry.active
         AND registry.token_address = state.token_address
         AND registry.discovery_block <= state.live_through_block
       ORDER BY registry.discovery_block, registry.protocol, registry.market_key
       LIMIT 1
    ) origin ON TRUE
    LEFT JOIN LATERAL (
      SELECT buy.block_number, buy.block_time
        FROM robinhood_wallet_token_first_buys buy
        INNER JOIN robinhood_pool_registry registry
          ON registry.chain = buy.chain AND registry.protocol = buy.protocol
         AND registry.market_key = buy.market_key
         AND registry.token_address = buy.token_address AND registry.active
         AND registry.discovery_block <= buy.block_number
       WHERE buy.chain = state.chain AND buy.token_address = state.token_address
         AND buy.block_number <= state.live_through_block
       ORDER BY buy.block_number, buy.transaction_index, buy.action_index,
                buy.transaction_hash
       LIMIT 1
    ) upper_buy ON TRUE
), candidate AS MATERIALIZED (
  SELECT source.block_number, source.block_time, source.transaction_hash,
         source.action_index, source.protocol, source.market_key
    FROM target
    INNER JOIN LATERAL (
      SELECT swap.block_number, swap.block_time, swap.transaction_hash,
             swap.action_index, swap.protocol, swap.market_key
        FROM robinhood_wallet_swaps swap
        INNER JOIN robinhood_pool_registry registry
          ON registry.chain = swap.chain AND registry.protocol = swap.protocol
         AND registry.market_key = swap.market_key
         AND registry.token_address = swap.token_address AND registry.active
         AND registry.discovery_block <= swap.block_number
       WHERE swap.chain = $1 AND swap.token_address = target.token_address
         AND swap.block_number BETWEEN target.first_pool_block AND target.upper_block
         AND swap.block_time BETWEEN target.first_pool_time AND target.upper_time
       ORDER BY swap.block_number, swap.block_time, swap.action_index,
                swap.transaction_hash
       LIMIT 1
    ) source ON target.ledger_status = 'live'
      AND target.live_through_block IS NOT NULL
      AND target.live_through_hash IS NOT NULL
      AND target.canonical_frontier
      AND target.first_pool_block IS NOT NULL
      AND target.upper_block IS NOT NULL
)
SELECT target.*, candidate.block_number AS launch_block,
       candidate.block_time AS launch_block_time,
       candidate.transaction_hash AS launch_transaction_hash,
       candidate.action_index AS launch_action_index,
       candidate.protocol AS launch_protocol,
       candidate.market_key AS launch_market_key,
       CASE
         WHEN target.ledger_status IS NULL THEN 'holder_missing'
         WHEN target.ledger_status <> 'live' THEN 'holder_not_live'
         WHEN target.live_through_block IS NULL OR target.live_through_hash IS NULL
           THEN 'holder_frontier_missing'
         WHEN NOT target.canonical_frontier THEN 'holder_frontier_not_canonical'
         WHEN target.first_pool_block IS NULL THEN 'active_pool_origin_missing'
         WHEN target.upper_block IS NULL THEN 'eligible_first_buy_missing'
         WHEN candidate.block_number IS NULL THEN 'launch_swap_missing'
         ELSE 'ready'
       END AS readiness
  FROM target LEFT JOIN candidate ON TRUE`;

// Revalidate exact evidence under a short cursor lock. Recovery either finishes before
// this statement and removes stale evidence, or waits until this write has committed.
const COMMIT_CANDIDATE_SQL = `WITH capture AS MATERIALIZED (
  SELECT checkpoint_block FROM robinhood_chain_capture_cursor
   WHERE chain = $1 AND recovery_state = 'running' FOR SHARE
), target AS MATERIALIZED (
  SELECT state.token_address, state.live_through_block, origin.discovery_block
    FROM robinhood_holder_token_states state
    CROSS JOIN capture
    INNER JOIN robinhood_chain_blocks frontier
      ON frontier.chain = state.chain AND frontier.canonical
     AND frontier.block_number = state.live_through_block
     AND frontier.block_hash = state.live_through_hash
    INNER JOIN LATERAL (
      SELECT registry.discovery_block
        FROM robinhood_pool_registry registry
       WHERE registry.chain = state.chain AND registry.active
         AND registry.token_address = state.token_address
         AND registry.discovery_block <= state.live_through_block
       ORDER BY registry.discovery_block, registry.protocol, registry.market_key
       LIMIT 1
    ) origin ON origin.discovery_block = $3::bigint
   WHERE state.chain = $1 AND state.token_address = $2
     AND state.ledger_status = 'live' AND state.live_through_block IS NOT NULL
     AND state.live_through_block <= capture.checkpoint_block
), source AS MATERIALIZED (
  SELECT swap.block_number, swap.block_time
    FROM robinhood_wallet_swaps swap
    INNER JOIN robinhood_pool_registry registry
      ON registry.chain = swap.chain AND registry.protocol = swap.protocol
     AND registry.market_key = swap.market_key
     AND registry.token_address = swap.token_address AND registry.active
     AND registry.discovery_block <= swap.block_number
   WHERE swap.chain = $1 AND swap.token_address = $2
     AND swap.block_number = $4::bigint AND swap.block_time = $5::timestamptz
     AND swap.transaction_hash = $6 AND swap.action_index = $7::bigint
     AND swap.protocol = $8 AND swap.market_key = $9
)
INSERT INTO robinhood_token_launch_anchors(
  chain, token_address, first_pool_block, launch_block, launch_block_time,
  source_through_block, evidence_version
) SELECT $1, target.token_address, target.discovery_block, source.block_number,
         source.block_time, target.live_through_block, 'rh_launch_anchor_v1'
    FROM target INNER JOIN source ON source.block_number BETWEEN
      target.discovery_block AND target.live_through_block
ON CONFLICT (chain, token_address) DO UPDATE SET
  first_pool_block = EXCLUDED.first_pool_block, launch_block = EXCLUDED.launch_block,
  launch_block_time = EXCLUDED.launch_block_time,
  source_through_block = GREATEST(robinhood_token_launch_anchors.source_through_block,
                                  EXCLUDED.source_through_block),
  evidence_version = EXCLUDED.evidence_version,
  anchor_wallet_address = NULL, anchor_transaction_hash = NULL,
  anchor_transaction_index = NULL, anchor_action_index = NULL,
  anchor_block_hash = NULL, anchor_side = NULL, anchor_volume_usd = NULL,
  updated_at = NOW() RETURNING token_address`;

function createRobinhoodLaunchAnchorOutboxRepository(options = {}) {
  const database = options.database || db;
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs) || 120_000, 900_000));
  const token = (value) => normalizeTokenAddress(CHAIN, value);
  const timedQuery = (sql, values) => {
    const query = database.queryWithStatementTimeout?.bind(database)
      || database.query.bind(database);
    return query(sql, values, timeoutMs);
  };

  async function claim({ owner, leaseMs }) {
    const { rows } = await database.query(`WITH candidate AS (
      SELECT token_address FROM robinhood_launch_anchor_outbox
       WHERE next_attempt_at <= NOW() AND (status = 'pending' OR lease_until <= NOW())
       ORDER BY next_attempt_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED
    ) UPDATE robinhood_launch_anchor_outbox outbox SET status = 'leased', lease_owner = $1,
        lease_until = NOW() + ($2::bigint * INTERVAL '1 millisecond'),
        attempt_count = attempt_count + 1, updated_at = NOW()
       FROM candidate WHERE outbox.chain = '${CHAIN}'
        AND outbox.token_address = candidate.token_address
      RETURNING outbox.token_address, outbox.attempt_count`, [owner, leaseMs]);
    return rows[0] ? { tokenAddress: rows[0].token_address,
      attemptCount: Number(rows[0].attempt_count) } : null;
  }
  async function materialize(tokenAddress) {
    const normalized = token(tokenAddress);
    const candidate = (await timedQuery(LOAD_CANDIDATE_SQL, [CHAIN, normalized])).rows[0];
    const reason = candidate?.readiness || 'candidate_missing';
    if (reason !== 'ready') {
      return { status: TERMINAL_REASONS.has(reason) ? 'ineligible' : 'deferred', reason };
    }
    const values = [CHAIN, normalized, candidate.first_pool_block,
      candidate.launch_block, candidate.launch_block_time,
      candidate.launch_transaction_hash, candidate.launch_action_index,
      candidate.launch_protocol, candidate.launch_market_key];
    const committed = await timedQuery(COMMIT_CANDIDATE_SQL, values);
    return committed.rowCount === 1
      ? { status: 'materialized' }
      : { status: 'deferred', reason: 'candidate_changed_during_validation' };
  }
  async function complete({ owner, tokenAddress }) {
    return (await database.query(`DELETE FROM robinhood_launch_anchor_outbox
      WHERE chain = '${CHAIN}' AND token_address = $1 AND status = 'leased'
        AND lease_owner = $2`, [token(tokenAddress), owner])).rowCount === 1;
  }
  async function retry({ owner, tokenAddress, retryMs, error }) {
    return (await database.query(`UPDATE robinhood_launch_anchor_outbox SET status = 'pending',
      lease_owner = NULL, lease_until = NULL,
      next_attempt_at = NOW() + ($3::bigint * INTERVAL '1 millisecond'),
      last_error = $4, updated_at = NOW() WHERE chain = '${CHAIN}' AND token_address = $1
      AND status = 'leased' AND lease_owner = $2`,
    [token(tokenAddress), owner, retryMs, String(error).slice(0, 500)])).rowCount === 1;
  }
  return Object.freeze({ claim, materialize, complete, retry });
}

module.exports = {
  createRobinhoodLaunchAnchorOutboxRepository,
  __private: { COMMIT_CANDIDATE_SQL, LOAD_CANDIDATE_SQL, TERMINAL_REASONS },
};
