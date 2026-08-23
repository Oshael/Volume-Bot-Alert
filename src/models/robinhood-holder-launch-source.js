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
const BURN_ADDRESSES = Object.freeze([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

function optionalLimit(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new Error('firstBuyLimit must be between 1 and 10000');
  }
  return value;
}

function unavailable(reason, details = {}) {
  return Object.freeze({ ready: false, reason, ...details });
}

function normalizeState(row, tokenAddress) {
  if (!row) return unavailable('holder_state_missing', { tokenAddress });
  if (row.ledger_status !== 'live' || row.live_through_block == null
      || row.live_through_hash == null) {
    return unavailable('holder_frontier_unavailable', { tokenAddress });
  }
  const launchFromBlock = row.first_pool_discovery_block;
  if (launchFromBlock == null) {
    return unavailable('registered_pool_unavailable', { tokenAddress });
  }
  if (BigInt(launchFromBlock) > BigInt(row.live_through_block)) {
    return unavailable('registered_pool_ahead_of_holder_frontier', { tokenAddress });
  }
  return Object.freeze({
    ready: true,
    tokenAddress,
    creatorAddress: row.creator_address || null,
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
    return unavailable('swap_coverage_starts_after_first_pool');
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
  const firstBuyLimit = optionalLimit(options.firstBuyLimit);

  async function loadState(tokenAddress) {
    const { rows } = await database.query(
      `SELECT state.ledger_status, state.live_through_block::text,
              state.live_through_hash, attribution.creator_address,
              pool.first_pool_discovery_block
         FROM robinhood_holder_token_states state
         LEFT JOIN robinhood_token_attributions attribution
           ON attribution.chain = state.chain
          AND attribution.token_address = state.token_address
         LEFT JOIN LATERAL (
           SELECT MIN(discovery_block)::text AS first_pool_discovery_block
             FROM robinhood_pool_registry registry
            WHERE registry.chain = state.chain
              AND registry.token_address = state.token_address
         ) pool ON true
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
      `SELECT buy.wallet_address, buy.transaction_hash, buy.action_index::text,
              buy.transaction_index::text, buy.block_number::text,
              buy.block_hash, buy.block_time, 'buy'::text AS side,
              buy.volume_usd::text
         FROM robinhood_wallet_token_first_buys buy
        WHERE buy.chain = $1 AND buy.token_address = $2
          AND buy.block_number >= $3::bigint
          AND buy.block_number <= $4::bigint
        ORDER BY buy.block_number, buy.transaction_index,
                 buy.action_index, buy.transaction_hash
        LIMIT $5::int`,
      [
        CHAIN, state.tokenAddress, state.launchFromBlock,
        state.frontier.blockNumber, firstBuyLimit,
      ]
    );
    return rows;
  }

  async function loadExclusions(state, firstBuys) {
    const candidates = firstBuys.map(({ walletAddress, blockNumber }) => ({
      wallet_address: walletAddress, block_number: blockNumber,
    }));
    const { rows } = await database.query(
      `WITH candidates AS (
         SELECT item.wallet_address, item.block_number::bigint
           FROM jsonb_to_recordset($5::jsonb) AS item(
             wallet_address text, block_number text
           )
       ) SELECT address, reason FROM (
         SELECT $3::varchar AS address, 'creator'::text AS reason
         UNION ALL
         SELECT CASE WHEN protocol = 'uniswap-v4' THEN origin_address ELSE pool_address END,
                'registered_pool'
           FROM robinhood_pool_registry
          WHERE chain = $1 AND token_address = $2
            AND discovery_block <= $4::bigint
         UNION ALL
         SELECT DISTINCT router_address, 'swap_router'
           FROM robinhood_wallet_swaps
          WHERE chain = $1 AND token_address = $2 AND router_address IS NOT NULL
            AND block_number <= $4::bigint
         UNION ALL
         SELECT registry.address, 'infrastructure_' || registry.kind
           FROM robinhood_infrastructure_registry registry
           INNER JOIN candidates candidate ON candidate.wallet_address = registry.address
          WHERE registry.chain = $1
            AND registry.valid_from_block <= candidate.block_number
            AND (registry.valid_through_block IS NULL
              OR registry.valid_through_block >= candidate.block_number)
       ) exclusions WHERE address IS NOT NULL ORDER BY address, reason`,
      [
        CHAIN, state.tokenAddress, state.creatorAddress,
        state.frontier.blockNumber, JSON.stringify(candidates),
      ]
    );
    const exclusions = new Map(BURN_ADDRESSES.map((address) => [address, 'burn_address']));
    for (const row of rows) exclusions.set(row.address, row.reason);
    return Object.freeze([...exclusions].sort(([left], [right]) => left.localeCompare(right))
      .map(([walletAddress, reason]) => Object.freeze({ walletAddress, reason })));
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
    const exclusions = await loadExclusions(state, firstBuys.records);
    return Object.freeze({
      ready: true, reason: null, tokenAddress,
      frontier: state.frontier, coverage, anchor: anchorResult.anchor,
      window: Object.freeze({ maxBlocks, maxSeconds }),
      firstBuys: firstBuys.records, exclusions,
    });
  }

  return Object.freeze({ loadLaunchEvidence });
}

module.exports = {
  BURN_ADDRESSES,
  createRobinhoodHolderLaunchSource,
  __private: { normalizeState, validateCoverage },
};
