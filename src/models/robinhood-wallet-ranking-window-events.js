const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const MAX_PAIRS = 20;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 5000;

const SWAPS_SQL = `SELECT requested.token_address, requested.wallet_address,
    swap.transaction_hash, swap.action_index AS log_index, swap.block_number,
    swap.block_time, swap.side, swap.token_amount_raw AS amount_raw,
    swap.volume_usd, swap.transaction_index, swap.canonical_verified
  FROM jsonb_to_recordset($1::jsonb)
    AS requested(token_address text, wallet_address text)
  CROSS JOIN LATERAL (
    SELECT swap.*, position.transaction_index,
      (block.canonical IS TRUE) AS canonical_verified
      FROM robinhood_wallet_swaps swap
      LEFT JOIN robinhood_transaction_positions position
        ON position.chain = swap.chain
       AND position.transaction_hash = swap.transaction_hash
       AND position.block_number = swap.block_number
      LEFT JOIN robinhood_chain_blocks block
        ON block.chain = position.chain AND block.block_number = position.block_number
       AND block.block_hash = position.block_hash
     WHERE swap.chain = '${CHAIN}'
       AND swap.token_address = requested.token_address
       AND swap.wallet_address = requested.wallet_address
       AND swap.block_time >= $2::timestamptz AND swap.block_time <= $3::timestamptz
     ORDER BY swap.block_time, swap.block_number,
       position.transaction_index NULLS LAST, swap.action_index, swap.transaction_hash
     LIMIT $4::int
  ) swap
  ORDER BY requested.token_address, requested.wallet_address,
    swap.block_number, swap.transaction_index NULLS LAST,
    swap.action_index, swap.transaction_hash`;

const TRANSFERS_SQL = `SELECT requested.token_address, requested.wallet_address,
    transfer.transaction_hash, transfer.log_index, transfer.block_number,
    transfer.block_time, transfer.transaction_index, transfer.amount_raw,
    transfer.from_wallet, transfer.to_wallet, transfer.canonical_verified
  FROM jsonb_to_recordset($1::jsonb)
    AS requested(token_address text, wallet_address text)
  CROSS JOIN LATERAL (
    SELECT transfer.*, (block.canonical IS TRUE) AS canonical_verified
     FROM robinhood_token_transfer_events transfer
     LEFT JOIN robinhood_chain_blocks block
       ON block.chain = transfer.chain AND block.block_number = transfer.block_number
      AND block.block_hash = transfer.block_hash
     WHERE transfer.chain = '${CHAIN}'
       AND transfer.token_address = requested.token_address
       AND (transfer.from_wallet = requested.wallet_address
         OR transfer.to_wallet = requested.wallet_address)
       AND transfer.transfer_kind = 'wallet_transfer'
       AND transfer.classification_version = $5
       AND transfer.amount_raw > 0
       AND transfer.block_time >= $2::timestamptz
       AND transfer.block_time <= $3::timestamptz
     ORDER BY transfer.block_time, transfer.block_number,
       transfer.transaction_index, transfer.log_index, transfer.transaction_hash
     LIMIT $4::int
  ) transfer
  ORDER BY requested.token_address, requested.wallet_address,
    transfer.block_number, transfer.transaction_index,
    transfer.log_index, transfer.transaction_hash`;

function identifier(value) {
  const version = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(version)) {
    throw new Error('classificationVersion is invalid');
  }
  return version;
}

