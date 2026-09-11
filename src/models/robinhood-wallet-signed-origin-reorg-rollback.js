'use strict';

const CHAIN = 'robinhood';

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

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(String(value || ''));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function normalizeRange(input = {}) {
  const range = {
    ancestorBlock: quantity(input.ancestorBlock, 'ancestorBlock'),
    ancestorHash: hash(input.ancestorHash, 'ancestorHash'),
    ancestorTimestamp: timestamp(input.ancestorTimestamp, 'ancestorTimestamp'),
    fromBlock: quantity(input.fromBlock, 'fromBlock'),
    throughBlock: quantity(input.throughBlock, 'throughBlock'),
  };
  if (BigInt(range.fromBlock) !== BigInt(range.ancestorBlock) + 1n
      || BigInt(range.throughBlock) < BigInt(range.fromBlock)) {
    throw new Error('signed-origin rollback range is inconsistent');
  }
  return range;
}

function conflict(message) {
  return Object.assign(new Error(message), { code: 'signed_origin_recovery_fence_conflict' });
}

async function loadCursor(client) {
  const result = await client.query(
    `SELECT cursor.*, EXISTS (
       SELECT 1 FROM robinhood_chain_blocks block
        WHERE block.chain=cursor.chain AND block.canonical
          AND block.block_number=cursor.checkpoint_block
          AND block.block_hash=cursor.checkpoint_hash
     ) AS checkpoint_canonical
       FROM robinhood_wallet_signed_origin_cursors cursor
      WHERE cursor.chain=$1 AND cursor.stream='live' FOR UPDATE`, [CHAIN]
  );
  return result.rows[0] || null;
}

async function inspectOrigins(client, range) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS affected,
            COUNT(*) FILTER (WHERE origin.source_stream <> 'live')::int AS immutable,
            COUNT(*) FILTER (WHERE block.block_hash IS NULL)::int AS unanchored
       FROM robinhood_wallet_signed_origins origin
       LEFT JOIN robinhood_chain_blocks block
         ON block.chain=origin.chain AND block.canonical
        AND block.block_number=origin.first_block_number
        AND block.block_hash=origin.first_block_hash
      WHERE origin.chain=$1
        AND origin.first_block_number BETWEEN $2::bigint AND $3::bigint`,
    [CHAIN, range.fromBlock, range.throughBlock]
  );
  return result.rows[0] || { affected: 0, immutable: 0, unanchored: 0 };
}

function assertCursor(cursor, range, origins) {
  const affected = Number(origins.affected || 0);
  if (Number(origins.unanchored || 0)) {
    throw conflict('signed-origin evidence is not anchored to the canonical branch');
  }
  if (!cursor) {
    if (affected) throw conflict('signed-origin evidence exists without a LIVE cursor');
    return false;
  }
  if (BigInt(cursor.next_block) <= BigInt(range.fromBlock)) {
    if (affected) throw conflict('signed-origin evidence is ahead of its LIVE cursor');
    return false;
  }
  if (!['running', 'caught_up'].includes(cursor.lifecycle_state)
      || BigInt(cursor.origin_block) > BigInt(range.ancestorBlock)
      || cursor.checkpoint_block == null || cursor.checkpoint_hash == null
      || BigInt(cursor.checkpoint_block) < BigInt(range.fromBlock)
      || BigInt(cursor.checkpoint_block) > BigInt(range.throughBlock)
      || cursor.checkpoint_canonical !== true) {
    throw conflict('signed-origin LIVE cursor is outside the orphan branch');
  }
  if (Number(origins.immutable || 0)) {
    throw conflict('signed-origin orphan range contains immutable seed evidence');
  }
  return true;
}

async function deleteOrigins(client, range) {
  return client.query(
    `DELETE FROM robinhood_wallet_signed_origins origin
      USING robinhood_chain_blocks block
      WHERE origin.chain=$1 AND origin.source_stream='live'
        AND block.chain=origin.chain AND block.canonical
        AND block.block_number=origin.first_block_number
        AND block.block_hash=origin.first_block_hash
        AND origin.first_block_number BETWEEN $2::bigint AND $3::bigint`,
    [CHAIN, range.fromBlock, range.throughBlock]
  );
}

async function rewindCursor(client, cursor, range) {
  const result = await client.query(
    `UPDATE robinhood_wallet_signed_origin_cursors SET
       next_block=$3::bigint, safe_head=$2::bigint, safe_head_hash=$4,
       checkpoint_block=$2::bigint, checkpoint_hash=$4,
       checkpoint_timestamp=$5::timestamptz, lifecycle_state='running',
       last_error_code=NULL, last_error_message=NULL,
       version=version+1, updated_at=NOW()
     WHERE chain=$1 AND stream='live' AND version=$6
       AND next_block=$7::bigint AND checkpoint_block=$8::bigint AND checkpoint_hash=$9`,
    [CHAIN, range.ancestorBlock, range.fromBlock, range.ancestorHash,
      range.ancestorTimestamp, cursor.version, cursor.next_block,
      cursor.checkpoint_block, cursor.checkpoint_hash]
  );
  if (result.rowCount !== 1) throw conflict('signed-origin LIVE cursor changed during recovery');
}

function createRobinhoodWalletSignedOriginReorgRollback() {
  async function rollback(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('signed-origin rollback requires a transaction client');
    }
    const range = normalizeRange(input);
    const cursor = await loadCursor(client);
    const origins = await inspectOrigins(client, range);
    const cursorRewound = assertCursor(cursor, range, origins);
    if (!cursorRewound) return { deletedOrigins: 0, cursorRewound: false };
    const deleted = await deleteOrigins(client, range);
    await rewindCursor(client, cursor, range);
    return { deletedOrigins: deleted.rowCount || 0, cursorRewound: true };
  }
  return Object.freeze({ rollback });
}

module.exports = {
  createRobinhoodWalletSignedOriginReorgRollback,
  __private: { normalizeRange },
};
