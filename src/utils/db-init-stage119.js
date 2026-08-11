/** Stage 119 - non-materialized publication boundary for Robinhood holder counts. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `ALTER TABLE robinhood_token_holder_daily_snapshots
     DROP CONSTRAINT IF EXISTS robinhood_token_holder_daily_snapshots_source_check,
     ADD CONSTRAINT robinhood_token_holder_daily_snapshots_source_check
       CHECK (source IN ('blockscout', 'ledger_live'))`,
  `CREATE OR REPLACE VIEW robinhood_published_holder_summaries AS
   WITH holder_tokens AS (
     SELECT chain, token_address
       FROM robinhood_token_holder_summaries
      WHERE chain = 'robinhood'
     UNION
     SELECT chain, token_address
       FROM robinhood_holder_token_states
      WHERE chain = 'robinhood' AND ledger_status = 'live'
   )
   SELECT tokens.chain,
          tokens.token_address,
          CASE WHEN live_cursor.chain IS NOT NULL
            THEN live_state.holder_count ELSE fallback.holder_count END AS holder_count,
          CASE WHEN live_cursor.chain IS NOT NULL
            THEN 'ledger_live'::varchar(32) ELSE fallback.source END AS source,
          CASE WHEN live_cursor.chain IS NOT NULL
            THEN live_state.updated_at ELSE fallback.observed_at END AS observed_at,
          CASE WHEN live_cursor.chain IS NOT NULL
            THEN live_cursor.updated_at ELSE fallback.checked_at END AS checked_at,
          CASE WHEN live_cursor.chain IS NOT NULL
            THEN NULL::varchar(64) ELSE fallback.last_error_code END AS last_error_code,
          CASE WHEN live_cursor.chain IS NOT NULL
            THEN 0 ELSE fallback.consecutive_failures END AS consecutive_failures,
          CASE WHEN live_cursor.chain IS NOT NULL
            THEN NULL::timestamptz ELSE fallback.retry_after_at END AS retry_after_at,
          CASE WHEN live_cursor.chain IS NOT NULL
            THEN live_state.version ELSE NULL::bigint END AS ledger_version,
          CASE WHEN live_cursor.chain IS NOT NULL
            THEN live_state.live_through_block ELSE NULL::bigint END AS live_through_block,
          CASE WHEN live_cursor.chain IS NOT NULL
            THEN live_state.live_through_hash ELSE NULL::varchar(66) END AS live_through_hash
     FROM holder_tokens tokens
     LEFT JOIN robinhood_token_holder_summaries fallback
       ON fallback.chain = tokens.chain AND fallback.token_address = tokens.token_address
     LEFT JOIN robinhood_holder_token_states live_state
       ON live_state.chain = tokens.chain AND live_state.token_address = tokens.token_address
      AND live_state.ledger_status = 'live'
     LEFT JOIN robinhood_holder_cursors live_cursor
       ON live_cursor.chain = tokens.chain AND live_cursor.stream = 'live'
      AND live_state.token_address IS NOT NULL`,
]);

async function init(options = {}) {
  try {
    for (const statement of STATEMENTS) await db.query(statement);
    console.log('Stage 119 Robinhood holder publication view created successfully');
  } finally {
    if (options.closePool !== false) await db.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 119:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
