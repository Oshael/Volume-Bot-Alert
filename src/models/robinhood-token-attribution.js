const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';

function boundedLimit(value, fallback = 1000) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 10000) return fallback;
  return parsed;
}

function createRobinhoodTokenAttributionRepository(options = {}) {
  const database = options.database || db;

  async function listCreatorCandidates(input = {}) {
    const retryBefore = new Date(input.retryBefore || 0);
    if (!Number.isFinite(retryBefore.getTime())) throw new Error('retryBefore is invalid');
    const eligibleExpression = input.includeEligible === false ? 'NULL::bigint' : 'COUNT(*) OVER()';
    const { rows } = await database.query(
      `SELECT registry.token_address, MIN(registry.discovery_block) AS discovery_block,
              ${eligibleExpression} AS eligible_count
       FROM robinhood_pool_registry registry
       LEFT JOIN robinhood_token_attributions attribution
         ON attribution.chain = registry.chain
        AND attribution.token_address = registry.token_address
       WHERE registry.chain = '${CHAIN}'
         AND attribution.creator_address IS NULL
         AND (attribution.last_attempted_at IS NULL OR attribution.last_attempted_at < $1)
       GROUP BY registry.token_address
       ORDER BY MIN(registry.discovery_block), registry.token_address
       LIMIT $2::int`,
      [retryBefore.toISOString(), boundedLimit(input.limit)]
    );
    return Object.freeze({
      eligible: rows.length
        ? (rows[0].eligible_count == null ? null : Number(rows[0].eligible_count))
        : (input.includeEligible === false ? null : 0),
      candidates: Object.freeze(rows.map((row) => Object.freeze({
        tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
        discoveryBlock: String(row.discovery_block),
      }))),
    });
  }

  async function recordAttempts(inputs = []) {
    if (!Array.isArray(inputs) || inputs.length === 0) return [];
    const normalized = inputs.map((input) => {
      const creatorAddress = input.creatorAddress == null
        ? null : normalizeTokenAddress(CHAIN, input.creatorAddress);
      return {
        tokenAddress: normalizeTokenAddress(CHAIN, input.tokenAddress),
        creatorAddress,
        lastError: creatorAddress
          ? null : String(input.error || 'creator_unavailable').slice(0, 500),
      };
    });
    const { rows } = await database.query(
      `INSERT INTO robinhood_token_attributions (
         chain, token_address, creator_address, source,
         last_attempted_at, last_resolved_at, last_error
       ) SELECT '${CHAIN}', input.token_address, input.creator_address,
                'blockscout', NOW(),
                CASE WHEN input.creator_address IS NULL THEN NULL ELSE NOW() END,
                input.last_error
         FROM UNNEST($1::varchar[], $2::varchar[], $3::varchar[])
           AS input(token_address, creator_address, last_error)
       ON CONFLICT (chain, token_address) DO UPDATE SET
         creator_address = COALESCE(EXCLUDED.creator_address, robinhood_token_attributions.creator_address),
         last_attempted_at = NOW(),
         last_resolved_at = COALESCE(EXCLUDED.last_resolved_at, robinhood_token_attributions.last_resolved_at),
         last_error = CASE
           WHEN COALESCE(EXCLUDED.creator_address, robinhood_token_attributions.creator_address) IS NULL
             THEN EXCLUDED.last_error
           ELSE NULL
       END,
         updated_at = NOW()
       RETURNING *`,
      [
        normalized.map((item) => item.tokenAddress),
        normalized.map((item) => item.creatorAddress),
        normalized.map((item) => item.lastError),
      ]
    );
    return rows;
  }

  async function recordAttempt(input = {}) {
    return (await recordAttempts([input]))[0];
  }

  return Object.freeze({ listCreatorCandidates, recordAttempt, recordAttempts });
}

module.exports = { createRobinhoodTokenAttributionRepository, __private: { boundedLimit } };
