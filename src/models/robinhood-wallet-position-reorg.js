'use strict';

const { applyWalletPositionEvent } = require('../services/robinhood-wallet-position-domain');
const {
  buildRobinhoodWalletUnifiedPositionBatch,
} = require('../services/robinhood-wallet-unified-position-batch');

const CHAIN = 'robinhood';
const SWAP_ONLY = 'swap_only_v1';
const UNIFIED = 'unified_transfer_v1';
const SUPPORTED_VERSIONS = Object.freeze([SWAP_ONLY, UNIFIED]);

function pairKey(row) {
  return `${row.token_address}:${row.wallet_address}`;
}

function conflict(message) {
  return Object.assign(new Error(message), { code: 'wallet_position_recovery_fence_conflict' });
}

function normalizePosition(state, projectionVersion) {
  return {
    projection_version: projectionVersion,
    token_address: state.tokenAddress,
    wallet_address: state.walletAddress,
    quantity_raw: state.quantityRaw,
    cost_basis_usd: state.costBasisUsd,
    realized_pnl_usd: state.realizedPnlUsd,
    buy_volume_usd: state.buyVolumeUsd,
    sell_proceeds_usd: state.sellProceedsUsd,
    buy_mcap_weighted_sum: state.buyMcapWeightedSum,
    buy_mcap_weight_usd: state.buyMcapWeightUsd,
    sell_mcap_weighted_sum: state.sellMcapWeightedSum,
    sell_mcap_weight_usd: state.sellMcapWeightUsd,
    buy_tx_count: String(state.buyTxCount),
    sell_tx_count: String(state.sellTxCount),
    zero_cost_received_raw: state.zeroCostReceivedRaw,
    zero_cost_sold_raw: state.zeroCostSoldRaw,
    cost_basis_source: state.costBasisSource,
    quality: state.quality,
    through_block: state.throughBlock,
    through_log_index: state.throughLogIndex,
  };
}

function rebuildSwapOnly(swaps, affected) {
  const positions = new Map();
  const counted = new Set();
  for (const swap of swaps) {
    const key = pairKey(swap);
    if (!affected.has(key)) continue;
    const transactionSide = `${key}:${swap.side}:${swap.transaction_hash}`;
    const state = applyWalletPositionEvent(positions.get(key) || {}, {
      type: swap.side,
      amountRaw: String(swap.token_amount_raw),
      volumeUsd: String(swap.volume_usd),
      marketCapUsd: swap.market_cap_usd == null ? null : String(swap.market_cap_usd),
      newSideTransaction: !counted.has(transactionSide),
    });
    counted.add(transactionSide);
    positions.set(key, {
      ...state,
      tokenAddress: swap.token_address,
      walletAddress: swap.wallet_address,
      throughBlock: String(swap.block_number),
      throughLogIndex: String(swap.action_index),
    });
  }
  return [...positions.values()];
}

async function loadRewoundCursors(client, range) {
  const result = await client.query(
    `SELECT live.projection_version, live.next_block::text,
            live.checkpoint_block::text, live.checkpoint_hash,
            live.lifecycle_state, live.version::text,
            seed.lifecycle_state AS seed_state,
            EXISTS (
              SELECT 1 FROM robinhood_chain_blocks block
               WHERE block.chain=live.chain AND block.canonical
                 AND block.block_number=live.checkpoint_block
                 AND block.block_hash=live.checkpoint_hash
            ) AS checkpoint_canonical
       FROM robinhood_wallet_position_cursors live
       LEFT JOIN robinhood_wallet_position_cursors seed
         ON seed.chain=live.chain AND seed.projection_version=live.projection_version
        AND seed.stream='seed'
      WHERE live.chain=$1 AND live.stream='live'
        AND live.projection_version=ANY($2::varchar[])
        AND live.next_block > $3::bigint
      ORDER BY live.projection_version
      FOR UPDATE OF live`,
    [CHAIN, SUPPORTED_VERSIONS, range.fromBlock]
  );
  for (const cursor of result.rows) {
    if (cursor.seed_state !== 'complete'
        || !['pending', 'running'].includes(cursor.lifecycle_state)
        || cursor.checkpoint_block == null || cursor.checkpoint_hash == null
        || BigInt(cursor.checkpoint_block) < BigInt(range.fromBlock)
        || BigInt(cursor.checkpoint_block) > BigInt(range.throughBlock)
        || cursor.checkpoint_canonical !== true) {
      throw conflict(`${cursor.projection_version} position cursor is outside the orphan branch`);
    }
  }
  return result.rows;
}

