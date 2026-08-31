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

const evaluationKey = (value) => `${value.tokenAddress || value.token_address}:`;
const pairKey = (value) => `${evaluationKey(value)}${value.walletAddress || value.wallet_address}`;

function createRobinhoodFreshWalletShadowRepository(options = {}) {
  const database = options.database || db;

  async function replaceAndCompleteBatch(inputs = [], transitionOptions = {}) {
    if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) {
      throw new Error('FRESH materialization batch must contain between 1 and 100 items');
    }
    const prepared = inputs.map((input) => {
      const evaluation = normalizeEvaluation(input);
      const owner = String(input.owner ?? '').trim();
      if (!owner || owner.length > 128) throw new Error('FRESH queue owner is invalid');
      return { evaluation, owner };
    });
    const leaseRows = prepared.map(({ evaluation, owner }) => ({
      token_address: evaluation.tokenAddress, wallet_address: evaluation.walletAddress,
      queue_version: evaluation.queueVersion, owner,
    }));
    const client = await database.getClient();
    try {
      await client.query('BEGIN');
      const locked = await client.query(`WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
          token_address varchar, wallet_address varchar, queue_version bigint, owner varchar
        )
      ) SELECT input.token_address, input.wallet_address, queue.requested_version::text,
          first_buy.transaction_hash, first_buy.block_number::text,
          first_buy.block_hash, first_buy.block_time
        FROM input INNER JOIN robinhood_fresh_wallet_queue queue
          ON queue.chain = $2 AND queue.token_address = input.token_address
         AND queue.wallet_address = input.wallet_address AND queue.rule_version = $3
         AND queue.requested_version = input.queue_version
         AND queue.status = 'leased' AND queue.lease_owner = input.owner
        INNER JOIN robinhood_wallet_token_first_buys first_buy
          ON first_buy.chain = queue.chain AND first_buy.token_address = queue.token_address
         AND first_buy.wallet_address = queue.wallet_address
        FOR UPDATE OF queue`, [JSON.stringify(leaseRows), CHAIN, RULE_VERSION]);
      const lockedByKey = new Map(locked.rows.map((row) => [pairKey(row), row]));
      const active = prepared.filter(({ evaluation }) => lockedByKey.has(pairKey(evaluation)));
      for (const { evaluation } of active) {
        if (!matchesCanonicalFirstBuy(evaluation, lockedByKey.get(pairKey(evaluation)))) {
          throw new Error('FRESH evidence no longer matches the canonical first-buy');
        }
      }
      const activePairs = active.map(({ evaluation }) => ({
        token_address: evaluation.tokenAddress, wallet_address: evaluation.walletAddress,
      }));
      const stored = active.length ? await client.query(`WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
          token_address varchar, wallet_address varchar
        )
      ) SELECT evaluation.* FROM input
        INNER JOIN robinhood_fresh_wallet_evaluations evaluation
          ON evaluation.chain = $2 AND evaluation.token_address = input.token_address
         AND evaluation.wallet_address = input.wallet_address AND evaluation.rule_version = $3
        FOR UPDATE OF evaluation`, [JSON.stringify(activePairs), CHAIN, RULE_VERSION]) : { rows: [] };
      const storedByKey = new Map(stored.rows.map((row) => [pairKey(row), row]));
      const planned = active.map((item) => ({ ...item,
        action: planReplacement(storedByKey.get(pairKey(item.evaluation)),
          item.evaluation, transitionOptions),
      }));
      const replacements = planned.filter(({ action }) => action === 'replace');
      if (replacements.length) {
        const rows = replacements.map(({ evaluation }) => ({
          token_address: evaluation.tokenAddress, wallet_address: evaluation.walletAddress,
          queue_version: evaluation.queueVersion, status: evaluation.status,
          outcome: evaluation.outcome, status_reason: evaluation.statusReason,
          evidence_json: evaluation.evidence,
          through_block_number: evaluation.frontier?.blockNumber ?? null,
          through_block_hash: evaluation.frontier?.blockHash ?? null,
          observed_at: evaluation.observedAt,
        }));
        await client.query(`WITH input AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
            token_address varchar, wallet_address varchar, queue_version bigint,
            status varchar, outcome varchar, status_reason varchar, evidence_json jsonb,
            through_block_number bigint, through_block_hash varchar, observed_at timestamptz
          )
        ) INSERT INTO robinhood_fresh_wallet_evaluations (
          chain, token_address, wallet_address, rule_version, classification_version,
          queue_version, status, outcome, status_reason, evidence_json,
          through_block_number, through_block_hash, observed_at
        ) SELECT $2, token_address, wallet_address, $3, $4, queue_version, status,
          outcome, status_reason, evidence_json, through_block_number,
          through_block_hash, observed_at FROM input
        ON CONFLICT (chain, token_address, wallet_address, rule_version) DO UPDATE SET
          classification_version = EXCLUDED.classification_version,
          queue_version = EXCLUDED.queue_version, status = EXCLUDED.status,
          outcome = EXCLUDED.outcome, status_reason = EXCLUDED.status_reason,
          evidence_json = EXCLUDED.evidence_json,
          through_block_number = EXCLUDED.through_block_number,
          through_block_hash = EXCLUDED.through_block_hash,
          observed_at = EXCLUDED.observed_at, updated_at = NOW()`, [JSON.stringify(rows),
          CHAIN, RULE_VERSION, HOLDER_CLASSIFICATION_VERSION]);
        const classified = replacements.map(({ evaluation }) => evaluation.classification)
          .filter(Boolean);
        if (classified.length) {
          const classifications = classified.map((record) => ({
            token_address: record.tokenAddress, wallet_address: record.walletAddress,
            confidence: record.confidence, reason_code: record.reasonCode,
            evidence_json: record.evidence, through_block_number: record.throughBlockNumber,
            through_block_hash: record.throughBlockHash, observed_at: record.observedAt,
          }));
          await client.query(`WITH input AS (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
              token_address varchar, wallet_address varchar, confidence varchar,
              reason_code varchar, evidence_json jsonb, through_block_number bigint,
              through_block_hash varchar, observed_at timestamptz
            )
          ) INSERT INTO robinhood_holder_classifications (
            chain, token_address, wallet_address, tag, classification_version,
            confidence, reason_code, evidence_json, through_block_number,
            through_block_hash, observed_at
          ) SELECT $2, token_address, wallet_address, 'fresh', $3, confidence,
            reason_code, evidence_json, through_block_number, through_block_hash,
            observed_at FROM input
          ON CONFLICT (chain, token_address, wallet_address, tag, classification_version)
          DO UPDATE SET confidence = EXCLUDED.confidence, reason_code = EXCLUDED.reason_code,
            evidence_json = EXCLUDED.evidence_json,
            through_block_number = EXCLUDED.through_block_number,
            through_block_hash = EXCLUDED.through_block_hash,
            observed_at = EXCLUDED.observed_at, updated_at = NOW()`, [
            JSON.stringify(classifications), CHAIN, HOLDER_CLASSIFICATION_VERSION]);
        }
        const removals = replacements.filter(({ evaluation }) => !evaluation.classification)
          .map(({ evaluation }) => ({ token_address: evaluation.tokenAddress,
            wallet_address: evaluation.walletAddress }));
        if (removals.length) await client.query(`WITH input AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
            token_address varchar, wallet_address varchar
          )
        ) DELETE FROM robinhood_holder_classifications classification USING input
          WHERE classification.chain = $2 AND classification.token_address = input.token_address
            AND classification.wallet_address = input.wallet_address AND classification.tag = 'fresh'
            AND classification.classification_version = $3`, [JSON.stringify(removals),
          CHAIN, HOLDER_CLASSIFICATION_VERSION]);
      }
      const ignored = planned.filter(({ action }) => action === 'ignore')
        .map(({ evaluation }) => ({ token_address: evaluation.tokenAddress,
          wallet_address: evaluation.walletAddress, queue_version: evaluation.queueVersion }));
      if (ignored.length) await client.query(`WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
          token_address varchar, wallet_address varchar, queue_version bigint
        )
      ) UPDATE robinhood_fresh_wallet_evaluations evaluation
        SET queue_version = GREATEST(evaluation.queue_version, input.queue_version), updated_at = NOW()
        FROM input WHERE evaluation.chain = $2 AND evaluation.token_address = input.token_address
          AND evaluation.wallet_address = input.wallet_address AND evaluation.rule_version = $3`, [
        JSON.stringify(ignored), CHAIN, RULE_VERSION]);
      if (active.length) await client.query(`WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS item(
          token_address varchar, wallet_address varchar, queue_version bigint, owner varchar
        )
      ) UPDATE robinhood_fresh_wallet_queue queue SET
        status = 'complete', completed_version = requested_version,
        lease_owner = NULL, lease_until = NULL, completed_at = NOW(),
        last_error_code = NULL, last_error_message = NULL, updated_at = NOW()
        FROM input WHERE queue.chain = $2 AND queue.token_address = input.token_address
          AND queue.wallet_address = input.wallet_address AND queue.rule_version = $3
          AND queue.status = 'leased' AND queue.lease_owner = input.owner
          AND queue.requested_version = input.queue_version`, [JSON.stringify(leaseRows),
        CHAIN, RULE_VERSION]);
      await client.query('COMMIT');
      const plannedByKey = new Map(planned.map((item) => [pairKey(item.evaluation), item.action]));
      return Object.freeze(prepared.map(({ evaluation }) => Object.freeze(
        plannedByKey.has(pairKey(evaluation))
          ? { completed: true, status: plannedByKey.get(pairKey(evaluation)) }
          : { completed: false }
      )));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { client.release(); }
  }

  async function replaceAndComplete(input = {}, transitionOptions = {}) {
    return (await replaceAndCompleteBatch([input], transitionOptions))[0];
  }

  return Object.freeze({ replaceAndComplete, replaceAndCompleteBatch });
}

module.exports = {
  createRobinhoodFreshWalletShadowRepository,
  __private: { normalizeEvaluation, planReplacement },
};
