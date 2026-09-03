const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const v4 = require('../services/uniswap-v4-decoder');
const { V4_DONATE_TOPIC } = require('../services/robinhood-pool-liquidity-events');
const { POOL_LIQUIDITY_BATCH_SIZE } = require('../utils/robinhood-liquidity-limits');

const CHAIN = 'robinhood';
const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const MAX_BATCH_SIZE = 500;
const V4_EVENT_TOPICS = new Set([...Object.values(v4.TOPICS), V4_DONATE_TOPIC]);

function timestamp(value, label) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} is invalid`);
  return parsed.toISOString();
}

function protocol(value) {
  const normalized = String(value || '');
  if (!PROTOCOLS.has(normalized)) throw new Error('protocol is invalid');
  return normalized;
}

function marketKey(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized.length > 160) throw new Error('marketKey is invalid');
  return normalized;
}

function quantity(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} is invalid`);
  return BigInt(normalized).toString();
}

function decimal(value, label, nullable = false) {
  if (nullable && value == null) return null;
  const normalized = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function blockHash(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw new Error('blockHash is invalid');
  return normalized;
}

function optionalWarning(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 64) throw new Error('liquidityWarning is invalid');
  return normalized;
}

function failure(value, fallback, maximum) {
  const normalized = String(value || fallback).trim().toLowerCase()
    .replace(/[^a-z0-9_:-]+/g, '_').replace(/^[^a-z0-9]+/, '').slice(0, maximum);
  return normalized || fallback;
}

function normalizeAssessment(input, resolvedProtocol) {
  const status = String(input.liquidityStatus || '');
  const confidence = String(input.liquidityConfidence || '');
  const liquidityUsd = decimal(input.liquidityUsd, 'liquidityUsd', true);
  const liquidityRaw = decimal(input.liquidityRaw, 'liquidityRaw', true);
  const available = liquidityUsd != null && confidence === 'medium';
  const valid = (
    resolvedProtocol === 'uniswap-v2'
      ? liquidityRaw == null && (
        (available && status === 'spot_estimate_from_double_quote_reserve')
        || (!available && liquidityUsd == null && confidence === 'none'
          && status === 'missing_v2_reserve_or_quote')
      )
      : liquidityRaw != null && (
        (available && status === (resolvedProtocol === 'uniswap-v3'
          ? 'spot_tvl_from_pool_balances' : 'spot_tvl_from_v4_tick_ranges'))
        || (!available && liquidityUsd == null && confidence === 'none'
          && status === 'requires_tick_liquidity_distribution')
      )
  );
  if (!valid) throw new Error('liquidity assessment is inconsistent');
  return {
    liquidityUsd, liquidityRaw, liquidityStatus: status,
    liquidityConfidence: confidence, liquidityWarning: optionalWarning(input.liquidityWarning),
  };
}

function normalizeCandidate(row) {
  return Object.freeze({
    protocol: protocol(row.protocol),
    marketKey: marketKey(row.market_key),
    poolAddress: row.pool_address == null ? null
      : normalizeTokenAddress(CHAIN, row.pool_address),
    poolId: row.pool_id == null ? null : String(row.pool_id).toLowerCase(),
    originAddress: row.origin_address == null ? null
      : normalizeTokenAddress(CHAIN, row.origin_address),
    tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
    quoteAddress: normalizeTokenAddress(CHAIN, row.quote_address),
    currency0: normalizeTokenAddress(CHAIN, row.currency0),
    currency1: normalizeTokenAddress(CHAIN, row.currency1),
    discoveredAt: timestamp(row.discovered_at, 'discoveredAt'),
    consecutiveFailures: Number(row.consecutive_failures) || 0,
  });
}