async function loadAffectedPairs(client, range, cursor) {
  const result = await client.query(
    `WITH affected AS MATERIALIZED (
       SELECT swap.token_address, swap.wallet_address
         FROM robinhood_wallet_swaps swap
         INNER JOIN robinhood_chain_transactions transaction
           ON transaction.chain=swap.chain
          AND transaction.transaction_hash=swap.transaction_hash
         INNER JOIN robinhood_chain_blocks block
           ON block.chain=transaction.chain AND block.block_hash=transaction.block_hash
          AND block.block_number=swap.block_number AND block.canonical
        WHERE swap.chain=$1 AND swap.block_number BETWEEN $2::bigint AND $3::bigint
          AND swap.block_time BETWEEN $4::timestamptz AND $5::timestamptz
       UNION
       SELECT transfer.token_address, endpoint.wallet_address
         FROM robinhood_token_transfer_events transfer
         CROSS JOIN LATERAL (VALUES (transfer.from_wallet), (transfer.to_wallet))
           endpoint(wallet_address)
         INNER JOIN robinhood_chain_blocks block
           ON block.chain=transfer.chain AND block.block_number=transfer.block_number
          AND block.block_hash=transfer.block_hash AND block.canonical
        WHERE $6::boolean AND transfer.chain=$1
          AND transfer.block_number BETWEEN $2::bigint AND $3::bigint
          AND transfer.block_time BETWEEN $4::timestamptz AND $5::timestamptz
          AND transfer.classification_version='rh_transfer_v1'
          AND transfer.transfer_kind='wallet_transfer'
     ) SELECT position.token_address, position.wallet_address
         FROM robinhood_wallet_token_positions position
         INNER JOIN affected USING (token_address, wallet_address)
        WHERE position.chain=$1 AND position.projection_version=$7
        ORDER BY position.token_address, position.wallet_address`,
    [CHAIN, range.fromBlock, range.throughBlock, range.fromTimestamp,
      range.throughTimestamp, cursor.projection_version === UNIFIED,
      cursor.projection_version]
  );
  return result.rows;
}

async function loadCanonicalLedger(client, range, pairs, includeTransfers) {
  if (!pairs.length) return { swaps: [], transfers: [] };
  const payload = JSON.stringify(pairs);
  const swaps = await client.query(
    `SELECT swap.wallet_address, swap.transaction_hash, swap.action_index,
            position.transaction_index, swap.block_number, swap.block_time,
            swap.token_address, swap.side, swap.token_amount_raw,
            swap.volume_usd, mc.fdv_usd AS market_cap_usd
       FROM robinhood_wallet_swaps swap
       INNER JOIN jsonb_to_recordset($4::jsonb)
         AS item(token_address text, wallet_address text)
         ON item.token_address=swap.token_address AND item.wallet_address=swap.wallet_address
       LEFT JOIN robinhood_swap_mc mc ON mc.chain=swap.chain
        AND mc.transaction_hash=swap.transaction_hash AND mc.log_index=swap.action_index
       LEFT JOIN robinhood_transaction_positions position ON position.chain=swap.chain
        AND position.transaction_hash=swap.transaction_hash
        AND position.block_number=swap.block_number
      WHERE swap.chain=$1 AND swap.block_number <= $2::bigint
        AND swap.block_time <= $3::timestamptz
      ORDER BY swap.block_time, swap.block_number, swap.action_index, swap.transaction_hash`,
    [CHAIN, range.ancestorBlock, range.ancestorTimestamp, payload]
  );
  if (!includeTransfers) return { swaps: swaps.rows, transfers: [] };
  const transfers = await client.query(
    `SELECT DISTINCT transfer.*
       FROM robinhood_token_transfer_events transfer
       INNER JOIN jsonb_to_recordset($4::jsonb)
         AS item(token_address text, wallet_address text)
         ON item.token_address=transfer.token_address
        AND item.wallet_address IN (transfer.from_wallet, transfer.to_wallet)
      WHERE transfer.chain=$1 AND transfer.block_number <= $2::bigint
        AND transfer.block_time <= $3::timestamptz
        AND transfer.classification_version='rh_transfer_v1'
        AND transfer.transfer_kind='wallet_transfer'
      ORDER BY transfer.block_number, transfer.transaction_index, transfer.log_index`,
    [CHAIN, range.ancestorBlock, range.ancestorTimestamp, payload]
  );
  return { swaps: swaps.rows, transfers: transfers.rows };
}

