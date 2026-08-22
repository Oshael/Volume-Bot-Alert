const db = require('./db');

const CHAIN = 'robinhood';
const MAX_RANGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 120_000;

const SOURCE_CTES_SQL = `WITH registered_buys AS MATERIALIZED (
  SELECT swap.token_address, swap.wallet_address, swap.transaction_hash,
         position.transaction_index, swap.action_index, swap.block_number,
         position.block_hash, swap.block_time, swap.protocol, swap.market_key,
         swap.volume_usd, swap.parser_version
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
   WHERE swap.chain = $1 AND swap.side = 'buy'
     AND swap.block_time >= $2::timestamptz
     AND swap.block_time < $3::timestamptz
), first_blocks AS MATERIALIZED (
  SELECT token_address, wallet_address, MIN(block_number) AS block_number
    FROM registered_buys GROUP BY token_address, wallet_address
), actionable_first_blocks AS MATERIALIZED (
  SELECT first.* FROM first_blocks first
  LEFT JOIN robinhood_wallet_token_first_buys existing
    ON existing.chain = $1
   AND existing.token_address = first.token_address
   AND existing.wallet_address = first.wallet_address
   WHERE existing.block_number IS NULL OR first.block_number <= existing.block_number
), first_block_rows AS MATERIALIZED (
  SELECT buy.* FROM registered_buys buy
  INNER JOIN actionable_first_blocks first
    ON first.token_address = buy.token_address
   AND first.wallet_address = buy.wallet_address
   AND first.block_number = buy.block_number
), quality AS (
  SELECT (SELECT COUNT(*) FROM registered_buys) AS rows_scanned,
         COUNT(*) FILTER (WHERE transaction_index IS NULL OR block_hash IS NULL)
           AS missing_positions
    FROM first_block_rows
), canonical AS MATERIALIZED (
  SELECT DISTINCT ON (token_address, wallet_address) *
    FROM first_block_rows
   WHERE transaction_index IS NOT NULL AND block_hash IS NOT NULL
   ORDER BY token_address, wallet_address, block_number,
            transaction_index, action_index, transaction_hash
)`;

const PROBE_RANGE_SQL = `${SOURCE_CTES_SQL}
SELECT quality.rows_scanned::text, quality.missing_positions::text,
       (SELECT COUNT(*)::text FROM canonical) AS facts_considered
  FROM quality`;

const MATERIALIZE_RANGE_SQL = `${SOURCE_CTES_SQL}, upserted AS (
  INSERT INTO robinhood_wallet_token_first_buys (
    chain, token_address, wallet_address, transaction_hash, transaction_index,
    action_index, block_number, block_hash, block_time, protocol, market_key,
    volume_usd, source_parser_version, evidence_version
  )
  SELECT $1, token_address, wallet_address, transaction_hash, transaction_index,
         action_index, block_number, block_hash, block_time, protocol, market_key,
         volume_usd, parser_version, 'rh_first_buy_v1'
    FROM canonical
   WHERE (SELECT missing_positions FROM quality) = 0
  ON CONFLICT (chain, token_address, wallet_address) DO UPDATE SET
    transaction_hash = EXCLUDED.transaction_hash,
    transaction_index = EXCLUDED.transaction_index,
    action_index = EXCLUDED.action_index,
    block_number = EXCLUDED.block_number,
    block_hash = EXCLUDED.block_hash,
    block_time = EXCLUDED.block_time,
    protocol = EXCLUDED.protocol,
    market_key = EXCLUDED.market_key,
    volume_usd = EXCLUDED.volume_usd,
    source_parser_version = EXCLUDED.source_parser_version,
    evidence_version = EXCLUDED.evidence_version,
    updated_at = NOW()
  WHERE ROW(
    EXCLUDED.block_number, EXCLUDED.transaction_index,
    EXCLUDED.action_index, EXCLUDED.transaction_hash
  ) < ROW(
    robinhood_wallet_token_first_buys.block_number,
    robinhood_wallet_token_first_buys.transaction_index,
    robinhood_wallet_token_first_buys.action_index,
    robinhood_wallet_token_first_buys.transaction_hash
  )
  RETURNING 1
)
SELECT quality.rows_scanned::text, quality.missing_positions::text,
       (SELECT COUNT(*)::text FROM canonical) AS facts_considered,
       (SELECT COUNT(*)::text FROM upserted) AS facts_written
  FROM quality`;

function instant(value, label) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be an instant`);
  return parsed;
}

function normalizeRange(input = {}) {
  const rangeStart = instant(input.rangeStart, 'rangeStart');
  const rangeEnd = instant(input.rangeEnd, 'rangeEnd');
  const duration = rangeEnd.getTime() - rangeStart.getTime();
  if (duration <= 0) throw new Error('rangeEnd must be after rangeStart');
  if (duration > MAX_RANGE_MS) throw new Error('first-buy range must not exceed 24 hours');
  return Object.freeze({ rangeStart: rangeStart.toISOString(), rangeEnd: rangeEnd.toISOString() });
}

function createRobinhoodWalletTokenFirstBuyRepository(options = {}) {
  const database = options.database || db;
  const statementTimeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;

  async function execute(sql, range) {
    const query = database.queryWithStatementTimeout
      ? database.queryWithStatementTimeout.bind(database) : database.query.bind(database);
    const { rows } = await query(
      sql, [CHAIN, range.rangeStart, range.rangeEnd], statementTimeoutMs
    );
    return rows[0] || {};
  }

  async function probeRange(input = {}) {
    const range = normalizeRange(input);
    const result = await execute(PROBE_RANGE_SQL, range);
    return Object.freeze({
      ...range,
      rowsScanned: Number(result.rows_scanned || 0),
      factsConsidered: Number(result.facts_considered || 0),
      missingPositions: Number(result.missing_positions || 0),
    });
  }

  async function materializeRange(input = {}) {
    const range = normalizeRange(input);
    const result = await execute(MATERIALIZE_RANGE_SQL, range);
    const missingPositions = Number(result.missing_positions || 0);
    if (missingPositions > 0) {
      const error = new Error(`canonical transaction positions missing: ${missingPositions}`);
      error.code = 'first_buy_position_unavailable';
      error.details = Object.freeze({ ...range, missingPositions });
      throw error;
    }
    return Object.freeze({
      ...range,
      rowsScanned: Number(result.rows_scanned || 0),
      factsConsidered: Number(result.facts_considered || 0),
      factsWritten: Number(result.facts_written || 0),
    });
  }

  return Object.freeze({ probeRange, materializeRange });
}

module.exports = {
  createRobinhoodWalletTokenFirstBuyRepository,
  __private: { MATERIALIZE_RANGE_SQL, PROBE_RANGE_SQL, normalizeRange },
};
