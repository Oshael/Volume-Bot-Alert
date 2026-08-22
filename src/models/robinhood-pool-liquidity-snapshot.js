const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const PROTOCOLS = new Set(['uniswap-v2', 'uniswap-v3', 'uniswap-v4']);
const MAX_BATCH_SIZE = 500;

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
  const unique = new Map();
  for (const log of logs) {
    const address = normalizeTokenAddress(CHAIN, log?.address);
    const topic1 = String(log?.topics?.[1] || '').toLowerCase();
    const poolId = /^0x[0-9a-f]{64}$/.test(topic1) ? topic1 : null;
    unique.set(`${address}:${poolId || ''}`, { address, poolId });
  }
  return [...unique.values()];
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
    const events = normalizeEventLogs(logs);
    if (!events.length) return Object.freeze([]);
    const { rows } = await database.query(
      `WITH events AS (
         SELECT address, pool_id
         FROM jsonb_to_recordset($1::jsonb) AS event(address text, pool_id text)
       )
       SELECT DISTINCT registry.protocol, registry.market_key, registry.pool_address,
              registry.pool_id, registry.origin_address, registry.token_address,
              registry.quote_address, registry.currency0, registry.currency1,
              registry.discovered_at,
              COALESCE(snapshot.consecutive_failures, 0) AS consecutive_failures
         FROM events
         INNER JOIN robinhood_pool_registry registry
           ON registry.chain = '${CHAIN}' AND registry.active = TRUE
          AND ((registry.protocol = 'uniswap-v4'
                AND registry.origin_address = events.address
                AND registry.pool_id = events.pool_id)
            OR (registry.protocol <> 'uniswap-v4'
                AND registry.pool_address = events.address))
         LEFT JOIN robinhood_pool_liquidity_snapshots snapshot
           ON snapshot.chain = registry.chain AND snapshot.protocol = registry.protocol
          AND snapshot.market_key = registry.market_key
        ORDER BY registry.protocol, registry.market_key`,
      [JSON.stringify(events.map(({ address, poolId }) => ({
        address, pool_id: poolId,
      })))]
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
    const resolvedProtocol = protocol(input.protocol);
    const resolvedMarketKey = marketKey(input.marketKey);
    const assessment = normalizeAssessment(input, resolvedProtocol);
    const params = [
      resolvedProtocol, resolvedMarketKey, quantity(input.blockNumber, 'blockNumber'),
      blockHash(input.blockHash), timestamp(input.observedAt, 'observedAt'),
      assessment.liquidityUsd, assessment.liquidityRaw, assessment.liquidityStatus,
      assessment.liquidityConfidence, assessment.liquidityWarning,
      timestamp(input.checkedAt || new Date(), 'checkedAt'),
    ];
    const result = await database.query(
      `INSERT INTO robinhood_pool_liquidity_snapshots (
         chain, protocol, market_key, snapshot_block_number, snapshot_block_hash,
         snapshot_observed_at, liquidity_usd, liquidity_raw, liquidity_status,
         liquidity_confidence, liquidity_warning, checked_at
       ) SELECT registry.chain, registry.protocol, registry.market_key,
                $3::bigint, $4, $5::timestamptz, $6::numeric, $7::numeric,
                $8, $9, $10, $11::timestamptz
           FROM robinhood_pool_registry registry
          WHERE registry.chain = '${CHAIN}' AND registry.protocol = $1
            AND registry.market_key = $2 AND registry.active = TRUE
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
      params
    );
    return result.rowCount === 1;
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
    recordFailure, recordSnapshot, resolveAnchorBlock,
  });
}

module.exports = {
  createRobinhoodPoolLiquiditySnapshotRepository,
  __private: { normalizeAssessment, normalizeCandidate },
};
