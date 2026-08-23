const db = require('../models/db');
const {
  HOLDER_CLASSIFICATION_VERSION,
} = require('./robinhood-holder-classification-domain');

const AUDIT_SQL = `WITH eligible AS (
  SELECT ledger.token_address, edge.to_wallet AS wallet_address,
         attribution.creator_address,
         edge.first_wallet_transfer_block::text AS transfer_block,
         edge.first_wallet_transfer_log_index::text AS transfer_log_index,
         edge.first_wallet_transfer_transaction_hash AS transaction_hash,
         edge.first_wallet_transfer_amount_raw::text AS amount_raw
    FROM robinhood_holder_token_states ledger
    INNER JOIN robinhood_token_attributions attribution
      ON attribution.chain = ledger.chain
     AND attribution.token_address = ledger.token_address
    INNER JOIN robinhood_wallet_transfer_edges edge
      ON edge.chain = ledger.chain AND edge.token_address = ledger.token_address
     AND edge.classification_version = 'rh_transfer_v1'
     AND edge.from_wallet = attribution.creator_address
     AND edge.to_wallet NOT IN (
       attribution.creator_address,
       '0x0000000000000000000000000000000000000000',
       '0x000000000000000000000000000000000000dead'
     )
     AND edge.first_wallet_transfer_block IS NOT NULL
     AND edge.first_wallet_transfer_amount_raw > 0
     AND edge.first_wallet_transfer_block <= ledger.live_through_block
   WHERE ledger.chain = 'robinhood' AND ledger.ledger_status = 'live'
     AND ledger.live_through_block IS NOT NULL AND ledger.live_through_hash IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM robinhood_infrastructure_registry infrastructure
        WHERE infrastructure.chain = edge.chain AND infrastructure.address = edge.to_wallet
          AND infrastructure.valid_from_block <= edge.first_wallet_transfer_block
          AND (infrastructure.valid_through_block IS NULL
            OR infrastructure.valid_through_block >= edge.first_wallet_transfer_block)
     )
     AND NOT EXISTS (
       SELECT 1 FROM robinhood_pool_registry pool
        WHERE pool.chain = edge.chain AND pool.token_address = edge.token_address
          AND pool.discovery_block <= edge.first_wallet_transfer_block
          AND (pool.pool_address = edge.to_wallet
            OR (pool.protocol = 'uniswap-v4' AND pool.origin_address = edge.to_wallet))
     )
), classified AS (
  SELECT * FROM robinhood_holder_classifications
   WHERE chain = 'robinhood' AND tag = 'insider' AND classification_version = $1
), compared AS (
  SELECT COALESCE(classified.token_address, eligible.token_address) AS token_address,
         COALESCE(classified.wallet_address, eligible.wallet_address) AS wallet_address,
         COALESCE(eligible.creator_address,
           classified.evidence_json #>> '{creator,address}') AS creator_address,
         COALESCE(eligible.transaction_hash,
           classified.evidence_json #>> '{transfer,transactionHash}') AS transaction_hash,
         COALESCE(eligible.transfer_block,
           classified.evidence_json #>> '{transfer,blockNumber}') AS transfer_block,
         COALESCE(eligible.transfer_log_index,
           classified.evidence_json #>> '{transfer,logIndex}') AS transfer_log_index,
         COALESCE(eligible.amount_raw,
           classified.evidence_json #>> '{transfer,amountRaw}') AS amount_raw,
         classified.token_address IS NOT NULL AS classified,
         eligible.token_address IS NOT NULL AS eligible,
         CASE
           WHEN classified.token_address IS NULL AND (
             snapshot.status = 'ready'
             AND snapshot.through_block_number = ledger.live_through_block
             AND snapshot.through_block_hash = ledger.live_through_hash
           ) IS NOT TRUE THEN 'pending_snapshot'
           WHEN classified.token_address IS NULL THEN 'missing_classification'
           WHEN eligible.token_address IS NULL THEN 'classification_without_eligible_evidence'
           WHEN classified.reason_code IS DISTINCT FROM 'creator_token_distribution'
             OR classified.confidence IS DISTINCT FROM 'high'
             OR classified.evidence_json #>> '{rule,evidenceVersion}'
               IS DISTINCT FROM 'rh_insider_direct_v1'
             OR classified.evidence_json #>> '{creator,address}'
               IS DISTINCT FROM eligible.creator_address
             OR classified.evidence_json #>> '{transfer,transactionHash}'
               IS DISTINCT FROM eligible.transaction_hash
             OR classified.evidence_json #>> '{transfer,blockNumber}'
               IS DISTINCT FROM eligible.transfer_block
             OR classified.evidence_json #>> '{transfer,logIndex}'
               IS DISTINCT FROM eligible.transfer_log_index
             OR classified.evidence_json #>> '{transfer,amountRaw}'
               IS DISTINCT FROM eligible.amount_raw
             THEN 'evidence_mismatch'
           WHEN snapshot.status IS DISTINCT FROM 'ready'
             OR snapshot.through_block_number IS DISTINCT FROM classified.through_block_number
             OR snapshot.through_block_hash IS DISTINCT FROM classified.through_block_hash
             THEN 'snapshot_incoherent'
           WHEN snapshot.through_block_number IS DISTINCT FROM ledger.live_through_block
             OR snapshot.through_block_hash IS DISTINCT FROM ledger.live_through_hash
             THEN 'stale_snapshot'
           ELSE 'matched'
         END AS outcome
    FROM classified FULL OUTER JOIN eligible
      ON eligible.token_address = classified.token_address
     AND eligible.wallet_address = classified.wallet_address
    LEFT JOIN robinhood_holder_classification_states snapshot
      ON snapshot.chain = 'robinhood'
     AND snapshot.token_address = COALESCE(classified.token_address, eligible.token_address)
     AND snapshot.classifier = 'insider' AND snapshot.classification_version = $1
    LEFT JOIN robinhood_holder_token_states ledger
      ON ledger.chain = 'robinhood'
     AND ledger.token_address = COALESCE(classified.token_address, eligible.token_address)
), snapshot_stats AS (
  SELECT COUNT(*)::int AS snapshot_tokens,
         COUNT(*) FILTER (WHERE snapshot.status = 'ready'
           AND snapshot.through_block_number = ledger.live_through_block
           AND snapshot.through_block_hash = ledger.live_through_hash)::int
           AS current_snapshot_tokens
    FROM robinhood_holder_classification_states snapshot
    LEFT JOIN robinhood_holder_token_states ledger
      ON ledger.chain = snapshot.chain AND ledger.token_address = snapshot.token_address
   WHERE snapshot.chain = 'robinhood' AND snapshot.classifier = 'insider'
     AND snapshot.classification_version = $1
), summary AS (
  SELECT COUNT(*) FILTER (WHERE eligible)::int AS eligible_wallets,
         COUNT(*) FILTER (WHERE classified)::int AS classified_wallets,
         COUNT(*) FILTER (WHERE outcome = 'matched')::int AS matched,
         COUNT(*) FILTER (WHERE outcome = 'pending_snapshot')::int AS pending,
         COUNT(*) FILTER (WHERE outcome = 'stale_snapshot')::int AS stale,
         COUNT(*) FILTER (WHERE outcome = 'missing_classification')::int AS missing,
         COUNT(*) FILTER (WHERE outcome IN (
           'classification_without_eligible_evidence', 'evidence_mismatch',
           'snapshot_incoherent'
         ))::int AS invalid,
         (SELECT snapshot_tokens FROM snapshot_stats) AS snapshot_tokens,
         (SELECT current_snapshot_tokens FROM snapshot_stats) AS current_snapshot_tokens
    FROM compared
), selected AS (
  SELECT * FROM compared
   ORDER BY CASE outcome
     WHEN 'missing_classification' THEN 0
     WHEN 'classification_without_eligible_evidence' THEN 1
     WHEN 'evidence_mismatch' THEN 2 WHEN 'snapshot_incoherent' THEN 3
     WHEN 'stale_snapshot' THEN 4 WHEN 'pending_snapshot' THEN 5 ELSE 6 END,
     MD5(token_address || wallet_address || $2)
   LIMIT $3::int
)
SELECT summary.*, selected.* FROM summary LEFT JOIN selected ON true`;

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function auditVerdict(summary) {
  if (summary.missing + summary.invalid) return 'divergence';
  if (!summary.snapshotTokens) return 'no_data';
  if (summary.pending || summary.stale) return 'incomplete';
  return 'clean';
}

