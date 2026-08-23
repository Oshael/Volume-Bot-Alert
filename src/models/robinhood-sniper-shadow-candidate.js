const db = require('./db');
const {
  HOLDER_CLASSIFICATION_VERSION,
} = require('../services/robinhood-holder-classification-domain');
const {
  SNIPER_HIGH_CONFIDENCE_RULE,
} = require('../services/robinhood-holder-sniper-policy');
const { normalizeTokenAddress } = require('../utils/token-identity');

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function createRobinhoodSniperShadowCandidateRepository(options = {}) {
  const database = options.database || db;

  async function listCandidates(input = {}) {
    const limit = boundedInteger(input.limit, 10, 1, 100, 'candidate limit');
    const retryMs = boundedInteger(
      input.retryMs, 3_600_000, 60_000, 86_400_000, 'candidate retry'
    );
    const afterToken = input.afterToken == null ? null
      : normalizeTokenAddress('robinhood', input.afterToken);
    const { rows } = await database.query(
      `SELECT state.token_address
         FROM robinhood_holder_token_states state
         INNER JOIN robinhood_first_buy_live_cursors cursor
           ON cursor.chain = state.chain
          AND cursor.next_time = cursor.source_through
          AND cursor.source_next_block > state.live_through_block
         LEFT JOIN robinhood_holder_classification_states sniper
           ON sniper.chain = state.chain AND sniper.token_address = state.token_address
          AND sniper.classifier = 'sniper' AND sniper.classification_version = $1
        WHERE state.chain = 'robinhood' AND state.ledger_status = 'live'
          AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
          AND ($3::varchar IS NULL OR state.token_address > $3)
          AND (
            sniper.token_address IS NULL
            OR (sniper.status = 'ready' AND
                (sniper.through_block_number, sniper.through_block_hash)
                  IS DISTINCT FROM (state.live_through_block, state.live_through_hash))
            OR (sniper.status <> 'ready'
                AND sniper.updated_at <= NOW() - ($2::int * INTERVAL '1 millisecond'))
            OR EXISTS (
              SELECT 1 FROM robinhood_holder_classifications legacy
               WHERE legacy.chain = state.chain
                 AND legacy.token_address = state.token_address
                 AND legacy.tag = 'sniper' AND legacy.classification_version = $1
                 AND legacy.evidence_json #>> '{rule,evidenceVersion}'
                   IS DISTINCT FROM $5
            )
          )
        ORDER BY state.token_address LIMIT $4::int`,
      [
        HOLDER_CLASSIFICATION_VERSION, retryMs, afterToken, limit,
        SNIPER_HIGH_CONFIDENCE_RULE.evidenceVersion,
      ]
    );
    return Object.freeze(rows.map(({ token_address: tokenAddress }) => tokenAddress));
  }

  return Object.freeze({ listCandidates });
}

module.exports = { createRobinhoodSniperShadowCandidateRepository };
