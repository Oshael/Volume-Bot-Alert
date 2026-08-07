/**
 * Robinhood wallet-swap source reader.
 *
 * Reads accepted swap observations by ascending block, grouped per block, so
 * the attribution worker can fetch each block once and attribute all of its
 * swaps. Backed by idx_robinhood_market_observations_attribution
 * (chain, status, block_number, log_index) added in stage 92 — without it this
 * would scan the whole observations table.
 */
const db = require('./db');

const CHAIN = 'robinhood';
const DEFAULT_MAX_BLOCKS = 200;
const MAX_MAX_BLOCKS = 2000;

// Columns the attributor needs to build a durable wallet-swap row.
const OBSERVATION_COLUMNS = [
  'transaction_hash', 'log_index', 'block_number', 'protocol', 'market_key',
  'token_address', 'quote_address', 'side', 'token_amount_raw', 'quote_amount_raw',
  'token_decimals', 'quote_decimals', 'token_amount', 'quote_amount',
  'price_usd', 'volume_usd', 'fdv_usd', 'token_total_supply_raw',
];

function nonNegativeInteger(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) throw new Error(`${label} must be a non-negative integer`);
  return BigInt(raw).toString();
}

function boundedMaxBlocks(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_MAX_BLOCKS;
  const raw = String(value).trim();
  if (!/^\d+$/.test(raw)) throw new Error('maxBlocks must be a positive integer');
  const parsed = Number(raw);
  if (parsed < 1) throw new Error('maxBlocks must be a positive integer');
  return Math.min(parsed, MAX_MAX_BLOCKS);
}

function groupByBlock(rows) {
  const groups = [];
  let current = null;
  for (const row of rows) {
    const blockNumber = String(row.block_number);
    if (!current || current[0] !== blockNumber) {
      current = [blockNumber, []];
      groups.push(current);
    }
    current[1].push(row);
  }
  return groups;
}

function createRobinhoodWalletSwapSourceReader(options = {}) {
  const database = options.database || db;

  // Returns { groups: [[blockNumber, observations[]], ...], blockNumbers: [] }
  // for the next distinct accepted blocks in [fromBlock, toBlock].
  async function readAcceptedBlockGroups(input = {}) {
    const fromBlock = nonNegativeInteger(input.fromBlock, 'fromBlock');
    const toBlock = nonNegativeInteger(input.toBlock, 'toBlock');
    const maxBlocks = boundedMaxBlocks(input.maxBlocks);
    if (BigInt(toBlock) < BigInt(fromBlock)) {
      return { groups: [], blockNumbers: [] };
    }

    const blockResult = await database.query(
      `SELECT DISTINCT block_number
       FROM robinhood_market_observations
       WHERE chain = $1 AND status = 'accepted'
         AND block_number >= $2::bigint AND block_number <= $3::bigint
       ORDER BY block_number ASC
       LIMIT $4`,
      [CHAIN, fromBlock, toBlock, maxBlocks]
    );
    const blockNumbers = blockResult.rows.map((row) => String(row.block_number));
    if (blockNumbers.length === 0) {
      return { groups: [], blockNumbers: [] };
    }

    const observationResult = await database.query(
      `SELECT ${OBSERVATION_COLUMNS.join(', ')}
       FROM robinhood_market_observations
       WHERE chain = $1 AND status = 'accepted'
         AND block_number = ANY($2::bigint[])
       ORDER BY block_number ASC, log_index ASC`,
      [CHAIN, blockNumbers]
    );

    return { groups: groupByBlock(observationResult.rows), blockNumbers };
  }

  return { readAcceptedBlockGroups };
}

module.exports = {
  createRobinhoodWalletSwapSourceReader,
  OBSERVATION_COLUMNS,
  DEFAULT_MAX_BLOCKS,
  MAX_MAX_BLOCKS,
  __private: { groupByBlock, boundedMaxBlocks },
};
