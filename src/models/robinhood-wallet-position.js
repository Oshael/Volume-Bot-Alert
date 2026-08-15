const db = require('./db');
const { createWalletPosition } = require('../services/robinhood-wallet-position-domain');

const CHAIN = 'robinhood';
const STREAMS = new Set(['seed', 'live']);

function identifier(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function address(value, label) {
  const result = String(value ?? '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(result)) throw new Error(`${label} must be a 20-byte address`);
  return result;
}

function uint(value, label) {
  const result = String(value ?? '').trim();
  if (!/^\d+$/.test(result)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(result).toString();
}

function stream(value) {
  const result = String(value ?? '').trim();
  if (!STREAMS.has(result)) throw new Error('stream must be seed or live');
  return result;
}

function timestamp(value, label) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error(`${label} must be a timestamp`);
  return date.toISOString();
}

function checkpoint(input, nextBlock) {
  const block = input.checkpointBlock == null
    ? null : uint(input.checkpointBlock, 'checkpointBlock');
  const hash = input.checkpointHash == null ? null : String(input.checkpointHash).toLowerCase();
  if ((block === null) !== (hash === null)) throw new Error('checkpoint block and hash must pair');
  if (hash !== null && !/^0x[0-9a-f]{64}$/.test(hash)) throw new Error('checkpointHash is invalid');
  if (block !== null && BigInt(block) >= BigInt(nextBlock)) {
    throw new Error('checkpointBlock must precede nextBlock');
  }
  return { block, hash };
}

function cursor(row) {
  return row ? {
    projectionVersion: row.projection_version, stream: row.stream,
    nextBlock: String(row.next_block), safeHead: row.safe_head == null ? null : String(row.safe_head),
    nextBlockTime: row.next_block_time ? new Date(row.next_block_time).toISOString() : null,
    checkpointBlock: row.checkpoint_block == null ? null : String(row.checkpoint_block),
    checkpointHash: row.checkpoint_hash || null, lifecycleState: row.lifecycle_state,
    version: Number(row.version),
  } : null;
}

function positionRow(input, projectionVersion, nextBlock) {
  const state = createWalletPosition(input);
  const throughBlock = uint(input.throughBlock, 'throughBlock');
  if (BigInt(throughBlock) >= BigInt(nextBlock)) throw new Error('throughBlock must precede nextBlock');
  return {
    projection_version: projectionVersion,
    token_address: address(input.tokenAddress, 'tokenAddress'),
    wallet_address: address(input.walletAddress, 'walletAddress'),
    quantity_raw: state.quantityRaw, cost_basis_usd: state.costBasisUsd,
    realized_pnl_usd: state.realizedPnlUsd, buy_volume_usd: state.buyVolumeUsd,
    sell_proceeds_usd: state.sellProceedsUsd,
    buy_mcap_weighted_sum: state.buyMcapWeightedSum,
    buy_mcap_weight_usd: state.buyMcapWeightUsd,
    sell_mcap_weighted_sum: state.sellMcapWeightedSum,
    sell_mcap_weight_usd: state.sellMcapWeightUsd,
    buy_tx_count: String(state.buyTxCount), sell_tx_count: String(state.sellTxCount),
    zero_cost_received_raw: state.zeroCostReceivedRaw,
    zero_cost_sold_raw: state.zeroCostSoldRaw,
    cost_basis_source: state.costBasisSource, quality: state.quality,
    through_block: throughBlock, through_log_index: uint(input.throughLogIndex, 'throughLogIndex'),
  };
}

function createRobinhoodWalletPositionRepository(options = {}) {
  const database = options.database || db;

  async function loadCursor(projectionVersion, streamName) {
    const result = await database.query(
      `SELECT * FROM robinhood_wallet_position_cursors
       WHERE chain = $1 AND projection_version = $2 AND stream = $3`,
      [CHAIN, identifier(projectionVersion, 'projectionVersion'), stream(streamName)]
    );
    return cursor(result.rows[0]);
  }

  async function initCursor(input = {}) {
    const version = identifier(input.projectionVersion, 'projectionVersion');
    const streamName = stream(input.stream);
    await database.query(
      `INSERT INTO robinhood_wallet_position_cursors (
         chain, projection_version, stream, next_block, safe_head, next_block_time
       ) VALUES ($1, $2, $3, $4::bigint, $5::bigint, $6::timestamptz)
       ON CONFLICT (chain, projection_version, stream) DO NOTHING`,
      [CHAIN, version, streamName, uint(input.nextBlock, 'nextBlock'),
        input.safeHead == null ? null : uint(input.safeHead, 'safeHead'),
        timestamp(input.nextBlockTime, 'nextBlockTime')]
    );
    return loadCursor(version, streamName);
  }

  async function loadPositions(projectionVersion, pairs = []) {
    if (pairs.length === 0) return [];
    const payload = pairs.map((pair) => ({
      token_address: address(pair.tokenAddress, 'tokenAddress'),
      wallet_address: address(pair.walletAddress, 'walletAddress'),
    }));
    const result = await database.query(
      `SELECT position.* FROM robinhood_wallet_token_positions position
       JOIN jsonb_to_recordset($3::jsonb) AS item(token_address text, wallet_address text)
         ON item.token_address = position.token_address
        AND item.wallet_address = position.wallet_address
       WHERE position.chain = $1 AND position.projection_version = $2`,
      [CHAIN, identifier(projectionVersion, 'projectionVersion'), JSON.stringify(payload)]
    );
    return result.rows.map((row) => ({
      tokenAddress: row.token_address, walletAddress: row.wallet_address,
      quantityRaw: String(row.quantity_raw), costBasisUsd: String(row.cost_basis_usd),
      realizedPnlUsd: String(row.realized_pnl_usd), buyVolumeUsd: String(row.buy_volume_usd),
      sellProceedsUsd: String(row.sell_proceeds_usd),
      buyMcapWeightedSum: String(row.buy_mcap_weighted_sum),
      buyMcapWeightUsd: String(row.buy_mcap_weight_usd),
      sellMcapWeightedSum: String(row.sell_mcap_weighted_sum),
      sellMcapWeightUsd: String(row.sell_mcap_weight_usd),
      buyTxCount: Number(row.buy_tx_count), sellTxCount: Number(row.sell_tx_count),
      zeroCostReceivedRaw: String(row.zero_cost_received_raw),
      zeroCostSoldRaw: String(row.zero_cost_sold_raw),
      costBasisSource: row.cost_basis_source, quality: row.quality,
      throughBlock: String(row.through_block), throughLogIndex: String(row.through_log_index),
    }));
  }

  async function readSwapBatch(input = {}) {
    const fromBlock = uint(input.fromBlock, 'fromBlock');
    const toBlock = uint(input.toBlock, 'toBlock');
    const fromTime = timestamp(input.fromTime, 'fromTime');
    const maxBlocks = Math.max(1, Math.min(Number(input.maxBlocks) || 50, 500));
    if (!fromTime) throw new Error('fromTime is required for partition pruning');
    const blocks = await database.query(
      `SELECT DISTINCT block_time, block_number
       FROM robinhood_wallet_swaps
       WHERE chain = $1 AND block_time >= $2::timestamptz
         AND block_number >= $3::bigint AND block_number <= $4::bigint
       ORDER BY block_time, block_number LIMIT $5::int`,
      [CHAIN, fromTime, fromBlock, toBlock, maxBlocks]
    );
    if (blocks.rows.length === 0) return {
      swaps: [],
      nextBlock: (BigInt(toBlock) + 1n).toString(),
      nextBlockTime: timestamp(input.emptyNextBlockTime, 'emptyNextBlockTime') || fromTime,
    };
    const blockNumbers = blocks.rows.map((row) => String(row.block_number));
    const last = blocks.rows[blocks.rows.length - 1];
    const swaps = await database.query(
      `SELECT swap.wallet_address, swap.transaction_hash, swap.action_index,
              swap.block_number, swap.block_time, swap.token_address, swap.side,
              swap.token_amount_raw, swap.volume_usd, mc.fdv_usd AS market_cap_usd
       FROM robinhood_wallet_swaps swap
       LEFT JOIN robinhood_swap_mc mc ON mc.chain = swap.chain
        AND mc.transaction_hash = swap.transaction_hash AND mc.log_index = swap.action_index
       WHERE swap.chain = $1 AND swap.block_time >= $2::timestamptz
         AND swap.block_time <= $3::timestamptz
         AND swap.block_number = ANY($4::bigint[])
       ORDER BY swap.block_time, swap.block_number, swap.action_index, swap.transaction_hash`,
      [CHAIN, fromTime, last.block_time, blockNumbers]
    );
    return {
      swaps: swaps.rows,
      nextBlock: (BigInt(last.block_number) + 1n).toString(),
      nextBlockTime: new Date(last.block_time).toISOString(),
    };
  }

  async function readUnifiedRangeSwaps(input = {}) {
    const fromBlock = uint(input.fromBlock, 'fromBlock');
    const toBlock = uint(input.toBlock, 'toBlock');
    if (BigInt(fromBlock) > BigInt(toBlock)) throw new Error('swap block range is inverted');
    const fromTime = timestamp(input.fromTime, 'fromTime');
    const toTime = timestamp(input.toTime, 'toTime');
    if (!fromTime || !toTime) throw new Error('swap range times are required');
    if (fromTime > toTime) throw new Error('swap time range is inverted');
    if (!Array.isArray(input.tokenAddresses)) throw new TypeError('tokenAddresses must be a list');
    const tokenAddresses = [...new Set(input.tokenAddresses.map((item) => (
      address(item, 'tokenAddress')
    )))];
    if (!tokenAddresses.length) return [];
    const result = await database.query(
      `SELECT swap.wallet_address, swap.transaction_hash, swap.action_index,
              swap.block_number, swap.block_time, swap.token_address, swap.side,
              swap.token_amount_raw, swap.volume_usd, mc.fdv_usd AS market_cap_usd
       FROM robinhood_wallet_swaps swap
       LEFT JOIN robinhood_swap_mc mc ON mc.chain = swap.chain
        AND mc.transaction_hash = swap.transaction_hash AND mc.log_index = swap.action_index
       WHERE swap.chain = $1
         AND swap.block_time >= $2::timestamptz AND swap.block_time <= $3::timestamptz
         AND swap.block_number >= $4::bigint AND swap.block_number <= $5::bigint
         AND swap.token_address = ANY($6::varchar[])
       ORDER BY swap.block_number, swap.action_index, swap.transaction_hash`,
      [CHAIN, fromTime, toTime, fromBlock, toBlock, tokenAddresses]
    );
    return result.rows;
  }

  async function reconcileTouchedPositions(projectionVersion, pairs = [], throughBlock) {
    const frontier = uint(throughBlock, 'throughBlock');
    if (pairs.length === 0) {
      return { checked: 0, aligned: 0, matching: 0, mismatched: 0, unaligned: 0, samples: [] };
    }
    const payload = pairs.map((pair) => ({
      token_address: address(pair.tokenAddress, 'tokenAddress'),
      wallet_address: address(pair.walletAddress, 'walletAddress'),
    }));
    const result = await database.query(
      `SELECT position.token_address, position.wallet_address, position.quantity_raw,
              state.ledger_status, state.live_through_block,
              COALESCE(balance.balance_raw, 0) AS holder_balance_raw
       FROM robinhood_wallet_token_positions position
       JOIN jsonb_to_recordset($3::jsonb) AS item(token_address text, wallet_address text)
         ON item.token_address = position.token_address
        AND item.wallet_address = position.wallet_address
       LEFT JOIN robinhood_holder_token_states state
         ON state.chain = position.chain AND state.token_address = position.token_address
       LEFT JOIN robinhood_holder_balances balance
         ON balance.chain = position.chain AND balance.token_address = position.token_address
        AND balance.wallet_address = position.wallet_address
       WHERE position.chain = $1 AND position.projection_version = $2`,
      [CHAIN, identifier(projectionVersion, 'projectionVersion'), JSON.stringify(payload)]
    );
    const aligned = result.rows.filter((row) => (
      row.ledger_status === 'live'
      && row.live_through_block != null
      && String(row.live_through_block) === frontier
    ));
    const mismatches = aligned.filter((row) => (
      String(row.quantity_raw) !== String(row.holder_balance_raw)
    ));
    return {
      checked: result.rows.length,
      aligned: aligned.length,
      matching: aligned.length - mismatches.length,
      mismatched: mismatches.length,
      unaligned: result.rows.length - aligned.length,
      samples: mismatches.slice(0, 10).map((row) => ({
        tokenAddress: row.token_address,
        walletAddress: row.wallet_address,
        projectedRaw: String(row.quantity_raw),
        holderRaw: String(row.holder_balance_raw),
      })),
    };
  }

  async function commitBatch(input = {}) {
    const projectionVersion = identifier(input.projectionVersion, 'projectionVersion');
    const streamName = stream(input.stream);
    const nextBlock = uint(input.nextBlock, 'nextBlock');
    const expectedVersion = uint(input.expectedVersion, 'expectedVersion');
    const nextCheckpoint = checkpoint(input, nextBlock);
    const nextBlockTime = timestamp(input.nextBlockTime, 'nextBlockTime');
    const safeHead = input.safeHead == null ? null : uint(input.safeHead, 'safeHead');
    const complete = streamName === 'seed' && safeHead !== null
      && BigInt(nextBlock) > BigInt(safeHead);
    const rows = (input.positions || []).map((item) => (
      positionRow(item, projectionVersion, nextBlock)
    ));
    const identities = new Set(rows.map((row) => `${row.token_address}:${row.wallet_address}`));
    if (identities.size !== rows.length) throw new Error('positions must be unique within a batch');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      if (rows.length > 0) {
        const upsert = await client.query(
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
           ) ON CONFLICT (chain, projection_version, token_address, wallet_address)
           DO UPDATE SET quantity_raw = EXCLUDED.quantity_raw,
             cost_basis_usd = EXCLUDED.cost_basis_usd,
             realized_pnl_usd = EXCLUDED.realized_pnl_usd,
             buy_volume_usd = EXCLUDED.buy_volume_usd,
             sell_proceeds_usd = EXCLUDED.sell_proceeds_usd,
             buy_mcap_weighted_sum = EXCLUDED.buy_mcap_weighted_sum,
             buy_mcap_weight_usd = EXCLUDED.buy_mcap_weight_usd,
             sell_mcap_weighted_sum = EXCLUDED.sell_mcap_weighted_sum,
             sell_mcap_weight_usd = EXCLUDED.sell_mcap_weight_usd,
             buy_tx_count = EXCLUDED.buy_tx_count, sell_tx_count = EXCLUDED.sell_tx_count,
             zero_cost_received_raw = EXCLUDED.zero_cost_received_raw,
             zero_cost_sold_raw = EXCLUDED.zero_cost_sold_raw,
             cost_basis_source = EXCLUDED.cost_basis_source, quality = EXCLUDED.quality,
             through_block = EXCLUDED.through_block,
             through_log_index = EXCLUDED.through_log_index, updated_at = NOW()
           WHERE (robinhood_wallet_token_positions.through_block,
                  robinhood_wallet_token_positions.through_log_index)
             < (EXCLUDED.through_block, EXCLUDED.through_log_index)`,
          [CHAIN, JSON.stringify(rows)]
        );
        if (upsert.rowCount !== rows.length) throw new Error('position frontier regressed');
      }
      const advanced = await client.query(
        `UPDATE robinhood_wallet_position_cursors
         SET next_block = $4::bigint,
             safe_head = CASE WHEN $5::bigint IS NULL THEN safe_head
               ELSE GREATEST(COALESCE(safe_head, $5::bigint), $5::bigint) END,
             checkpoint_block = COALESCE($6::bigint, checkpoint_block),
             checkpoint_hash = COALESCE($7, checkpoint_hash),
             next_block_time = CASE WHEN $9::timestamptz IS NULL THEN next_block_time
               ELSE GREATEST(COALESCE(next_block_time, $9::timestamptz), $9::timestamptz) END,
             lifecycle_state = CASE WHEN $10::boolean THEN 'complete' ELSE 'running' END,
             completed_at = CASE WHEN $10::boolean THEN NOW() ELSE NULL END,
             state_reason = NULL,
             version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2 AND stream = $3
           AND version = $8::bigint AND next_block <= $4::bigint
           AND (safe_head IS NULL OR $5::bigint IS NULL OR safe_head <= $5::bigint)
           AND (checkpoint_block IS NULL OR $6::bigint IS NULL OR checkpoint_block <= $6::bigint)
           AND (next_block_time IS NULL OR $9::timestamptz IS NULL OR next_block_time <= $9::timestamptz)
           AND lifecycle_state IN ('pending', 'running')
         RETURNING *`,
        [CHAIN, projectionVersion, streamName, nextBlock, safeHead,
          nextCheckpoint.block, nextCheckpoint.hash, expectedVersion, nextBlockTime, complete]
      );
      if (!advanced.rows[0]) {
        const error = new Error('projection cursor conflict');
        error.code = 'CURSOR_CONFLICT';
        throw error;
      }
      await client.query('COMMIT');
      return { committed: true, positions: rows.length, cursor: cursor(advanced.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.code === 'CURSOR_CONFLICT') return { committed: false, reason: 'cursor_conflict' };
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    commitBatch, initCursor, loadCursor, loadPositions,
    readSwapBatch, readUnifiedRangeSwaps, reconcileTouchedPositions,
  };
}

module.exports = { createRobinhoodWalletPositionRepository };
