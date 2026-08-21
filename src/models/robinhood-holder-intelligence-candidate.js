const db = require('./db');
const {
  HOLDER_CLASSIFICATION_VERSION,
} = require('../services/robinhood-holder-classification-domain');

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function createRobinhoodHolderIntelligenceCandidateRepository(options = {}) {
  const database = options.database || db;

  async function listCandidates(input = {}) {
    const limit = boundedInteger(input.limit, 20, 1, 100, 'candidate limit');
    const unavailableRetryMs = boundedInteger(
      input.unavailableRetryMs, 3_600_000, 60_000, 86_400_000,
      'unavailable retry'
    );
    const result = await database.query(
      `SELECT state.token_address
         FROM robinhood_holder_token_states state
         LEFT JOIN robinhood_holder_classification_states lp
           ON lp.chain = state.chain AND lp.token_address = state.token_address
          AND lp.classifier = 'lp' AND lp.classification_version = $1
         LEFT JOIN robinhood_holder_classification_states cex
           ON cex.chain = state.chain AND cex.token_address = state.token_address
          AND cex.classifier = 'cex' AND cex.classification_version = $1
         LEFT JOIN robinhood_holder_distribution_metrics dev
           ON dev.chain = state.chain AND dev.token_address = state.token_address
          AND dev.metric = 'dev_hold' AND dev.classification_version = $1
        WHERE state.chain = 'robinhood' AND state.ledger_status = 'live'
          AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
          AND (
            lp.token_address IS NULL
            OR (lp.through_block_number, lp.through_block_hash)
                IS DISTINCT FROM (state.live_through_block, state.live_through_hash)
            OR cex.token_address IS NULL
            OR (cex.through_block_number, cex.through_block_hash)
                IS DISTINCT FROM (state.live_through_block, state.live_through_hash)
            OR dev.token_address IS NULL
            OR (dev.status IN ('ready', 'stale', 'reorged') AND
                (dev.through_block_number, dev.through_block_hash)
                  IS DISTINCT FROM (state.live_through_block, state.live_through_hash))
            OR (dev.status NOT IN ('ready', 'stale', 'reorged')
                AND dev.updated_at <= NOW() - ($2::int * INTERVAL '1 millisecond'))
          )
        ORDER BY LEAST(
          COALESCE(lp.updated_at, '-infinity'::timestamptz),
          COALESCE(cex.updated_at, '-infinity'::timestamptz),
          COALESCE(dev.updated_at, '-infinity'::timestamptz)
        ), state.token_address
        LIMIT $3::int`,
      [HOLDER_CLASSIFICATION_VERSION, unavailableRetryMs, limit]
    );
    return Object.freeze(result.rows.map(({ token_address: tokenAddress }) => tokenAddress));
  }

  return Object.freeze({ listCandidates });
}

module.exports = { createRobinhoodHolderIntelligenceCandidateRepository };
