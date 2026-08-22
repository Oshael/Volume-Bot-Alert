const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const ANCHOR_BATCH_SIZE = 250;

const FIRST_BUYS_SQL = `WITH pool_origins AS MATERIALIZED (
  SELECT token_address, MIN(discovery_block) AS first_pool_block
    FROM robinhood_pool_registry WHERE chain = $2 GROUP BY token_address
), eligible_tokens AS MATERIALIZED (
  SELECT state.token_address, state.live_through_block, pool.first_pool_block
    FROM robinhood_holder_token_states state
    INNER JOIN pool_origins pool ON pool.token_address = state.token_address
   WHERE state.chain = $2 AND state.ledger_status = 'live'
     AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
     AND pool.first_pool_block >= $3::bigint
     AND pool.first_pool_block <= state.live_through_block
     AND state.live_through_block <= $4::bigint
), candidate_buy_blocks AS MATERIALIZED (
  SELECT swap.wallet_address, swap.token_address,
         MIN(swap.block_number) AS first_buy_block
    FROM robinhood_wallet_swaps swap
    INNER JOIN eligible_tokens token ON token.token_address = swap.token_address
    INNER JOIN robinhood_pool_registry registry
      ON registry.chain = swap.chain AND registry.protocol = swap.protocol
     AND registry.market_key = swap.market_key
     AND registry.token_address = swap.token_address
     AND registry.discovery_block <= swap.block_number
   WHERE swap.chain = $2 AND swap.wallet_address = $1 AND swap.side = 'buy'
     AND swap.block_number BETWEEN token.first_pool_block AND token.live_through_block
   GROUP BY swap.wallet_address, swap.token_address
), ranked_first_buys AS MATERIALIZED (
  SELECT swap.wallet_address, swap.token_address, swap.volume_usd::text,
         swap.block_number, position.transaction_index,
         ROW_NUMBER() OVER (
           PARTITION BY swap.wallet_address, swap.token_address
           ORDER BY position.transaction_index NULLS LAST,
                    swap.action_index, swap.transaction_hash
         ) AS canonical_rank,
         BOOL_AND(position.transaction_index IS NOT NULL
           AND position.block_hash IS NOT NULL) OVER (
             PARTITION BY swap.wallet_address, swap.token_address
         ) AS position_ready
    FROM robinhood_wallet_swaps swap
    INNER JOIN candidate_buy_blocks first
      ON first.wallet_address = swap.wallet_address
     AND first.token_address = swap.token_address
     AND first.first_buy_block = swap.block_number
    INNER JOIN robinhood_pool_registry registry
      ON registry.chain = swap.chain AND registry.protocol = swap.protocol
     AND registry.market_key = swap.market_key
     AND registry.token_address = swap.token_address
     AND registry.discovery_block <= swap.block_number
    LEFT JOIN robinhood_transaction_positions position
      ON position.chain = swap.chain
     AND position.transaction_hash = swap.transaction_hash
     AND position.block_number = swap.block_number
   WHERE swap.chain = $2 AND swap.side = 'buy'
)
SELECT buy.wallet_address, buy.token_address, buy.volume_usd,
       buy.block_number::text AS first_buy_block,
       token.first_pool_block::text, token.live_through_block::text,
       buy.position_ready
  FROM ranked_first_buys buy
  INNER JOIN eligible_tokens token ON token.token_address = buy.token_address
  LEFT JOIN robinhood_token_attributions attribution
    ON attribution.chain = $2 AND attribution.token_address = buy.token_address
 WHERE buy.canonical_rank = 1
   AND (attribution.creator_address IS NULL
     OR attribution.creator_address <> buy.wallet_address)
   AND NOT EXISTS (
     SELECT 1 FROM robinhood_infrastructure_registry infrastructure
      WHERE infrastructure.chain = $2 AND infrastructure.address = buy.wallet_address
        AND infrastructure.valid_from_block <= buy.block_number
        AND (infrastructure.valid_through_block IS NULL
          OR infrastructure.valid_through_block >= buy.block_number)
   )
 ORDER BY buy.wallet_address, buy.token_address`;

