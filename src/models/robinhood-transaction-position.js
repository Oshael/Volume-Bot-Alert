const db = require('./db');

const CHAIN = 'robinhood';
const MAX_POSITIONS = 10_000;

function fixedHex(input, label, bytes) {
  const normalized = String(input ?? '').trim().toLowerCase();
  if (!new RegExp(`^0x[0-9a-f]{${bytes * 2}}$`).test(normalized)) {
    throw new Error(`${label} must be ${bytes} bytes`);
  }
  return normalized;
}

function uint(input, label) {
  const normalized = String(input ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(normalized).toString();
}

function index(input, label) {
  const normalized = uint(input, label);
  if (BigInt(normalized) > 2147483647n) throw new Error(`${label} exceeds INTEGER range`);
  return normalized;
}

function normalizePosition(input = {}) {
  return Object.freeze({
    transaction_hash: fixedHex(input.transactionHash, 'transactionHash', 32),
    block_number: uint(input.blockNumber, 'blockNumber'),
    block_hash: fixedHex(input.blockHash, 'blockHash', 32),
    transaction_index: index(input.transactionIndex, 'transactionIndex'),
  });
}

function compactPositions(inputs) {
  if (!Array.isArray(inputs)) throw new TypeError('transaction positions must be a list');
  if (inputs.length > MAX_POSITIONS) {
    throw new RangeError(`transaction positions exceed ${MAX_POSITIONS}`);
  }
  const compacted = new Map();
  for (const input of inputs) {
    const position = normalizePosition(input);
    const current = compacted.get(position.transaction_hash);
    if (current && (current.block_number !== position.block_number
      || current.block_hash !== position.block_hash
      || current.transaction_index !== position.transaction_index)) {
      throw new Error('transaction position batch contains conflicting evidence');
    }
    compacted.set(position.transaction_hash, position);
  }
  return [...compacted.values()];
}

function normalizeStored(row) {
  return Object.freeze({
    transactionHash: row.transaction_hash,
    blockNumber: String(row.block_number),
    blockHash: row.block_hash,
    transactionIndex: String(row.transaction_index),
  });
}

function createRobinhoodTransactionPositionRepository(options = {}) {
  const database = options.database || db;

  async function upsertPositions(inputs = []) {
    const payload = compactPositions(inputs);
    if (!payload.length) return Object.freeze({ requested: 0, persisted: 0 });
    const result = await database.query(
      `INSERT INTO robinhood_transaction_positions (
         chain, transaction_hash, block_number, block_hash, transaction_index
       ) SELECT '${CHAIN}', item.transaction_hash, item.block_number::bigint,
                item.block_hash, item.transaction_index::integer
         FROM jsonb_to_recordset($1::jsonb) AS item(
           transaction_hash text, block_number text, block_hash text,
           transaction_index text
         )
       ON CONFLICT (chain, transaction_hash) DO UPDATE SET
         block_number = EXCLUDED.block_number,
         block_hash = EXCLUDED.block_hash,
         transaction_index = EXCLUDED.transaction_index,
         updated_at = NOW()
       WHERE (robinhood_transaction_positions.block_number,
              robinhood_transaction_positions.block_hash,
              robinhood_transaction_positions.transaction_index)
         IS DISTINCT FROM (EXCLUDED.block_number, EXCLUDED.block_hash,
                           EXCLUDED.transaction_index)
       RETURNING transaction_hash`,
      [JSON.stringify(payload)]
    );
    return Object.freeze({ requested: payload.length, persisted: result.rowCount || 0 });
  }

  async function loadPositions(transactionHashes = []) {
    if (!Array.isArray(transactionHashes)) {
      throw new TypeError('transaction hashes must be a list');
    }
    const hashes = [...new Set(transactionHashes.map((hash) => (
      fixedHex(hash, 'transactionHash', 32)
    )))];
    if (hashes.length > MAX_POSITIONS) {
      throw new RangeError(`transaction hashes exceed ${MAX_POSITIONS}`);
    }
    if (!hashes.length) return Object.freeze([]);
    const { rows } = await database.query(
      `SELECT transaction_hash, block_number, block_hash, transaction_index
         FROM robinhood_transaction_positions
        WHERE chain = $1 AND transaction_hash = ANY($2::varchar[])
        ORDER BY transaction_hash`,
      [CHAIN, hashes]
    );
    return Object.freeze(rows.map(normalizeStored));
  }

  return Object.freeze({ loadPositions, upsertPositions });
}

module.exports = {
  createRobinhoodTransactionPositionRepository,
  __private: { compactPositions, normalizePosition },
};
