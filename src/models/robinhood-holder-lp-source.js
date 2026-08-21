const db = require('./db');

const CHAIN = 'robinhood';

function tokenAddress(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) {
    throw new Error('tokenAddress must be a 20-byte address');
  }
  return normalized;
}

function normalizeRows(rows) {
  if (!rows.length) {
    return Object.freeze({ ready: false, reason: 'holder_state_missing', pools: Object.freeze([]) });
  }
  const [state] = rows;
  const hasFrontier = state.live_through_block != null && state.live_through_hash != null;
  if (state.ledger_status !== 'live' || !hasFrontier) {
    return Object.freeze({
      ready: false,
      reason: 'holder_frontier_unavailable',
      pools: Object.freeze([]),
    });
  }
  return Object.freeze({
    ready: true,
    tokenAddress: state.token_address,
    frontier: Object.freeze({
      blockNumber: String(state.live_through_block),
      blockHash: state.live_through_hash,
    }),
    pools: Object.freeze(rows.filter((row) => row.wallet_address).map((row) => Object.freeze({
      walletAddress: row.wallet_address,
      poolAddress: row.pool_address,
      poolId: row.pool_id,
      protocol: row.protocol,
      marketKey: row.market_key,
      discoveryBlock: String(row.discovery_block),
      discoveryBlockHash: row.discovery_block_hash,
      discoveryTransactionHash: row.discovery_tx_hash,
      discoveryLogIndex: String(row.discovery_log_index),
    }))),
  });
}

function createRobinhoodHolderLpSource(options = {}) {
  const database = options.database || db;

  async function loadTokenPoolEvidence(inputTokenAddress) {
    const normalizedToken = tokenAddress(inputTokenAddress);
    const result = await database.query(
      `SELECT state.token_address, state.ledger_status,
              state.live_through_block::text, state.live_through_hash,
              CASE WHEN registry.protocol = 'uniswap-v4'
                THEN registry.origin_address ELSE registry.pool_address
              END AS wallet_address,
              registry.pool_address, registry.pool_id,
              registry.protocol, registry.market_key,
              registry.discovery_block::text, registry.discovery_block_hash,
              registry.discovery_tx_hash, registry.discovery_log_index::text
         FROM robinhood_holder_token_states state
         LEFT JOIN robinhood_pool_registry registry
           ON registry.chain = state.chain
          AND registry.token_address = state.token_address
          AND registry.active = true
          AND (
            (registry.protocol IN ('uniswap-v2', 'uniswap-v3')
              AND registry.pool_address IS NOT NULL)
            OR (registry.protocol = 'uniswap-v4' AND registry.origin_address IS NOT NULL)
          )
          AND registry.discovery_block <= state.live_through_block
        WHERE state.chain = $1 AND state.token_address = $2
        ORDER BY wallet_address, registry.protocol, registry.market_key`,
      [CHAIN, normalizedToken]
    );
    return normalizeRows(result.rows);
  }

  return Object.freeze({ loadTokenPoolEvidence });
}

module.exports = {
  createRobinhoodHolderLpSource,
  __private: { normalizeRows, tokenAddress },
};
