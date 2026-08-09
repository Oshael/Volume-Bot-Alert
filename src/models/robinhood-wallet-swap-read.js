/**
 * Robinhood wallet-swap read model (per-swap trades feed).
 *
 * Serves the Axiom-style token trades feed: one row per accepted swap with the
 * resolved trader wallet, the USD size, the side, and the per-swap market cap.
 *
 * Source of truth is `robinhood_wallet_swaps` (one durable row per attributed
 * swap). Market cap (FDV) is not stored there, so it is joined by
 * `(chain, transaction_hash, action_index = log_index)`. MC is read as
 * `COALESCE(mc.fdv_usd, observation.fdv_usd)`: the durable sidecar
 * `robinhood_swap_mc` wins, falling back to the live `robinhood_market_observations`
 * while the sidecar is still being backfilled. Both are LEFT JOINs so a swap whose
 * MC is not (yet) available surfaces with `mcUsd: null` instead of vanishing. Once
 * observations are pruned for disk, only the sidecar remains and the observation
 * join is dropped (see feed plan §8).
 *
 * Pagination is keyset (block_time DESC), tie-broken by (block_number,
 * action_index) so swaps sharing a block_time are never skipped or repeated. The
 * cursor is an opaque token; callers pass the previous page's `nextCursor` back.
 */
const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const TRADE_SCOPES = new Set(['all', 'dev']);

const CREATOR_SQL = `SELECT creator_address
  FROM robinhood_token_attributions
  WHERE chain = '${CHAIN}' AND token_address = $1`;

// $1 token_address, $2 cursor block_time (or NULL for the first page),
// $3 cursor block_number, $4 cursor action_index, $5 row limit (fetch limit + 1),
// $6 optional creator wallet for the DEV scope.
const RECENT_TRADES_SQL = `SELECT
    swap.transaction_hash, swap.action_index, swap.block_number, swap.block_time,
    swap.side, swap.wallet_address, swap.volume_usd, swap.price_usd,
    COALESCE(mc.fdv_usd, observation.fdv_usd) AS mc_usd
  FROM robinhood_wallet_swaps swap
  LEFT JOIN robinhood_swap_mc mc
    ON mc.chain = swap.chain
   AND mc.transaction_hash = swap.transaction_hash
   AND mc.log_index = swap.action_index
  LEFT JOIN robinhood_market_observations observation
    ON observation.chain = swap.chain
   AND observation.transaction_hash = swap.transaction_hash
   AND observation.log_index = swap.action_index
  WHERE swap.chain = '${CHAIN}'
    AND swap.token_address = $1
    AND ($6::varchar IS NULL OR swap.wallet_address = $6)
    AND (
      $2::timestamptz IS NULL
      OR (swap.block_time, swap.block_number, swap.action_index)
         < ($2::timestamptz, $3::bigint, $4::bigint)
    )
  ORDER BY swap.block_time DESC, swap.block_number DESC, swap.action_index DESC
  LIMIT $5::int`;

function taggedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function encodeCursor(trade) {
  return Buffer.from(
    `${trade.blockTime}|${trade.blockNumber}|${trade.actionIndex}`, 'utf8',
  ).toString('base64url');
}

function decodeCursor(cursor) {
  if (cursor == null || cursor === '') return null;
  const parts = Buffer.from(String(cursor), 'base64url').toString('utf8').split('|');
  if (parts.length !== 3) throw taggedError('INVALID_CURSOR', 'cursor is malformed');
  const blockTime = new Date(parts[0]);
  const blockNumber = Number(parts[1]);
  const actionIndex = Number(parts[2]);
  if (!Number.isFinite(blockTime.getTime())
    || !Number.isSafeInteger(blockNumber) || blockNumber < 0
    || !Number.isSafeInteger(actionIndex) || actionIndex < 0) {
    throw taggedError('INVALID_CURSOR', 'cursor is invalid');
  }
  return { blockTime, blockNumber, actionIndex };
}

function normalizeLimit(value) {
  if (value == null || value === '') return DEFAULT_LIMIT;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw taggedError('INVALID_LIMIT', `limit must be between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
}

function normalizeScope(value) {
  const scope = String(value || 'all').trim().toLowerCase();
  if (!TRADE_SCOPES.has(scope)) throw taggedError('INVALID_SCOPE', 'scope must be all or dev');
  return scope;
}

function normalizeQuery(input = {}) {
  const tokenAddress = normalizeTokenAddress(CHAIN, input.tokenAddress);
  const limit = normalizeLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const scope = normalizeScope(input.scope);
  return { tokenAddress, limit, cursor, scope };
}

function numberOrNull(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTrade(row) {
  return Object.freeze({
    chain: CHAIN,
    transactionHash: row.transaction_hash,
    actionIndex: Number(row.action_index),
    blockNumber: Number(row.block_number),
    blockTime: new Date(row.block_time).toISOString(),
    side: row.side,
    walletAddress: row.wallet_address,
    amountUsd: numberOrNull(row.volume_usd),
    priceUsd: numberOrNull(row.price_usd),
    mcUsd: numberOrNull(row.mc_usd),
  });
}

function createRobinhoodWalletSwapReadRepository(options = {}) {
  const database = options.database || db;

  async function getRecentTrades(input = {}) {
    const query = normalizeQuery(input);
    let creatorAddress = null;
    if (query.scope === 'dev') {
      const creatorResult = await database.query(CREATOR_SQL, [query.tokenAddress]);
      const rawCreator = creatorResult.rows[0]?.creator_address;
      creatorAddress = rawCreator ? normalizeTokenAddress(CHAIN, rawCreator) : null;
      if (!creatorAddress) {
        return Object.freeze({
          chain: CHAIN, token: query.tokenAddress, scope: query.scope,
          creatorAddress: null, trades: Object.freeze([]), hasMore: false, nextCursor: null,
        });
      }
    }
    const params = [
      query.tokenAddress,
      query.cursor ? query.cursor.blockTime : null,
      query.cursor ? String(query.cursor.blockNumber) : null,
      query.cursor ? String(query.cursor.actionIndex) : null,
      query.limit + 1,
      creatorAddress,
    ];
    const result = await database.query(RECENT_TRADES_SQL, params);
    const rows = result.rows.map(normalizeTrade);
    const hasMore = rows.length > query.limit;
    const trades = hasMore ? rows.slice(0, query.limit) : rows;
    return Object.freeze({
      chain: CHAIN,
      token: query.tokenAddress,
      scope: query.scope,
      creatorAddress,
      trades: Object.freeze(trades),
      hasMore,
      nextCursor: hasMore ? encodeCursor(trades[trades.length - 1]) : null,
    });
  }

  return Object.freeze({ getRecentTrades });
}

module.exports = {
  createRobinhoodWalletSwapReadRepository,
  __private: {
    CREATOR_SQL, RECENT_TRADES_SQL, DEFAULT_LIMIT, MAX_LIMIT,
    encodeCursor, decodeCursor, normalizeLimit, normalizeQuery, normalizeScope, normalizeTrade,
  },
};
