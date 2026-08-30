const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const {
  HOLDER_CLASSIFICATION_VERSION,
  compareClassificationFrontiers,
  normalizeClassificationFrontier,
  normalizeHolderClassification,
} = require('../services/robinhood-holder-classification-domain');
const { RULE_VERSION } = require('../services/robinhood-fresh-wallet-rule');

const CHAIN = 'robinhood';
const FRONTIER_STATUSES = new Set(['ready', 'stale', 'reorged']);
const TERMINAL_STATUSES = new Set(['ready', 'unavailable', 'stale', 'reorged']);

function decimal(value, label) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) throw new Error(`${label} must be an unsigned integer`);
  return BigInt(normalized).toString();
}

function identifier(value, label) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(normalized)) {
    throw new Error(`${label} must be a lowercase identifier`);
  }
  return normalized;
}

function instant(value, label) {
  const timestamp = Date.parse(String(value ?? ''));
  if (!Number.isFinite(timestamp)) throw new Error(`${label} must be an ISO instant`);
  return new Date(timestamp).toISOString();
}

function jsonObject(value) {
  let normalized;
  try { normalized = JSON.parse(JSON.stringify(value)); } catch { normalized = null; }
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object'
      || !Object.keys(normalized).length) throw new Error('evidence must be a JSON object');
  return normalized;
}

function firstDefined(primary, fallback) {
  return primary == null ? fallback : primary;
}

function normalizeEvaluationFrontier(status, input, evidence) {
  if (!FRONTIER_STATUSES.has(status)) return null;
  return normalizeClassificationFrontier({
    blockNumber: firstDefined(input.throughBlockNumber, evidence.firstBuy?.blockNumber),
    blockHash: firstDefined(input.throughBlockHash, evidence.firstBuy?.blockHash),
  });
}

function normalizeReadyResult(input, context) {
  const decision = input.decision || {};
  if (decision.ruleVersion !== RULE_VERSION
      || !['fresh', 'not_fresh'].includes(decision.outcome)) {
    throw new Error('ready FRESH evaluation requires a valid decision');
  }
  const firstBuy = context.evidence.firstBuy || {};
  const evidenceMatches = context.evidence.ruleVersion === RULE_VERSION
    && String(firstBuy.walletAddress).toLowerCase() === context.walletAddress
    && decimal(firstBuy.blockNumber, 'evidence.firstBuy.blockNumber')
      === context.frontier.blockNumber
    && String(firstBuy.blockHash).toLowerCase() === context.frontier.blockHash;
  if (!evidenceMatches) throw new Error('FRESH evidence does not match the queue item');
  const classification = decision.outcome === 'fresh' ? normalizeHolderClassification({
    tokenAddress: context.tokenAddress, walletAddress: context.walletAddress, tag: 'fresh',
    classificationVersion: HOLDER_CLASSIFICATION_VERSION,
    confidence: decision.confidence, reasonCode: decision.reasonCode,
    evidence: { ...context.evidence, decision },
    throughBlockNumber: context.frontier.blockNumber,
    throughBlockHash: context.frontier.blockHash,
    observedAt: context.observedAt,
  }) : null;
  return { outcome: decision.outcome, classification };
}

function normalizeEvaluation(input = {}) {
  const tokenAddress = normalizeTokenAddress(CHAIN, input.tokenAddress);
  const walletAddress = normalizeTokenAddress(CHAIN, input.walletAddress);
  const queueVersion = decimal(input.requestedVersion, 'requestedVersion');
  const status = String(input.status ?? '').trim().toLowerCase();
  if (!TERMINAL_STATUSES.has(status)) throw new Error(`Unsupported FRESH status: ${status}`);
  const evidence = jsonObject(input.evidence);
  const observedAt = instant(firstDefined(input.observedAt, evidence.observedAt), 'observedAt');
  const statusReason = identifier(
    firstDefined(input.statusReason, input.decision?.outcomeReason), 'statusReason'
  );
  const frontier = normalizeEvaluationFrontier(status, input, evidence);
  const ready = status === 'ready' ? normalizeReadyResult(input, {
    tokenAddress, walletAddress, evidence, observedAt, frontier,
  }) : { outcome: null, classification: null };
  return Object.freeze({
    tokenAddress, walletAddress, queueVersion, status, outcome: ready.outcome, statusReason,
    evidence, observedAt, frontier, classification: ready.classification,
  });
}

