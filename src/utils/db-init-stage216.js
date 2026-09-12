'use strict';

/** Stage 216 - reorg-safe launchpad lifecycle evidence and current-state view. */
const db = require('../models/db');

const STATEMENTS = Object.freeze([
  `CREATE TABLE IF NOT EXISTS token_launchpad_lifecycle_events (
     chain VARCHAR(16) NOT NULL,
     block_hash VARCHAR(66) NOT NULL,
     block_number BIGINT NOT NULL,
     transaction_hash VARCHAR(66) NOT NULL,
     log_index INTEGER NOT NULL,
     event_address VARCHAR(42) NOT NULL,
     token_address VARCHAR(42) NOT NULL,
     curve_address VARCHAR(42),
     launchpad_id VARCHAR(32) NOT NULL,
     event_kind VARCHAR(24) NOT NULL,
     quote_delta_raw NUMERIC(78,0),
     graduation_threshold_raw NUMERIC(78,0),
     evidence_source VARCHAR(32) NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     CONSTRAINT token_launchpad_lifecycle_events_pkey PRIMARY KEY (
       chain, block_hash, log_index
     ),
     CONSTRAINT token_launchpad_lifecycle_events_event_fkey FOREIGN KEY (
       chain, block_hash, log_index
     ) REFERENCES robinhood_chain_events(chain, block_hash, log_index) ON DELETE CASCADE,
     CONSTRAINT token_launchpad_lifecycle_events_values_check CHECK (
       block_number >= 0 AND log_index >= 0
       AND event_address ~ '^0x[0-9a-f]{40}$'
       AND token_address ~ '^0x[0-9a-f]{40}$'
       AND (curve_address IS NULL OR curve_address ~ '^0x[0-9a-f]{40}$')
       AND event_kind IN ('launched', 'curve_progress', 'swept', 'migrated', 'rescued')
       AND evidence_source = 'canonical_event'
       AND ((event_kind = 'launched' AND curve_address IS NOT NULL
             AND graduation_threshold_raw > 0 AND quote_delta_raw IS NULL)
         OR (event_kind = 'curve_progress' AND curve_address IS NOT NULL
             AND quote_delta_raw IS NOT NULL AND graduation_threshold_raw IS NULL)
         OR (event_kind IN ('swept', 'migrated', 'rescued')
             AND quote_delta_raw IS NULL AND graduation_threshold_raw IS NULL))
     )
   )`,
  `CREATE INDEX IF NOT EXISTS idx_token_launchpad_lifecycle_token
     ON token_launchpad_lifecycle_events(
       chain, token_address, launchpad_id, block_number DESC, log_index DESC
     )`,
  `CREATE INDEX IF NOT EXISTS idx_token_launchpad_lifecycle_curve
     ON token_launchpad_lifecycle_events(chain, curve_address, block_number)
     WHERE curve_address IS NOT NULL`,
  `CREATE OR REPLACE VIEW token_launchpad_lifecycle AS
     WITH canonical AS (
       SELECT evidence.*, block.block_timestamp
         FROM token_launchpad_lifecycle_events evidence
         JOIN robinhood_chain_blocks block
           ON block.chain=evidence.chain AND block.block_hash=evidence.block_hash
        WHERE block.canonical=TRUE
     ), launches AS (
       SELECT DISTINCT ON (chain, token_address, launchpad_id)
              chain, token_address, launchpad_id, curve_address,
              graduation_threshold_raw, block_timestamp AS launched_at
         FROM canonical WHERE event_kind='launched'
        ORDER BY chain, token_address, launchpad_id, block_number DESC, log_index DESC
     ), rollup AS (
       SELECT launch.chain, launch.token_address, launch.launchpad_id,
              launch.curve_address, launch.graduation_threshold_raw, launch.launched_at,
              COALESCE(SUM(event.quote_delta_raw)
                FILTER (WHERE event.event_kind='curve_progress'), 0) AS quote_progress_raw,
              MAX(event.block_timestamp) FILTER (WHERE event.event_kind='migrated') AS migrated_at,
              COUNT(event.*)::bigint AS version
         FROM launches launch JOIN canonical event
           ON event.chain=launch.chain AND event.token_address=launch.token_address
          AND event.launchpad_id=launch.launchpad_id
        GROUP BY launch.chain, launch.token_address, launch.launchpad_id,
                 launch.curve_address, launch.graduation_threshold_raw, launch.launched_at
     ), latest AS (
       SELECT DISTINCT ON (chain, token_address, launchpad_id)
              chain, token_address, launchpad_id, event_kind, block_timestamp,
              block_number, block_hash, transaction_hash, log_index
         FROM canonical
        ORDER BY chain, token_address, launchpad_id, block_number DESC, log_index DESC
     )
     SELECT rollup.chain, rollup.token_address, rollup.launchpad_id,
            CASE WHEN latest.event_kind='migrated' THEN 'migrated'
                 WHEN latest.event_kind IN ('launched','curve_progress') THEN 'pre_bonded'
                 ELSE 'unknown' END AS status,
            CASE WHEN latest.event_kind IN ('launched','curve_progress') THEN
              LEAST(10000, GREATEST(0, TRUNC(
                rollup.quote_progress_raw * 10000 / rollup.graduation_threshold_raw
              )))::integer ELSE NULL END AS bond_progress_bps,
            rollup.curve_address, rollup.launched_at AS created_at, rollup.migrated_at,
            latest.block_timestamp AS last_event_at, 'canonical_event'::text AS evidence_source,
            latest.block_number AS evidence_block_number,
            latest.block_hash AS evidence_block_hash,
            latest.transaction_hash AS evidence_transaction_hash,
            latest.log_index AS evidence_log_index, rollup.version
       FROM rollup JOIN latest USING (chain, token_address, launchpad_id)`,
]);

async function init(options = {}) {
  const database = options.database || db;
  try {
    for (const statement of STATEMENTS) await database.query(statement);
    console.log('Stage 216 Robinhood launchpad lifecycle created successfully');
  } finally {
    if (options.closePool !== false) await database.pool.end().catch(() => {});
  }
}

if (require.main === module) init().catch((error) => {
  console.error('Failed to create Stage 216:', error.message);
  process.exitCode = 1;
});

module.exports = { STATEMENTS, init };
