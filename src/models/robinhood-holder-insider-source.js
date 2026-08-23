const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const PROJECTION_VERSION = 'rh_transfer_v1';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

function unavailable(reason, tokenAddress) {
  return Object.freeze({ ready: false, reason, tokenAddress });
}

function normalizeRows(rows, tokenAddress) {
  if (!rows.length) return unavailable('holder_state_missing', tokenAddress);
  const state = rows[0];
  if (state.ledger_status !== 'live' || state.live_through_block == null
      || state.live_through_hash == null) {
    return unavailable('holder_frontier_unavailable', tokenAddress);
  }
  if (!state.creator_address
      || [ZERO_ADDRESS, DEAD_ADDRESS].includes(state.creator_address)) {
    return unavailable('creator_unavailable', tokenAddress);
  }
  if (state.attribution_block != null
      && BigInt(state.attribution_block) > BigInt(state.live_through_block)) {
    return unavailable('creator_frontier_ahead', tokenAddress);
  }
  if (state.replay_id == null) return unavailable('directional_replay_incomplete', tokenAddress);
  if (state.transfer_lifecycle_state !== 'running' || state.transfer_next_block == null
      || BigInt(state.transfer_next_block) <= BigInt(state.live_through_block)) {
    return unavailable('transfer_projection_behind', tokenAddress);
  }
  return Object.freeze({
    ready: true, reason: null, tokenAddress,
    frontier: Object.freeze({
      blockNumber: String(state.live_through_block), blockHash: state.live_through_hash,
    }),
    creator: Object.freeze({
      address: state.creator_address,
      source: state.attribution_source,
      blockNumber: state.attribution_block == null ? null : String(state.attribution_block),
      transactionHash: state.attribution_tx_hash || null,
      factoryAddress: state.attribution_factory_address || null,
    }),
    coverage: Object.freeze({
      projectionVersion: PROJECTION_VERSION,
      replayRunId: String(state.replay_id),
      replayFromBlock: String(state.replay_from_block),
      replayThroughBlock: String(state.replay_through_block),
      transferCompleteThroughBlock: (BigInt(state.transfer_next_block) - 1n).toString(),
    }),
    distributions: Object.freeze(rows.filter((row) => row.wallet_address).map((row) => (
      Object.freeze({
        walletAddress: row.wallet_address,
        blockNumber: String(row.first_wallet_transfer_block),
        logIndex: String(row.first_wallet_transfer_log_index),
        blockTime: new Date(row.first_wallet_transfer_at).toISOString(),
        transactionHash: row.first_wallet_transfer_transaction_hash,
        amountRaw: String(row.first_wallet_transfer_amount_raw),
      })
    ))),
  });
}

function createRobinhoodHolderInsiderSource(options = {}) {
  const database = options.database || db;

  async function loadDirectDistributionEvidence(inputTokenAddress) {
    const tokenAddress = normalizeTokenAddress(CHAIN, inputTokenAddress);
    const { rows } = await database.query(
      `SELECT state.ledger_status, state.live_through_block::text,
              state.live_through_hash, attribution.creator_address,
              attribution.source AS attribution_source,
              attribution.attribution_block::text, attribution.attribution_tx_hash,
              attribution.attribution_factory_address,
              cursor.lifecycle_state AS transfer_lifecycle_state,
              cursor.next_block::text AS transfer_next_block,
              replay.id::text AS replay_id,
              replay.source_from_block::text AS replay_from_block,
              replay.source_through_block::text AS replay_through_block,
              edge.to_wallet AS wallet_address,
              edge.first_wallet_transfer_block::text,
              edge.first_wallet_transfer_log_index::text,
              edge.first_wallet_transfer_at,
              edge.first_wallet_transfer_transaction_hash,
              edge.first_wallet_transfer_amount_raw::text
         FROM robinhood_holder_token_states state
         LEFT JOIN robinhood_token_attributions attribution
           ON attribution.chain = state.chain AND attribution.token_address = state.token_address
         LEFT JOIN robinhood_wallet_transfer_cursors cursor
           ON cursor.chain = state.chain AND cursor.projection_version = $3
          AND cursor.stream = 'live'
         LEFT JOIN LATERAL (
           SELECT run.* FROM robinhood_directional_transfer_replay_runs run
            WHERE run.chain = state.chain AND run.projection_version = $3
              AND run.status = 'completed'
            ORDER BY run.source_through_block DESC, run.id DESC LIMIT 1
         ) replay ON true
         LEFT JOIN LATERAL (
           SELECT direct.* FROM robinhood_wallet_transfer_edges direct
            WHERE direct.chain = state.chain AND direct.classification_version = $3
              AND direct.token_address = state.token_address
              AND direct.from_wallet = attribution.creator_address
              AND direct.to_wallet NOT IN ($4, $5, attribution.creator_address)
              AND direct.first_wallet_transfer_block IS NOT NULL
              AND direct.first_wallet_transfer_amount_raw > 0
              AND direct.first_wallet_transfer_block <= state.live_through_block
              AND NOT EXISTS (
                SELECT 1 FROM robinhood_infrastructure_registry infrastructure
                 WHERE infrastructure.chain = direct.chain
                   AND infrastructure.address = direct.to_wallet
                   AND infrastructure.valid_from_block <= direct.first_wallet_transfer_block
                   AND (infrastructure.valid_through_block IS NULL
                     OR infrastructure.valid_through_block >= direct.first_wallet_transfer_block)
              )
              AND NOT EXISTS (
                SELECT 1 FROM robinhood_pool_registry pool
                 WHERE pool.chain = direct.chain AND pool.token_address = direct.token_address
                   AND pool.discovery_block <= direct.first_wallet_transfer_block
                   AND (pool.pool_address = direct.to_wallet
                     OR (pool.protocol = 'uniswap-v4' AND pool.origin_address = direct.to_wallet))
              )
            ORDER BY direct.first_wallet_transfer_block,
                     direct.first_wallet_transfer_log_index, direct.to_wallet
         ) edge ON true
        WHERE state.chain = $1 AND state.token_address = $2
        ORDER BY edge.first_wallet_transfer_block,
                 edge.first_wallet_transfer_log_index, edge.to_wallet`,
      [CHAIN, tokenAddress, PROJECTION_VERSION, ZERO_ADDRESS, DEAD_ADDRESS]
    );
    return normalizeRows(rows, tokenAddress);
  }

  return Object.freeze({ loadDirectDistributionEvidence });
}

module.exports = {
  createRobinhoodHolderInsiderSource,
  __private: { normalizeRows },
};