function currentFrontier(row) {
  return row?.through_block_number == null ? null : {
    blockNumber: String(row.through_block_number), blockHash: row.through_block_hash,
  };
}

function planSameFrontier(current, candidate, options, sameVersion) {
  if (current.status === candidate.status && current.outcome === candidate.outcome) {
    return 'unchanged';
  }
  if (sameVersion && options.allowSameFrontierReplacement !== true) {
    throw new Error('Conflicting FRESH evaluation at the same frontier');
  }
  return 'replace';
}

function planNoFrontierReplacement(current, candidate, sameVersion) {
  if (candidate.frontier || !sameVersion) return 'replace';
  if (current.status !== candidate.status) return 'replace';
  return current.status_reason === candidate.statusReason ? 'unchanged' : 'replace';
}

function planFrontierReplacement(current, candidate, options, sameVersion) {
  const oldFrontier = currentFrontier(current);
  if (!oldFrontier) return planNoFrontierReplacement(current, candidate, sameVersion);
  if (!candidate.frontier && options.allowReset !== true) {
    throw new Error('FRESH frontier reset requires explicit replacement');
  }
  if (!candidate.frontier) return 'replace';
  const relation = compareClassificationFrontiers(candidate.frontier, oldFrontier);
  if (relation === 'behind') return 'ignore';
  if (relation === 'fork' && options.allowForkReplacement !== true) {
    throw new Error('FRESH frontier fork requires explicit replacement');
  }
  return relation === 'same'
    ? planSameFrontier(current, candidate, options, sameVersion)
    : 'replace';
}

function planReplacement(current, candidate, options = {}) {
  if (!current) return 'replace';
  const currentVersion = BigInt(current.queue_version);
  const candidateVersion = BigInt(candidate.queueVersion);
  if (currentVersion > candidateVersion) return 'ignore';
  return planFrontierReplacement(
    current, candidate, options, currentVersion === candidateVersion
  );
}

function matchesCanonicalFirstBuy(evaluation, row) {
  if (evaluation.status !== 'ready') return true;
  const firstBuy = evaluation.evidence.firstBuy;
  return firstBuy.transactionHash.toLowerCase() === row.transaction_hash
    && BigInt(firstBuy.blockNumber) === BigInt(row.block_number)
    && firstBuy.blockHash.toLowerCase() === row.block_hash
    && Date.parse(firstBuy.blockTime) === Date.parse(row.block_time);
}