async function replacePositions(client, projectionVersion, pairs, states) {
  if (!pairs.length) return { removed: 0, rebuilt: 0 };
  const removed = await client.query(
    `DELETE FROM robinhood_wallet_token_positions position
      USING jsonb_to_recordset($3::jsonb) AS item(token_address text, wallet_address text)
      WHERE position.chain=$1 AND position.projection_version=$2
        AND position.token_address=item.token_address
        AND position.wallet_address=item.wallet_address`,
    [CHAIN, projectionVersion, JSON.stringify(pairs)]
  );
  const rows = states.map((state) => normalizePosition(state, projectionVersion));
  if (rows.length) await client.query(
    `INSERT INTO robinhood_wallet_token_positions (
       chain, projection_version, token_address, wallet_address, quantity_raw,
       cost_basis_usd, realized_pnl_usd, buy_volume_usd, sell_proceeds_usd,
       buy_mcap_weighted_sum, buy_mcap_weight_usd, sell_mcap_weighted_sum,
       sell_mcap_weight_usd, buy_tx_count, sell_tx_count, zero_cost_received_raw,
       zero_cost_sold_raw, cost_basis_source, quality, through_block, through_log_index
     ) SELECT $1, item.projection_version, item.token_address, item.wallet_address,
       item.quantity_raw::numeric, item.cost_basis_usd::numeric,
       item.realized_pnl_usd::numeric, item.buy_volume_usd::numeric,
       item.sell_proceeds_usd::numeric, item.buy_mcap_weighted_sum::numeric,
       item.buy_mcap_weight_usd::numeric, item.sell_mcap_weighted_sum::numeric,
       item.sell_mcap_weight_usd::numeric, item.buy_tx_count::bigint,
       item.sell_tx_count::bigint, item.zero_cost_received_raw::numeric,
       item.zero_cost_sold_raw::numeric, item.cost_basis_source, item.quality,
       item.through_block::bigint, item.through_log_index::bigint
       FROM jsonb_to_recordset($2::jsonb) AS item(
         projection_version text, token_address text, wallet_address text,
         quantity_raw text, cost_basis_usd text, realized_pnl_usd text,
         buy_volume_usd text, sell_proceeds_usd text, buy_mcap_weighted_sum text,
         buy_mcap_weight_usd text, sell_mcap_weighted_sum text,
         sell_mcap_weight_usd text, buy_tx_count text, sell_tx_count text,
         zero_cost_received_raw text, zero_cost_sold_raw text,
         cost_basis_source text, quality text, through_block text, through_log_index text
       )`,
    [CHAIN, JSON.stringify(rows)]
  );
  return { removed: removed.rowCount, rebuilt: rows.length };
}

async function rewindCursor(client, range, cursor) {
  const result = await client.query(
    `UPDATE robinhood_wallet_position_cursors SET
       next_block=$3::bigint, safe_head=$2::bigint,
       checkpoint_block=$2::bigint, checkpoint_hash=$4,
       next_block_time=$5::timestamptz, lifecycle_state='running',
       state_reason=NULL, completed_at=NULL, version=version+1, updated_at=NOW()
     WHERE chain=$1 AND projection_version=$6 AND stream='live'
       AND version=$7::bigint AND next_block=$8::bigint
       AND checkpoint_block=$9::bigint AND checkpoint_hash=$10`,
    [CHAIN, range.ancestorBlock, range.fromBlock, range.ancestorHash,
      range.ancestorTimestamp, cursor.projection_version, cursor.version,
      cursor.next_block, cursor.checkpoint_block, cursor.checkpoint_hash]
  );
  if (result.rowCount !== 1) throw conflict('position cursor changed during recovery');
}

function createRobinhoodWalletPositionReorg() {
  async function rollback(client, range) {
    const cursors = await loadRewoundCursors(client, range);
    const summary = {
      projections: cursors.length, affectedPositions: 0,
      removedPositions: 0, rebuiltPositions: 0, cursorsRewound: 0,
    };
    for (const cursor of cursors) {
      const pairs = await loadAffectedPairs(client, range, cursor);
      const affected = new Set(pairs.map(pairKey));
      const unified = cursor.projection_version === UNIFIED;
      const ledger = await loadCanonicalLedger(client, range, pairs, unified);
      const states = unified
        ? buildRobinhoodWalletUnifiedPositionBatch(ledger).positions
          .filter((position) => affected.has(`${position.tokenAddress}:${position.walletAddress}`))
        : rebuildSwapOnly(ledger.swaps, affected);
      const replaced = await replacePositions(client, cursor.projection_version, pairs, states);
      await rewindCursor(client, range, cursor);
      summary.affectedPositions += pairs.length;
      summary.removedPositions += replaced.removed;
      summary.rebuiltPositions += replaced.rebuilt;
      summary.cursorsRewound += 1;
    }
    return summary;
  }
  return Object.freeze({ rollback });
}

module.exports = {
  SUPPORTED_VERSIONS,
  createRobinhoodWalletPositionReorg,
  __private: { rebuildSwapOnly },
};
