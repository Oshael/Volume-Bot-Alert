const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');

const CHAIN = 'robinhood';

function boundedLimit(value, fallback = 100) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 1000) return fallback;
  return parsed;
}

function createRobinhoodTokenAttributionRepository(options = {}) {
  const database = options.database || db;

  async function listCreatorCandidates(input = {}) {
    const retryBefore = new Date(input.retryBefore || 0);
    if (!Number.isFinite(retryBefore.getTime())) throw new Error('retryBefore is invalid');
    const { rows } = await database.query(
      `SELECT registry.token_address, MIN(registry.discovery_block) AS discovery_block
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
    return rows.map((row) => ({
      tokenAddress: normalizeTokenAddress(CHAIN, row.token_address),
      discoveryBlock: String(row.discovery_block),
    }));
  }

  async function recordAttempt(input = {}) {
    const tokenAddress = normalizeTokenAddress(CHAIN, input.tokenAddress);
    const creatorAddress = input.creatorAddress == null
      ? null : normalizeTokenAddress(CHAIN, input.creatorAddress);
    const lastError = creatorAddress ? null : String(input.error || 'creator_unavailable').slice(0, 500);
    const { rows } = await database.query(
      `INSERT INTO robinhood_token_attributions (
         chain, token_address, creator_address, source,
         last_attempted_at, last_resolved_at, last_error
       ) VALUES ('${CHAIN}', $1, $2, 'blockscout', NOW(),
                 CASE WHEN $2::varchar IS NULL THEN NULL ELSE NOW() END, $3)
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
      [tokenAddress, creatorAddress, lastError]
    );
    return rows[0];
  }

  return Object.freeze({ listCreatorCandidates, recordAttempt });
}

module.exports = { createRobinhoodTokenAttributionRepository, __private: { boundedLimit } };
