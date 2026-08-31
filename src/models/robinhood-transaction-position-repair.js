const db = require('./db');

const CHAIN = 'robinhood';
const MAX_BATCH_SIZE = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;

function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be an instant`);
  return parsed.toISOString();
}

function batchSize(value) {
  const parsed = Number(value ?? 10_000);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_BATCH_SIZE) {
    throw new Error(`batchSize must be between 1 and ${MAX_BATCH_SIZE}`);
  }
  return parsed;
}

function createRobinhoodTransactionPositionRepairRepository(options = {}) {
  const database = options.database || db;
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;

  async function listMissing(input = {}) {
    const rangeStart = instant(input.rangeStart, 'rangeStart');
    const rangeEnd = instant(input.rangeEnd, 'rangeEnd');
    if (rangeStart >= rangeEnd) throw new Error('rangeEnd must be after rangeStart');
    const limit = batchSize(input.limit);
    const query = database.queryWithStatementTimeout
      ? database.queryWithStatementTimeout.bind(database) : database.query.bind(database);
    const { rows } = await query(
      `SELECT DISTINCT swap.block_number, swap.transaction_hash
         FROM robinhood_wallet_swaps swap
         INNER JOIN robinhood_pool_registry registry
           ON registry.chain = swap.chain
          AND registry.protocol = swap.protocol
          AND registry.market_key = swap.market_key
          AND registry.token_address = swap.token_address
          AND registry.discovery_block <= swap.block_number
         LEFT JOIN robinhood_transaction_positions position
           ON position.chain = swap.chain
          AND position.transaction_hash = swap.transaction_hash
          AND position.block_number = swap.block_number
        WHERE swap.chain = $1
          AND swap.block_time >= $2::timestamptz
          AND swap.block_time < $3::timestamptz
          AND position.transaction_hash IS NULL
        ORDER BY swap.block_number, swap.transaction_hash
        LIMIT $4`,
      [CHAIN, rangeStart, rangeEnd, limit], statementTimeoutMs
    );
    return Object.freeze(rows.map((row) => Object.freeze({
      transaction_hash: row.transaction_hash,
      block_number: String(row.block_number),
      transaction_index: null,
    })));
  }

  return Object.freeze({ listMissing });
}

module.exports = {
  createRobinhoodTransactionPositionRepairRepository,
  __private: { batchSize, instant },
};