const ANCHORS_SQL = `WITH token_frontiers AS MATERIALIZED (
  SELECT * FROM UNNEST($1::varchar[], $2::bigint[], $3::bigint[])
    AS item(token_address, first_pool_block, live_through_block)
)
SELECT token.token_address, anchor.block_number::text AS launch_block
  FROM token_frontiers token
  LEFT JOIN LATERAL (
    SELECT swap.block_number
      FROM robinhood_wallet_swaps swap
      INNER JOIN robinhood_pool_registry registry
        ON registry.chain = swap.chain AND registry.protocol = swap.protocol
       AND registry.market_key = swap.market_key
       AND registry.token_address = swap.token_address
       AND registry.discovery_block <= swap.block_number
     WHERE swap.chain = $4 AND swap.token_address = token.token_address
       AND swap.block_number BETWEEN token.first_pool_block AND token.live_through_block
     ORDER BY swap.block_time, swap.block_number, swap.action_index, swap.transaction_hash
     LIMIT 1
  ) anchor ON true
 ORDER BY token.token_address`;

function block(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a block number`);
  return BigInt(normalized).toString();
}

function uniqueTokens(rows) {
  const tokens = new Map();
  for (const row of rows) {
    if (!tokens.has(row.token_address)) tokens.set(row.token_address, row);
  }
  return [...tokens.values()];
}

function createRobinhoodHolderSniperCalibrationSource(options = {}) {
  const database = options.database || db;

  async function loadAnchors(firstBuys) {
    const tokens = uniqueTokens(firstBuys);
    const anchors = new Map();
    for (let offset = 0; offset < tokens.length; offset += ANCHOR_BATCH_SIZE) {
      const batch = tokens.slice(offset, offset + ANCHOR_BATCH_SIZE);
      const { rows } = await database.query(ANCHORS_SQL, [
        batch.map((row) => row.token_address),
        batch.map((row) => row.first_pool_block),
        batch.map((row) => row.live_through_block),
        CHAIN,
      ]);
      for (const row of rows) anchors.set(row.token_address, row.launch_block);
    }
    return anchors;
  }

  async function loadPopulationRecurrence(walletAddresses, coverage) {
    const wallets = [...new Set((walletAddresses || []).map((address) => (
      normalizeTokenAddress(CHAIN, address)
    )))].sort();
    if (!wallets.length) return Object.freeze([]);
    const fromBlock = block(coverage?.historicalFromBlock, 'historicalFromBlock');
    const throughBlock = block(coverage?.completeThroughBlock, 'completeThroughBlock');
    const firstBuys = [];
    for (const wallet of wallets) {
      const { rows } = await database.query(FIRST_BUYS_SQL, [
        wallet, CHAIN, fromBlock, throughBlock,
      ]);
      firstBuys.push(...rows);
    }
    const anchors = await loadAnchors(firstBuys);
    return Object.freeze(firstBuys.map((row) => {
      const launchBlock = anchors.get(row.token_address);
      const anchorReady = launchBlock != null;
      const deltaBlocks = anchorReady
        ? BigInt(row.first_buy_block) - BigInt(launchBlock) : null;
      return Object.freeze({
        walletAddress: row.wallet_address,
        tokenAddress: row.token_address,
        volumeUsd: row.volume_usd,
        deltaBlocks: deltaBlocks?.toString() || null,
        anchorReady,
        withinOneBlock: anchorReady && deltaBlocks >= 0n && deltaBlocks <= 1n,
        positionReady: row.position_ready === true,
      });
    }));
  }

  return Object.freeze({ loadPopulationRecurrence });
}

module.exports = {
  createRobinhoodHolderSniperCalibrationSource,
  __private: { ANCHORS_SQL, FIRST_BUYS_SQL },
};
