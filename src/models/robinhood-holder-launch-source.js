const db = require('./db');
const {
  createRobinhoodWalletTransferLiveSourceRepository,
} = require('./robinhood-wallet-transfer-live-source');
const {
  deriveFirstBuyEvidence,
  deriveLaunchAnchor,
} = require('../services/robinhood-holder-launch-domain');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const DEFAULT_MAX_BLOCKS = 3;
const DEFAULT_MAX_SECONDS = 90;

function unavailable(reason, details = {}) {
  return Object.freeze({ ready: false, reason, ...details });
}

function normalizeState(row, tokenAddress) {
  if (!row) return unavailable('holder_state_missing', { tokenAddress });
  if (row.ledger_status !== 'live' || row.live_through_block == null
      || row.live_through_hash == null) {
    return unavailable('holder_frontier_unavailable', { tokenAddress });
  }
  const launchFromBlock = row.deployment_block ?? row.attribution_block;
  if (launchFromBlock == null) {
    return unavailable('token_launch_block_unavailable', { tokenAddress });
  }
  if (BigInt(launchFromBlock) > BigInt(row.live_through_block)) {
    return unavailable('token_launch_ahead_of_holder_frontier', { tokenAddress });
  }
  return Object.freeze({
    ready: true,
    tokenAddress,
    launchFromBlock: String(launchFromBlock),
    frontier: Object.freeze({
      blockNumber: String(row.live_through_block),
      blockHash: row.live_through_hash,
    }),
  });
}

function validateCoverage(state, coverage) {
  if (!coverage?.ready) {
    return unavailable(coverage?.reason || 'swap_coverage_unavailable');
  }
  if (BigInt(coverage.historicalFromBlock) > BigInt(state.launchFromBlock)) {
    return unavailable('swap_coverage_starts_after_token_launch');
  }
  if (BigInt(coverage.completeThroughBlock) < BigInt(state.frontier.blockNumber)) {
    return unavailable('swap_coverage_behind_holder_frontier');
  }
  return Object.freeze({
    ready: true,
    historicalFromBlock: coverage.historicalFromBlock,
    completeThroughBlock: coverage.completeThroughBlock,
  });
}

function missingPosition(rows) {
  return rows.some((row) => row.transaction_index == null || row.block_hash == null);
}

