const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const ANCHOR_BATCH_SIZE = 250;
const LAUNCH_ANCHOR_VERSION = 'rh_launch_anchor_v1';

const FIRST_BUYS_SQL = `WITH wallet_buys AS MATERIALIZED (
  SELECT * FROM robinhood_wallet_token_first_buys
   WHERE chain = $2 AND wallet_address = $1
     AND block_number BETWEEN $3::bigint AND $4::bigint
)
SELECT buy.wallet_address, buy.token_address, buy.volume_usd::text,
       buy.block_number::text AS first_buy_block,
       pool.first_pool_block::text, state.live_through_block::text,
       true AS position_ready,
       (SELECT COUNT(*) + 1 FROM (
          SELECT 1 FROM robinhood_wallet_token_first_buys earlier
           WHERE earlier.chain = buy.chain
             AND earlier.token_address = buy.token_address
             AND ROW(earlier.block_number, earlier.transaction_index,
                     earlier.action_index, earlier.transaction_hash)
               < ROW(buy.block_number, buy.transaction_index,
                     buy.action_index, buy.transaction_hash)
           ORDER BY earlier.block_number, earlier.transaction_index,
                    earlier.action_index, earlier.transaction_hash
           LIMIT 5
        ) preceding)::int AS buyer_rank
  FROM wallet_buys buy
  INNER JOIN robinhood_holder_token_states state
    ON state.chain = buy.chain AND state.token_address = buy.token_address
  INNER JOIN LATERAL (
    SELECT registry.discovery_block AS first_pool_block
      FROM robinhood_pool_registry registry
     WHERE registry.chain = buy.chain
       AND registry.token_address = buy.token_address
     ORDER BY registry.discovery_block
     LIMIT 1
  ) pool ON true
  LEFT JOIN robinhood_token_attributions attribution
    ON attribution.chain = $2 AND attribution.token_address = buy.token_address
 WHERE state.ledger_status = 'live'
   AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
   AND pool.first_pool_block >= $3::bigint
   AND pool.first_pool_block <= state.live_through_block
   AND state.live_through_block <= $4::bigint
   AND buy.block_number BETWEEN pool.first_pool_block AND state.live_through_block
   AND (attribution.creator_address IS NULL
     OR attribution.creator_address <> buy.wallet_address)
   AND NOT EXISTS (
     SELECT 1 FROM robinhood_infrastructure_registry infrastructure
      WHERE infrastructure.chain = $2 AND infrastructure.address = buy.wallet_address
        AND infrastructure.valid_from_block <= buy.block_number
        AND (infrastructure.valid_through_block IS NULL
          OR infrastructure.valid_through_block >= buy.block_number)
   )
   AND NOT EXISTS (
     SELECT 1 FROM robinhood_pool_registry registry
      WHERE registry.chain = buy.chain AND registry.token_address = buy.token_address
        AND registry.discovery_block <= buy.block_number
        AND CASE WHEN registry.protocol = 'uniswap-v4'
          THEN registry.origin_address ELSE registry.pool_address END = buy.wallet_address
   )
   AND NOT EXISTS (
     SELECT 1 FROM robinhood_wallet_swaps swap
      WHERE swap.chain = buy.chain AND swap.token_address = buy.token_address
        AND swap.router_address = buy.wallet_address
        AND swap.block_number <= state.live_through_block
   )
   AND buy.wallet_address NOT IN (
     '0x0000000000000000000000000000000000000000',
     '0x000000000000000000000000000000000000dead'
   )
 ORDER BY buy.wallet_address, buy.token_address`;

