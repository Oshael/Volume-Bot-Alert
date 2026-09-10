'use strict';

const {
  createRobinhoodWalletPositionReorg,
} = require('./robinhood-wallet-position-reorg');

const CHAIN = 'robinhood';

function quantity(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} is invalid`);
  return BigInt(raw).toString();
}

function hash(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function rollbackInput(input = {}) {
  const normalized = {
    generation: quantity(input.generation, 'generation'),
    ancestorBlock: quantity(input.ancestorBlock, 'ancestorBlock'),
    ancestorHash: hash(input.ancestorHash, 'ancestorHash'),
    fromBlock: quantity(input.fromBlock, 'fromBlock'),
    throughBlock: quantity(input.throughBlock, 'throughBlock'),
    checkpointHash: hash(input.checkpointHash, 'checkpointHash'),
  };
  if (BigInt(normalized.fromBlock) !== BigInt(normalized.ancestorBlock) + 1n
      || BigInt(normalized.throughBlock) < BigInt(normalized.fromBlock)) {
    throw new Error('wallet rollback range is inconsistent');
  }
  return normalized;
}

function conflict(message) {
  return Object.assign(new Error(message), { code: 'wallet_recovery_fence_conflict' });
}

async function rewindLiveCursor(client, range, fence) {
  const result = await client.query(
    `SELECT next_block::text, checkpoint_block::text, checkpoint_hash,
            lifecycle_state, version
       FROM robinhood_wallet_swap_cursors
      WHERE chain=$1 AND stream='live' FOR UPDATE`,
    [CHAIN]
  );
  const cursor = result.rows[0];
  if (!cursor || BigInt(cursor.next_block) <= BigInt(range.fromBlock)) return false;
  if (!['pending', 'running'].includes(cursor.lifecycle_state)
      || cursor.checkpoint_block == null || cursor.checkpoint_hash == null
      || BigInt(cursor.checkpoint_block) < BigInt(range.fromBlock)
      || BigInt(cursor.checkpoint_block) > BigInt(range.throughBlock)) {
    throw conflict('wallet live cursor is outside the recoverable branch');
  }
  const checkpoint = await client.query(
    `SELECT 1 FROM robinhood_chain_blocks
      WHERE chain=$1 AND canonical AND block_number=$2::bigint AND block_hash=$3`,
    [CHAIN, cursor.checkpoint_block, cursor.checkpoint_hash]
  );
  if (checkpoint.rowCount !== 1) throw conflict('wallet checkpoint hash is not canonical');
  const rewound = await client.query(
    `UPDATE robinhood_wallet_swap_cursors
        SET next_block=$3::bigint, safe_head=$2::bigint,
            checkpoint_block=$2::bigint, checkpoint_hash=$4,
            checkpoint_timestamp=$5::timestamptz,
            lifecycle_state='running', state_reason=NULL,
            version=version+1, updated_at=NOW()
      WHERE chain=$1 AND stream='live' AND version=$6
        AND next_block=$7::bigint AND checkpoint_block=$8::bigint
        AND checkpoint_hash=$9
      RETURNING next_block`,
    [CHAIN, range.ancestorBlock, range.fromBlock, range.ancestorHash,
      fence.ancestor_timestamp, cursor.version, cursor.next_block,
      cursor.checkpoint_block, cursor.checkpoint_hash]
  );
  if (rewound.rowCount !== 1) throw conflict('wallet live cursor changed during recovery');
  return true;
}

function createRobinhoodWalletReorgRollback(options = {}) {
  const positionReorg = options.positionReorg || createRobinhoodWalletPositionReorg();

  async function rollback(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('wallet rollback requires a transaction client');
    }
    const range = rollbackInput(input);
    const fence = await client.query(
      `SELECT ancestor.block_timestamp AS ancestor_timestamp,
              range_start.block_timestamp AS from_timestamp,
              range_end.block_timestamp AS through_timestamp
         FROM robinhood_chain_capture_cursor capture
         INNER JOIN robinhood_chain_blocks ancestor
           ON ancestor.chain=capture.chain
          AND ancestor.block_number=$3::bigint
          AND ancestor.block_hash=$4
          AND ancestor.canonical
         INNER JOIN robinhood_chain_blocks range_start
           ON range_start.chain=capture.chain AND range_start.canonical
          AND range_start.block_number=$7::bigint
         INNER JOIN robinhood_chain_blocks range_end
           ON range_end.chain=capture.chain AND range_end.canonical
          AND range_end.block_number=$5::bigint
        WHERE capture.chain=$1 AND capture.generation=$2::bigint
          AND capture.recovery_state='recovery_required'
          AND capture.checkpoint_block=$5::bigint
          AND capture.checkpoint_hash=$6`,
      [CHAIN, range.generation, range.ancestorBlock, range.ancestorHash,
        range.throughBlock, range.checkpointHash, range.fromBlock]
    );
    if (fence.rowCount !== 1) throw conflict('wallet rollback lost the canonical fence');

    const cursorRewound = await rewindLiveCursor(client, range, fence.rows[0]);
    const positionRollback = await positionReorg.rollback(client, {
      ...range,
      ancestorTimestamp: fence.rows[0].ancestor_timestamp,
      fromTimestamp: fence.rows[0].from_timestamp,
      throughTimestamp: fence.rows[0].through_timestamp,
    });

    const deleted = await client.query(
      `WITH orphaned_swaps AS MATERIALIZED (
         SELECT observed.transaction_hash, observed.log_index,
                observed.block_number, block.block_timestamp
           FROM robinhood_wallet_swap_realtime_outbox observed
           INNER JOIN robinhood_chain_blocks block
             ON block.chain=observed.chain
            AND block.block_number=observed.block_number
            AND block.block_hash=observed.block_hash
            AND block.canonical
          WHERE observed.chain=$1 AND observed.event_kind='observed'
            AND observed.block_number BETWEEN $2::bigint AND $3::bigint
         UNION
         SELECT outbox.transaction_hash, outbox.log_index,
                outbox.block_number, block.block_timestamp
           FROM robinhood_wallet_swap_outbox outbox
           INNER JOIN robinhood_chain_blocks block
             ON block.chain=outbox.chain AND block.block_number=outbox.block_number
            AND block.block_hash=outbox.block_hash AND block.canonical
          WHERE outbox.chain=$1
            AND outbox.block_number BETWEEN $2::bigint AND $3::bigint
         UNION
         SELECT swap.transaction_hash, swap.action_index,
                swap.block_number, swap.block_time
           FROM robinhood_wallet_swaps swap
           INNER JOIN robinhood_chain_transactions transaction
             ON transaction.chain=swap.chain
            AND transaction.transaction_hash=swap.transaction_hash
           INNER JOIN robinhood_chain_blocks block
             ON block.chain=transaction.chain AND block.block_hash=transaction.block_hash
            AND block.block_number=swap.block_number AND block.canonical
            AND block.block_timestamp=swap.block_time
          WHERE swap.chain=$1
            AND swap.block_number BETWEEN $2::bigint AND $3::bigint
            AND swap.block_time BETWEEN $4::timestamptz AND $5::timestamptz
       ), removed_outbox AS (
         DELETE FROM robinhood_wallet_swap_outbox outbox USING orphaned_swaps orphaned
          WHERE outbox.chain=$1
            AND outbox.transaction_hash=orphaned.transaction_hash
            AND outbox.log_index=orphaned.log_index RETURNING 1
       ), removed_mc AS (
         DELETE FROM robinhood_swap_mc mc USING orphaned_swaps orphaned
          WHERE mc.chain=$1 AND mc.transaction_hash=orphaned.transaction_hash
            AND mc.log_index=orphaned.log_index RETURNING 1
       ), removed_swaps AS (
         DELETE FROM robinhood_wallet_swaps swap USING orphaned_swaps orphaned
          WHERE swap.chain=$1 AND swap.transaction_hash=orphaned.transaction_hash
            AND swap.action_index=orphaned.log_index
            AND swap.block_number=orphaned.block_number
            AND swap.block_time=orphaned.block_timestamp RETURNING 1
       ), removed_positions AS (
         DELETE FROM robinhood_transaction_positions position
         USING robinhood_chain_blocks block
          WHERE position.chain=$1 AND block.chain=position.chain AND block.canonical
            AND block.block_number=position.block_number
            AND block.block_hash=position.block_hash
            AND block.block_number BETWEEN $2::bigint AND $3::bigint RETURNING 1
       )
       SELECT (SELECT COUNT(*)::int FROM orphaned_swaps) AS orphaned_swaps,
              (SELECT COUNT(*)::int FROM removed_outbox) AS deleted_outbox,
              (SELECT COUNT(*)::int FROM removed_mc) AS deleted_swap_mc,
              (SELECT COUNT(*)::int FROM removed_swaps) AS deleted_swaps,
              (SELECT COUNT(*)::int FROM removed_positions) AS deleted_positions`,
      [CHAIN, range.fromBlock, range.throughBlock,
        fence.rows[0].from_timestamp, fence.rows[0].through_timestamp]
    );
    const row = deleted.rows[0] || {};
    return {
      orphanedSwaps: Number(row.orphaned_swaps || 0),
      deletedOutbox: Number(row.deleted_outbox || 0),
      deletedSwapMc: Number(row.deleted_swap_mc || 0),
      deletedSwaps: Number(row.deleted_swaps || 0),
      deletedTransactionPositions: Number(row.deleted_positions || 0),
      cursorRewound,
      positionRollback,
    };
  }

  return Object.freeze({ rollback });
}

module.exports = {
  createRobinhoodWalletReorgRollback,
  __private: { rewindLiveCursor, rollbackInput },
};