function normalizeEventLogs(logs = []) {
  const addresses = new Set();
  const v4Pools = new Map();
  for (const log of logs) {
    const address = normalizeTokenAddress(CHAIN, log?.address);
    if (!V4_EVENT_TOPICS.has(String(log?.topics?.[0] || '').toLowerCase())) {
      // Indexed V3 senders are not pool identities.
      addresses.add(address);
      continue;
    }
    const poolId = String(log?.topics?.[1] || '').toLowerCase();
    if (/^0x[0-9a-f]{64}$/.test(poolId)) {
      v4Pools.set(`${address}:${poolId}`, { address, pool_id: poolId });
    }
  }
  return { addresses: [...addresses], v4Pools: [...v4Pools.values()] };
}

function normalizeSnapshot(input) {
  const resolvedProtocol = protocol(input.protocol);
  const assessment = normalizeAssessment(input, resolvedProtocol);
  return {
    protocol: resolvedProtocol, market_key: marketKey(input.marketKey),
    block_number: quantity(input.blockNumber, 'blockNumber'),
    block_hash: blockHash(input.blockHash), observed_at: timestamp(input.observedAt, 'observedAt'),
    liquidity_usd: assessment.liquidityUsd, liquidity_raw: assessment.liquidityRaw,
    liquidity_status: assessment.liquidityStatus,
    liquidity_confidence: assessment.liquidityConfidence, liquidity_warning: assessment.liquidityWarning,
    checked_at: timestamp(input.checkedAt || new Date(), 'checkedAt'),
  };
}