const ANCHORS_SQL = `WITH token_frontiers AS MATERIALIZED (
  SELECT * FROM UNNEST($1::varchar[], $2::bigint[], $3::bigint[])
    AS item(token_address, first_pool_block, live_through_block)
)
SELECT token.token_address, anchor.block_number::text AS launch_block,
       anchor.block_time AS launch_block_time
  FROM token_frontiers token
  LEFT JOIN LATERAL (
    SELECT swap.block_number, swap.block_time
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

const CACHED_ANCHORS_SQL = `WITH requested_anchors AS (
  SELECT * FROM UNNEST($1::varchar[], $2::bigint[], $3::bigint[])
    AS item(token_address, first_pool_block, live_through_block)
)
SELECT cache.token_address, cache.launch_block::text
  FROM requested_anchors requested
  INNER JOIN robinhood_token_launch_anchors cache
    ON cache.chain = $4 AND cache.token_address = requested.token_address
   AND cache.first_pool_block = requested.first_pool_block
   AND cache.launch_block <= requested.live_through_block
 ORDER BY cache.token_address`;

const UPSERT_ANCHORS_SQL = `INSERT INTO robinhood_token_launch_anchors (
  chain, token_address, first_pool_block, launch_block, launch_block_time,
  source_through_block, evidence_version
)
SELECT $1, item.token_address, item.first_pool_block,
       item.launch_block, item.launch_block_time, item.source_through_block, $7
  FROM UNNEST(
    $2::varchar[], $3::bigint[], $4::bigint[], $5::timestamptz[], $6::bigint[]
  ) AS item(
    token_address, first_pool_block, launch_block, launch_block_time,
    source_through_block
  )
ON CONFLICT (chain, token_address) DO UPDATE SET
  first_pool_block = EXCLUDED.first_pool_block,
  launch_block = EXCLUDED.launch_block,
  launch_block_time = EXCLUDED.launch_block_time,
  source_through_block = GREATEST(
    robinhood_token_launch_anchors.source_through_block,
    EXCLUDED.source_through_block
  ),
  evidence_version = EXCLUDED.evidence_version,
  anchor_wallet_address = CASE WHEN
    robinhood_token_launch_anchors.first_pool_block = EXCLUDED.first_pool_block
    AND robinhood_token_launch_anchors.launch_block = EXCLUDED.launch_block
    AND robinhood_token_launch_anchors.launch_block_time
      IS NOT DISTINCT FROM EXCLUDED.launch_block_time
    THEN robinhood_token_launch_anchors.anchor_wallet_address END,
  anchor_transaction_hash = CASE WHEN
    robinhood_token_launch_anchors.first_pool_block = EXCLUDED.first_pool_block
    AND robinhood_token_launch_anchors.launch_block = EXCLUDED.launch_block
    AND robinhood_token_launch_anchors.launch_block_time
      IS NOT DISTINCT FROM EXCLUDED.launch_block_time
    THEN robinhood_token_launch_anchors.anchor_transaction_hash END,
  anchor_transaction_index = CASE WHEN
    robinhood_token_launch_anchors.first_pool_block = EXCLUDED.first_pool_block
    AND robinhood_token_launch_anchors.launch_block = EXCLUDED.launch_block
    AND robinhood_token_launch_anchors.launch_block_time
      IS NOT DISTINCT FROM EXCLUDED.launch_block_time
    THEN robinhood_token_launch_anchors.anchor_transaction_index END,
  anchor_action_index = CASE WHEN
    robinhood_token_launch_anchors.first_pool_block = EXCLUDED.first_pool_block
    AND robinhood_token_launch_anchors.launch_block = EXCLUDED.launch_block
    AND robinhood_token_launch_anchors.launch_block_time
      IS NOT DISTINCT FROM EXCLUDED.launch_block_time
    THEN robinhood_token_launch_anchors.anchor_action_index END,
  anchor_block_hash = CASE WHEN
    robinhood_token_launch_anchors.first_pool_block = EXCLUDED.first_pool_block
    AND robinhood_token_launch_anchors.launch_block = EXCLUDED.launch_block
    AND robinhood_token_launch_anchors.launch_block_time
      IS NOT DISTINCT FROM EXCLUDED.launch_block_time
    THEN robinhood_token_launch_anchors.anchor_block_hash END,
  anchor_side = CASE WHEN
    robinhood_token_launch_anchors.first_pool_block = EXCLUDED.first_pool_block
    AND robinhood_token_launch_anchors.launch_block = EXCLUDED.launch_block
    AND robinhood_token_launch_anchors.launch_block_time
      IS NOT DISTINCT FROM EXCLUDED.launch_block_time
    THEN robinhood_token_launch_anchors.anchor_side END,
  anchor_volume_usd = CASE WHEN
    robinhood_token_launch_anchors.first_pool_block = EXCLUDED.first_pool_block
    AND robinhood_token_launch_anchors.launch_block = EXCLUDED.launch_block
    AND robinhood_token_launch_anchors.launch_block_time
      IS NOT DISTINCT FROM EXCLUDED.launch_block_time
    THEN robinhood_token_launch_anchors.anchor_volume_usd END,
  updated_at = NOW()
