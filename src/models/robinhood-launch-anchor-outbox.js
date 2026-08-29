const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const MATERIALIZE_SQL = `WITH target AS MATERIALIZED (
  SELECT state.token_address, state.live_through_block,
         (SELECT MIN(registry.discovery_block)
            FROM robinhood_pool_registry registry
           WHERE registry.chain = state.chain
             AND registry.token_address = state.token_address
             AND registry.discovery_block <= state.live_through_block) AS first_pool_block
    FROM robinhood_holder_token_states state
   WHERE state.chain = $1 AND state.token_address = $2
     AND state.ledger_status = 'live' AND state.live_through_block IS NOT NULL
), anchor AS MATERIALIZED (
  SELECT target.*, swap.block_number AS launch_block, swap.block_time AS launch_block_time
    FROM target
    INNER JOIN LATERAL (
      SELECT source.block_number, source.block_time
        FROM robinhood_wallet_swaps source
        INNER JOIN robinhood_pool_registry registry
          ON registry.chain = source.chain AND registry.protocol = source.protocol
         AND registry.market_key = source.market_key
         AND registry.token_address = source.token_address
         AND registry.discovery_block <= source.block_number
       WHERE source.chain = $1 AND source.token_address = target.token_address
         AND source.block_number BETWEEN target.first_pool_block AND target.live_through_block
       ORDER BY source.block_time, source.block_number, source.action_index,
                source.transaction_hash LIMIT 1
    ) swap ON target.first_pool_block IS NOT NULL
)
INSERT INTO robinhood_token_launch_anchors(
  chain, token_address, first_pool_block, launch_block, launch_block_time,
  source_through_block, evidence_version
) SELECT $1, token_address, first_pool_block, launch_block, launch_block_time,
         live_through_block, 'rh_launch_anchor_v1' FROM anchor
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
    const query = database.queryWithStatementTimeout?.bind(database) || database.query.bind(database);
    return (await query(MATERIALIZE_SQL, [CHAIN, token(tokenAddress)], timeoutMs)).rowCount === 1;
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

module.exports = { createRobinhoodLaunchAnchorOutboxRepository, __private: { MATERIALIZE_SQL } };
