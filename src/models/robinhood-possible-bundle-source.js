const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';
const RULE_VERSION = 'rh_possible_bundle_v1';
const EVIDENCE_VERSION = 'rh_native_funding_v2';
const MAX_CANDIDATES_PER_TOKEN = 10_000;
const MAX_EVIDENCE_ROWS_PER_TOKEN = 100_000;

const RUN_SQL = `SELECT id::text, status, rule_version, evidence_version,
       source_through_block::text, source_through_hash, lookback_blocks::text
  FROM robinhood_bundle_funding_backfill_runs
 WHERE chain = $1 AND id = $2::bigint`;

const CANDIDATES_SQL = `SELECT token_address, wallet_address,
       launch_block::text, first_buy_block::text,
       first_buy_transaction_index::text
  FROM robinhood_bundle_funding_backfill_candidates
 WHERE run_id = $1::bigint AND token_address = $2
 ORDER BY first_buy_block, first_buy_transaction_index, wallet_address
 LIMIT $3::int`;

const EVIDENCE_SQL = `SELECT token_address, candidate_wallet, hop,
       block_number::text, transaction_index::text, transaction_hash,
       from_wallet, to_wallet, value_wei::text
  FROM robinhood_bundle_funding_evidence
 WHERE chain = $1 AND run_id = $2::bigint AND token_address = $3
   AND evidence_version = $4
 ORDER BY candidate_wallet, block_number, transaction_index, transaction_hash, hop
 LIMIT $5::int`;

const BARRIERS_SQL = `WITH actors AS MATERIALIZED (
  SELECT candidate.wallet_address AS address,
         candidate.first_buy_block AS observed_block
    FROM robinhood_bundle_funding_backfill_candidates candidate
   WHERE candidate.run_id = $2::bigint AND candidate.token_address = $3
  UNION ALL
  SELECT evidence.from_wallet, evidence.block_number
    FROM robinhood_bundle_funding_evidence evidence
   WHERE evidence.chain = $1 AND evidence.run_id = $2::bigint
     AND evidence.token_address = $3 AND evidence.evidence_version = $4
  UNION ALL
  SELECT evidence.to_wallet, evidence.block_number
    FROM robinhood_bundle_funding_evidence evidence
   WHERE evidence.chain = $1 AND evidence.run_id = $2::bigint
     AND evidence.token_address = $3 AND evidence.evidence_version = $4
), barriers AS (
  SELECT actor.address
    FROM actors actor
    INNER JOIN robinhood_infrastructure_registry infrastructure
      ON infrastructure.chain = $1 AND infrastructure.address = actor.address
     AND infrastructure.valid_from_block <= actor.observed_block
     AND (infrastructure.valid_through_block IS NULL
       OR infrastructure.valid_through_block >= actor.observed_block)
  UNION
  SELECT actor.address
    FROM actors actor
    INNER JOIN robinhood_pool_registry pool
      ON pool.chain = $1 AND pool.discovery_block <= actor.observed_block
     AND (pool.pool_address = actor.address
       OR (pool.protocol = 'uniswap-v4' AND pool.origin_address = actor.address))
) SELECT DISTINCT address FROM barriers ORDER BY address`;