WHERE robinhood_token_launch_anchors.first_pool_block <> EXCLUDED.first_pool_block
   OR robinhood_token_launch_anchors.launch_block <> EXCLUDED.launch_block
   OR robinhood_token_launch_anchors.launch_block_time
        IS DISTINCT FROM EXCLUDED.launch_block_time
   OR robinhood_token_launch_anchors.source_through_block < EXCLUDED.source_through_block
   OR robinhood_token_launch_anchors.evidence_version <> EXCLUDED.evidence_version`;

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

  async function loadProjectionCoverage(coverage) {
    const completeThroughBlock = block(
      coverage?.completeThroughBlock, 'completeThroughBlock'
    );
    const { rows } = await database.query(
      `SELECT next_time, source_through, source_next_block::text
         FROM robinhood_first_buy_live_cursors WHERE chain = $1`, [CHAIN]
    );
    const cursor = rows[0];
    if (!cursor) return unavailable('first_buy_projection_unavailable');
    if (new Date(cursor.next_time).toISOString()
        !== new Date(cursor.source_through).toISOString()) {
      return unavailable('first_buy_projection_behind');
    }
    if (cursor.source_next_block == null
        || BigInt(cursor.source_next_block) <= BigInt(completeThroughBlock)) {
      return unavailable('first_buy_projection_behind');
    }
    return Object.freeze({ ready: true, completeThroughBlock });
  }

  async function loadAnchors(firstBuys) {
    const tokens = uniqueTokens(firstBuys);
    const anchors = new Map();
    for (let offset = 0; offset < tokens.length; offset += ANCHOR_BATCH_SIZE) {
      const requested = tokens.slice(offset, offset + ANCHOR_BATCH_SIZE);
      const cached = await database.query(CACHED_ANCHORS_SQL, [
        requested.map((row) => row.token_address),
        requested.map((row) => row.first_pool_block),
        requested.map((row) => row.live_through_block),
        CHAIN,
      ]);
      for (const row of cached.rows) anchors.set(row.token_address, row.launch_block);
      const batch = requested.filter(({ token_address: tokenAddress }) => (
        !anchors.has(tokenAddress)
      ));
      if (!batch.length) continue;
      const { rows } = await database.query(ANCHORS_SQL, [
        batch.map((row) => row.token_address),
        batch.map((row) => row.first_pool_block),
        batch.map((row) => row.live_through_block),
        CHAIN,
      ]);
      for (const row of rows) anchors.set(row.token_address, row.launch_block);
      const proven = rows.filter(({ launch_block: launchBlock }) => launchBlock != null);
      if (proven.length) {
        const frontierByToken = new Map(batch.map((row) => [row.token_address, row]));
        await database.query(UPSERT_ANCHORS_SQL, [
          CHAIN,
          proven.map((row) => row.token_address),
          proven.map((row) => frontierByToken.get(row.token_address).first_pool_block),
          proven.map((row) => row.launch_block),
          proven.map((row) => row.launch_block_time),
          proven.map((row) => frontierByToken.get(row.token_address).live_through_block),
          LAUNCH_ANCHOR_VERSION,
        ]);
      }
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
        buyerRank: Number(row.buyer_rank),
        positionReady: row.position_ready === true,
      });
    }));
  }

  async function loadHighConfidenceRecurrence(walletAddresses, coverage) {
    const projection = await loadProjectionCoverage(coverage);
    if (!projection.ready) return projection;
    return Object.freeze({
      ready: true,
      completeThroughBlock: projection.completeThroughBlock,
      rows: await loadPopulationRecurrence(walletAddresses, coverage),
    });
  }

  return Object.freeze({ loadHighConfidenceRecurrence, loadPopulationRecurrence });
}

function unavailable(reason) {
  return Object.freeze({ ready: false, reason });
}

module.exports = {
  createRobinhoodHolderSniperCalibrationSource,
  __private: {
    ANCHORS_SQL, CACHED_ANCHORS_SQL, FIRST_BUYS_SQL, UPSERT_ANCHORS_SQL,
  },
};