function createRobinhoodFreshWalletShadowRepository(options = {}) {
  const database = options.database || db;

  async function replaceAndComplete(input = {}, transitionOptions = {}) {
    const evaluation = normalizeEvaluation(input);
    const owner = String(input.owner ?? '').trim();
    if (!owner || owner.length > 128) throw new Error('FRESH queue owner is invalid');
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`SELECT queue.requested_version::text,
          first_buy.transaction_hash, first_buy.block_number::text,
          first_buy.block_hash, first_buy.block_time
        FROM robinhood_fresh_wallet_queue queue
        INNER JOIN robinhood_wallet_token_first_buys first_buy USING (
          chain, token_address, wallet_address
        )
        WHERE chain = $1 AND token_address = $2 AND wallet_address = $3
          AND rule_version = $4 AND queue.status = 'leased' AND lease_owner = $5
          AND requested_version = $6::bigint FOR UPDATE OF queue`, [
        CHAIN, evaluation.tokenAddress, evaluation.walletAddress, RULE_VERSION,
        owner, evaluation.queueVersion,
      ]);
      if (!locked.rowCount) { await client.query('ROLLBACK'); return { completed: false }; }
      if (!matchesCanonicalFirstBuy(evaluation, locked.rows[0])) {
        throw new Error('FRESH evidence no longer matches the canonical first-buy');
      }
      const stored = await client.query(`SELECT * FROM robinhood_fresh_wallet_evaluations
        WHERE chain = $1 AND token_address = $2 AND wallet_address = $3
          AND rule_version = $4 FOR UPDATE`, [
        CHAIN, evaluation.tokenAddress, evaluation.walletAddress, RULE_VERSION,
      ]);
      const action = planReplacement(stored.rows[0], evaluation, transitionOptions);
      if (action === 'replace') {
        await client.query(`INSERT INTO robinhood_fresh_wallet_evaluations (
          chain, token_address, wallet_address, rule_version, classification_version,
          queue_version, status, outcome, status_reason, evidence_json,
          through_block_number, through_block_hash, observed_at
        ) VALUES ($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9, $10::jsonb,
          $11::bigint, $12, $13::timestamptz)
        ON CONFLICT (chain, token_address, wallet_address, rule_version) DO UPDATE SET
          classification_version = EXCLUDED.classification_version,
          queue_version = EXCLUDED.queue_version, status = EXCLUDED.status,
          outcome = EXCLUDED.outcome, status_reason = EXCLUDED.status_reason,
          evidence_json = EXCLUDED.evidence_json,
          through_block_number = EXCLUDED.through_block_number,
          through_block_hash = EXCLUDED.through_block_hash,
          observed_at = EXCLUDED.observed_at, updated_at = NOW()`, [
          CHAIN, evaluation.tokenAddress, evaluation.walletAddress, RULE_VERSION,
          HOLDER_CLASSIFICATION_VERSION, evaluation.queueVersion, evaluation.status,
          evaluation.outcome, evaluation.statusReason, JSON.stringify(evaluation.evidence),
          evaluation.frontier?.blockNumber ?? null,
          evaluation.frontier?.blockHash ?? null, evaluation.observedAt,
        ]);
        if (evaluation.classification) {
          const record = evaluation.classification;
          await client.query(`INSERT INTO robinhood_holder_classifications (
            chain, token_address, wallet_address, tag, classification_version,
            confidence, reason_code, evidence_json, through_block_number,
            through_block_hash, observed_at
          ) VALUES ($1, $2, $3, 'fresh', $4, $5, $6, $7::jsonb, $8::bigint, $9, $10)
          ON CONFLICT (chain, token_address, wallet_address, tag, classification_version)
          DO UPDATE SET confidence = EXCLUDED.confidence, reason_code = EXCLUDED.reason_code,
            evidence_json = EXCLUDED.evidence_json,
            through_block_number = EXCLUDED.through_block_number,
            through_block_hash = EXCLUDED.through_block_hash,
            observed_at = EXCLUDED.observed_at, updated_at = NOW()`, [
            CHAIN, record.tokenAddress, record.walletAddress, record.classificationVersion,
            record.confidence, record.reasonCode, JSON.stringify(record.evidence),
            record.throughBlockNumber, record.throughBlockHash, record.observedAt,
          ]);
        } else {
          await client.query(`DELETE FROM robinhood_holder_classifications
            WHERE chain = $1 AND token_address = $2 AND wallet_address = $3
              AND tag = 'fresh' AND classification_version = $4`, [
            CHAIN, evaluation.tokenAddress, evaluation.walletAddress,
            HOLDER_CLASSIFICATION_VERSION,
          ]);
        }
      } else if (action === 'ignore') {
        await client.query(`UPDATE robinhood_fresh_wallet_evaluations
          SET queue_version = GREATEST(queue_version, $5::bigint), updated_at = NOW()
          WHERE chain = $1 AND token_address = $2 AND wallet_address = $3
            AND rule_version = $4`, [
          CHAIN, evaluation.tokenAddress, evaluation.walletAddress, RULE_VERSION,
          evaluation.queueVersion,
        ]);
      }
      await client.query(`UPDATE robinhood_fresh_wallet_queue SET
        status = 'complete', completed_version = requested_version,
        lease_owner = NULL, lease_until = NULL, completed_at = NOW(),
        last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
        WHERE chain = $1 AND token_address = $2 AND wallet_address = $3
          AND rule_version = $4`, [
        CHAIN, evaluation.tokenAddress, evaluation.walletAddress, RULE_VERSION,
      ]);
      await client.query('COMMIT');
      return Object.freeze({ completed: true, status: action });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  return Object.freeze({ replaceAndComplete });
}

module.exports = {
  createRobinhoodFreshWalletShadowRepository,
  __private: { normalizeEvaluation, planReplacement },
};
