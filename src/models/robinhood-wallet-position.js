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
         chain, projection_version, stream, next_block, safe_head
       ) VALUES ($1, $2, $3, $4::bigint, $5::bigint)
       ON CONFLICT (chain, projection_version, stream) DO NOTHING`,
      [CHAIN, version, streamName, uint(input.nextBlock, 'nextBlock'),
        input.safeHead == null ? null : uint(input.safeHead, 'safeHead')]
    );
    return loadCursor(version, streamName);
  }

  async function commitBatch(input = {}) {
    const projectionVersion = identifier(input.projectionVersion, 'projectionVersion');
    const streamName = stream(input.stream);
    const nextBlock = uint(input.nextBlock, 'nextBlock');
    const expectedVersion = uint(input.expectedVersion, 'expectedVersion');
    const nextCheckpoint = checkpoint(input, nextBlock);
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
             lifecycle_state = 'running', state_reason = NULL,
             version = version + 1, updated_at = NOW()
         WHERE chain = $1 AND projection_version = $2 AND stream = $3
           AND version = $8::bigint AND next_block <= $4::bigint
           AND (safe_head IS NULL OR $5::bigint IS NULL OR safe_head <= $5::bigint)
           AND (checkpoint_block IS NULL OR $6::bigint IS NULL OR checkpoint_block <= $6::bigint)
         RETURNING *`,
        [CHAIN, projectionVersion, streamName, nextBlock,
          input.safeHead == null ? null : uint(input.safeHead, 'safeHead'),
          nextCheckpoint.block, nextCheckpoint.hash, expectedVersion]
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

  return { commitBatch, initCursor, loadCursor };
}

module.exports = { createRobinhoodWalletPositionRepository };
