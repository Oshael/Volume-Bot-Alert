const db = require('./db');

const CHAIN = 'robinhood';
const WRITE_BATCH_SIZE = 500;
const CANDIDATES_SQL = `WITH evidence AS (
  SELECT protocol, market_key, block_number, log_index, observed_at,
         liquidity_usd, liquidity_raw, liquidity_status,
         liquidity_confidence, liquidity_warning, 3 AS source_rank
    FROM robinhood_market_observations
   WHERE chain = '${CHAIN}' AND status = 'accepted' AND block_number <= $1::bigint
  UNION ALL
  SELECT protocol, market_key, last_block_number, last_log_index, last_observed_at,
         close_liquidity_usd, close_liquidity_raw, close_liquidity_status,
         close_liquidity_confidence, close_liquidity_warning, 2
    FROM robinhood_market_buckets_1m
   WHERE chain = '${CHAIN}' AND last_block_number <= $1::bigint
  UNION ALL
  SELECT protocol, market_key, last_block_number, last_log_index, last_observed_at,
         close_liquidity_usd, close_liquidity_raw, close_liquidity_status,
         close_liquidity_confidence, close_liquidity_warning, 1
    FROM robinhood_market_buckets_1h
   WHERE chain = '${CHAIN}' AND last_block_number <= $1::bigint
), valued AS (
  SELECT * FROM evidence
   WHERE liquidity_usd IS NOT NULL AND liquidity_confidence = 'medium'
     AND ((protocol = 'uniswap-v2' AND liquidity_raw IS NULL
           AND liquidity_status = 'spot_estimate_from_double_quote_reserve')
       OR (protocol = 'uniswap-v3' AND liquidity_raw IS NOT NULL
           AND liquidity_status = 'spot_tvl_from_pool_balances')
       OR (protocol = 'uniswap-v4' AND liquidity_raw IS NOT NULL
           AND liquidity_status = 'spot_tvl_from_v4_tick_ranges'))
), latest AS (
  SELECT DISTINCT ON (protocol, market_key) *
    FROM valued
   ORDER BY protocol, market_key, block_number DESC, log_index DESC, source_rank DESC
)
SELECT latest.protocol, latest.market_key, latest.block_number,
       latest.liquidity_usd, latest.liquidity_raw, latest.liquidity_status,
       latest.liquidity_confidence, latest.liquidity_warning
  FROM latest
  INNER JOIN robinhood_pool_registry registry
    ON registry.chain = '${CHAIN}' AND registry.active = TRUE
   AND registry.protocol = latest.protocol AND registry.market_key = latest.market_key
  LEFT JOIN robinhood_pool_liquidity_snapshots snapshot
    ON snapshot.chain = registry.chain AND snapshot.protocol = registry.protocol
   AND snapshot.market_key = registry.market_key
 WHERE snapshot.snapshot_block_number IS NULL
    OR latest.block_number > snapshot.snapshot_block_number
 ORDER BY latest.protocol, latest.market_key`;

const WRITE_SQL = `WITH input AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS seed(
    protocol text, market_key text, block_number bigint, block_hash text,
    observed_at timestamptz, liquidity_usd numeric, liquidity_raw numeric,
    liquidity_status text, liquidity_confidence text, liquidity_warning text
  )
)
INSERT INTO robinhood_pool_liquidity_snapshots (
  chain, protocol, market_key, snapshot_block_number, snapshot_block_hash,
  snapshot_observed_at, liquidity_usd, liquidity_raw, liquidity_status,
  liquidity_confidence, liquidity_warning, checked_at
)
SELECT registry.chain, registry.protocol, registry.market_key,
       input.block_number, input.block_hash, input.observed_at,
       input.liquidity_usd, input.liquidity_raw, input.liquidity_status,
       input.liquidity_confidence, input.liquidity_warning, NOW()
  FROM input
  INNER JOIN robinhood_pool_registry registry
    ON registry.chain = '${CHAIN}' AND registry.active = TRUE
   AND registry.protocol = input.protocol AND registry.market_key = input.market_key
ON CONFLICT (chain, protocol, market_key) DO UPDATE SET
  snapshot_block_number = EXCLUDED.snapshot_block_number,
  snapshot_block_hash = EXCLUDED.snapshot_block_hash,
  snapshot_observed_at = EXCLUDED.snapshot_observed_at,
  liquidity_usd = EXCLUDED.liquidity_usd, liquidity_raw = EXCLUDED.liquidity_raw,
  liquidity_status = EXCLUDED.liquidity_status,
  liquidity_confidence = EXCLUDED.liquidity_confidence,
  liquidity_warning = EXCLUDED.liquidity_warning, checked_at = NOW(),
  last_error_code = NULL, last_error_message = NULL,
  consecutive_failures = 0, updated_at = NOW()
WHERE robinhood_pool_liquidity_snapshots.snapshot_block_number IS NULL
   OR EXCLUDED.snapshot_block_number > robinhood_pool_liquidity_snapshots.snapshot_block_number
RETURNING market_key`;

function mapCandidate(row) {
  return Object.freeze({
    protocol: String(row.protocol), marketKey: String(row.market_key),
    blockNumber: String(row.block_number), liquidityUsd: String(row.liquidity_usd),
    liquidityRaw: row.liquidity_raw == null ? null : String(row.liquidity_raw),
    liquidityStatus: String(row.liquidity_status),
    liquidityConfidence: String(row.liquidity_confidence),
    liquidityWarning: row.liquidity_warning == null ? null : String(row.liquidity_warning),
  });
}

function createRobinhoodPoolLiquiditySeedRepository(options = {}) {
  const database = options.database || db;

  async function listCandidates(input = {}) {
    const throughBlock = BigInt(String(input.throughBlock)).toString();
    const { rows } = await database.query(CANDIDATES_SQL, [throughBlock]);
    return Object.freeze(rows.map(mapCandidate));
  }

  async function commitSeed(input = {}) {
    const rows = input.rows || [];
    const startBlock = BigInt(String(input.startBlock)).toString();
    const client = await database.getClient();
    let written = 0;
    try {
      await client.query('BEGIN');
      for (let offset = 0; offset < rows.length; offset += WRITE_BATCH_SIZE) {
        const batch = rows.slice(offset, offset + WRITE_BATCH_SIZE);
        const result = await client.query(WRITE_SQL, [JSON.stringify(batch)]);
        written += result.rowCount;
      }
      const cursor = await client.query(
        `INSERT INTO robinhood_pool_liquidity_event_cursors (
           chain, coverage_start_block, next_block
         ) VALUES ($1, $2::bigint, $2::bigint)
         ON CONFLICT (chain) DO NOTHING
         RETURNING next_block`,
        [CHAIN, startBlock]
      );
      if (cursor.rowCount !== 1) throw new Error('liquidity event cursor already exists');
      await client.query('COMMIT');
      return Object.freeze({ written, startBlock });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({ commitSeed, listCandidates });
}

module.exports = {
  CANDIDATES_SQL, WRITE_SQL, createRobinhoodPoolLiquiditySeedRepository,
};