function boundedInteger(value, fallback, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${label} must be between 1 and ${maximum}`);
  }
  return parsed;
}

function unavailable(reason, tokenAddress, sourceRunId) {
  return Object.freeze({ ready: false, reason, tokenAddress, sourceRunId });
}

function candidate(row) {
  return Object.freeze({
    tokenAddress: row.token_address, walletAddress: row.wallet_address,
    launchBlock: String(row.launch_block), firstBuyBlock: String(row.first_buy_block),
    firstBuyTransactionIndex: String(row.first_buy_transaction_index),
  });
}

function evidence(row) {
  return Object.freeze({
    tokenAddress: row.token_address, candidateWallet: row.candidate_wallet,
    hop: Number(row.hop), blockNumber: String(row.block_number),
    transactionIndex: String(row.transaction_index), transactionHash: row.transaction_hash,
    fromAddress: row.from_wallet, toAddress: row.to_wallet,
    valueWei: String(row.value_wei),
  });
}

function createRobinhoodPossibleBundleSource(options = {}) {
  const database = options.database || db;
  const statementTimeoutMs = boundedInteger(
    options.statementTimeoutMs, 120_000, 900_000, 'statementTimeoutMs'
  );
  const maxCandidates = boundedInteger(
    options.maxCandidatesPerToken, MAX_CANDIDATES_PER_TOKEN,
    MAX_CANDIDATES_PER_TOKEN, 'maxCandidatesPerToken'
  );
  const maxEvidenceRows = boundedInteger(
    options.maxEvidenceRowsPerToken, MAX_EVIDENCE_ROWS_PER_TOKEN,
    MAX_EVIDENCE_ROWS_PER_TOKEN, 'maxEvidenceRowsPerToken'
  );
  const query = (sql, params) => (typeof database.queryWithStatementTimeout === 'function'
    ? database.queryWithStatementTimeout(sql, params, statementTimeoutMs)
    : database.query(sql, params));

  async function loadSeedToken(input = {}) {
    const sourceRunId = String(boundedInteger(
      input.runId, null, Number.MAX_SAFE_INTEGER, 'runId'
    ));
    const tokenAddress = normalizeTokenAddress(CHAIN, input.tokenAddress);
    const run = (await query(RUN_SQL, [CHAIN, sourceRunId])).rows[0];
    if (!run) return unavailable('funding_run_missing', tokenAddress, sourceRunId);
    if (run.status !== 'completed') {
      return unavailable('funding_run_incomplete', tokenAddress, sourceRunId);
    }
    if (run.rule_version !== RULE_VERSION || run.evidence_version !== EVIDENCE_VERSION) {
      return unavailable('funding_lineage_unsupported', tokenAddress, sourceRunId);
    }
    if (BigInt(run.lookback_blocks) <= 0n) {
      return unavailable('funding_policy_invalid', tokenAddress, sourceRunId);
    }
    const candidates = await query(
      CANDIDATES_SQL, [sourceRunId, tokenAddress, maxCandidates + 1]
    );
    if (candidates.rows.length > maxCandidates) {
      return unavailable('bundle_token_candidate_cap_exceeded', tokenAddress, sourceRunId);
    }
    if (candidates.rows.length < 2) {
      return unavailable('bundle_token_candidate_scope_too_small', tokenAddress, sourceRunId);
    }
    const evidenceRows = await query(EVIDENCE_SQL, [
      CHAIN, sourceRunId, tokenAddress, EVIDENCE_VERSION, maxEvidenceRows + 1,
    ]);
    if (evidenceRows.rows.length > maxEvidenceRows) {
      return unavailable('bundle_token_evidence_cap_exceeded', tokenAddress, sourceRunId);
    }
    const barriers = await query(BARRIERS_SQL, [
      CHAIN, sourceRunId, tokenAddress, EVIDENCE_VERSION,
    ]);
    return Object.freeze({
      ready: true, reason: null, tokenAddress, ruleVersion: RULE_VERSION,
      evidenceVersion: EVIDENCE_VERSION, sourceKind: 'seed', sourceRunId,
      lookbackBlocks: String(run.lookback_blocks),
      throughBlockNumber: String(run.source_through_block),
      throughBlockHash: run.source_through_hash,
      candidates: Object.freeze(candidates.rows.map(candidate)),
      evidence: Object.freeze(evidenceRows.rows.map(evidence)),
      barrierAddresses: Object.freeze(barriers.rows.map(({ address }) => address)),
    });
  }

  return Object.freeze({ loadSeedToken });
}

module.exports = {
  createRobinhoodPossibleBundleSource,
  __private: {
    BARRIERS_SQL, CANDIDATES_SQL, EVIDENCE_SQL, RUN_SQL,
    MAX_CANDIDATES_PER_TOKEN, MAX_EVIDENCE_ROWS_PER_TOKEN,
  },
};
