const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const HASH_RE = /^0x[0-9a-f]{64}$/;
const SIDES = new Set(['all', 'buy', 'sell']);

const WALLET_TRADES_SQL = `SELECT
    swap.transaction_hash, swap.action_index, swap.block_number, swap.block_time,
    swap.wallet_address, swap.token_address, swap.side, swap.token_amount,
    swap.token_amount_raw, swap.token_decimals, swap.volume_usd, swap.price_usd
  FROM robinhood_wallet_swaps swap
  WHERE swap.chain = '${CHAIN}'
    AND swap.wallet_address = $1
    AND ($2::varchar IS NULL OR swap.side = $2)
    AND (
      $3::timestamptz IS NULL
      OR (swap.block_time, swap.block_number, swap.action_index, swap.transaction_hash)
         < ($3::timestamptz, $4::bigint, $5::bigint, $6::varchar)
    )
  ORDER BY swap.block_time DESC, swap.block_number DESC,
    swap.action_index DESC, swap.transaction_hash DESC
  LIMIT $7::int`;

function taggedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeLimit(value) {
  if (value == null || value === '') return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw taggedError('INVALID_LIMIT', `limit must be between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function normalizeSide(value) {
  const side = String(value || 'all').trim().toLowerCase();
  if (!SIDES.has(side)) throw taggedError('INVALID_SIDE', 'side must be all, buy or sell');
  return side;
}

function encodeCursor(wallet, side, trade) {
  return Buffer.from(JSON.stringify([
    wallet, side, trade.blockTime, trade.blockNumber,
    trade.actionIndex, trade.transactionHash,
  ]), 'utf8').toString('base64url');
}

function validCursorTuple(parts) {
  if (typeof parts[2] !== 'string' || !Number.isFinite(new Date(parts[2]).getTime())
    || new Date(parts[2]).toISOString() !== parts[2]) return false;
  if (!Number.isSafeInteger(parts[3]) || parts[3] < 0
    || !Number.isSafeInteger(parts[4]) || parts[4] < 0) return false;
  return typeof parts[5] === 'string' && HASH_RE.test(parts[5]);
}

function decodeCursor(value, wallet, side) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw taggedError('INVALID_CURSOR', 'cursor is malformed');
  }
  let parts;
  try {
    parts = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch (_) {
    throw taggedError('INVALID_CURSOR', 'cursor is malformed');
  }
  if (!Array.isArray(parts) || parts.length !== 6 || parts[0] !== wallet || parts[1] !== side) {
    throw taggedError('INVALID_CURSOR', 'cursor does not match the wallet and side');
  }
  if (!validCursorTuple(parts)) {
    throw taggedError('INVALID_CURSOR', 'cursor is invalid');
  }
  return {
    blockTime: new Date(parts[2]),
    blockNumber: parts[3], actionIndex: parts[4], transactionHash: parts[5],
  };
}

function numberOrNull(value) {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTrade(row) {
  return Object.freeze({
    chain: CHAIN,
    walletAddress: row.wallet_address,
    tokenAddress: row.token_address,
    transactionHash: row.transaction_hash,
    actionIndex: Number(row.action_index),
    blockNumber: Number(row.block_number),
    blockTime: new Date(row.block_time).toISOString(),
    side: row.side,
    tokenAmount: row.token_amount == null ? null : String(row.token_amount),
    tokenAmountRaw: String(row.token_amount_raw),
    tokenDecimals: row.token_decimals == null ? null : Number(row.token_decimals),
    amountUsd: numberOrNull(row.volume_usd),
    priceUsd: numberOrNull(row.price_usd),
  });
}

function createRobinhoodWalletTradeReadRepository(options = {}) {
  const database = options.database || db;

  async function getWalletTrades(input = {}) {
    const wallet = normalizeTokenAddress(CHAIN, input.walletAddress);
    const side = normalizeSide(input.side);
    const limit = normalizeLimit(input.limit);
    const cursor = decodeCursor(input.cursor, wallet, side);
    const result = await database.query(WALLET_TRADES_SQL, [
      wallet, side === 'all' ? null : side,
      cursor?.blockTime || null, cursor ? String(cursor.blockNumber) : null,
      cursor ? String(cursor.actionIndex) : null, cursor?.transactionHash || null,
      limit + 1,
    ]);
    const rows = result.rows.map(normalizeTrade);
    const hasMore = rows.length > limit;
    const trades = hasMore ? rows.slice(0, limit) : rows;
    return Object.freeze({
      chain: CHAIN, wallet, side, trades: Object.freeze(trades), hasMore,
      nextCursor: hasMore ? encodeCursor(wallet, side, trades[trades.length - 1]) : null,
    });
  }

  return Object.freeze({ getWalletTrades });
}

module.exports = {
  createRobinhoodWalletTradeReadRepository,
  __private: { WALLET_TRADES_SQL, decodeCursor, encodeCursor, normalizeLimit, normalizeSide },
};
