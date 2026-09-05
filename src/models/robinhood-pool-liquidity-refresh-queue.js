'use strict';

const db = require('./db');

const CHAIN = 'robinhood';
const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);

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

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new RangeError(`${label} is invalid`);
  }
  return parsed;
}

function retryError(value) {
  const code = String(value?.code || 'liquidity_refresh_error').trim().slice(0, 64);
  const message = String(value?.message || value || code).trim().slice(0, 500);
  return { code: code || 'liquidity_refresh_error', message };
}

function owner(value) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 160) throw new Error('owner is invalid');
  return normalized;
}

function pool(value, index) {
  const protocol = String(value?.protocol || '').trim().toLowerCase();
  const marketKey = String(value?.marketKey || '').trim().toLowerCase();
  if (!PROTOCOLS.has(protocol) || !marketKey || marketKey.length > 160) {
    throw new Error(`pools[${index}] is invalid`);
  }
  return { protocol, market_key: marketKey };
}

function pools(values) {
  if (!Array.isArray(values) || values.length > 5000) {
    throw new RangeError('pools must contain at most 5000 entries');
  }
  const unique = new Map(values.map((value, index) => {
    const normalized = pool(value, index);
    return [`${normalized.protocol}:${normalized.market_key}`, normalized];
  }));
  return [...unique.values()];
}

function cursorConflict() {
  const error = new Error('liquidity event range is not contiguous');
  error.code = 'liquidity_event_cursor_conflict';
  return error;
}