function createRobinhoodHolderLaunchSource(options = {}) {
  const database = options.database || db;
  const coverageSource = options.coverageSource
    || createRobinhoodWalletTransferLiveSourceRepository({ database });
  const maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
  const maxSeconds = options.maxSeconds ?? DEFAULT_MAX_SECONDS;

  async function loadState(tokenAddress) {
    const { rows } = await database.query(
      `SELECT state.ledger_status, state.deployment_block::text,
              state.live_through_block::text, state.live_through_hash,
              attribution.attribution_block::text
         FROM robinhood_holder_token_states state
         LEFT JOIN robinhood_token_attributions attribution
           ON attribution.chain = state.chain
          AND attribution.token_address = state.token_address
        WHERE state.chain = $1 AND state.token_address = $2`,
      [CHAIN, tokenAddress]
    );
    return normalizeState(rows[0], tokenAddress);
  }

  async function loadLaunchRows(state) {
    const { rows } = await database.query(
      `WITH registered_swaps AS MATERIALIZED (
         SELECT swap.*
           FROM robinhood_wallet_swaps swap
           INNER JOIN robinhood_pool_registry registry
             ON registry.chain = swap.chain
            AND registry.protocol = swap.protocol
            AND registry.market_key = swap.market_key
            AND registry.token_address = swap.token_address
            AND registry.discovery_block <= swap.block_number
          WHERE swap.chain = $1 AND swap.token_address = $2
            AND swap.block_number >= $3::bigint
            AND swap.block_number <= $4::bigint
       ), launch_block AS (
         SELECT MIN(block_number) AS block_number FROM registered_swaps
       )
       SELECT swap.wallet_address, swap.transaction_hash,
              swap.action_index::text, position.transaction_index::text,
              swap.block_number::text, position.block_hash, swap.block_time,
              swap.side, swap.volume_usd::text
         FROM registered_swaps swap
         INNER JOIN launch_block launch ON launch.block_number = swap.block_number
         LEFT JOIN robinhood_transaction_positions position
           ON position.chain = swap.chain
          AND position.transaction_hash = swap.transaction_hash
          AND position.block_number = swap.block_number
        ORDER BY swap.action_index, swap.transaction_hash`,
      [CHAIN, state.tokenAddress, state.launchFromBlock, state.frontier.blockNumber]
    );
    return rows;
  }

  async function loadFirstBuyRows(state) {
    const { rows } = await database.query(
      `WITH registered_buys AS MATERIALIZED (
         SELECT swap.*
           FROM robinhood_wallet_swaps swap
           INNER JOIN robinhood_pool_registry registry
             ON registry.chain = swap.chain
            AND registry.protocol = swap.protocol
            AND registry.market_key = swap.market_key
            AND registry.token_address = swap.token_address
            AND registry.discovery_block <= swap.block_number
          WHERE swap.chain = $1 AND swap.token_address = $2 AND swap.side = 'buy'
            AND swap.block_number >= $3::bigint
            AND swap.block_number <= $4::bigint
       ), first_buy_blocks AS (
         SELECT wallet_address, MIN(block_number) AS block_number
           FROM registered_buys GROUP BY wallet_address
       )
       SELECT buy.wallet_address, buy.transaction_hash, buy.action_index::text,
              position.transaction_index::text, buy.block_number::text,
              position.block_hash, buy.block_time, buy.side, buy.volume_usd::text
         FROM registered_buys buy
         INNER JOIN first_buy_blocks first
           ON first.wallet_address = buy.wallet_address
          AND first.block_number = buy.block_number
         LEFT JOIN robinhood_transaction_positions position
           ON position.chain = buy.chain
          AND position.transaction_hash = buy.transaction_hash
          AND position.block_number = buy.block_number
        ORDER BY buy.wallet_address, buy.action_index, buy.transaction_hash`,
      [CHAIN, state.tokenAddress, state.launchFromBlock, state.frontier.blockNumber]
    );
    return rows;
  }

  async function loadLaunchEvidence(inputTokenAddress) {
    const tokenAddress = normalizeTokenAddress(CHAIN, inputTokenAddress);
    const [state, sourceCoverage] = await Promise.all([
      loadState(tokenAddress), coverageSource.loadBackfillFrontier(),
    ]);
    if (!state.ready) return state;
    const coverage = validateCoverage(state, sourceCoverage);
    if (!coverage.ready) return unavailable(coverage.reason, { tokenAddress });

    const launchRows = await loadLaunchRows(state);
    if (missingPosition(launchRows)) {
      return unavailable('transaction_position_unavailable', { tokenAddress });
    }
    const anchorResult = deriveLaunchAnchor({
      coverageReady: true, frontier: state.frontier, swaps: launchRows,
    });
    if (!anchorResult.ready) return unavailable(anchorResult.reason, { tokenAddress });

    const firstBuyRows = await loadFirstBuyRows(state);
    if (missingPosition(firstBuyRows)) {
      return unavailable('transaction_position_unavailable', { tokenAddress });
    }
    const firstBuys = deriveFirstBuyEvidence({
      anchorResult, swaps: firstBuyRows, maxBlocks, maxSeconds,
    });
    if (!firstBuys.ready) return unavailable(firstBuys.reason, { tokenAddress });
    return Object.freeze({
      ready: true, reason: null, tokenAddress,
      frontier: state.frontier, coverage, anchor: anchorResult.anchor,
      firstBuys: firstBuys.records,
    });
  }

  return Object.freeze({ loadLaunchEvidence });
}

module.exports = {
  createRobinhoodHolderLaunchSource,
  __private: { normalizeState, validateCoverage },
};