function normalizeInput(input) {
  if (!Array.isArray(input.pairs) || input.pairs.length > MAX_PAIRS) {
    throw new Error(`pairs must contain at most ${MAX_PAIRS} entries`);
  }
  const seen = new Set();
  const pairs = input.pairs.map((pair) => {
    const tokenAddress = normalizeTokenAddress(CHAIN, pair?.tokenAddress);
    const walletAddress = normalizeTokenAddress(CHAIN, pair?.walletAddress);
    const key = `${tokenAddress}:${walletAddress}`;
    if (seen.has(key)) throw new Error('duplicate wallet/token pair');
    seen.add(key);
    return { tokenAddress, walletAddress, key };
  });
  const start = new Date(input.windowStart);
  const end = new Date(input.asOf);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())
    || end <= start || end.getTime() - start.getTime() > MAX_WINDOW_MS) {
    throw new Error('windowStart/asOf must define a window of at most 30 days');
  }
  const limit = input.limitPerPair ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limitPerPair must be between 1 and ${MAX_LIMIT}`);
  }
  return { pairs, start, end, limit, version: identifier(input.classificationVersion) };
}

function rowKey(row) {
  return `${row.token_address}:${row.wallet_address}`;
}

function rankEvent(left, right) {
  for (const field of ['blockNumber', 'transactionIndex', 'logIndex']) {
    const a = left[field] == null ? null : BigInt(left[field]);
    const b = right[field] == null ? null : BigInt(right[field]);
    if (a === null || b === null) continue;
    if (a !== b) return a < b ? -1 : 1;
  }
  return left.eventOrder - right.eventOrder
    || left.transactionHash.localeCompare(right.transactionHash);
}

function swapEvent(row) {
  return {
    source: 'swap', type: row.side, time: new Date(row.block_time).toISOString(),
    amountRaw: String(row.amount_raw),
    volumeUsd: row.volume_usd == null ? null : String(row.volume_usd),
    blockNumber: String(row.block_number),
    transactionIndex: row.transaction_index == null ? null : String(row.transaction_index),
    logIndex: String(row.log_index), transactionHash: row.transaction_hash,
    canonicalVerified: row.canonical_verified === true,
    eventOrder: 0,
  };
}

function transferEvent(row) {
  if (row.from_wallet === row.to_wallet) throw new Error('wallet self-transfer is not a position event');
  return {
    source: 'wallet_transfer',
    type: row.from_wallet === row.wallet_address ? 'transfer_out' : 'transfer_in',
    time: new Date(row.block_time).toISOString(), amountRaw: String(row.amount_raw),
    volumeUsd: null, blockNumber: String(row.block_number),
    transactionIndex: String(row.transaction_index), logIndex: String(row.log_index),
    transactionHash: row.transaction_hash,
    canonicalVerified: row.canonical_verified === true,
    eventOrder: row.from_wallet === row.wallet_address ? 1 : 2,
  };
}

function createRobinhoodWalletRankingWindowEventsRepository(options = {}) {
  const database = options.database || db;
  return {
    async getWindowEvents(input = {}) {
      const { pairs, start, end, limit, version } = normalizeInput(input);
      if (!pairs.length) return [];
      const payload = JSON.stringify(pairs.map(({ tokenAddress, walletAddress }) => ({
        token_address: tokenAddress, wallet_address: walletAddress,
      })));
      const params = [payload, start, end, limit + 1, version];
      const swaps = await database.queryWithStatementTimeout(
        SWAPS_SQL, params.slice(0, 4), TIMEOUT_MS,
      );
      const transfers = await database.queryWithStatementTimeout(
        TRANSFERS_SQL, params, TIMEOUT_MS,
      );
      const byPair = new Map(pairs.map(({ key, tokenAddress, walletAddress }) => [key, {
        tokenAddress, walletAddress, swaps: [], transfers: [],
      }]));
      for (const row of swaps.rows) byPair.get(rowKey(row)).swaps.push(swapEvent(row));
      for (const row of transfers.rows) byPair.get(rowKey(row)).transfers.push(transferEvent(row));
      return [...byPair.values()].map((pair) => {
        const truncated = pair.swaps.length > limit || pair.transfers.length > limit;
        const events = [...pair.swaps.slice(0, limit), ...pair.transfers.slice(0, limit)]
          .sort(rankEvent);
        return {
          tokenAddress: pair.tokenAddress, walletAddress: pair.walletAddress,
          windowStart: start.toISOString(), asOf: end.toISOString(),
          events, truncated,
          orderingComplete: events.every((event) => event.transactionIndex != null),
          canonicalEventsVerified: events.every((event) => event.canonicalVerified),
          sourceCoverageVerified: false,
        };
      });
    },
  };
}

module.exports = { createRobinhoodWalletRankingWindowEventsRepository };
