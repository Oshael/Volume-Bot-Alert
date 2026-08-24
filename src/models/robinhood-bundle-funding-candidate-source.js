const db = require('./db');

const CHAIN = 'robinhood';
const MAX_CANDIDATE_ROWS = 500_000;

const COVERAGE_SQL = `SELECT cursor.source_next_block::text,
       cursor.next_time = cursor.source_through AS caught_up,
       seed.status AS seed_status
  FROM robinhood_first_buy_live_cursors cursor
  LEFT JOIN robinhood_first_buy_backfill_runs seed
    ON seed.id = cursor.seed_run_id AND seed.chain = cursor.chain
 WHERE cursor.chain = $1`;

const ANCHOR_COVERAGE_SQL = `WITH live_tokens AS MATERIALIZED (
  SELECT state.chain, state.token_address, state.live_through_block
    FROM robinhood_holder_token_states state
   WHERE state.chain = $1 AND state.ledger_status = 'live'
     AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
     AND state.live_through_block <= $2::bigint
) SELECT COUNT(DISTINCT live.token_address)::text AS live_tokens,
       COUNT(DISTINCT buy.token_address)::text AS first_buy_tokens,
       COUNT(DISTINCT anchor.token_address)
         FILTER (WHERE buy.token_address IS NOT NULL)::text AS anchored_tokens
  FROM live_tokens live
  LEFT JOIN robinhood_wallet_token_first_buys buy
    ON buy.chain = live.chain AND buy.token_address = live.token_address
   AND buy.block_number <= live.live_through_block
  LEFT JOIN robinhood_token_launch_anchors anchor
    ON anchor.chain = live.chain AND anchor.token_address = live.token_address
   AND anchor.launch_block <= live.live_through_block`;

const CANDIDATES_SQL = `WITH early AS MATERIALIZED (
SELECT anchor.token_address, buy.wallet_address,
       anchor.launch_block::text, buy.block_number::text AS first_buy_block,
       buy.transaction_index::text AS first_buy_transaction_index,
       COUNT(*) OVER (PARTITION BY anchor.token_address) AS token_wallets
  FROM robinhood_token_launch_anchors anchor
  INNER JOIN robinhood_wallet_token_first_buys buy
    ON buy.chain = anchor.chain AND buy.token_address = anchor.token_address
  INNER JOIN robinhood_holder_token_states state
    ON state.chain = buy.chain AND state.token_address = buy.token_address
 WHERE anchor.chain = $1
   AND state.ledger_status = 'live'
   AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
   AND state.live_through_block <= $2::bigint
   AND anchor.launch_block <= state.live_through_block
   AND buy.block_number BETWEEN anchor.launch_block AND anchor.launch_block + 3
   AND buy.block_number <= state.live_through_block
   AND buy.wallet_address NOT IN (
     '0x0000000000000000000000000000000000000000',
     '0x000000000000000000000000000000000000dead'
   )
   AND NOT EXISTS (
     SELECT 1 FROM robinhood_infrastructure_registry infrastructure
      WHERE infrastructure.chain = buy.chain
        AND infrastructure.address = buy.wallet_address
        AND infrastructure.valid_from_block <= buy.block_number
        AND (infrastructure.valid_through_block IS NULL
          OR infrastructure.valid_through_block >= buy.block_number)
   )
   AND NOT EXISTS (
     SELECT 1 FROM robinhood_pool_registry pool
      WHERE pool.chain = buy.chain AND pool.token_address = buy.token_address
        AND pool.discovery_block <= buy.block_number
        AND CASE WHEN pool.protocol = 'uniswap-v4'
          THEN pool.origin_address ELSE pool.pool_address END = buy.wallet_address
   )
) SELECT token_address, wallet_address, launch_block, first_buy_block,
         first_buy_transaction_index
    FROM early WHERE token_wallets >= 2
   ORDER BY token_address, first_buy_block::bigint,
            first_buy_transaction_index::int, wallet_address
   LIMIT $3::int`;

function unavailable(reason, details = {}) {
  return Object.freeze({
    ready: false, reason, completeThroughBlock: null, candidates: [], ...details,
  });
}

function normalizeCandidate(row) {
  return Object.freeze({
    tokenAddress: row.token_address,
    walletAddress: row.wallet_address,
    launchBlock: row.launch_block,
    firstBuyBlock: row.first_buy_block,
    firstBuyTransactionIndex: row.first_buy_transaction_index,
  });
}

function createRobinhoodBundleFundingCandidateSource(options = {}) {
  const database = options.database || db;
  const timeoutMs = Number(options.statementTimeoutMs ?? 120_000);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 900_000) {
    throw new Error('statementTimeoutMs must be between 1000 and 900000');
  }
  const maxCandidateRows = Number(options.maxCandidateRows ?? MAX_CANDIDATE_ROWS);
  if (!Number.isSafeInteger(maxCandidateRows)
      || maxCandidateRows < 1 || maxCandidateRows > MAX_CANDIDATE_ROWS) {
    throw new Error(`maxCandidateRows must be between 1 and ${MAX_CANDIDATE_ROWS}`);
  }
  const query = (sql, params) => (typeof database.queryWithStatementTimeout === 'function'
    ? database.queryWithStatementTimeout(sql, params, timeoutMs)
    : database.query(sql, params));

  async function load() {
    const coverage = (await query(COVERAGE_SQL, [CHAIN])).rows[0];
    if (!coverage) return unavailable('first_buy_cursor_unavailable');
    if (coverage.seed_status !== 'completed') return unavailable('first_buy_seed_incomplete');
    if (coverage.caught_up !== true) return unavailable('first_buy_cursor_behind');
    if (coverage.source_next_block == null || BigInt(coverage.source_next_block) < 1n) {
      return unavailable('first_buy_block_frontier_unavailable');
    }
    const completeThroughBlock = (BigInt(coverage.source_next_block) - 1n).toString();
    const anchorCoverage = (await query(
      ANCHOR_COVERAGE_SQL, [CHAIN, completeThroughBlock]
    )).rows[0];
    const liveTokens = String(anchorCoverage?.live_tokens ?? '0');
    const firstBuyTokens = String(anchorCoverage?.first_buy_tokens ?? '0');
    const anchoredTokens = String(anchorCoverage?.anchored_tokens ?? '0');
    const tokensWithoutFirstBuy = (BigInt(liveTokens) - BigInt(firstBuyTokens)).toString();
    const missingAnchorTokens = (BigInt(firstBuyTokens) - BigInt(anchoredTokens)).toString();
    const result = await query(CANDIDATES_SQL, [
      CHAIN, completeThroughBlock, maxCandidateRows + 1,
    ]);
    if (result.rows.length > maxCandidateRows) {
      return unavailable('bundle_candidate_memory_cap_exceeded', {
        observedCandidateRows: String(result.rows.length),
      });
    }
    return Object.freeze({
      ready: true,
      reason: null,
      completeThroughBlock,
      liveTokens,
      firstBuyTokens,
      anchoredTokens,
      tokensWithoutFirstBuy,
      missingAnchorTokens,
      anchorCoverageComplete: missingAnchorTokens === '0',
      candidates: Object.freeze(result.rows.map(normalizeCandidate)),
    });
  }

  return Object.freeze({ load });
}

module.exports = {
  createRobinhoodBundleFundingCandidateSource,
  __private: {
    ANCHOR_COVERAGE_SQL, CANDIDATES_SQL, COVERAGE_SQL,
    MAX_CANDIDATE_ROWS, normalizeCandidate,
  },
};
