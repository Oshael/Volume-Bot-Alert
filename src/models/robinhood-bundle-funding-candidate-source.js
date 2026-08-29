const db = require('./db');

const CHAIN = 'robinhood';
const MAX_CANDIDATE_ROWS = 500_000;

const BASELINE_RUN_SQL = `SELECT id::text, status, rule_version, evidence_version,
       source_through_block::text, lookback_blocks::text
  FROM robinhood_bundle_funding_backfill_runs
 WHERE chain = $1 AND id = $2::bigint`;

const BASELINE_CANDIDATES_SQL = `SELECT token_address, wallet_address,
       launch_block::text, first_buy_block::text,
       first_buy_transaction_index::text
  FROM robinhood_bundle_funding_backfill_candidates
 WHERE run_id = $1::bigint
 ORDER BY token_address, wallet_address`;

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
), covered AS MATERIALIZED (
  SELECT live.*,
         EXISTS (
           SELECT 1 FROM robinhood_wallet_token_first_buys buy
            WHERE buy.chain = live.chain AND buy.token_address = live.token_address
              AND buy.block_number <= live.live_through_block
         ) AS has_first_buy
    FROM live_tokens live
) SELECT COUNT(*)::text AS live_tokens,
       COUNT(*) FILTER (WHERE covered.has_first_buy)::text AS first_buy_tokens,
       COUNT(*) FILTER (WHERE covered.has_first_buy AND EXISTS (
         SELECT 1 FROM robinhood_token_launch_anchors anchor
          WHERE anchor.chain = covered.chain
            AND anchor.token_address = covered.token_address
            AND anchor.launch_block <= covered.live_through_block
       ))::text AS anchored_tokens
  FROM covered`;

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

function candidateKey(row) {
  return `${row.token_address}:${row.wallet_address}`;
}

function candidateEvidence(row) {
  return `${row.launch_block}:${row.first_buy_block}:${row.first_buy_transaction_index}`;
}

function incrementalCandidates(currentRows, baselineRows) {
  const current = new Map(currentRows.map((row) => [candidateKey(row), row]));
  const baseline = new Map(baselineRows.map((row) => [candidateKey(row), row]));
  const addedOrChanged = currentRows.filter((row) => {
    const previous = baseline.get(candidateKey(row));
    return !previous || candidateEvidence(previous) !== candidateEvidence(row);
  });
  const scanTokens = new Set(addedOrChanged.map((row) => row.token_address));
  const removedOrChanged = baselineRows.filter((row) => {
    const latest = current.get(candidateKey(row));
    return !latest || candidateEvidence(latest) !== candidateEvidence(row);
  });
  return Object.freeze({
    rows: currentRows.filter((row) => scanTokens.has(row.token_address)),
    scanTokens: scanTokens.size,
    addedOrChangedCandidateRows: addedOrChanged.length,
    removedOrChangedCandidateRows: removedOrChanged.length,
    reconciliationTokens: new Set(removedOrChanged.map((row) => row.token_address)).size,
  });
}

async function resolveCandidateScope(input, query, currentRows, completeThroughBlock) {
  if (input.baselineRunId == null) return { rows: currentRows, baseline: null };
  const baselineRunId = String(input.baselineRunId);
  if (!/^\d+$/.test(baselineRunId) || BigInt(baselineRunId) < 1n) {
    throw new Error('baselineRunId must be positive');
  }
  const baselineRun = (await query(BASELINE_RUN_SQL, [CHAIN, baselineRunId])).rows[0];
  if (baselineRun?.status !== 'completed'
      || baselineRun.rule_version !== 'rh_possible_bundle_v1'
      || baselineRun.evidence_version !== 'rh_native_funding_v2') {
    return unavailable('bundle_baseline_run_unavailable');
  }
  if (BigInt(baselineRun.source_through_block) > BigInt(completeThroughBlock)) {
    return unavailable('bundle_baseline_frontier_ahead');
  }
  const baselineRows = (await query(BASELINE_CANDIDATES_SQL, [baselineRunId])).rows;
  const delta = incrementalCandidates(currentRows, baselineRows);
  return { rows: delta.rows, baseline: Object.freeze({ runId: baselineRunId,
    sourceThroughBlock: String(baselineRun.source_through_block),
    lookbackBlocks: String(baselineRun.lookback_blocks),
    candidateRows: baselineRows.length, scanTokens: delta.scanTokens,
    addedOrChangedCandidateRows: delta.addedOrChangedCandidateRows,
    removedOrChangedCandidateRows: delta.removedOrChangedCandidateRows,
    reconciliationTokens: delta.reconciliationTokens }) };
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

  async function load(input = {}) {
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
    const scope = await resolveCandidateScope(
      input, query, result.rows, completeThroughBlock
    );
    if (scope.ready === false) return scope;
    const { rows: candidateRows, baseline } = scope;
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
      candidateScope: baseline ? 'incremental' : 'full',
      baseline,
      fullCandidateRows: result.rows.length,
      candidates: Object.freeze(candidateRows.map(normalizeCandidate)),
    });
  }

  return Object.freeze({ load });
}

module.exports = {
  createRobinhoodBundleFundingCandidateSource,
  __private: {
    ANCHOR_COVERAGE_SQL, BASELINE_CANDIDATES_SQL, BASELINE_RUN_SQL,
    CANDIDATES_SQL, COVERAGE_SQL, MAX_CANDIDATE_ROWS,
    incrementalCandidates, normalizeCandidate, resolveCandidateScope,
  },
};