function createRobinhoodPoolLiquiditySnapshotRepository(options = {}) {
  const database = options.database || db;

  async function resolveAnchorBlock() {
    const { rows } = await database.query(
      `SELECT cursor.checkpoint_block,
              (SELECT MIN(capture.block_number)
                 FROM robinhood_head_captures capture
                WHERE capture.chain = cursor.chain AND capture.stream = cursor.stream
                  AND capture.processing_status IN ('pending', 'leased', 'blocked')
              ) AS pending_block
         FROM robinhood_head_capture_cursors cursor
        WHERE cursor.chain = '${CHAIN}' AND cursor.stream = 'market'
        LIMIT 1`
    );
    const row = rows[0];
    if (row?.checkpoint_block == null) return null;
    const checkpoint = BigInt(row.checkpoint_block);
    const frontier = row.pending_block == null ? checkpoint : BigInt(row.pending_block) - 1n;
    return frontier >= 0n ? frontier.toString() : null;
  }

  async function listDuePools(input = {}) {
    const dueBefore = timestamp(input.dueBefore || new Date(), 'dueBefore');
    const limit = Number(input.limit ?? 100);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
      throw new RangeError(`limit must be between 1 and ${MAX_BATCH_SIZE}`);
    }
    const { rows } = await database.query(
      `SELECT registry.protocol, registry.market_key, registry.pool_address,
              registry.pool_id, registry.origin_address, registry.token_address,
              registry.quote_address, registry.currency0, registry.currency1,
              registry.discovered_at,
              COALESCE(snapshot.consecutive_failures, 0) AS consecutive_failures
         FROM robinhood_pool_registry registry
         LEFT JOIN robinhood_pool_liquidity_snapshots snapshot
           ON snapshot.chain = registry.chain AND snapshot.protocol = registry.protocol
          AND snapshot.market_key = registry.market_key
        WHERE registry.chain = '${CHAIN}' AND registry.active = TRUE
          AND (snapshot.checked_at IS NULL OR snapshot.checked_at <= $1::timestamptz)
        ORDER BY snapshot.checked_at ASC NULLS FIRST, registry.discovered_at DESC,
                 registry.protocol, registry.market_key
        LIMIT $2::int`,
      [dueBefore, limit]
    );
    return Object.freeze(rows.map(normalizeCandidate));
  }

  async function listPoolsForLiquidityEvents(logs = []) {
    const { addresses, v4Pools } = normalizeEventLogs(logs);
    if (!addresses.length && !v4Pools.length) return Object.freeze([]);
    const { rows } = await database.query(
      `WITH events AS (
         SELECT address, pool_id
         FROM jsonb_to_recordset($2::jsonb) AS event(address text, pool_id text)
       ), affected AS (
         SELECT registry.*
           FROM robinhood_pool_registry registry
          WHERE registry.chain = '${CHAIN}' AND registry.active = TRUE
            AND registry.protocol IN ('uniswap-v2', 'uniswap-v3')
            AND registry.pool_address = ANY($1::varchar[])
         UNION ALL
         SELECT registry.*
           FROM events
           INNER JOIN robinhood_pool_registry registry
             ON registry.chain = '${CHAIN}' AND registry.active = TRUE
            AND registry.protocol = 'uniswap-v4'
            AND registry.pool_id = events.pool_id
            AND registry.origin_address = events.address
       )
       SELECT registry.protocol, registry.market_key, registry.pool_address,
              registry.pool_id, registry.origin_address, registry.token_address,
              registry.quote_address, registry.currency0, registry.currency1,
              registry.discovered_at,
              COALESCE(snapshot.consecutive_failures, 0) AS consecutive_failures
         FROM affected registry
         LEFT JOIN robinhood_pool_liquidity_snapshots snapshot
           ON snapshot.chain = registry.chain AND snapshot.protocol = registry.protocol
          AND snapshot.market_key = registry.market_key
        ORDER BY registry.protocol, registry.market_key`,
      [addresses, JSON.stringify(v4Pools)]
    );
    return Object.freeze(rows.map(normalizeCandidate));
  }

  async function invalidateSnapshotsFromBlock(input = {}) {
    const rewindBlock = quantity(input.rewindBlock, 'rewindBlock');
    const { rows } = await database.query(
      `WITH invalidated AS (
         UPDATE robinhood_pool_liquidity_snapshots snapshot
            SET snapshot_block_number = NULL, snapshot_block_hash = NULL,
                snapshot_observed_at = NULL, liquidity_usd = NULL,
                liquidity_raw = NULL, liquidity_status = NULL,
                liquidity_confidence = NULL, liquidity_warning = NULL,
                checked_at = NOW(), last_error_code = NULL,
                last_error_message = NULL, consecutive_failures = 0,
                updated_at = NOW()
          WHERE snapshot.chain = '${CHAIN}'
            AND snapshot.snapshot_block_number >= $1::bigint
          RETURNING snapshot.protocol, snapshot.market_key
       )
       SELECT registry.protocol, registry.market_key, registry.pool_address,
              registry.pool_id, registry.origin_address, registry.token_address,
              registry.quote_address, registry.currency0, registry.currency1,
              registry.discovered_at, 0 AS consecutive_failures
         FROM invalidated
         INNER JOIN robinhood_pool_registry registry
           ON registry.chain = '${CHAIN}' AND registry.active = TRUE
          AND registry.protocol = invalidated.protocol
          AND registry.market_key = invalidated.market_key
        ORDER BY registry.protocol, registry.market_key`,
      [rewindBlock]
    );
    return Object.freeze(rows.map(normalizeCandidate));
  }

  async function recordSnapshot(input = {}) {
    return await recordSnapshots([input]) === 1;
  }

  async function recordSnapshots(inputs = []) {
    if (!Array.isArray(inputs) || inputs.length > POOL_LIQUIDITY_BATCH_SIZE) {
      throw new RangeError(`snapshot batch must contain at most ${POOL_LIQUIDITY_BATCH_SIZE} rows`);
    }
    if (!inputs.length) return 0;
    let rows;
    try {
      rows = inputs.map(normalizeSnapshot);
      const keys = new Set(rows.map((row) => `${row.protocol}:${row.market_key}`));
      if (keys.size !== rows.length) throw new Error('snapshot batch contains duplicate pools');
    } catch (error) {
      error.code = 'liquidity_snapshot_invalid';
      throw error;
    }
    const result = await database.query(
      `WITH input AS (
         SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
           protocol text, market_key text, block_number bigint, block_hash text,
           observed_at timestamptz, liquidity_usd numeric, liquidity_raw numeric,
           liquidity_status text, liquidity_confidence text, liquidity_warning text,
           checked_at timestamptz
         )
       ) INSERT INTO robinhood_pool_liquidity_snapshots (
         chain, protocol, market_key, snapshot_block_number, snapshot_block_hash,
         snapshot_observed_at, liquidity_usd, liquidity_raw, liquidity_status,
         liquidity_confidence, liquidity_warning, checked_at
       ) SELECT registry.chain, registry.protocol, registry.market_key,
                input.block_number, input.block_hash, input.observed_at,
                input.liquidity_usd, input.liquidity_raw, input.liquidity_status,
                input.liquidity_confidence, input.liquidity_warning, input.checked_at
           FROM input
           JOIN robinhood_pool_registry registry
             ON registry.chain = '${CHAIN}' AND registry.protocol = input.protocol
            AND registry.market_key = input.market_key AND registry.active = TRUE
          ORDER BY input.protocol, input.market_key
       ON CONFLICT (chain, protocol, market_key) DO UPDATE SET
         snapshot_block_number = EXCLUDED.snapshot_block_number,
         snapshot_block_hash = EXCLUDED.snapshot_block_hash,
         snapshot_observed_at = EXCLUDED.snapshot_observed_at,
         liquidity_usd = EXCLUDED.liquidity_usd,
         liquidity_raw = EXCLUDED.liquidity_raw,
         liquidity_status = EXCLUDED.liquidity_status,
         liquidity_confidence = EXCLUDED.liquidity_confidence,
         liquidity_warning = EXCLUDED.liquidity_warning,
         checked_at = GREATEST(robinhood_pool_liquidity_snapshots.checked_at,
                               EXCLUDED.checked_at),
         last_error_code = NULL, last_error_message = NULL,
         consecutive_failures = 0, updated_at = NOW()
       WHERE robinhood_pool_liquidity_snapshots.snapshot_block_number IS NULL
          OR EXCLUDED.snapshot_block_number >=
             robinhood_pool_liquidity_snapshots.snapshot_block_number
       RETURNING market_key`,
      [JSON.stringify(rows)]
    );
    return result.rowCount;
  }

  async function recordFailure(input = {}) {
    const resolvedProtocol = protocol(input.protocol);
    const resolvedMarketKey = marketKey(input.marketKey);
    const code = failure(input.error?.code, 'liquidity_snapshot_error', 64);
    const message = String(input.error?.message || input.error || code).trim().slice(0, 500);
    const checkedAt = timestamp(input.checkedAt || new Date(), 'checkedAt');
    const result = await database.query(
      `INSERT INTO robinhood_pool_liquidity_snapshots (
         chain, protocol, market_key, checked_at, last_error_code,
         last_error_message, consecutive_failures
       ) SELECT registry.chain, registry.protocol, registry.market_key,
                $3::timestamptz, $4, $5, 1
           FROM robinhood_pool_registry registry
          WHERE registry.chain = '${CHAIN}' AND registry.protocol = $1
            AND registry.market_key = $2 AND registry.active = TRUE
       ON CONFLICT (chain, protocol, market_key) DO UPDATE SET
         checked_at = EXCLUDED.checked_at,
         last_error_code = EXCLUDED.last_error_code,
         last_error_message = EXCLUDED.last_error_message,
         consecutive_failures = robinhood_pool_liquidity_snapshots.consecutive_failures + 1,
         updated_at = NOW()
       RETURNING market_key`,
      [resolvedProtocol, resolvedMarketKey, checkedAt, code, message]
    );
    return result.rowCount === 1;
  }

  return Object.freeze({
    invalidateSnapshotsFromBlock, listDuePools, listPoolsForLiquidityEvents,
    recordFailure, recordSnapshot, recordSnapshots, resolveAnchorBlock,
  });
}

module.exports = {
  createRobinhoodPoolLiquiditySnapshotRepository,
  __private: { normalizeAssessment, normalizeCandidate },
};
