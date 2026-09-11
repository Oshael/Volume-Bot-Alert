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
    throw new Error('liquidity rollback range is inconsistent');
  }
  return range;
}

function conflict(message) {
  return Object.assign(new Error(message), { code: 'liquidity_recovery_fence_conflict' });
}

async function lockAndCollectPools(client, range) {
  await client.query('LOCK TABLE robinhood_pool_liquidity_snapshots IN SHARE ROW EXCLUSIVE MODE');
  await client.query('LOCK TABLE robinhood_pool_liquidity_refresh_queue IN SHARE ROW EXCLUSIVE MODE');
  const result = await client.query(
    `CREATE TEMP TABLE rh_reorg_liquidity_pools ON COMMIT DROP AS
     SELECT snapshot.protocol, snapshot.market_key
       FROM robinhood_pool_liquidity_snapshots snapshot
       INNER JOIN robinhood_chain_blocks block
         ON block.chain=snapshot.chain AND block.canonical
        AND block.block_number=snapshot.snapshot_block_number
        AND block.block_hash=snapshot.snapshot_block_hash
      WHERE snapshot.chain=$1
        AND snapshot.snapshot_block_number BETWEEN $2::bigint AND $3::bigint
     UNION
     SELECT queue.protocol, queue.market_key
       FROM robinhood_pool_liquidity_refresh_queue queue
       INNER JOIN robinhood_chain_blocks block
         ON block.chain=queue.chain AND block.canonical
        AND block.block_number=queue.dirty_through_block
        AND block.block_hash=queue.dirty_through_hash
      WHERE queue.chain=$1
        AND queue.dirty_through_block BETWEEN $2::bigint AND $3::bigint`,
    [CHAIN, range.fromBlock, range.throughBlock]
  );
  await client.query(
    'CREATE UNIQUE INDEX ON rh_reorg_liquidity_pools(protocol, market_key)'
  );
  return result.rowCount || 0;
}

async function rewindCursor(client, range) {
  const result = await client.query(
    `SELECT cursor.*, EXISTS (
       SELECT 1 FROM robinhood_chain_blocks block
        WHERE block.chain=cursor.chain AND block.canonical
          AND block.block_number=cursor.checkpoint_block
          AND block.block_hash=cursor.checkpoint_hash
     ) AS checkpoint_canonical
       FROM robinhood_pool_liquidity_event_cursors cursor
      WHERE cursor.chain=$1 FOR UPDATE`, [CHAIN]
  );
  const cursor = result.rows[0];
  if (!cursor || BigInt(cursor.next_block) <= BigInt(range.fromBlock)) return false;
  if (BigInt(cursor.coverage_start_block) > BigInt(range.fromBlock)
      || cursor.checkpoint_block == null || cursor.checkpoint_hash == null
      || BigInt(cursor.checkpoint_block) < BigInt(range.fromBlock)
      || BigInt(cursor.checkpoint_block) > BigInt(range.throughBlock)
      || cursor.checkpoint_canonical !== true) {
    throw conflict('liquidity cursor is outside the orphan branch');
  }
  const rewound = await client.query(
    `UPDATE robinhood_pool_liquidity_event_cursors SET
       next_block=$3::bigint, safe_head=$2::bigint,
       checkpoint_block=$2::bigint, checkpoint_hash=$4,
       checkpoint_timestamp=$5::timestamptz, version=version+1, updated_at=NOW()
     WHERE chain=$1 AND version=$6 AND next_block=$7::bigint
       AND checkpoint_block=$8::bigint AND checkpoint_hash=$9`,
    [CHAIN, range.ancestorBlock, range.fromBlock, range.ancestorHash,
      range.ancestorTimestamp, cursor.version, cursor.next_block,
      cursor.checkpoint_block, cursor.checkpoint_hash]
  );
  if (rewound.rowCount !== 1) throw conflict('liquidity cursor changed during recovery');
  return true;
}

async function invalidateSnapshots(client, range) {
  return client.query(
    `UPDATE robinhood_pool_liquidity_snapshots snapshot SET
       snapshot_block_number=NULL, snapshot_block_hash=NULL, snapshot_observed_at=NULL,
       liquidity_usd=NULL, liquidity_raw=NULL, liquidity_status=NULL,
       liquidity_confidence=NULL, liquidity_warning=NULL, checked_at=NOW(),
       last_error_code=NULL, last_error_message=NULL, consecutive_failures=0,
       updated_at=NOW()
     FROM rh_reorg_liquidity_pools affected, robinhood_chain_blocks block
     WHERE snapshot.chain=$1 AND snapshot.protocol=affected.protocol
       AND snapshot.market_key=affected.market_key AND block.chain=snapshot.chain
       AND block.canonical AND block.block_number=snapshot.snapshot_block_number
       AND block.block_hash=snapshot.snapshot_block_hash
       AND block.block_number BETWEEN $2::bigint AND $3::bigint`,
    [CHAIN, range.fromBlock, range.throughBlock]
  );
}

async function requeuePools(client, range) {
  return client.query(
    `INSERT INTO robinhood_pool_liquidity_refresh_queue(
       chain, protocol, market_key, dirty_from_block, dirty_through_block,
       dirty_through_hash
     ) SELECT registry.chain, registry.protocol, registry.market_key,
              $2::bigint, $2::bigint, $3
         FROM rh_reorg_liquidity_pools affected
         INNER JOIN robinhood_pool_registry registry
           ON registry.chain=$1 AND registry.active
          AND registry.protocol=affected.protocol AND registry.market_key=affected.market_key
     ON CONFLICT (chain, protocol, market_key) DO UPDATE SET
       dirty_from_block=LEAST(robinhood_pool_liquidity_refresh_queue.dirty_from_block, $2::bigint),
       dirty_through_block=$2::bigint, dirty_through_hash=$3,
       generation=robinhood_pool_liquidity_refresh_queue.generation+1,
       status='pending', attempt_count=0, next_attempt_at=NOW(),
       lease_owner=NULL, lease_until=NULL, last_error=NULL, updated_at=NOW()`,
    [CHAIN, range.ancestorBlock, range.ancestorHash]
  );
}

function createRobinhoodLiquidityReorgRollback() {
  async function rollback(client, input = {}) {
    if (!client || typeof client.query !== 'function') {
      throw new Error('liquidity rollback requires a transaction client');
    }
    const range = normalizeRange(input);
    const affectedPools = await lockAndCollectPools(client, range);
    const cursorRewound = await rewindCursor(client, range);
    const invalidated = await invalidateSnapshots(client, range);
    const queued = await requeuePools(client, range);
    return {
      affectedPools, invalidatedSnapshots: invalidated.rowCount || 0,
      queuedRefreshes: queued.rowCount || 0, cursorRewound,
    };
  }
  return Object.freeze({ rollback });
}

module.exports = { createRobinhoodLiquidityReorgRollback, __private: { normalizeRange } };
