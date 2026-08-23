const db = require('./db');
const {
  HOLDER_CLASSIFICATION_VERSION,
} = require('../services/robinhood-holder-classification-domain');
const { normalizeTokenAddress } = require('../utils/token-identity');

const PROJECTION_VERSION = 'rh_transfer_v1';
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function createRobinhoodInsiderShadowCandidateRepository(options = {}) {
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
         INNER JOIN robinhood_token_attributions attribution
           ON attribution.chain = state.chain AND attribution.token_address = state.token_address
          AND attribution.creator_address NOT IN ($5, $6)
          AND (attribution.attribution_block IS NULL
            OR attribution.attribution_block <= state.live_through_block)
         INNER JOIN robinhood_wallet_transfer_cursors cursor
           ON cursor.chain = state.chain AND cursor.projection_version = $2
          AND cursor.stream = 'live' AND cursor.lifecycle_state = 'running'
          AND cursor.next_block > state.live_through_block
         LEFT JOIN robinhood_holder_classification_states insider
           ON insider.chain = state.chain AND insider.token_address = state.token_address
          AND insider.classifier = 'insider' AND insider.classification_version = $1
        WHERE state.chain = 'robinhood' AND state.ledger_status = 'live'
          AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
          AND ($4::varchar IS NULL OR state.token_address > $4)
          AND EXISTS (
            SELECT 1 FROM robinhood_directional_transfer_replay_runs replay
             WHERE replay.chain = state.chain AND replay.projection_version = $2
               AND replay.status = 'completed'
          )
          AND (
            insider.token_address IS NULL
            OR (insider.status = 'ready' AND
                (insider.through_block_number, insider.through_block_hash)
                  IS DISTINCT FROM (state.live_through_block, state.live_through_hash))
            OR (insider.status <> 'ready'
                AND insider.updated_at <= NOW() - ($3::int * INTERVAL '1 millisecond'))
          )
        ORDER BY state.token_address LIMIT $7::int`,
      [HOLDER_CLASSIFICATION_VERSION, PROJECTION_VERSION, retryMs, afterToken,
        ZERO_ADDRESS, DEAD_ADDRESS, limit]
    );
    return Object.freeze(rows.map(({ token_address: tokenAddress }) => tokenAddress));
  }

  return Object.freeze({ listCandidates });
}

module.exports = { createRobinhoodInsiderShadowCandidateRepository };
