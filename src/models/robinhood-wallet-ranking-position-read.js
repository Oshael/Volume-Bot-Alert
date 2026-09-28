const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const MAX_TOKENS = 50;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const TIMEOUT_MS = 5000;

const OPEN_POSITIONS_SQL = `SELECT position.token_address, position.wallet_address,
    position.quantity_raw, position.cost_basis_usd, position.cost_basis_source,
    position.zero_cost_received_raw, position.quality,
    position.through_block, position.through_log_index
  FROM unnest($2::varchar[]) AS requested(token_address)
  CROSS JOIN LATERAL (
    SELECT position.* FROM robinhood_wallet_token_positions position
    WHERE position.chain = '${CHAIN}' AND position.projection_version = $1
      AND position.token_address = requested.token_address
      AND position.quantity_raw > 0
      AND ($3::varchar IS NULL OR requested.token_address > $3::varchar
        OR (requested.token_address = $3::varchar
          AND position.wallet_address > $4::varchar))
    ORDER BY position.wallet_address
    LIMIT $5::int
  ) position
  ORDER BY position.token_address, position.wallet_address
  LIMIT $5::int`;

const GLOBAL_OPEN_POSITIONS_SQL = `SELECT position.token_address, position.wallet_address,
    position.quantity_raw, position.cost_basis_usd, position.cost_basis_source,
    position.zero_cost_received_raw, position.quality,
    position.through_block, position.through_log_index
  FROM robinhood_wallet_token_positions position
  WHERE position.chain = '${CHAIN}' AND position.projection_version = $1
    AND position.quantity_raw > 0
    AND ($2::varchar IS NULL OR (position.token_address, position.wallet_address)
      > ($2::varchar, $3::varchar))
  ORDER BY position.token_address, position.wallet_address
  LIMIT $4::int`;

function projectionVersion(value) {
  const version = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(version)) {
    throw new Error('projectionVersion is invalid');
  }
  return version;
}

function normalizeTokens(values) {
  if (!Array.isArray(values) || values.length > MAX_TOKENS) {
    throw new Error(`tokenAddresses must contain at most ${MAX_TOKENS} tokens`);
  }
  return [...new Set(values.map((value) => normalizeTokenAddress(CHAIN, value)))].sort();
}

function normalizeLimit(value) {
  const limit = value ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function normalizeAfter(value, tokens) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('after must be a token/wallet pair');
  }
  const tokenAddress = normalizeTokenAddress(CHAIN, value.tokenAddress);
  const walletAddress = normalizeTokenAddress(CHAIN, value.walletAddress);
  if (!tokens.includes(tokenAddress)) throw new Error('after token is outside the requested set');
  return { tokenAddress, walletAddress };
}

function normalizeGlobalAfter(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('after must be a token/wallet pair');
  }
  return {
    tokenAddress: normalizeTokenAddress(CHAIN, value.tokenAddress),
    walletAddress: normalizeTokenAddress(CHAIN, value.walletAddress),
  };
}

function normalizeRow(row) {
  return {
    tokenAddress: row.token_address,
    walletAddress: row.wallet_address,
    quantityRaw: String(row.quantity_raw),
    costBasisUsd: String(row.cost_basis_usd),
    costBasisSource: row.cost_basis_source,
    zeroCostReceivedRaw: String(row.zero_cost_received_raw),
    quality: row.quality,
    throughBlock: String(row.through_block),
    throughLogIndex: String(row.through_log_index),
  };
}

function pageResult(version, rows, limit) {
  const hasMore = rows.length > limit;
  const positions = rows.slice(0, limit).map(normalizeRow);
  const last = positions.at(-1);
  return {
    projectionVersion: version, positions, hasMore,
    nextAfter: hasMore ? { tokenAddress: last.tokenAddress,
      walletAddress: last.walletAddress } : null,
    snapshotConsistent: false,
  };
}

function createRobinhoodWalletRankingPositionReadRepository(options = {}) {
  const database = options.database || db;
  return {
    async getOpenPositions(input = {}) {
      const version = projectionVersion(input.projectionVersion);
      const tokens = normalizeTokens(input.tokenAddresses);
      const limit = normalizeLimit(input.limit);
      const after = normalizeAfter(input.after, tokens);
      if (!tokens.length) {
        return { projectionVersion: version, positions: [], hasMore: false,
          nextAfter: null, snapshotConsistent: false };
      }
      const result = await database.queryWithStatementTimeout(OPEN_POSITIONS_SQL, [
        version, tokens, after?.tokenAddress || null, after?.walletAddress || null, limit + 1,
      ], TIMEOUT_MS);
      return pageResult(version, result.rows, limit);
    },
    async getGlobalOpenPositions(input = {}) {
      const version = projectionVersion(input.projectionVersion);
      const limit = normalizeLimit(input.limit);
      const after = normalizeGlobalAfter(input.after);
      const result = await database.queryWithStatementTimeout(GLOBAL_OPEN_POSITIONS_SQL, [
        version, after?.tokenAddress || null, after?.walletAddress || null, limit + 1,
      ], TIMEOUT_MS);
      return pageResult(version, result.rows, limit);
    },
  };
}

module.exports = { createRobinhoodWalletRankingPositionReadRepository };