function createRobinhoodInsiderShadowAuditor(options = {}) {
  const database = options.database || db;
  if (typeof database?.query !== 'function') throw new TypeError('INSIDER audit database is invalid');

  async function audit(input = {}) {
    const sampleLimit = boundedInteger(input.sampleLimit, 20, 1, 100, 'sampleLimit');
    const statementTimeoutMs = boundedInteger(
      input.statementTimeoutMs, 10_000, 100, 30_000, 'statementTimeoutMs'
    );
    const seed = String(input.seed || 'default').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(seed)) throw new Error('seed is invalid');
    const params = [HOLDER_CLASSIFICATION_VERSION, seed, sampleLimit];
    const result = typeof database.queryWithStatementTimeout === 'function'
      ? await database.queryWithStatementTimeout(AUDIT_SQL, params, statementTimeoutMs)
      : await database.query(AUDIT_SQL, params);
    const first = result.rows[0] || {};
    const summary = Object.freeze({
      eligibleWallets: Number(first.eligible_wallets || 0),
      classifiedWallets: Number(first.classified_wallets || 0),
      matched: Number(first.matched || 0), pending: Number(first.pending || 0),
      stale: Number(first.stale || 0), missing: Number(first.missing || 0),
      invalid: Number(first.invalid || 0),
      snapshotTokens: Number(first.snapshot_tokens || 0),
      currentSnapshotTokens: Number(first.current_snapshot_tokens || 0),
    });
    const samples = result.rows.filter((row) => row.token_address).map((row) => Object.freeze({
      outcome: row.outcome, tokenAddress: row.token_address,
      walletAddress: row.wallet_address, creatorAddress: row.creator_address || null,
      transactionHash: row.transaction_hash || null, blockNumber: row.transfer_block || null,
      logIndex: row.transfer_log_index || null, amountRaw: row.amount_raw || null,
    }));
    return Object.freeze({
      mode: 'read-only', verdict: auditVerdict(summary),
      selection: Object.freeze({ sampleLimit, seed, statementTimeoutMs }),
      summary, samples: Object.freeze(samples),
    });
  }

  return Object.freeze({ audit });
}

module.exports = { AUDIT_SQL, createRobinhoodInsiderShadowAuditor };
