'use strict';
const db = require('./db');
const NOTIFY_CHANNEL = 'robinhood_liquidity_realtime_outbox';
const TABLE = 'robinhood_liquidity_realtime_outbox';
const DEFAULT_MAX_ATTEMPTS = 5;
function positiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be positive`);
  return parsed;
}
function ownerOf(value) {
  const owner = String(value || '').trim();
  if (!owner || owner.length > 128) throw new Error('liquidity realtime owner is required');
  return owner;
}
function idOf(value, label) {
  const id = String(value ?? '').trim();
  if (!/^\d+$/.test(id) || BigInt(id) <= 0n) throw new Error(`${label} must be a positive id`);
  return id;
}
function tokenAddressOf(value) {
  const address = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error('liquidity token address is invalid');
  return address;
}
function timestampOf(value) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) throw new Error('liquidity projection timestamp is invalid');
  return new Date(parsed).toISOString();
}
function createRobinhoodLiquidityRealtimeOutboxRepository(options = {}) {
  const database = options.database || db;
  const defaultMaxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  async function claimOutbox(input = {}) {
    const owner = ownerOf(input.owner);
    const limit = positiveInt(input.limit, 'limit');
    const leaseMs = positiveInt(input.leaseMs, 'leaseMs');
    const result = await database.query(
      `WITH claimable AS (
         SELECT id FROM ${TABLE}
         WHERE status='pending' AND next_attempt_at<=NOW()
         ORDER BY next_attempt_at, id LIMIT $2 FOR UPDATE SKIP LOCKED
       ), leased AS (
         UPDATE ${TABLE} outbox
            SET status='leased', lease_owner=$1,
                lease_until=NOW()+($3::bigint*INTERVAL '1 millisecond'),
                attempt_count=outbox.attempt_count+1, updated_at=NOW()
           FROM claimable WHERE outbox.id=claimable.id
         RETURNING outbox.id, outbox.token_address, outbox.attempt_count,
                   outbox.projection_committed_at
       ), projection AS (
         SELECT leased.id, leased.attempt_count, leased.token_address,
           SUM(snapshot.liquidity_usd) FILTER (WHERE snapshot.liquidity_usd IS NOT NULL)
             AS liquidity_usd,
           COUNT(registry.market_key)::int AS market_count,
           COUNT(snapshot.liquidity_usd)::int AS valued_count,
           COALESCE(MAX(snapshot.updated_at) FILTER (WHERE snapshot.liquidity_usd IS NOT NULL),
                    leased.projection_committed_at) AS committed_at,
           COALESCE(jsonb_agg(jsonb_build_object(
             'protocol', registry.protocol, 'marketKey', registry.market_key,
             'poolAddress', registry.pool_address, 'poolId', registry.pool_id,
             'liquidityUsd', snapshot.liquidity_usd::text
           ) ORDER BY snapshot.liquidity_usd DESC, registry.protocol, registry.market_key)
             FILTER (WHERE snapshot.liquidity_usd IS NOT NULL), '[]'::jsonb) AS pools
         FROM leased
         LEFT JOIN robinhood_pool_registry registry
           ON registry.chain='robinhood' AND registry.token_address=leased.token_address
          AND registry.active
         LEFT JOIN robinhood_pool_liquidity_snapshots snapshot
           ON snapshot.chain=registry.chain AND snapshot.protocol=registry.protocol
          AND snapshot.market_key=registry.market_key
          AND snapshot.snapshot_block_number IS NOT NULL
          AND snapshot.liquidity_confidence='medium'
         GROUP BY leased.id, leased.attempt_count, leased.token_address,
                  leased.projection_committed_at
       ) SELECT id, attempt_count, jsonb_build_object(
           'chain', 'robinhood', 'address', token_address,
           'liquidityUsd', liquidity_usd::text,
           'liquidityProjectionCommittedAt', committed_at,
           'liquidityCoverage', CASE WHEN valued_count=0 THEN 'unavailable'
             WHEN valued_count<market_count THEN 'partial' ELSE 'complete' END,
           'liquidityMarketCount', market_count,
           'valuedLiquidityMarketCount', valued_count, 'liquidityPools', pools,
           'liquidityIsLowerBound', valued_count>0 AND valued_count<market_count,
           'latency', jsonb_build_object('projectionCommittedAt', committed_at)
         ) AS payload FROM projection ORDER BY id`,
      [owner, limit, leaseMs]
    );
    return result.rows.map((row) => ({
      id: String(row.id), payload: row.payload, attemptCount: Number(row.attempt_count),
    }));
  }
  async function settleOutbox(input = {}) {
    const owner = ownerOf(input.owner);
    const maxAttempts = positiveInt(input.maxAttempts ?? defaultMaxAttempts, 'maxAttempts');
    const items = (input.delivered || []).map((id) => ({ id: idOf(id, 'delivered.id') }));
    for (const [index, entry] of (input.retry || []).entries()) items.push({
      id: idOf(entry?.id, `retry[${index}].id`),
      error: String(entry?.error || '').slice(0, 4000),
      backoffMs: positiveInt(entry?.backoffMs ?? 1, `retry[${index}].backoffMs`),
    });
    if (!items.length) return { delivered: 0, retried: 0, blocked: 0 };
    const result = await database.query(
      `UPDATE ${TABLE} outbox SET
         status=CASE WHEN item.error IS NULL THEN 'complete'
           WHEN outbox.attempt_count >= $3 THEN 'blocked' ELSE 'pending' END,
         lease_owner=NULL, lease_until=NULL,
         next_attempt_at=CASE WHEN item.error IS NOT NULL AND outbox.attempt_count < $3
           THEN NOW()+(item."backoffMs"*INTERVAL '1 millisecond') ELSE next_attempt_at END,
         last_error=item.error, updated_at=NOW()
       FROM jsonb_to_recordset($1::jsonb) AS item(id bigint, error text, "backoffMs" bigint)
       WHERE outbox.id=item.id AND outbox.status='leased'
         AND outbox.lease_owner=$2 AND outbox.lease_until>NOW()
       RETURNING outbox.status`, [JSON.stringify(items), owner, maxAttempts]
    );
    const count = (status) => result.rows.filter((row) => row.status === status).length;
    return { delivered: count('complete'), retried: count('pending'), blocked: count('blocked') };
  }
  async function reclaimExpiredLeases() {
    const result = await database.query(
      `UPDATE ${TABLE} SET status='pending', lease_owner=NULL, lease_until=NULL, updated_at=NOW()
       WHERE status='leased' AND lease_until<=NOW()`
    );
    return result.rowCount;
  }
  async function readBacklog() {
    const result = await database.query(
      `SELECT COUNT(*)::int AS pending,
         COUNT(*) FILTER (WHERE next_attempt_at<=NOW())::int AS due,
         COALESCE(MAX(attempt_count),0)::int AS max_attempts,
         EXTRACT(EPOCH FROM NOW()-MIN(created_at))::float AS oldest_age_seconds
       FROM ${TABLE} WHERE status='pending'`
    );
    const row = result.rows[0] || {};
    return {
      pending: Number(row.pending || 0), due: Number(row.due || 0),
      maxAttempts: Number(row.max_attempts || 0),
      oldestAgeSeconds: row.oldest_age_seconds == null ? null : Number(row.oldest_age_seconds),
    };
  }
  async function readProjection(input = {}) {
    const address = tokenAddressOf(input.address);
    const committedAt = timestampOf(input.liquidityProjectionCommittedAt);
    const result = await database.query(
      `WITH projection AS (
         SELECT $1::text AS token_address,
           SUM(snapshot.liquidity_usd) FILTER (WHERE snapshot.liquidity_usd IS NOT NULL)
             AS liquidity_usd,
           COUNT(registry.market_key)::int AS market_count,
           COUNT(snapshot.liquidity_usd)::int AS valued_count,
           COALESCE(MAX(snapshot.updated_at) FILTER (WHERE snapshot.liquidity_usd IS NOT NULL),
                    $2::timestamptz) AS committed_at,
           COALESCE(jsonb_agg(jsonb_build_object(
             'protocol', registry.protocol, 'marketKey', registry.market_key,
             'poolAddress', registry.pool_address, 'poolId', registry.pool_id,
             'liquidityUsd', snapshot.liquidity_usd::text
           ) ORDER BY snapshot.liquidity_usd DESC, registry.protocol, registry.market_key)
             FILTER (WHERE snapshot.liquidity_usd IS NOT NULL), '[]'::jsonb) AS pools
         FROM robinhood_pool_registry registry
         LEFT JOIN robinhood_pool_liquidity_snapshots snapshot
           ON snapshot.chain=registry.chain AND snapshot.protocol=registry.protocol
          AND snapshot.market_key=registry.market_key
          AND snapshot.snapshot_block_number IS NOT NULL
          AND snapshot.liquidity_confidence='medium'
         WHERE registry.chain='robinhood' AND registry.token_address=$1 AND registry.active
       ) SELECT jsonb_build_object(
           'chain', 'robinhood', 'address', token_address,
           'liquidityUsd', liquidity_usd::text,
           'liquidityProjectionCommittedAt', committed_at,
           'liquidityCoverage', CASE WHEN valued_count=0 THEN 'unavailable'
             WHEN valued_count<market_count THEN 'partial' ELSE 'complete' END,
           'liquidityMarketCount', market_count,
           'valuedLiquidityMarketCount', valued_count, 'liquidityPools', pools,
           'liquidityIsLowerBound', valued_count>0 AND valued_count<market_count,
           'latency', jsonb_build_object('projectionCommittedAt', committed_at)
         ) AS payload FROM projection`,
      [address, committedAt]
    );
    return result.rows[0]?.payload || null;
  }
  return Object.freeze({
    claimOutbox, settleOutbox, reclaimExpiredLeases, readBacklog, readProjection,
  });
}
module.exports = {
  DEFAULT_MAX_ATTEMPTS, NOTIFY_CHANNEL, TABLE,
  createRobinhoodLiquidityRealtimeOutboxRepository,
};