function createRobinhoodPoolLiquidityRefreshQueue(options = {}) {
  const database = options.database || db;

  async function commitScannedRange(input = {}) {
    const fromBlock = quantity(input.fromBlock, 'fromBlock');
    const nextBlock = quantity(input.nextBlock, 'nextBlock');
    if (BigInt(nextBlock) <= BigInt(fromBlock)) throw new Error('nextBlock must advance');
    const checkpoint = input.checkpoint || {};
    const checkpointBlock = quantity(checkpoint.number, 'checkpoint.number');
    if (BigInt(checkpointBlock) !== BigInt(nextBlock) - 1n) {
      throw new Error('checkpoint must be immediately before nextBlock');
    }
    const checkpointHash = hash(checkpoint.hash, 'checkpoint.hash');
    const safeHead = quantity(input.safeHead, 'safeHead');
    const candidates = pools(input.pools);
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const queued = await client.query(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) item(
             protocol text, market_key text
           )
         ) INSERT INTO robinhood_pool_liquidity_refresh_queue(
           chain, protocol, market_key, dirty_from_block,
           dirty_through_block, dirty_through_hash
         ) SELECT registry.chain, registry.protocol, registry.market_key,
                  $2::bigint, $3::bigint, $4
             FROM input
             JOIN robinhood_pool_registry registry
               ON registry.chain=$5 AND registry.active=TRUE
              AND registry.protocol=input.protocol AND registry.market_key=input.market_key
         ON CONFLICT (chain, protocol, market_key) DO UPDATE SET
           dirty_from_block=LEAST(
             robinhood_pool_liquidity_refresh_queue.dirty_from_block,
             EXCLUDED.dirty_from_block
           ),
           dirty_through_block=EXCLUDED.dirty_through_block,
           dirty_through_hash=EXCLUDED.dirty_through_hash,
           generation=robinhood_pool_liquidity_refresh_queue.generation+1,
           next_attempt_at=CASE
             WHEN robinhood_pool_liquidity_refresh_queue.status='pending' THEN NOW()
             ELSE robinhood_pool_liquidity_refresh_queue.next_attempt_at END,
           last_error=NULL, updated_at=NOW()
         RETURNING generation`,
        [JSON.stringify(candidates), fromBlock, checkpointBlock, checkpointHash, CHAIN]
      );
      const advanced = await client.query(
        `UPDATE robinhood_pool_liquidity_event_cursors
            SET next_block=$3, safe_head=$4, checkpoint_block=$5,
                checkpoint_hash=$6, checkpoint_timestamp=$7,
                version=version+1, updated_at=NOW()
          WHERE chain=$1 AND next_block=$2
          RETURNING next_block`,
        [CHAIN, fromBlock, nextBlock, safeHead, checkpointBlock, checkpointHash,
          input.checkpoint.timestampMs == null ? null : new Date(input.checkpoint.timestampMs)]
      );
      if (advanced.rowCount !== 1) throw cursorConflict();
      await client.query('COMMIT');
      return Object.freeze({ queued: queued.rowCount, nextBlock });
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function claim(input = {}) {
    const limit = positiveInteger(input.limit, 'limit', 500);
    const leaseMs = positiveInteger(input.leaseMs, 'leaseMs', 600_000);
    const leaseOwner = owner(input.owner);
    const { rows } = await database.query(
      `WITH claimable AS (
         SELECT chain, protocol, market_key
           FROM robinhood_pool_liquidity_refresh_queue
          WHERE chain=$1 AND status='pending' AND next_attempt_at<=NOW()
          ORDER BY dirty_from_block, protocol, market_key
          LIMIT $2 FOR UPDATE SKIP LOCKED
       ), leased AS (
         UPDATE robinhood_pool_liquidity_refresh_queue queue
            SET status='leased', lease_owner=$3,
                lease_until=NOW()+($4::bigint*INTERVAL '1 millisecond'),
                attempt_count=attempt_count+1, updated_at=NOW()
           FROM claimable
          WHERE queue.chain=claimable.chain AND queue.protocol=claimable.protocol
            AND queue.market_key=claimable.market_key
         RETURNING queue.*
       ) SELECT leased.*, registry.pool_address, registry.pool_id,
                registry.origin_address, registry.token_address, registry.quote_address,
                registry.currency0, registry.currency1, registry.discovered_at
           FROM leased JOIN robinhood_pool_registry registry
             USING (chain, protocol, market_key)
          ORDER BY leased.dirty_from_block, leased.protocol, leased.market_key`,
      [CHAIN, limit, leaseOwner, leaseMs]
    );
    return rows;
  }

  async function complete(input = {}) {
    const protocol = pool(input, 0).protocol;
    const marketKey = pool(input, 0).market_key;
    const generation = positiveInteger(input.generation, 'generation');
    const leaseOwner = owner(input.owner);
    const { rows } = await database.query(
      `WITH removed AS (
         DELETE FROM robinhood_pool_liquidity_refresh_queue
          WHERE chain=$1 AND protocol=$2 AND market_key=$3
            AND status='leased' AND lease_owner=$4 AND lease_until>NOW()
            AND generation=$5
        RETURNING 1
       ), requeued AS (
         UPDATE robinhood_pool_liquidity_refresh_queue
            SET status='pending', lease_owner=NULL, lease_until=NULL,
                next_attempt_at=NOW(), updated_at=NOW()
          WHERE chain=$1 AND protocol=$2 AND market_key=$3
            AND status='leased' AND lease_owner=$4 AND lease_until>NOW()
            AND generation>$5 AND NOT EXISTS (SELECT 1 FROM removed)
        RETURNING 1
       ) SELECT EXISTS(SELECT 1 FROM removed) AS removed,
                EXISTS(SELECT 1 FROM requeued) AS requeued`,
      [CHAIN, protocol, marketKey, leaseOwner, generation]
    );
    return Object.freeze(rows[0]);
  }

  async function retry(input = {}) {
    const protocol = pool(input, 0).protocol;
    const marketKey = pool(input, 0).market_key;
    const generation = positiveInteger(input.generation, 'generation');
    const leaseOwner = owner(input.owner);
    const retryMs = positiveInteger(input.retryMs, 'retryMs', 86_400_000);
    const result = await database.query(
      `UPDATE robinhood_pool_liquidity_refresh_queue
          SET status='pending', lease_owner=NULL, lease_until=NULL,
              next_attempt_at=CASE WHEN generation>$5 THEN NOW()
                ELSE NOW()+($6::bigint*INTERVAL '1 millisecond') END,
              last_error=$7::jsonb, updated_at=NOW()
        WHERE chain=$1 AND protocol=$2 AND market_key=$3
          AND status='leased' AND lease_owner=$4 AND lease_until>NOW()
          AND generation>=$5`,
      [CHAIN, protocol, marketKey, leaseOwner, generation, retryMs,
        JSON.stringify(retryError(input.error))]
    );
    return result.rowCount === 1;
  }

  async function reclaimExpired() {
    const result = await database.query(
      `UPDATE robinhood_pool_liquidity_refresh_queue
          SET status='pending', lease_owner=NULL, lease_until=NULL, updated_at=NOW()
        WHERE chain=$1 AND status='leased' AND lease_until<=NOW()`, [CHAIN]
    );
    return result.rowCount;
  }

  return Object.freeze({ claim, commitScannedRange, complete, reclaimExpired, retry });
}

module.exports = { createRobinhoodPoolLiquidityRefreshQueue };
