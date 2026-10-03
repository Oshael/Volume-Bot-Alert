const db = require('./db');
const { normalizeTokenAddress } = require('../utils/token-identity');
const { holderCanonicalReadySql } = require('./robinhood-holder-canonical-projection');
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

  async function listCandidatePage(input = {}) {
    const limit = boundedInteger(input.limit, 20, 1, 100, 'candidate limit');
    const unavailableRetryMs = boundedInteger(
      input.unavailableRetryMs, 3_600_000, 60_000, 86_400_000,
      'unavailable retry'
    );
    const afterToken = input.afterToken == null ? ''
      : normalizeTokenAddress('robinhood', input.afterToken);
    const scanLimit = limit * 5;
    const result = await database.query(
      `WITH capture AS MATERIALIZED (
         SELECT chain FROM robinhood_chain_capture_cursor WHERE chain='robinhood'
           AND recovery_state='running'
       ), scanned AS MATERIALIZED (
         SELECT chain, token_address, live_through_block, live_through_hash
         FROM robinhood_holder_token_states state JOIN capture USING (chain)
         WHERE state.chain = 'robinhood' AND state.ledger_status = 'live'
           AND state.live_through_block IS NOT NULL AND state.live_through_hash IS NOT NULL
           AND state.token_address > $4::varchar
         ORDER BY state.token_address LIMIT $5::int
       ), anchored AS MATERIALIZED (
         SELECT state.*, ${holderCanonicalReadySql()} AS canonical_ready FROM scanned state
       ), candidates AS MATERIALIZED (
         SELECT state.token_address, state.live_through_block, state.live_through_hash
         FROM anchored state
         LEFT JOIN robinhood_holder_classification_states lp
           ON lp.chain = state.chain AND lp.token_address = state.token_address
          AND lp.classifier = 'lp' AND lp.classification_version = $1
         LEFT JOIN robinhood_holder_classification_states cex
           ON cex.chain = state.chain AND cex.token_address = state.token_address
          AND cex.classifier = 'cex' AND cex.classification_version = $1
         LEFT JOIN robinhood_holder_distribution_metrics dev
           ON dev.chain = state.chain AND dev.token_address = state.token_address
          AND dev.metric = 'dev_hold' AND dev.classification_version = $1
         LEFT JOIN robinhood_holder_distribution_metrics top10
           ON top10.chain = state.chain AND top10.token_address = state.token_address
          AND top10.metric = 'top10' AND top10.classification_version = $1
         LEFT JOIN robinhood_holder_distribution_metrics top50
           ON top50.chain = state.chain AND top50.token_address = state.token_address
          AND top50.metric = 'top50' AND top50.classification_version = $1
        WHERE state.canonical_ready
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
            OR top10.token_address IS NULL
            OR (top10.status IN ('ready', 'stale', 'reorged') AND
                (top10.through_block_number, top10.through_block_hash)
                  IS DISTINCT FROM (state.live_through_block, state.live_through_hash))
            OR (top10.status NOT IN ('ready', 'stale', 'reorged')
                AND top10.updated_at <= NOW() - ($2::int * INTERVAL '1 millisecond'))
            OR top50.token_address IS NULL
            OR (top50.status IN ('ready', 'stale', 'reorged') AND
                (top50.through_block_number, top50.through_block_hash)
                  IS DISTINCT FROM (state.live_through_block, state.live_through_hash))
            OR (top50.status NOT IN ('ready', 'stale', 'reorged')
                AND top50.updated_at <= NOW() - ($2::int * INTERVAL '1 millisecond'))
          )
        ORDER BY state.token_address LIMIT $3::int
       ) SELECT
         (SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'tokenAddress', token_address,
           'throughBlockNumber', live_through_block::text,
           'throughBlockHash', live_through_hash
         ) ORDER BY token_address), '[]'::jsonb) FROM candidates) AS candidates,
         (SELECT COUNT(*)::int FROM scanned) AS scanned,
         (SELECT MAX(token_address) FROM scanned) AS next_token,
         (SELECT COUNT(*)::int FROM anchored WHERE NOT canonical_ready) AS unanchored`,
      [HOLDER_CLASSIFICATION_VERSION, unavailableRetryMs, limit, afterToken, scanLimit]
    );
    const row = result.rows[0];
    const candidates = Object.freeze(row.candidates.map(Object.freeze));
    const nextToken = candidates.length === limit
      ? candidates.at(-1).tokenAddress : row.next_token;
    return Object.freeze({
      candidates, nextToken, scanned: row.scanned, unanchored: row.unanchored,
      exhausted: row.scanned < scanLimit && nextToken === row.next_token,
    });
  }

  async function listCandidates(input = {}) {
    return Object.freeze((await listCandidatePage(input)).candidates
      .map(({ tokenAddress }) => tokenAddress));
  }

  return Object.freeze({ listCandidatePage, listCandidates });
}

module.exports = { createRobinhoodHolderIntelligenceCandidateRepository };
