'use strict';

const CHAIN = 'robinhood';
const TRANSACTION_SOURCES = Object.freeze([
  'blockscout_internal', 'rpc_direct', 'rpc_trace', 'launchpad_event',
]);

function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function hash(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function normalizeRange(input = {}) {
  const range = {
    ancestorBlock: quantity(input.ancestorBlock, 'creator rollback ancestorBlock'),
    ancestorHash: hash(input.ancestorHash, 'creator rollback ancestorHash'),
    ancestorTimestamp: new Date(input.ancestorTimestamp),
    fromBlock: quantity(input.fromBlock, 'creator rollback fromBlock'),
    throughBlock: quantity(input.throughBlock, 'creator rollback throughBlock'),
  };
  if (!Number.isFinite(range.ancestorTimestamp.getTime())
      || BigInt(range.fromBlock) !== BigInt(range.ancestorBlock) + 1n
      || BigInt(range.fromBlock) > BigInt(range.throughBlock)) {
    throw new Error('creator rollback range is inconsistent');
  }
  return range;
}

function conflict(message) {
  return Object.assign(new Error(message), { code: 'creator_recovery_fence_conflict' });
}

async function rewindLiveCursor(client, range) {
  const result = await client.query(
    `SELECT next_block::text, safe_head::text, checkpoint_block::text,
            checkpoint_hash, checkpoint_timestamp
       FROM robinhood_direct_creator_cursors
      WHERE chain=$1 AND stream='live' FOR UPDATE`, [CHAIN]
  );
  const cursor = result.rows[0];
  if (!cursor || BigInt(cursor.next_block) <= BigInt(range.fromBlock)) return false;
  if (BigInt(cursor.next_block) > BigInt(range.throughBlock) + 1n
      || cursor.checkpoint_block == null
      || BigInt(cursor.checkpoint_block) + 1n !== BigInt(cursor.next_block)
      || BigInt(cursor.checkpoint_block) < BigInt(range.fromBlock)
      || BigInt(cursor.checkpoint_block) > BigInt(range.throughBlock)) {
    throw conflict('direct creator LIVE cursor is outside the orphan branch');
  }
  const canonical = await client.query(
    `SELECT 1 FROM robinhood_chain_blocks
      WHERE chain=$1 AND canonical AND block_number=$2::bigint AND block_hash=$3`,
    [CHAIN, cursor.checkpoint_block, cursor.checkpoint_hash]
  );
  if (!canonical.rowCount) throw conflict('direct creator LIVE checkpoint is not canonical');
  const rewound = await client.query(
    `UPDATE robinhood_direct_creator_cursors SET
       next_block=$2::bigint, safe_head=$3::bigint,
       checkpoint_block=$3::bigint, checkpoint_hash=$4,
       checkpoint_timestamp=$5::timestamptz, updated_at=NOW()
     WHERE chain=$1 AND stream='live' AND next_block=$6::bigint
       AND checkpoint_block=$7::bigint AND checkpoint_hash=$8`,
    [CHAIN, range.fromBlock, range.ancestorBlock, range.ancestorHash,
      range.ancestorTimestamp.toISOString(), cursor.next_block,
      cursor.checkpoint_block, cursor.checkpoint_hash]
  );
  if (rewound.rowCount !== 1) throw conflict('direct creator LIVE cursor changed during recovery');
  return true;
}

function createRobinhoodCreatorReorgRollback() {
  async function rollback(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('creator rollback requires a transaction client');
    }
    const range = normalizeRange(input);
    await client.query('LOCK TABLE robinhood_token_attributions IN SHARE ROW EXCLUSIVE MODE');
    const cursorRewound = await rewindLiveCursor(client, range);
    const unanchored = await client.query(
      `SELECT COUNT(*)::int AS rows
         FROM robinhood_token_attributions attribution
        WHERE attribution.chain=$1
          AND attribution.source=ANY($4::varchar[])
          AND attribution.attribution_block BETWEEN $2::bigint AND $3::bigint
          AND NOT EXISTS (
            SELECT 1 FROM robinhood_chain_transactions transaction
            INNER JOIN robinhood_chain_blocks block
              ON block.chain=transaction.chain AND block.block_hash=transaction.block_hash
             AND block.canonical
            WHERE transaction.chain=attribution.chain
              AND block.block_number=attribution.attribution_block
              AND transaction.transaction_hash=attribution.attribution_tx_hash
          )`, [CHAIN, range.fromBlock, range.throughBlock, TRANSACTION_SOURCES]
    );
    if (Number(unanchored.rows[0]?.rows || 0)) {
      throw conflict('creator attribution is not anchored to the canonical branch');
    }
    const removed = await client.query(
      `DELETE FROM robinhood_token_attributions
        WHERE chain=$1 AND source<>'blockscout'
          AND attribution_block BETWEEN $2::bigint AND $3::bigint`,
      [CHAIN, range.fromBlock, range.throughBlock]
    );
    return Object.freeze({ deletedAttributions: removed.rowCount || 0, cursorRewound });
  }

  return Object.freeze({ rollback });
}

module.exports = {
  createRobinhoodCreatorReorgRollback,
  __private: { normalizeRange },
};
